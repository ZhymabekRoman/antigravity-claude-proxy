/**
 * Per-model exhaustion circuit breaker.
 *
 * When every Google account fails for a model (5 attempts of 429 + backoff, ~100s wasted),
 * the next requests would burn the same ~100s again before reaching the last-resort chain
 * (Copilot -> Strata). This breaker remembers "model exhausted" and fails fast so server.js
 * can hand the request to the fallback chain immediately.
 *
 *   closed    -> normal operation
 *   open      -> fail fast with "Max retries exceeded (circuit open ...)" until cooldown expires
 *   half-open -> after cooldown exactly ONE probe request is let through (single attempt, cheap);
 *                success closes the breaker, failure re-opens it with a longer cooldown.
 *
 * Cooldown: 60s, doubling on each failed probe up to 5 min.
 */

import { logger } from '../utils/logger.js';

const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
const PARTIAL_COOLDOWN_MS = 30_000;   // some accounts were never tried -> short pause, then probe fresh accounts
const MIN_DISTINCT_FOR_FULL_TRIP = 3; // never declare a model dead from fewer than 3 distinct accounts

/** @type {Map<string, {openUntil:number, cooldown:number, probing:boolean, trips:number}>} */
const states = new Map();
/** model -> timestamp of the last request this model actually served (any session). */
const lastSuccessAt = new Map();
const RECENT_SUCCESS_MS = 120_000;
/** Requests currently acting as the half-open probe (inner handler limits them to 1 attempt). */
const probeRequests = new WeakSet();
/** request object -> Set of account emails attempted for it (so a trip reflects what was really tried). */
const triedAccounts = new WeakMap();

export const PROBE_ATTEMPTS = 3;

export function noteAttempt(request, email) {
    if (!request || typeof request !== 'object' || !email) return;
    let set = triedAccounts.get(request);
    if (!set) { set = new Set(); triedAccounts.set(request, set); }
    set.add(email);
}

export function getTriedAccounts(request) {
    return (request && typeof request === 'object' && triedAccounts.get(request)) || new Set();
}

const EXHAUSTION_RE = /max(imum)? retries exceeded|all accounts rate-limited|no accounts available/i;

export function isExhaustionError(error) {
    return EXHAUSTION_RE.test(String(error?.message || error || ''));
}

/**
 * @param {string} model
 * @returns {{state:'closed'|'open'|'probe', retryInMs:number}}
 */
export function checkBreaker(model) {
    const s = states.get(model);
    if (!s) return { state: 'closed', retryInMs: 0 };
    const now = Date.now();
    if (now < s.openUntil) return { state: 'open', retryInMs: s.openUntil - now };
    if (s.probing) return { state: 'open', retryInMs: 5_000 }; // another request is already probing
    s.probing = true;
    return { state: 'probe', retryInMs: 0 };
}

/** Non-mutating check (does NOT claim the half-open probe slot). True while cooling down or a probe is running. */
export function isBreakerOpen(model) {
    const s = states.get(model);
    if (!s) return false;
    return Date.now() < s.openUntil || s.probing;
}

export function markProbeRequest(request) {
    if (request && typeof request === 'object') probeRequests.add(request);
}

export function isProbeRequest(request) {
    return !!request && typeof request === 'object' && probeRequests.has(request);
}

/**
 * @param {string} model
 * @param {{triedCount?: number, untriedAvailable?: number}} [info] - What the failed request actually covered.
 *   A FULL trip (escalating cooldown) needs >= 3 distinct accounts tried and none left untried; otherwise a short
 *   PARTIAL trip (30s, no escalation) so the next probe sweeps accounts that were never tried.
 */
export function markExhausted(model, { triedCount = Infinity, untriedAvailable = 0 } = {}) {
    // If this model served ANY request recently, the failure is specific to the failing request/session
    // (e.g. one huge conversation) and must not shut the model down for everybody else.
    const sinceOk = Date.now() - (lastSuccessAt.get(model) || 0);
    if (sinceOk < RECENT_SUCCESS_MS) {
        logger.warn(`[Breaker] ⚖️ ${model} failed on ${triedCount} account(s) but served a request ${Math.round(sinceOk / 1000)}s ago -> failure looks request-specific, NOT opening the breaker`);
        return;
    }
    const prev = states.get(model);
    const full = triedCount >= MIN_DISTINCT_FOR_FULL_TRIP && untriedAvailable === 0;
    const cooldown = full
        ? (prev && !prev.partial ? Math.min((prev.cooldown || BASE_COOLDOWN_MS) * 2, MAX_COOLDOWN_MS) : BASE_COOLDOWN_MS)
        : PARTIAL_COOLDOWN_MS;
    states.set(model, { openUntil: Date.now() + cooldown, cooldown, probing: false, partial: !full, trips: (prev?.trips || 0) + 1 });
    logger.warn(`[Breaker] 🔌 ${model} ${full ? 'exhausted on all usable accounts' : `failed on ${triedCount} account(s), ${untriedAvailable} untried left (partial)`} -> failing fast to last-resort chain for ${Math.round(cooldown / 1000)}s`);
}

export function markHealthy(model) {
    lastSuccessAt.set(model, Date.now());
    if (states.delete(model)) {
        logger.info(`[Breaker] ✅ ${model} recovered -> circuit closed`);
    }
}

export function getBreakerStates() {
    const now = Date.now();
    return Object.fromEntries([...states].map(([m, s]) => [m, {
        open: now < s.openUntil, retryInMs: Math.max(0, s.openUntil - now), cooldownMs: s.cooldown, trips: s.trips, probing: s.probing
    }]));
}

/** Test helper */
export function _resetBreaker() { states.clear(); lastSuccessAt.clear(); }

export class CircuitOpenError extends Error {
    constructor(model, retryInMs) {
        super(`Max retries exceeded (circuit open: all accounts exhausted for ${model}; probing again in ${Math.ceil(retryInMs / 1000)}s)`);
        this.name = 'CircuitOpenError';
        this.model = model;
        this.retryInMs = retryInMs;
    }
}
