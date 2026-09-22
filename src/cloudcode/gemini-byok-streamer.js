/**
 * Gemini BYOK Streamer & Message Handler
 * 
 * Directly executes requests against Google AI Studio (generativelanguage.googleapis.com)
 * using a user-provided Gemini API Key (gemini-byok).
 */

import { convertAnthropicToGoogle } from '../format/index.js';
import { streamSSEResponse, parseGoogleContinuationStream } from './sse-streamer.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { throttledFetch } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { isReroute38To37 } from '../constants.js';
import { RateLimitError } from '../errors.js';
import { recordByokSpend } from '../modules/byok-accounting.js';
import { sessionRouter, extractSessionKey } from './session-manager.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Standard Google AI Studio Free Tier Quotas
 */
export const GEMINI_BYOK_LIMITS = {
    flash: {
        rpm: 15,
        rpd: 1500,
        tpm: 1000000
    },
    pro: {
        rpm: 2,
        rpd: 50,
        tpm: 32000
    }
};

/**
 * In-memory BYOK rate limit and usage tracking state
 * key: email/apiKey -> { requests: [], tokens: [], dailyCount: 0, lastUsed: null, today: string }
 */
const byokUsageMap = new Map();

/**
 * Get current date string in Pacific Time (Google AI Studio quota reset timezone: UTC-8)
 * @returns {string} YYYY-MM-DD
 */
function getPacificDateString() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

/**
 * Get or initialize BYOK usage stats for an account
 * @param {string} accountKey 
 * @returns {Object} Usage record
 */
export function getByokUsage(accountKey) {
    const today = getPacificDateString();
    let record = byokUsageMap.get(accountKey);
    if (!record) {
        record = {
            today,
            requests: [],      // timestamps within last 60s
            tokens: [],        // { timestamp, count } within last 60s
            dailyCount: 0,     // requests today (resets at midnight PT)
            lastUsed: null
        };
        byokUsageMap.set(accountKey, record);
    }

    // Daily reset check (midnight Pacific Time)
    if (record.today !== today) {
        record.today = today;
        record.dailyCount = 0;
    }

    // Prune timestamps older than 60s
    const now = Date.now();
    record.requests = record.requests.filter(ts => (now - ts) < 60000);
    if (record.tokens) {
        record.tokens = record.tokens.filter(item => (now - item.timestamp) < 60000);
    } else {
        record.tokens = [];
    }

    return record;
}

/**
 * Record a request for BYOK account
 * @param {string} accountKey 
 */
export function recordByokRequest(accountKey) {
    const record = getByokUsage(accountKey);
    const now = Date.now();
    record.requests.push(now);
    record.dailyCount += 1;
    record.lastUsed = now;
}

/**
 * Record token consumption for BYOK account
 * @param {string} accountKey 
 * @param {number} count 
 */
export function recordByokTokens(accountKey, count = 0) {
    if (!count || count <= 0) return;
    const record = getByokUsage(accountKey);
    const now = Date.now();
    record.tokens.push({ timestamp: now, count });
}

/**
 * Compute BYOK quota limits object for an account
 * @param {Object} account 
 * @param {string} modelId 
 * @returns {Object} Quota info
 */
export function getByokQuotaInfo(account, modelId = 'gemini-2.5-flash') {
    const accountKey = account.email || account.apiKey || 'byok';
    const usage = getByokUsage(accountKey);
    const isPro = modelId.includes('pro') || modelId.includes('opus');
    const limits = isPro ? GEMINI_BYOK_LIMITS.pro : GEMINI_BYOK_LIMITS.flash;

    const rpmUsed = usage.requests.length;
    const rpdUsed = usage.dailyCount;
    const tpmUsed = (usage.tokens || []).reduce((acc, item) => acc + item.count, 0);
    const remainingFraction = Math.max(0, Math.min(1, (limits.rpd - rpdUsed) / limits.rpd));

    // Check if account has an active rate limit lock
    const modelLimit = account.modelRateLimits?.[modelId];
    const isRateLimited = !!(modelLimit && modelLimit.isRateLimited && modelLimit.resetTime > Date.now());
    const resetTime = isRateLimited ? new Date(modelLimit.resetTime).toISOString() : null;

    return {
        tier: 'free',
        category: 'byok-free',
        remainingFraction,
        rpmUsed,
        rpmLimit: limits.rpm,
        rpdUsed,
        rpdLimit: limits.rpd,
        tpmUsed,
        tpmLimit: limits.tpm,
        isRateLimited,
        resetTime
    };
}

/**
 * Parse 429 retry delay from Google AI Studio error response
 * @param {string} errorText 
 * @returns {number} Milliseconds to back off
 */
function parseRetryDelayMs(errorText) {
    try {
        const parsed = JSON.parse(errorText);
        // Look for retryDelay in details
        if (parsed.error?.details) {
            for (const detail of parsed.error.details) {
                if (detail.retryDelay) {
                    const match = detail.retryDelay.match(/([0-9.]+)\s*s/i);
                    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
                }
            }
        }
    } catch {
        // Fallback regex scan
        const match = errorText.match(/retry\s+in\s+([0-9.]+)\s*s/i) || errorText.match(/retryDelay["']?\s*:\s*["']?([0-9.]+)s/i);
        if (match) {
            return Math.ceil(parseFloat(match[1]) * 1000);
        }
    }
    return 60000; // Default 60s for Free Tier RPM reset
}

/**
 * Map Anthropic / CloudCode model names to Google AI Studio standard model names
 * @param {string} model 
 * @returns {string} Clean Google AI Studio model name
 */
export function mapToGeminiStudioModel(model) {
    if (!model) return 'gemini-3.7-flash';
    const m = model.toLowerCase();
    // Direct 3.8 / 3.7 mapping
    if (m.includes('3.8-flash') || m.includes('3-8-flash')) return isReroute38To37() ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
    if (m.includes('3.7-flash') || m.includes('3-7-flash')) return 'gemini-3.7-flash';
    if (m.includes('3.7-pro') || m.includes('3-7-pro') || m.includes('3.1-pro')) return 'gemini-3.1-pro-preview';
    if (m.includes('3.6-flash') || m.includes('3-6-flash')) return 'gemini-3.6-flash';
    if (m.includes('3.5-flash') || m.includes('3-5-flash')) return 'gemini-3.5-flash';
    if (m.includes('2.5-pro') || m.includes('2-5-pro')) return 'gemini-2.5-pro';
    if (m.includes('2.5-flash') || m.includes('2-5-flash')) return 'gemini-2.5-flash';
    // Claude aliases mapped to best coding models
    if (m.includes('claude-3-7') || m.includes('claude-3.7') || m.includes('sonnet')) return 'gemini-3.7-flash';
    if (m.includes('opus')) return 'gemini-2.5-pro';
    if (m.startsWith('gemini-')) return model;
    return 'gemini-3.7-flash';
}

/**
 * Stream message from Google AI Studio with BYOK API key
 * @param {Object} anthropicRequest - Anthropic format request
 * @param {Object} byokAccount - Account with apiKey and settings
 * @yields {Object} Anthropic SSE events
 */
export async function* streamGeminiByok(anthropicRequest, byokAccount, accountManager = null) {
    const originalModel = anthropicRequest.model;
    const studioModel = mapToGeminiStudioModel(originalModel);
    const googlePayload = convertAnthropicToGoogle(anthropicRequest, true);
    const apiKey = byokAccount.apiKey || byokAccount.byokApiKey;
    const accountKey = byokAccount.email || apiKey;

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
    logger.info(`[Gemini-BYOK] 🔑 Executing streaming request model=${studioModel} via Google AI Studio Key`);

    recordByokRequest(accountKey);

    const response = await throttledFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(googlePayload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`[Gemini-BYOK] API Error HTTP ${response.status}: ${errorText.slice(0, 300)}`);
        
        if (response.status === 429) {
            const delayMs = parseRetryDelayMs(errorText);
            if (!byokAccount.modelRateLimits) byokAccount.modelRateLimits = {};
            byokAccount.modelRateLimits[originalModel] = {
                isRateLimited: true,
                resetTime: Date.now() + delayMs,
                actualResetMs: delayMs
            };
            logger.warn(`[Gemini-BYOK] ⏳ 429 Rate Limit encountered for ${byokAccount.email} (model: ${originalModel}). Locked for ${Math.round(delayMs / 1000)}s`);
            throw new RateLimitError(`Gemini-BYOK 429 Rate Limit: ${errorText.slice(0, 200)}`, delayMs, byokAccount.email);
        }

        throw new Error(`Gemini-BYOK Error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const onThoughtOnly = async ({ accumulatedThinkingText }) => {
        logger.info(`[Gemini-BYOK] 🔄 Thought-only response detected (${accumulatedThinkingText?.length || 0} chars). Auto-retrying with tool continuation...`);
        try {
            const contPayload = JSON.parse(JSON.stringify(googlePayload));
            if (contPayload.generationConfig?.thinkingConfig) {
                contPayload.generationConfig.thinkingConfig.thinkingBudget = 0;
            }
            const contents = contPayload.contents || [];
            if (contents.length > 0) {
                const lastContent = contents[contents.length - 1];
                if (lastContent && lastContent.role === 'user') {
                    lastContent.parts.push({
                        text: '\n\n[System Note: Based on your reasoning above, now proceed directly to executing the required tool call(s) or provide the final direct answer. Do not output more reasoning.]'
                    });
                }
            }
            const contRes = await throttledFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(contPayload)
            });
            if (!contRes.ok) return null;
            return parseGoogleContinuationStream(contRes);
        } catch (err) {
            logger.warn(`[Gemini-BYOK] Continuation execution error:`, err.message);
            return null;
        }
    };

    for await (const event of streamSSEResponse(response, originalModel, onThoughtOnly)) {
        if (event.type === 'message_delta' && event.usage) {
            const totalTokens = (event.usage.output_tokens || 0) + (event.usage.input_tokens || 0) + (event.usage.cache_read_input_tokens || 0);
            recordByokTokens(accountKey, totalTokens);
            recordByokSpend(byokAccount, originalModel, event.usage, accountManager);
            const sessionKey = extractSessionKey(anthropicRequest);
            sessionRouter.recordSessionUsage(sessionKey, event.usage);
        }
        yield event;
    }
}

/**
 * Send non-streaming message to Google AI Studio with BYOK API key
 * @param {Object} anthropicRequest - Anthropic format request
 * @param {Object} byokAccount - Account with apiKey and settings
 * @returns {Promise<Object>} Anthropic format response
 */
export async function sendGeminiByokMessage(anthropicRequest, byokAccount, accountManager = null) {
    const originalModel = anthropicRequest.model;
    const studioModel = mapToGeminiStudioModel(originalModel);
    const googlePayload = convertAnthropicToGoogle(anthropicRequest, true);
    const apiKey = byokAccount.apiKey || byokAccount.byokApiKey;
    const accountKey = byokAccount.email || apiKey;

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
    logger.info(`[Gemini-BYOK] 🔑 Executing non-streaming request model=${studioModel} via Google AI Studio Key`);

    recordByokRequest(accountKey);

    const response = await throttledFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(googlePayload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`[Gemini-BYOK] API Error HTTP ${response.status}: ${errorText.slice(0, 300)}`);

        if (response.status === 429) {
            const delayMs = parseRetryDelayMs(errorText);
            if (!byokAccount.modelRateLimits) byokAccount.modelRateLimits = {};
            byokAccount.modelRateLimits[originalModel] = {
                isRateLimited: true,
                resetTime: Date.now() + delayMs,
                actualResetMs: delayMs
            };
            logger.warn(`[Gemini-BYOK] ⏳ 429 Rate Limit encountered for ${byokAccount.email} (model: ${originalModel}). Locked for ${Math.round(delayMs / 1000)}s`);
            throw new RateLimitError(`Gemini-BYOK 429 Rate Limit: ${errorText.slice(0, 200)}`, delayMs, byokAccount.email);
        }

        throw new Error(`Gemini-BYOK Error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const result = await parseThinkingSSEResponse(response, originalModel);
    if (result?.usage) {
        const totalTokens = (result.usage.output_tokens || 0) + (result.usage.input_tokens || 0) + (result.usage.cache_read_input_tokens || 0);
        recordByokTokens(accountKey, totalTokens);
        recordByokSpend(byokAccount, originalModel, result.usage, accountManager);
    }
    return result;
}
