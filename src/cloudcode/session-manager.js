/**
 * Session Management for Cloud Code
 *
 * Handles session-sticky routing and session ID derivation for prompt caching continuity.
 * Enables per-conversation / per-subagent affinity to maximize Google TPU prompt cache hits.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

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
 * and tracks real-time session analytics.
 */
export class SessionRouter {
    #sessions = new Map(); // sessionKey -> { accountEmail, assignedAt, lastUsed, modelId, requestCount, isSubagent, tokens }
    #ttlMs;

    constructor(ttlMs = 45 * 60 * 1000) { // 45 minutes TTL
        this.#ttlMs = ttlMs;
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
                logger.info(`[CACHE][ROUTING-HIT] 🎯 Session: ${sessionKey} -> Pinned to ${account.email} (prompt cache affinity preserved, reqs: ${entry.requestCount})`);
                return account;
            }

            // Account is no longer in available list (rate limited / invalid) -> Failover
            logger.warn(`[CACHE][ROUTING-FAILOVER] ⚠️ Session: ${sessionKey} -> Previous account ${entry.accountEmail} unavailable, rotating to new account`);
            this.#sessions.delete(sessionKey);
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
                isSubagent: !!extra.isSubagent
            });
        }
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
            const modelQuota = acc?.models?.[entry.modelId];
            const remainingFraction = modelQuota?.remainingFraction ?? null;
            const remainingPercent = remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
            
            // Check if account is currently rate limited for this model
            const isRateLimited = acc?.modelRateLimits?.[entry.modelId] && acc.modelRateLimits[entry.modelId] > now;
            const rateLimitExpiry = isRateLimited ? acc.modelRateLimits[entry.modelId] : null;

            sessionsList.push({
                sessionKey: key,
                accountEmail: entry.accountEmail,
                modelId: entry.modelId,
                requestCount: entry.requestCount || 1,
                assignedAt: entry.assignedAt,
                lastUsed: entry.lastUsed,
                idleSeconds: Math.round((now - entry.lastUsed) / 1000),
                isSubagent: !!entry.isSubagent,
                accountTier: acc?.subscription?.tier || (acc?.source === 'gemini-byok' ? 'byok' : 'free'),
                accountSource: acc?.source || 'oauth',
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
            }
        }
    }

    /**
     * Clear all session bindings
     */
    clear() {
        this.#sessions.clear();
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
