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
                                accountEmail: item.accountEmail,
                                assignedAt: item.assignedAt || item.lastUsed || now,
                                lastUsed: item.lastUsed || now,
                                modelId: item.modelId,
                                requestCount: item.requestCount || 1,
                                isSubagent: !!item.isSubagent,
                                tokens: item.tokens || { input: 0, output: 0 }
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

        if (entry) {
            const account = availableAccounts.find(a => a.email === entry.accountEmail);
            if (account) {
                entry.lastUsed = Date.now();
                entry.requestCount = (entry.requestCount || 0) + 1;
                if (modelId) entry.modelId = modelId;
                this.#scheduleSave();
                logger.info(`[CACHE][ROUTING-HIT] 🎯 Session: ${sessionKey} -> Pinned to ${account.email} (prompt cache affinity preserved, reqs: ${entry.requestCount})`);
                return account;
            }

            // Account is no longer in available list (rate limited / invalid) -> Failover
            logger.warn(`[CACHE][ROUTING-FAILOVER] ⚠️ Session: ${sessionKey} -> Previous account ${entry.accountEmail} unavailable, rotating to new account`);
            this.#sessions.delete(sessionKey);
            this.#scheduleSave();
        } else {
            logger.info(`[CACHE][ROUTING-MISS] 🆕 Session: ${sessionKey} -> No previous affinity found, selecting new account`);
        }

        return null;
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
            existing.modelId = modelId || existing.modelId;
            existing.requestCount = (existing.requestCount || 0) + 1;
            if (extra.isSubagent !== undefined) existing.isSubagent = extra.isSubagent;
        } else {
            this.#sessions.set(sessionKey, {
                accountEmail,
                assignedAt: Date.now(),
                lastUsed: Date.now(),
                modelId,
                requestCount: 1,
                isSubagent: !!extra.isSubagent,
                tokens: { input: 0, output: 0 }
            });
        }
        this.#scheduleSave();
    }

    /**
     * Record usage statistics for a session
     */
    recordSessionUsage(sessionKey, tokens = {}) {
        if (!sessionKey || sessionKey === 'anon') return;
        const entry = this.#sessions.get(sessionKey);
        if (entry) {
            entry.tokens = entry.tokens || { input: 0, output: 0 };
            entry.tokens.input += (tokens.input_tokens || tokens.inputTokens || 0);
            entry.tokens.output += (tokens.output_tokens || tokens.outputTokens || 0);
            this.#scheduleSave();
        }
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
            const acc = accounts.find(a => a.email === entry.accountEmail);
            const modelQuota = acc?.quota?.models?.[entry.modelId] || acc?.models?.[entry.modelId];
            const remainingFraction = modelQuota?.remainingFraction ?? null;
            const remainingPercent = remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
            
            // Check if account is currently rate limited for this model
            const isRateLimited = acc?.modelRateLimits?.[entry.modelId] && acc.modelRateLimits[entry.modelId] > now;
            const rateLimitExpiry = isRateLimited ? acc.modelRateLimits[entry.modelId] : null;

            const rawKey = acc?.apiKey || acc?.byokApiKey || null;
            const byokKeyPreview = rawKey ? `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}` : null;
            const isByok = acc?.source === 'gemini-byok' || !!acc?.byokApiKey;
            const byokMode = acc?.mode || acc?.byokMode || (acc?.source === 'gemini-byok' ? 'default_for_gemini_models' : null);
            const accountTier = acc?.source === 'gemini-byok' ? 'byok' : (acc?.subscription?.tier && acc.subscription.tier !== 'unknown' ? acc.subscription.tier : (isByok ? 'byok' : 'free'));

            sessionsList.push({
                sessionKey: key,
                accountEmail: entry.accountEmail,
                modelId: entry.modelId,
                requestCount: entry.requestCount || 1,
                assignedAt: entry.assignedAt,
                lastUsed: entry.lastUsed,
                idleSeconds: Math.round((now - entry.lastUsed) / 1000),
                isSubagent: !!entry.isSubagent,
                accountTier,
                accountSource: acc?.source || 'oauth',
                isByok,
                hasByokKey: !!rawKey,
                byokMode,
                byokKeyPreview,
                accountStatus: isRateLimited ? 'rate_limited' : (acc?.status || 'ok'),
                remainingFraction,
                remainingPercent,
                resetTime: modelQuota?.resetTime || null,
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
