/**
 * Session Management for Cloud Code
 *
 * Handles session-sticky routing and session ID derivation for prompt caching continuity.
 * Enables per-conversation / per-subagent affinity to maximize Google TPU prompt cache hits.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { SESSIONS_PERSISTENCE_PATH } from '../constants.js';
import { config } from '../config.js';
import { isBreakerOpen } from './exhaustion-breaker.js';

// Runtime storage for session IDs (per account)
const runtimeSessionStore = new Map();

/**
 * Extract a deterministic session fingerprint from the incoming Anthropic request.
 * Identifies the conversation or subagent across turns.
 *
 * @param {Object} anthropicRequest - Anthropic request body
 * @returns {string} Session key string
 */
export function extractSessionKey(anthropicRequest) {
    if (!anthropicRequest) return 'anon';

    // 1. Explicit session ID in request — most stable, use as-is
    if (anthropicRequest.session_id || anthropicRequest.sessionId) {
        return `session:${anthropicRequest.session_id || anthropicRequest.sessionId}`;
    }

    // 2. Stable deterministic fingerprint based on IMMUTABLE parts of the conversation.
    //
    //    OLD: used messages.length + lastMsg.content — BOTH change on every agent turn
    //    (each tool call adds messages), causing a new session key per turn and
    //    destroying sticky routing / TPU prompt cache continuity.
    //
    //    NEW: use only parts that never change across turns of the same conversation:
    //      - system prompt (set once at start, constant throughout)
    //      - first user message (the original user request, never mutated)
    //    This produces the same fingerprint for all turns of the same agent session.
    const messages = anthropicRequest.messages || [];
    if (messages.length === 0) return 'anon';

    // Extract system prompt (can be string or structured array)
    const system = anthropicRequest.system || '';
    const systemStr = typeof system === 'string'
        ? system.slice(0, 200)
        : JSON.stringify(system).slice(0, 200);

    // Extract first user message only — stable across all turns
    const firstMsg = messages[0];
    const firstContent = typeof firstMsg?.content === 'string'
        ? firstMsg.content.slice(0, 200)
        : JSON.stringify(firstMsg?.content || '').slice(0, 200);

    const hash = crypto.createHash('sha256')
        .update(`sys:${systemStr}`)
        .update(`first:${firstContent}`)
        .digest('hex')
        .slice(0, 12);

    return `conv:${hash}`;
}

/**
 * Session Router
 * Maintains per-session affinity to accounts to maximize prompt caching hit rate
 * and persists session routing & analytics to disk across proxy restarts.
 */
export class SessionRouter {
    #sessions = new Map(); // sessionKey -> { accountEmail, assignedAt, lastUsed, modelId, requestCount, isSubagent, tokens }
    #ttlMs;
    #maxSessions;
    #saveTimer = null;
    #isDirty = false;

    constructor(ttlMs = 24 * 60 * 60 * 1000, maxSessions = 500) { // 24 hours TTL, max 500 entries
        this.#ttlMs = ttlMs;
        this.#maxSessions = maxSessions;
        this.#loadFromDisk();
    }

    /**
     * Load persisted sessions from disk on startup
     */
    #loadFromDisk() {
        try {
            if (fs.existsSync(SESSIONS_PERSISTENCE_PATH)) {
                const raw = fs.readFileSync(SESSIONS_PERSISTENCE_PATH, 'utf8');
                const data = JSON.parse(raw);
                if (Array.isArray(data)) {
                    const now = Date.now();
                    let loaded = 0;
                    for (const item of data) {
                        if (item && item.sessionKey && item.lastUsed && (now - item.lastUsed <= this.#ttlMs)) {
                            this.#sessions.set(item.sessionKey, {
                                accountEmail: item.accountEmail || null,
                                assignedAt: item.assignedAt || item.lastUsed || now,
                                lastUsed: item.lastUsed || now,
                                modelId: item.modelId || null,
                                upstreamSessionId: item.upstreamSessionId || null,
                                requestCount: item.requestCount || 1,
                                isSubagent: !!item.isSubagent,
                                tokens: item.tokens || { input: 0, output: 0, cached: 0 },
                                pin: item.pin || null,
                                servedBy: item.servedBy || null
                            });
                            loaded++;
                        }
                    }
                    this.#pruneStale();
                    logger.info(`[SessionRouter] Restored ${loaded} persistent session(s) from disk`);
                }
            }
        } catch (e) {
            logger.warn(`[SessionRouter] Failed to load sessions from disk: ${e.message}`);
        }
    }

    /**
     * Schedule a debounced async save to disk
     */
    scheduleSave() {
        this.#scheduleSave();
    }

    #scheduleSave() {
        this.#isDirty = true;
        if (this.#saveTimer) return;
        this.#saveTimer = setTimeout(() => {
            this.#saveTimer = null;
            this.#saveToDisk();
        }, 1000);
    }

    /**
     * Save active sessions to disk atomically
     */
    #saveToDisk() {
        if (!this.#isDirty) return;
        try {
            this.#pruneStale();
            const dir = path.dirname(SESSIONS_PERSISTENCE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const data = [];
            for (const [key, entry] of this.#sessions.entries()) {
                data.push({
                    sessionKey: key,
                    accountEmail: entry.accountEmail,
                    assignedAt: entry.assignedAt,
                    lastUsed: entry.lastUsed,
                    modelId: entry.modelId,
                    upstreamSessionId: entry.upstreamSessionId || null,
                    requestCount: entry.requestCount,
                    isSubagent: entry.isSubagent,
                    tokens: entry.tokens,
                    pin: entry.pin || null,
                    servedBy: entry.servedBy || null
                });
            }

            // Keep top #maxSessions by lastUsed
            data.sort((a, b) => b.lastUsed - a.lastUsed);
            const capped = data.slice(0, this.#maxSessions);

            const tempPath = `${SESSIONS_PERSISTENCE_PATH}.tmp.${process.pid}`;
            fs.writeFileSync(tempPath, JSON.stringify(capped, null, 2), 'utf8');
            fs.renameSync(tempPath, SESSIONS_PERSISTENCE_PATH);
            this.#isDirty = false;
            logger.debug(`[SessionRouter] Saved ${capped.length} session(s) to disk`);
        } catch (e) {
            logger.warn(`[SessionRouter] Failed to save sessions to disk: ${e.message}`);
        }
    }

    /**
     * Get the pinned model for a session if one has been assigned
     * @param {string} sessionKey - Fingerprint for the session
     * @returns {string|null} Pinned model ID or null
     */
    getPinnedModel(sessionKey) {
        if (!sessionKey || sessionKey === 'anon') return null;
        this.#pruneStale();
        const entry = this.#sessions.get(sessionKey);
        return entry?.modelId || null;
    }

    /**
     * Pre-pin a model to a session before account selection
     * @param {string} sessionKey - Fingerprint for the session
     * @param {string} modelId - Model ID to attach
     */
    pinModel(sessionKey, modelId, reason = 'filter') {
        if (!sessionKey || sessionKey === 'anon' || !modelId) return;
        const pin = { model: modelId, at: Date.now(), reason };
        const existing = this.#sessions.get(sessionKey);
        if (existing) {
            existing.modelId = modelId;
            existing.pin = pin;
            existing.lastUsed = Date.now();
        } else {
            this.#sessions.set(sessionKey, {
                accountEmail: null,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId,
                pin,
                upstreamSessionId: null,
                requestCount: 0,
                isSubagent: false,
                tokens: { input: 0, output: 0, cached: 0 }
            });
        }
        this.#scheduleSave();
    }

    /**
     * Active filter pin for a session: the pinned model, or null.
     * - Only a real pin record counts (set by pinModel on a safety-filter event). A session's sticky
     *   `modelId` is NOT a pin (legacy sessions therefore come back unpinned).
     * - Pins expire config.filterPin.ttlMs (default 30 min) after the last filter event.
     * - A pin is ignored while its model's exhaustion breaker is open, so a session can never be trapped
     *   on a dead model (one-way escape: the request keeps the model the client asked for).
     */
    getActivePin(sessionKey) {
        if (!sessionKey || sessionKey === 'anon') return null;
        const entry = this.#sessions.get(sessionKey);
        const pin = entry?.pin;
        if (!pin?.model) return null;
        const ttlMs = config.filterPin?.ttlMs ?? 30 * 60_000;
        if (Date.now() - pin.at > ttlMs) {
            entry.pin = null;
            this.#scheduleSave();
            return null;
        }
        if (isBreakerOpen(pin.model)) {
            logger.warn(`[Pin] ${pin.model} is unhealthy (breaker open) -> ignoring pin for ${sessionKey}`);
            return null;
        }
        return pin.model;
    }

    /**
     * Give a session a brand-new upstream sessionId (Google-side conversation identity).
     * Costs one cold prompt cache. Used when a session keeps failing on every model/account while other
     * sessions work on the same accounts (identity-bound failure), and by the unpin actions.
     */
    rotateUpstreamSession(sessionKey, reason = 'manual') {
        if (!sessionKey || sessionKey === 'anon') return false;
        const entry = this.#sessions.get(sessionKey);
        if (!entry) return false;
        const old = entry.upstreamSessionId;
        entry.upstreamSessionId = null;               // re-created lazily by getOrCreateUpstreamSessionId()
        entry.failStreak = null;
        entry.lastRotatedAt = Date.now();
        this.#scheduleSave();
        logger.warn(`[SessionRotate] ♻️ ${sessionKey}: new upstream sessionId (${reason}); old=${String(old).slice(0, 8)}…`);
        return true;
    }

    /**
     * Record a request-level exhaustion for a session (called once per model hop that failed on >=3 accounts).
     * When >=2 DIFFERENT models failed for the same session within 5 min, the failure is tied to the session,
     * not to a model -> rotate its upstream sessionId (at most once per 10 min).
     */
    noteSessionExhaustion(sessionKey, model, triedCount) {
        if (!sessionKey || sessionKey === 'anon' || triedCount < 3) return;
        const entry = this.#sessions.get(sessionKey);
        if (!entry) return;
        const now = Date.now();
        const st = entry.failStreak && now - entry.failStreak.at < 5 * 60_000 ? entry.failStreak : { at: now, models: [] };
        if (!st.models.includes(model)) st.models.push(model);
        st.at = now;
        entry.failStreak = st;
        if (st.models.length >= 2 && now - (entry.lastRotatedAt || 0) > 10 * 60_000) {
            this.rotateUpstreamSession(sessionKey, `failed on ${st.models.join(' + ')} across accounts`);
        }
    }

    noteSessionSuccess(sessionKey) {
        const entry = sessionKey && this.#sessions.get(sessionKey);
        if (entry?.failStreak) entry.failStreak = null;
    }

    /**
     * Unpin sessions: clears the filter pin, the account affinity and the last-resort marker so the
     * session is routed fresh on its next request (one-time prompt-cache miss).
     * @param {{sessionKey?: string, all?: boolean, strata?: boolean}} opts
     * @returns {number} Number of sessions affected
     */
    unpinSessions({ sessionKey = null, all = false, strata = false } = {}) {
        let n = 0;
        for (const [key, entry] of this.#sessions) {
            const onStrata = entry.servedBy?.backend === 'strata' || /strata|swift/i.test(entry.modelId || '');
            const match = all || (sessionKey && key === sessionKey) || (strata && onStrata);
            if (!match) continue;
            entry.pin = null;
            entry.accountEmail = null;
            entry.servedBy = null;
            entry.upstreamSessionId = null;   // fresh upstream identity too
            entry.failStreak = null;
            if (/3\.8-flash/i.test(entry.modelId || '')) entry.modelId = null;   // drop the legacy sticky 3.8 model too
            n++;
        }
        if (n > 0) this.#scheduleSave();
        logger.info(`[SessionRouter] 🔓 Unpinned ${n} session(s) (${all ? 'all' : strata ? 'strata' : sessionKey})`);
        return n;
    }

    /**
     * Get session entry if it exists
     * @param {string} sessionKey
     * @returns {Object|null}
     */
    getSession(sessionKey) {
        if (!sessionKey || sessionKey === 'anon') return null;
        return this.#sessions.get(sessionKey) || null;
    }

    /**
     * Get or create a dedicated upstream sessionId for a session key
     * @param {string} sessionKey
     * @param {string|null} accountEmail
     * @returns {string}
     */
    getOrCreateUpstreamSessionId(sessionKey, accountEmail = null) {
        if (!sessionKey || sessionKey === 'anon') return null;
        let entry = this.#sessions.get(sessionKey);
        if (entry?.upstreamSessionId) {
            return entry.upstreamSessionId;
        }
        const newUpstreamId = randomAgySessionId();
        if (entry) {
            entry.upstreamSessionId = newUpstreamId;
        } else {
            entry = {
                accountEmail: accountEmail || null,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId: null,
                upstreamSessionId: newUpstreamId,
                requestCount: 0,
                isSubagent: false,
                tokens: { input: 0, output: 0, cached: 0 }
            };
            this.#sessions.set(sessionKey, entry);
        }
        this.#scheduleSave();
        return newUpstreamId;
    }

    /**
     * Get the pinned account for a session if it exists and is healthy
     *
     * @param {string} sessionKey - Fingerprint for the session
     * @param {string} modelId - Model ID being requested
     * @param {Array<Object>} availableAccounts - List of healthy available accounts
     * @returns {Object|null} Pinned account or null if none/unhealthy
     */
    getPinnedAccount(sessionKey, modelId, availableAccounts) {
        if (!sessionKey || sessionKey === 'anon') return null;

        this.#pruneStale();
        const entry = this.#sessions.get(sessionKey);

        if (entry && entry.accountEmail) {
            const account = availableAccounts.find(a => a.email === entry.accountEmail);
            if (account) {
                entry.lastUsed = Date.now();
                entry.requestCount = (entry.requestCount || 0) + 1;
                if (!entry.modelId && modelId) entry.modelId = modelId;
                this.#scheduleSave();
                logger.info(`[CACHE][ROUTING-HIT] 🎯 Session: ${sessionKey} -> Pinned to ${account.email} (prompt cache affinity preserved, reqs: ${entry.requestCount})`);
                return account;
            }

            // Account is no longer in available list (rate limited / invalid) -> Failover
            logger.warn(`[CACHE][ROUTING-FAILOVER] ⚠️ Session: ${sessionKey} -> Previous account ${entry.accountEmail} unavailable, rotating to new account`);
            entry.accountEmail = null; // Unbind account only; preserve pinned model & session stats!
            this.#scheduleSave();
        } else {
            logger.info(`[CACHE][ROUTING-MISS] 🆕 Session: ${sessionKey} -> No previous affinity found, selecting new account`);
        }

        return null;
    }

    /**
     * Number of recently active sessions currently bound to an account.
     * Used by the account strategy to spread NEW sessions across accounts instead of piling
     * every session on the single best-scoring account.
     *
     * @param {string} email - Account email
     * @param {{windowMs?: number, excludeKey?: string|null}} [opts]
     * @returns {number}
     */
    /**
     * Record which last-resort backend (copilot/strata) answered a session that has no Google account.
     */
    recordServedBy(sessionKey, backend) {
        if (!sessionKey || sessionKey === 'anon') return;
        const entry = this.#sessions.get(sessionKey);
        if (!entry) return;
        entry.servedBy = { backend, at: Date.now() };
        this.#scheduleSave();
    }

    getActiveSessionCount(email, { windowMs = 300000, excludeKey = null } = {}) {
        if (!email) return 0;
        const now = Date.now();
        let n = 0;
        for (const [key, entry] of this.#sessions) {
            if (key === excludeKey) continue;
            if (entry.accountEmail === email && now - (entry.lastUsed || 0) <= windowMs) n++;
        }
        return n;
    }

    /**
     * Unbind a session key from its current account (e.g. on rate limit or failover)
     * Preserves model assignment and session tokens.
     *
     * @param {string} sessionKey - Fingerprint for the session
     */
    unbindSession(sessionKey) {
        if (!sessionKey || sessionKey === 'anon') return;
        if (this.#sessions.has(sessionKey)) {
            const entry = this.#sessions.get(sessionKey);
            logger.info(`[CACHE][ROUTING-UNBIND] 🔄 Unbinding session ${sessionKey} from ${entry.accountEmail}`);
            entry.accountEmail = null;
            this.#scheduleSave();
        }
    }

    /**
     * Bind a session key to an account
     *
     * @param {string} sessionKey - Fingerprint for the session
     * @param {string} accountEmail - Email of selected account
     * @param {string} modelId - Model ID
     * @param {Object} extra - Extra session metadata
     */
    bindSession(sessionKey, accountEmail, modelId, extra = {}) {
        if (!sessionKey || sessionKey === 'anon' || !accountEmail) return;

        const existing = this.#sessions.get(sessionKey);
        if (existing) {
            existing.accountEmail = accountEmail;
            existing.lastUsed = Date.now();
            if (!existing.modelId && modelId) existing.modelId = modelId;
            existing.requestCount = (existing.requestCount || 0) + 1;
            if (extra.isSubagent !== undefined) existing.isSubagent = extra.isSubagent;
        } else {
            this.#sessions.set(sessionKey, {
                accountEmail,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId,
                upstreamSessionId: null,
                requestCount: 1,
                isSubagent: !!extra.isSubagent,
                tokens: { input: 0, output: 0, cached: 0 }
            });
        }
        this.#scheduleSave();
    }

    /**
     * Record usage statistics for a session
     */
    recordSessionUsage(sessionKey, tokens = {}) {
        if (!sessionKey || sessionKey === 'anon') return;
        let entry = this.#sessions.get(sessionKey);
        if (!entry) {
            entry = {
                accountEmail: null,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId: null,
                upstreamSessionId: null,
                requestCount: 1,
                isSubagent: false,
                tokens: { input: 0, output: 0, cached: 0 }
            };
            this.#sessions.set(sessionKey, entry);
        }
        entry.tokens = entry.tokens || { input: 0, output: 0, cached: 0 };
        entry.tokens.input += (tokens.input_tokens || tokens.inputTokens || 0);
        entry.tokens.output += (tokens.output_tokens || tokens.outputTokens || 0);
        entry.tokens.cached = (entry.tokens.cached || 0) + (tokens.cache_read_input_tokens || tokens.cachedTokens || 0);
        this.#scheduleSave();
    }

    /**
     * Get all active sessions enriched with quota data from AccountManager
     *
     * @param {Object} accountManager - AccountManager instance
     * @returns {Array<Object>} List of session objects
     */
    getAllSessions(accountManager) {
        this.#pruneStale();
        const sessionsList = [];
        const accounts = accountManager?.getAllAccounts?.() || [];
        const now = Date.now();

        for (const [key, entry] of this.#sessions.entries()) {
            const acc = entry.accountEmail ? accounts.find(a => a.email === entry.accountEmail) : null;
            const gcpProject = acc?.gcpProject || accountManager?.getSettings?.()?.gcpProject || null;
            const isClaude = Boolean(entry.modelId && entry.modelId.toLowerCase().includes('claude'));
            const isVertex = Boolean(gcpProject && !isClaude);

            const effectiveQuotaModel = (isClaude && !acc?.quota?.models?.[entry.modelId]) ? 'gemini-4-hydrogen-high' : entry.modelId;
            const modelQuota = acc?.quota?.models?.[effectiveQuotaModel] || acc?.models?.[effectiveQuotaModel];
            const remainingFraction = isVertex ? 1.0 : (modelQuota?.remainingFraction ?? null);
            const remainingPercent = isVertex ? 100 : (remainingFraction !== null ? Math.round(remainingFraction * 100) : null);
            
            // Check if account is currently rate limited for this model
            const isRateLimited = isVertex ? false : (acc?.modelRateLimits?.[entry.modelId] && acc.modelRateLimits[entry.modelId] > now);
            const rateLimitExpiry = isRateLimited ? acc.modelRateLimits[entry.modelId] : null;

            const rawKey = acc?.apiKey || acc?.byokApiKey || null;
            const byokKeyPreview = rawKey ? `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}` : null;
            const isByok = acc?.source === 'gemini-byok' || !!acc?.byokApiKey;
            const accountTier = isVertex ? 'vertex' : (acc?.source === 'gemini-byok' ? 'byok' : (acc?.subscription?.tier && acc.subscription.tier !== 'unknown' ? acc.subscription.tier : (isByok ? 'byok' : (acc ? 'free' : 'none'))));

            sessionsList.push({
                sessionKey: key,
                accountEmail: entry.accountEmail || 'unassigned',
                modelId: entry.modelId,
                requestCount: entry.requestCount || 1,
                assignedAt: entry.assignedAt,
                lastUsed: entry.lastUsed,
                idleSeconds: Math.round((now - entry.lastUsed) / 1000),
                isSubagent: !!entry.isSubagent,
                accountTier,
                accountSource: isVertex ? 'vertex' : (acc?.source || 'oauth'),
                isVertex,
                gcpProject,
                isByok,
                hasByokKey: !!rawKey,
                byokKeyPreview,
                servedBy: entry.servedBy || null,
                pinnedModel: entry.pin?.model && (Date.now() - entry.pin.at <= (config.filterPin?.ttlMs ?? 30 * 60_000)) ? entry.pin.model : null,
                pinExpiresInMs: entry.pin?.model ? Math.max(0, (config.filterPin?.ttlMs ?? 30 * 60_000) - (Date.now() - entry.pin.at)) : null,
                accountStatus: isRateLimited ? 'rate_limited' : (acc?.status || (entry.accountEmail ? 'ok' : (entry.servedBy && now - entry.servedBy.at < 300000 ? 'fallback' : 'unassigned'))),
                remainingFraction,
                remainingPercent,
                resetTime: isVertex ? null : (modelQuota?.resetTime || null),
                rateLimitExpiry,
                tokens: entry.tokens || null
            });
        }

        // Sort by lastUsed descending (most active/recent sessions first)
        return sessionsList.sort((a, b) => b.lastUsed - a.lastUsed);
    }

    /**
     * Remove stale sessions
     */
    #pruneStale() {
        const now = Date.now();
        for (const [key, entry] of this.#sessions.entries()) {
            if (now - entry.lastUsed > this.#ttlMs) {
                this.#sessions.delete(key);
                this.#isDirty = true;
            }
        }
    }

    /**
     * Clear all session bindings
     */
    clear() {
        this.#sessions.clear();
        this.#isDirty = true;
        this.#saveToDisk();
    }
}

// Global singleton session router instance
export const sessionRouter = new SessionRouter();

/**
 * Get or create a session ID for the given account.
 * 
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} accountEmail - The account email to scope the session ID
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(anthropicRequest, accountEmail) {
    // 1. If request has a deterministic session key, derive or reuse a dedicated upstream session ID
    // for that conversation. This ensures isolated, continuous Google TPU prompt cache affinity.
    const sessionKey = extractSessionKey(anthropicRequest);
    if (sessionKey && sessionKey !== 'anon') {
        return toAgySessionId(sessionRouter.getOrCreateUpstreamSessionId(sessionKey, accountEmail));
    }

    if (!accountEmail) {
        return generateBinaryStyleId();
    }

    if (runtimeSessionStore.has(accountEmail)) {
        return toAgySessionId(runtimeSessionStore.get(accountEmail));
    }

    const newSessionId = generateBinaryStyleId();
    runtimeSessionStore.set(accountEmail, newSessionId);
    return newSessionId;
}


/**
 * agy sends sessionId as a signed 64-bit integer string (e.g. "-3750763034362895579"), not uuid+timestamp.
 */
function randomAgySessionId() {
    return crypto.randomBytes(8).readBigInt64BE().toString();
}

/**
 * Map a legacy (uuid+timestamp) upstream session id to a stable signed-64 decimal string so persisted
 * sessions keep a constant id (TPU prompt-cache affinity) while matching agy's format.
 */
export function toAgySessionId(id) {
    if (!id) return id;
    if (/^-?\d{1,19}$/.test(String(id))) return String(id);
    return crypto.createHash('sha256').update(String(id)).digest().readBigInt64BE(0).toString();
}

/**
 * Generate a Session ID using the binary's exact logic.
 */
function generateBinaryStyleId() {
    return randomAgySessionId();
}

/**
 * Clears all session IDs
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    sessionRouter.clear();
}
