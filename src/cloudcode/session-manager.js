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

    // 1. Explicit metadata / user_id (Claude Code or custom clients)
    if (anthropicRequest.metadata?.user_id) {
        return `user:${anthropicRequest.metadata.user_id}`;
    }

    // 2. Explicit session ID in request
    if (anthropicRequest.session_id || anthropicRequest.sessionId) {
        return `session:${anthropicRequest.session_id || anthropicRequest.sessionId}`;
    }

    // 3. Deterministic root message fingerprint (First user message + system prefix)
    const messages = anthropicRequest.messages || [];
    const firstUserMsg = messages.find(m => m.role === 'user');
    const rootContent = typeof firstUserMsg?.content === 'string'
        ? firstUserMsg.content
        : JSON.stringify(firstUserMsg?.content || '');

    const systemContent = typeof anthropicRequest.system === 'string'
        ? anthropicRequest.system
        : JSON.stringify(anthropicRequest.system || '');

    if (rootContent.length > 0 || systemContent.length > 0) {
        const hash = crypto.createHash('sha256')
            .update(systemContent.slice(0, 300))
            .update(rootContent.slice(0, 300))
            .digest('hex')
            .slice(0, 12);
        return `conv:${hash}`;
    }

    return 'anon';
}

/**
 * Session Router
 * Maintains per-session affinity to accounts to maximize prompt caching hit rate.
 */
export class SessionRouter {
    #sessions = new Map(); // sessionKey -> { accountEmail, assignedAt, lastUsed, modelId }
    #ttlMs;

    constructor(ttlMs = 30 * 60 * 1000) { // 30 minutes TTL
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
                logger.info(`[CACHE][ROUTING-HIT] 🎯 Session: ${sessionKey} -> Pinned to ${account.email} (prompt cache affinity preserved)`);
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
     */
    bindSession(sessionKey, accountEmail, modelId) {
        if (!sessionKey || sessionKey === 'anon' || !accountEmail) return;

        this.#sessions.set(sessionKey, {
            accountEmail,
            assignedAt: Date.now(),
            lastUsed: Date.now(),
            modelId
        });
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
