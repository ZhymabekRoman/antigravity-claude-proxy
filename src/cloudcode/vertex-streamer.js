/**
 * Vertex AI Streamer
 *
 * Calls the Vertex AI REST endpoint directly using the account's OAuth token
 * and GCP project ID. This is the same API that Antigravity Business uses
 * (aiplatform.googleapis.com) — bypassing Cloud Code's wrapper entirely.
 *
 * Endpoint:
 *   POST https://aiplatform.googleapis.com/v1/projects/{gcpProject}/locations/global
 *        /publishers/google/models/{model}:streamGenerateContent?alt=sse
 *
 * Benefits over Cloud Code:
 *   - No Cloud Code wrapper overhead / JSON re-wrapping
 *   - Direct SSE stream, same format as BYOK but with OAuth
 *   - Model IDs are plain (gemini-3.7-flash) — no "-tiered" suffix needed
 *   - Potentially lower latency on short contexts (no project lookup indirection)
 *
 * The response SSE format is identical to Google AI Studio, so we reuse
 * the existing streamSSEResponse / parseGoogleContinuationStream parsers.
 */

import { convertAnthropicToGoogle, sanitizeThoughtSignatures } from '../format/index.js';
import { streamSSEResponse, parseGoogleContinuationStream } from './sse-streamer.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { throttledFetch } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { deriveSessionId, sessionRouter, extractSessionKey } from './session-manager.js';
import { GEMINI_SKIP_SIGNATURE, isModelSplitEnabled, isReroute38To37, isVertexFlexMode } from '../constants.js';
import { recordByokSpend } from '../modules/byok-accounting.js';
import crypto from 'crypto';

/**
 * Execute a fetch to Vertex AI with automatic retry on 400 "Invalid thought signature".
 * If Vertex rejects signatures, all signatures are sanitized to GEMINI_SKIP_SIGNATURE and retried once.
 *
 * @param {string} url - Vertex AI endpoint URL
 * @param {Object} headers - Request headers
 * @param {Object} payload - Vertex AI request payload
 * @param {string} accountEmail - Account email for logging
 * @returns {Promise<{response: Response, ttfbMs: number}>}
 */
async function fetchWithSignatureRetry(url, headers, payload, accountEmail) {
    let bodyStr = JSON.stringify(payload);
    const tFetch = Date.now();
    let response = await throttledFetch(url, { method: 'POST', headers, body: bodyStr });
    let ttfbMs = Date.now() - tFetch;

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 400 && errorText.includes('thought signature')) {
            logger.warn(`[Vertex] ⚠️ "Invalid thought signature" received for ${accountEmail}. Retrying with sanitized skip signatures...`);
            const sanitizedPayload = sanitizeThoughtSignatures(payload);
            const tRetry = Date.now();
            response = await throttledFetch(url, { method: 'POST', headers, body: JSON.stringify(sanitizedPayload) });
            ttfbMs = Date.now() - tRetry;
            if (!response.ok) {
                const retryErrorText = await response.text().catch(() => '');
                logger.error(`[Vertex] Retry HTTP ${response.status} for ${accountEmail}: ${retryErrorText.slice(0, 300)}`);
                const err = new Error(`Vertex Error (${response.status}): ${retryErrorText.slice(0, 200)}`);
                err.status = response.status;
                err.body = retryErrorText;
                throw err;
            }
        } else if (response.status === 400 && errorText.includes('Flex API is not supported')) {
            logger.warn(`[Vertex] ⚠️ Flex API not supported for this model on ${accountEmail}. Retrying without flex headers...`);
            const retryHeaders = { ...headers };
            delete retryHeaders['X-Vertex-AI-LLM-Request-Type'];
            delete retryHeaders['X-Vertex-AI-LLM-Shared-Request-Type'];
            const tRetry = Date.now();
            response = await throttledFetch(url, { method: 'POST', headers: retryHeaders, body: bodyStr });
            ttfbMs = Date.now() - tRetry;
            if (!response.ok) {
                const retryErrorText = await response.text().catch(() => '');
                logger.error(`[Vertex] Retry HTTP ${response.status} for ${accountEmail}: ${retryErrorText.slice(0, 300)}`);
                const err = new Error(`Vertex Error (${response.status}): ${retryErrorText.slice(0, 200)}`);
                err.status = response.status;
                err.body = retryErrorText;
                throw err;
            }
        } else {
            logger.error(`[Vertex] HTTP ${response.status} for ${accountEmail}: ${errorText.slice(0, 300)}`);
            const err = new Error(`Vertex Error (${response.status}): ${errorText.slice(0, 200)}`);
            err.status = response.status;
            err.body = errorText;
            throw err;
        }
    }

    return { response, ttfbMs };
}

const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1';
const VERTEX_LOCATION = 'global';

/**
 * Map CloudCode / Anthropic model names to plain Vertex AI model IDs.
 * Vertex doesn't use the "-tiered" suffix — just the base model name.
 *
 * @param {string} model
 * @returns {string} Vertex-compatible model ID
 */
export function mapToVertexModel(model) {
    if (!model) return 'gemini-3.7-flash';
    const m = model.toLowerCase();

    // Strip tiered/high/medium/low suffixes
    if (m.includes('3.8-flash') || m.includes('3-8-flash')) return (!isModelSplitEnabled() && isReroute38To37()) ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
    if (m.includes('3.7-flash') || m.includes('3-7-flash')) return 'gemini-3.7-flash';
    if (m.includes('3.6-flash') || m.includes('3-6-flash')) return 'gemini-3.6-flash';
    if (m.includes('3.5-flash') || m.includes('3-5-flash')) return 'gemini-3.5-flash';
    if (m.includes('3.1-pro')   || m.includes('3-1-pro'))   return 'gemini-3.1-pro-preview';
    if (m.includes('3.1-flash') || m.includes('3-1-flash')) return 'gemini-3.1-flash';
    if (m.includes('2.5-pro')   || m.includes('2-5-pro'))   return 'gemini-2.5-pro';
    if (m.includes('2.5-flash') || m.includes('2-5-flash')) return 'gemini-2.5-flash';

    // Claude aliases — map to best coding model
    if (m.includes('claude') && m.includes('opus'))   return 'gemini-3.1-pro-preview';
    if (m.includes('claude'))                          return 'gemini-3.7-flash';

    // Already a plain gemini- ID
    if (m.startsWith('gemini-')) return model.replace(/-tiered$/, '').replace(/-(high|medium|low|extra-low)$/, '');

    return 'gemini-3.7-flash';
}

/**
 * Build the Vertex AI REST URL for a given project and model.
 *
 * @param {string} gcpProject - GCP project ID (e.g. "carmen01")
 * @param {string} vertexModel - Plain model ID (e.g. "gemini-3.7-flash")
 * @returns {string}
 */
export function buildVertexUrl(gcpProject, vertexModel) {
    return `${VERTEX_BASE}/projects/${gcpProject}/locations/${VERTEX_LOCATION}/publishers/google/models/${vertexModel}:streamGenerateContent?alt=sse`;
}

/**
 * Build headers for a Vertex AI REST request.
 *
 * @param {string} token - OAuth2 Bearer token
 * @param {string} accountEmail - For throttle key
 * @returns {Object}
 */
export function buildVertexHeaders(token, accountEmail) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; auth_method=gcp)',
        // Internal pacer key — stripped by throttledFetch before sending to Google
        'x-account-key': accountEmail,
    };

    if (isVertexFlexMode()) {
        headers['X-Vertex-AI-LLM-Request-Type'] = 'shared';
        headers['X-Vertex-AI-LLM-Shared-Request-Type'] = 'flex';
    }

    return headers;
}

/**
 * Build Vertex AI request payload from an Anthropic-format request.
 * The format is identical to Google AI Studio (no project/wrapper fields).
 *
 * @param {Object} anthropicRequest
 * @param {string} accountEmail - Used to derive stable sessionId
 * @returns {Object} Vertex AI request body
 */
export function buildVertexRequest(anthropicRequest, accountEmail) {
    // Pass isByok=true so convertAnthropicToGoogle skips Cloud Code wrapper logic
    const googleRequest = convertAnthropicToGoogle(anthropicRequest, true);

    // Attach a stable sessionId for TPU prompt cache affinity (same as Cloud Code path)
    googleRequest.sessionId = deriveSessionId(anthropicRequest, accountEmail);

    // Labels matching what Antigravity Business sends (informational only, not required)
    googleRequest.labels = {
        request_id: crypto.randomUUID(),
        used_claude: 'false',
        used_non_gemini_model: 'false',
    };

    return googleRequest;
}


/**
 * Stream a message via Vertex AI (Antigravity Business endpoint).
 *
 * @param {Object} anthropicRequest - Anthropic-format request
 * @param {string} token - OAuth2 Bearer token for the account
 * @param {string} gcpProject - GCP project ID
 * @param {Object|string} account - Account object or email
 * @param {Object} [accountManager] - AccountManager instance
 * @yields {Object} Anthropic SSE events
 */
export async function* streamVertex(anthropicRequest, token, gcpProject, account, accountManager = null) {
    const accountEmail = typeof account === 'string' ? account : account?.email;
    const accountObj   = typeof account === 'object' ? account : null;
    const originalModel = anthropicRequest.model;
    const vertexModel   = mapToVertexModel(originalModel);
    const url           = buildVertexUrl(gcpProject, vertexModel);
    const payload       = buildVertexRequest(anthropicRequest, accountEmail);
    const headers       = buildVertexHeaders(token, accountEmail);
    const bodyStr       = JSON.stringify(payload);

    logger.info(`[Vertex] 🚀 Dispatching stream → ${url.split('?')[0]} (account: ${accountEmail}, model: ${vertexModel})`);

    const { response, ttfbMs } = await fetchWithSignatureRetry(url, headers, payload, accountEmail);

    logger.info(`[PERF][Vertex] ⚡ TTFB=${ttfbMs}ms account=${accountEmail} model=${vertexModel}${ttfbMs > 3000 ? ' ⚠️ SLOW_TTFB' : ''}`);

    // Continuation handler for thought-only responses (same logic as BYOK)
    const onThoughtOnly = async ({ accumulatedThinkingText }) => {
        logger.info(`[Vertex] 🔄 Thought-only response (${accumulatedThinkingText?.length || 0} chars). Retrying with continuation...`);
        try {
            const contPayload = JSON.parse(bodyStr);
            if (contPayload.generationConfig?.thinkingConfig) {
                contPayload.generationConfig.thinkingConfig.thinkingBudget = 0;
            }
            const contents = contPayload.contents || [];
            if (contents.length > 0) {
                const lastContent = contents[contents.length - 1];
                if (lastContent?.role === 'user') {
                    lastContent.parts.push({
                        text: '\n\n[System Note: Based on your reasoning above, now proceed directly to executing the required tool call(s) or provide the final direct answer. Do not output more reasoning.]'
                    });
                }
            }
            const contRes = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(contPayload),
            });
            if (!contRes.ok) return null;
            return parseGoogleContinuationStream(contRes);
        } catch (err) {
            logger.warn(`[Vertex] Continuation error: ${err.message}`);
            return null;
        }
    };

    for await (const event of streamSSEResponse(response, originalModel, onThoughtOnly)) {
        if (event.type === 'message_delta' && event.usage) {
            if (accountObj) {
                recordByokSpend(accountObj, originalModel, event.usage, accountManager);
            }
            const sessionKey = extractSessionKey(anthropicRequest);
            sessionRouter.recordSessionUsage(sessionKey, event.usage);
        }
        yield event;
    }
}

/**
 * Send a non-streaming message via Vertex AI.
 *
 * @param {Object} anthropicRequest - Anthropic-format request
 * @param {string} token - OAuth2 Bearer token
 * @param {string} gcpProject - GCP project ID
 * @param {Object|string} account - Account object or email
 * @param {Object} [accountManager] - AccountManager instance
 * @returns {Promise<Object>} Anthropic-format response
 */
export async function sendVertexMessage(anthropicRequest, token, gcpProject, account, accountManager = null) {
    const accountEmail = typeof account === 'string' ? account : account?.email;
    const accountObj   = typeof account === 'object' ? account : null;
    const originalModel = anthropicRequest.model;
    const vertexModel   = mapToVertexModel(originalModel);
    const url           = buildVertexUrl(gcpProject, vertexModel);
    const payload       = buildVertexRequest(anthropicRequest, accountEmail);
    const headers       = buildVertexHeaders(token, accountEmail);

    logger.info(`[Vertex] 🚀 Dispatching non-stream → ${url.split('?')[0]} (account: ${accountEmail}, model: ${vertexModel})`);

    const { response } = await fetchWithSignatureRetry(url, headers, payload, accountEmail);

    const result = await parseThinkingSSEResponse(response, originalModel);
    if (result && result.usage && accountObj) {
        recordByokSpend(accountObj, originalModel, result.usage, accountManager);
    }
    return result;
}
