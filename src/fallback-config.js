/**
 * Model Fallback Configuration
 *
 * Defines fallback mappings for when a model's quota is exhausted across all accounts.
 * Enables graceful degradation to alternative models with similar capabilities.
 */

import { MODEL_FALLBACK_MAP } from './constants.js';

// Re-export for convenience
export { MODEL_FALLBACK_MAP };

/**
 * Get fallback model for a given model ID
 * @param {string} model - Primary model ID
 * @returns {string|null} Fallback model ID or null if no fallback exists
 */
export function getFallbackModel(model) {
    return MODEL_FALLBACK_MAP[model] || 'gemini-4-hydrogen-high';
}

/**
 * Quota/exhaustion fallback walk (pool-aware, no Argon).
 * Hydrogen tiers are skipped (they likely share one pool); 3.8-flash has its own limits.
 */
export const QUOTA_FALLBACK_WALK = [
    { match: m => m.includes('hydrogen'),  next: ['gemini-3.8-flash-tiered'] },
    // 3.8-flash NEVER forwards to Hydrogen: Hydrogen -> 3.8 -> Hydrogen could ping-pong (e.g. a session pinned to
    // 3.8 by a Hydrogen safety filter would be sent straight back to the model that refused it).
    { match: m => m.includes('3.8-flash'), next: [] },
];

export function getQuotaFallbackCandidates(model) {
    const rule = QUOTA_FALLBACK_WALK.find(r => r.match(String(model || '').toLowerCase()));
    return rule ? rule.next.filter(m => m !== model) : null;
}

/**
 * Fallback model for quota/exhaustion cases.
 * Walk rule exists -> first candidate whose breaker is not open (or null when all are open).
 * No walk rule -> legacy single-hop map.
 * @param {string} model
 * @param {(m:string)=>boolean} [isOpen]
 */
export function getQuotaFallbackModel(model, isOpen = () => false) {
    const cands = getQuotaFallbackCandidates(model);
    if (cands) return cands.find(m => !isOpen(m)) || null;
    return getFallbackModel(model);
}

/**
 * Check if a model has a fallback configured
 * @param {string} model - Model ID to check
 * @returns {boolean} True if fallback exists
 */
export function hasFallback(model) {
    return model in MODEL_FALLBACK_MAP;
}
