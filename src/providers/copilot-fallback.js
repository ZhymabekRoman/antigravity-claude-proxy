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
import { telemetry } from '../modules/telemetry.js';
import { sessionRouter } from '../cloudcode/session-manager.js';
import { isClientAborted } from '../utils/client-signal.js';
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
    /max(imum)? retries exceeded/i,
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
export function isFallbackWorthyError(error) {
    const msg = String(error?.message || error || '');
    if (NO_FALLBACK_PATTERNS.some(p => p.test(msg))) return false;
    return FALLBACK_ERROR_PATTERNS.some(p => p.test(msg));
}

/**
 * Copilot health memory: after a hard failure (402 monthly quota, connection refused, ...) skip Copilot
 * for a while instead of paying a failed round-trip on every request.
 */
let copilotDownUntil = 0;
const COPILOT_DOWN_QUOTA_MS = 30 * 60_000;   // 402 / quota_exceeded: monthly quota, won't recover soon
const COPILOT_DOWN_OTHER_MS = 2 * 60_000;    // transient failure (fetch failed, 5xx)

export function isCopilotMarkedDown() {
    return Date.now() < copilotDownUntil;
}

export function markCopilotDown(err) {
    const msg = String(err?.message || err || '');
    // Only hard backend failures count; a 400 for one oversized/odd request must not take Copilot down.
    if (!/\b402\b|quota|fetch failed|ECONN|ETIMEDOUT|socket hang up|\b5\d\d\b/i.test(msg)) return;
    const quota = /\b402\b|quota_exceeded|exceeded your monthly quota/i.test(msg);
    const ms = quota ? COPILOT_DOWN_QUOTA_MS : COPILOT_DOWN_OTHER_MS;
    copilotDownUntil = Date.now() + ms;
    logger.warn(`[FALLBACK][COPILOT] 🔌 marked down for ${Math.round(ms / 60000)} min (${msg.slice(0, 80)})`);
}

export function markCopilotUp() {
    copilotDownUntil = 0;
}

/** Test helper */
export function _resetCopilotHealth() { copilotDownUntil = 0; }

export function shouldFallbackToCopilot(error) {
    if (!getCopilotFallbackConfig()) return false;
    if (isCopilotMarkedDown()) return false;
    return isFallbackWorthyError(error);
}

/**
 * Strata last-resort upstream (config.upstreams.strata, anthropic-pass-through).
 * Disable with config.strataFallback.enabled=false.
 * @returns {Object|null} upstream config or null
 */
export function getStrataFallbackConfig() {
    if (config.strataFallback?.enabled === false) return null;
    const up = config.upstreams?.strata;
    if (!up || up.enabled === false || !up.baseUrl) return null;
    return up;
}

/**
 * Is any last-resort backend currently usable at all (Strata enabled, or Copilot enabled and not marked down)?
 * When none is, failing fast (circuit open) only produces instant 500s, so the breaker must not short-circuit.
 */
export function hasAnyLastResort() {
    return !!getStrataFallbackConfig() || (!!getCopilotFallbackConfig() && !isCopilotMarkedDown());
}

/**
 * Is ANY last-resort backend (Copilot or Strata) usable for this Google-path error?
 */
export function hasLastResortFallback(request, error) {
    if (!isFallbackWorthyError(error)) return false;
    return (shouldFallbackToCopilot(error) && canFallbackToCopilot(request)) || !!getStrataFallbackConfig();
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
            retries: 2,
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
    // Claude Code may inject role:"system" entries inside `messages` (hook context, diagnostics).
    // That is not valid Anthropic and copilot-api turns it into a broken role order, so convert
    // them to user messages wrapped in <system-reminder> (merged with the adjacent user turn below).
    const rawMessages = (request.messages || []).map(msg => {
        if (msg.role !== 'system') return msg;
        const text = typeof msg.content === 'string'
            ? msg.content
            : (msg.content || []).map(b => (b && b.text) || '').join('\n');
        return { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] };
    });
    const messages = rawMessages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const content = msg.content
            .filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking' && !(b.type === 'text' && !String(b.text || '').trim()))
            .map(b => {
                if (b && b.thoughtSignature !== undefined) {
                    const { thoughtSignature, ...rest } = b;
                    return rest;
                }
                return b;
            });
        return { ...msg, content: content.length ? content : [{ type: 'text', text: '(no content)' }] };
    });
    // Merge consecutive same-role messages (stripping blocks can leave user/user or assistant/assistant).
    const toBlocks = c => typeof c === 'string' ? [{ type: 'text', text: c }] : c;
    const merged = [];
    for (const msg of messages) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role) {
            prev.content = [...toBlocks(prev.content), ...toBlocks(msg.content)];
        } else {
            merged.push({ ...msg });
        }
    }

    // Gemini/most backends reject a conversation whose LAST message is from the assistant
    // (Claude "prefill"). Append a neutral user turn so it ends with a user message.
    if (merged.length && merged[merged.length - 1].role === 'assistant') {
        merged.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    }

    const { thinking, ...rest } = request;
    return { ...rest, messages: merged, model: targetModel };
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
        targetModel,
        retries: 2
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


/**
 * If a last-resort backend rejected the request for exceeding its context window, convert that into
 * Anthropic's standard "prompt is too long: N tokens > M maximum" error so Claude Code auto-compacts
 * and retries (instead of dying on a generic 500). Reports >= limit+120k so compaction trims enough
 * history on the first attempt (see parseError in server.js).
 * @param {Error} err
 * @returns {Error|null}
 */
export function toPromptTooLongError(err) {
    const msg = String(err?.message || err || '');
    if (/prompt is too long:\s*\d+\s*tokens?\s*>\s*\d+/i.test(msg)) return err;   // already in Claude Code's format
    const m = msg.match(/exceeds the context window:\s*prompt \((\d+) tokens\).*?context \((\d+)\)/i);
    if (!m) return null;
    const actual = parseInt(m[1], 10);
    const limit = parseInt(m[2], 10);
    const reported = Math.max(actual, limit + 120000);
    const out = new Error(`prompt is too long: ${reported} tokens > ${limit} maximum`);
    out.name = 'PromptTooLongError';
    out.cause = err;
    return out;
}

/**
 * Strata protection. Strata is a single small backend that also serves the native strata-agent calls,
 * so fallback traffic from exhausted Google sessions must not flood it with huge prompts.
 *   - prompts above maxPromptTokens (default 150k) get Claude Code's compaction error instead
 *   - at most maxConcurrent (default 2) fallback requests at a time
 * Tune via config.strataFallback.maxPromptTokens / maxConcurrent.
 */
let strataFallbackInflight = 0;

function strataLimits() {
    return {
        maxPromptTokens: config.strataFallback?.maxPromptTokens ?? 150_000,
        maxConcurrent: config.strataFallback?.maxConcurrent ?? 2
    };
}

export function assertStrataFallbackAllowed(request) {
    const { maxPromptTokens, maxConcurrent } = strataLimits();
    const est = estimatePromptTokens(request);
    if (est > maxPromptTokens) {
        // Report >= limit + 120k so Claude Code's reactive compaction trims enough history on attempt 1
        const reported = Math.max(est, maxPromptTokens + 120000);
        throw new Error(`prompt is too long: ${reported} tokens > ${maxPromptTokens} maximum`);
    }
    if (strataFallbackInflight >= maxConcurrent) {
        throw new Error(`Strata busy (${strataFallbackInflight}/${maxConcurrent} fallback requests in flight)`);
    }
}

export function _strataInflight() { return strataFallbackInflight; }

/**
 * Last-resort chain (streaming): Copilot -> Strata. A backend is skipped/abandoned only if it fails
 * BEFORE yielding its first event (headers not yet sent); the original Google error is rethrown if all fail.
 * @param {Object} request - Anthropic request (original)
 * @param {Error} cause - Google-path error that triggered the fallback
 * @param {string|null} sessionKey - For telemetry
 */
export async function* streamLastResortChain(request, cause, sessionKey = null) {
    const reason = String(cause?.message || cause).slice(0, 80);
    const steps = [];
    if (shouldFallbackToCopilot(cause) && canFallbackToCopilot(request)) {
        steps.push({ name: 'copilot', toModel: 'copilot:fusion-standard', run: () => streamCopilotFallback(request, cause) });
    }
    const strata = getStrataFallbackConfig();
    if (strata) {
        const target = strata.targetModel || 'swift-1.5-iq3_s';
        steps.push({
            name: 'strata',
            toModel: `strata:${target}`,
            run: async function* () {
                assertStrataFallbackAllowed(request);
                logger.warn(`[FALLBACK][STRATA] 🔀 last resort (${reason}); routing ${request.model} -> strata:${target}`);
                strataFallbackInflight++;
                try {
                    yield* streamAnthropicPassThrough(sanitizeForCopilot(request, target), { ...strata, targetModel: target });
                } finally {
                    strataFallbackInflight--;
                }
            }
        });
    }

    let overflowErr = null;
    for (let i = 0; i < steps.length; i++) {
        if (isClientAborted(request)) return;
        const step = steps[i];
        let gen;
        let first;
        try {
            gen = step.run();
            first = await gen.next();
        } catch (err) {
            if (isClientAborted(request)) return;
            overflowErr = toPromptTooLongError(err) || overflowErr;
            if (step.name === 'copilot') markCopilotDown(err);
            logger.warn(`[FALLBACK][${step.name.toUpperCase()}] ❌ failed before first event: ${String(err?.message || err).slice(0, 160)}${i < steps.length - 1 ? ' -> trying next last-resort backend' : ''}`);
            continue;
        }
        if (step.name === 'copilot') markCopilotUp();
        sessionRouter.recordServedBy(sessionKey, step.name);
        telemetry.recordFallback({ type: `${step.name}_fallback`, reason, fromModel: request.model, toModel: step.toModel, sessionKey });
        if (!first.done) yield first.value;
        yield* gen;
        return;
    }
    if (overflowErr) {
        logger.warn(`[FALLBACK] 📏 All last-resort backends failed and prompt exceeds Strata's window -> returning auto-compact error: ${overflowErr.message}`);
        throw overflowErr;
    }
    throw cause;
}

/**
 * Last-resort chain (non-streaming): Copilot -> Strata.
 */
export async function sendLastResortChain(request, cause, sessionKey = null) {
    const reason = String(cause?.message || cause).slice(0, 80);
    if (shouldFallbackToCopilot(cause) && canFallbackToCopilot(request)) {
        try {
            const r = await sendCopilotFallback(request, cause);
            markCopilotUp();
            sessionRouter.recordServedBy(sessionKey, 'copilot');
            telemetry.recordFallback({ type: 'copilot_fallback', reason, fromModel: request.model, toModel: 'copilot:fusion-standard', sessionKey });
            return r;
        } catch (err) {
            markCopilotDown(err);
            logger.warn(`[FALLBACK][COPILOT] ❌ ${String(err?.message || err).slice(0, 160)} -> trying Strata`);
        }
    }
    const strata = getStrataFallbackConfig();
    if (strata) {
        const target = strata.targetModel || 'swift-1.5-iq3_s';
        logger.warn(`[FALLBACK][STRATA] 🔀 last resort (${reason}); routing ${request.model} -> strata:${target}`);
        try {
            assertStrataFallbackAllowed(request);
            strataFallbackInflight++;
            let r;
            try {
                r = await sendAnthropicPassThrough(sanitizeForCopilot(request, target), { ...strata, targetModel: target });
            } finally {
                strataFallbackInflight--;
            }
            sessionRouter.recordServedBy(sessionKey, 'strata');
            telemetry.recordFallback({ type: 'strata_fallback', reason, fromModel: request.model, toModel: `strata:${target}`, sessionKey });
            return r;
        } catch (err) {
            const overflow = toPromptTooLongError(err);
            if (overflow) {
                logger.warn(`[FALLBACK] 📏 Prompt exceeds Strata's window -> returning auto-compact error: ${overflow.message}`);
                throw overflow;
            }
            throw cause;
        }
    }
    throw cause;
}
