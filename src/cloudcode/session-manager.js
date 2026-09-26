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
                                tokens: item.tokens || { input: 0, output: 0, cached: 0 }
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
                    tokens: entry.tokens
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
    pinModel(sessionKey, modelId) {
        if (!sessionKey || sessionKey === 'anon' || !modelId) return;
        const existing = this.#sessions.get(sessionKey);
        if (existing) {
            existing.modelId = modelId;
            existing.lastUsed = Date.now();
        } else {
            this.#sessions.set(sessionKey, {
                accountEmail: null,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId,
                upstreamSessionId: null,
                requestCount: 0,
                isSubagent: false,
                tokens: { input: 0, output: 0, cached: 0 }
            });
        }
        this.#scheduleSave();
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
        const newUpstreamId = crypto.randomUUID() + Date.now().toString();
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

            const effectiveQuotaModel = (isClaude && !acc?.quota?.models?.[entry.modelId]) ? 'gemini-3.7-flash-tiered' : entry.modelId;
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
                accountStatus: isRateLimited ? 'rate_limited' : (acc?.status || (entry.accountEmail ? 'ok' : 'unassigned')),
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
        return sessionRouter.getOrCreateUpstreamSessionId(sessionKey, accountEmail);
    }

    if (!accountEmail) {
        return generateBinaryStyleId();
    }

    if (runtimeSessionStore.has(accountEmail)) {
        return runtimeSessionStore.get(accountEmail);
    }

    const newSessionId = generateBinaryStyleId();
    runtimeSessionStore.set(accountEmail, newSessionId);
    return newSessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 */
function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    sessionRouter.clear();
}
