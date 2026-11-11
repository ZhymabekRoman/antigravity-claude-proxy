/**
 * GitHub Copilot Fallback (via local `copilot-api` server)
 *
 * When every Google/Antigravity account is exhausted (rate-limited, capacity, invalid, none
 * available) the request is re-dispatched to a local copilot-api instance, which exposes an
 * Anthropic-compatible /v1/messages endpoint. It reuses the generic anthropic-pass-through
 * adapter, exactly like the Strata / CheaperInference upstreams.
 *
 * Enabled by default (config.copilotFallback.enabled !== false, env COPILOT_FALLBACK=false to disable).
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
    streamAnthropicPassThrough,
    sendAnthropicPassThrough,
    cleanModelName
} from './adapters/anthropic-pass-through.js';

/** Hardcoded: every Copilot request (fallback, direct, always-mode) uses this model. */
export const COPILOT_MODEL = 'fusion-standard';

/** Errors that mean "Google side is unavailable" and a fallback makes sense. */
const FALLBACK_ERROR_PATTERNS = [
    /rate[- ]?limit/i,
    /all accounts/i,
    /no accounts available/i,
    /resource[_ ]exhausted/i,
    /quota/i,
    /capacity/i,
    /overloaded/i,
    /\b(429|500|502|503|504|529)\b/,
    /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i
];

/** Errors we must NOT mask: the request itself is bad / too large for any backend. */
const NO_FALLBACK_PATTERNS = [
    /prompt is too long/i,
    /invalid_request_error/i
];

/**
 * @returns {Object|null} Effective fallback settings or null when disabled
 */
export function getCopilotFallbackConfig() {
    const cfg = config.copilotFallback;
    if (!cfg || cfg.enabled === false) return null;
    if (!cfg.baseUrl) return null;
    return cfg;
}

/**
 * Should this error from the Google path trigger the Copilot fallback?
 * @param {Error} error
 * @returns {boolean}
 */
export function shouldFallbackToCopilot(error) {
    if (!getCopilotFallbackConfig()) return false;
    const msg = String(error?.message || error || '');
    if (NO_FALLBACK_PATTERNS.some(p => p.test(msg))) return false;
    return FALLBACK_ERROR_PATTERNS.some(p => p.test(msg));
}

/**
 * Copilot model for any requested model: hardcoded to fusion-standard for now.
 * @returns {string}
 */
export function mapToCopilotModel() {
    return COPILOT_MODEL;
}

/**
 * Flag: route EVERY request to Copilot, bypassing Google accounts entirely.
 * (config.copilotFallback.always or env COPILOT_ALWAYS=true)
 * @returns {boolean}
 */
export function isAlwaysCopilot() {
    const cfg = config.copilotFallback;
    return !!(cfg && cfg.always === true && cfg.baseUrl);
}

/**
 * Upstream descriptor for "always" mode (same shape as router.findUpstreamForModel result).
 */
export function getCopilotUpstream() {
    const cfg = config.copilotFallback;
    return {
        name: 'copilot-always',
        config: {
            type: 'anthropic-pass-through',
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey || 'test',
            targetModel: COPILOT_MODEL,
            sanitizeForCopilot: true,
            enabled: true
        }
    };
}

/** Rough prompt size estimate (chars / 3.5). Used only to avoid hopeless fallbacks. */
function estimatePromptTokens(request) {
    try {
        const chars = JSON.stringify({
            s: request.system, m: request.messages, t: request.tools
        }).length;
        return Math.ceil(chars / 3.5);
    } catch {
        return 0;
    }
}

/**
 * Copilot (Claude) cannot validate Gemini thinking signatures, and requires thinking blocks
 * to be consistent when `thinking` is on. Strip them from history and drop the thinking param.
 */
export function sanitizeForCopilot(request, targetModel) {
    const messages = (request.messages || []).map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const content = msg.content
            .filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking')
            .map(b => {
                if (b && b.thoughtSignature !== undefined) {
                    const { thoughtSignature, ...rest } = b;
                    return rest;
                }
                return b;
            });
        return { ...msg, content: content.length ? content : [{ type: 'text', text: '(no content)' }] };
    });
    const { thinking, ...rest } = request;
    return { ...rest, messages, model: targetModel };
}

/**
 * Whether a fallback is allowed for this request (enabled + fits Copilot's smaller window).
 * @param {Object} request
 * @returns {boolean}
 */
export function canFallbackToCopilot(request) {
    const cfg = getCopilotFallbackConfig();
    if (!cfg) return false;
    const est = estimatePromptTokens(request);
    const max = cfg.maxPromptTokens || 180000;
    if (est > max) {
        logger.warn(`[CopilotFallback] Skipping: estimated prompt ~${est} tokens exceeds Copilot limit ${max}`);
        return false;
    }
    return true;
}

function buildUpstreamConfig(targetModel) {
    const cfg = getCopilotFallbackConfig();
    return {
        type: 'anthropic-pass-through',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey || 'test',
        targetModel
    };
}

/**
 * Streaming fallback to Copilot.
 * @param {Object} request - Anthropic request (original)
 * @param {Error} cause - Error that triggered the fallback
 */
export async function* streamCopilotFallback(request, cause) {
    const targetModel = mapToCopilotModel(request.model);
    logger.warn(`[FALLBACK][COPILOT] 🔀 Google path failed (${String(cause?.message || cause).slice(0, 120)}); routing ${request.model} -> copilot:${targetModel}`);
    yield* streamAnthropicPassThrough(sanitizeForCopilot(request, targetModel), buildUpstreamConfig(targetModel));
}

/**
 * Non-streaming fallback to Copilot.
 */
export async function sendCopilotFallback(request, cause) {
    const targetModel = mapToCopilotModel(request.model);
    logger.warn(`[FALLBACK][COPILOT] 🔀 Google path failed (${String(cause?.message || cause).slice(0, 120)}); routing ${request.model} -> copilot:${targetModel}`);
    return await sendAnthropicPassThrough(sanitizeForCopilot(request, targetModel), buildUpstreamConfig(targetModel));
}
