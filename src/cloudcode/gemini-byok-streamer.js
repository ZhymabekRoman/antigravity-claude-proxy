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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Map Anthropic / CloudCode model names to Google AI Studio standard model names
 * @param {string} model 
 * @returns {string} Clean Google AI Studio model name
 */
export function mapToGeminiStudioModel(model) {
    if (!model) return 'gemini-3.7-flash';
    const m = model.toLowerCase();
    // Direct 3.7 mapping
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
export async function* streamGeminiByok(anthropicRequest, byokAccount) {
    const originalModel = anthropicRequest.model;
    const studioModel = mapToGeminiStudioModel(originalModel);
    const googlePayload = convertAnthropicToGoogle(anthropicRequest, true);
    const apiKey = byokAccount.apiKey || byokAccount.byokApiKey;

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
    logger.info(`[Gemini-BYOK] 🔑 Executing streaming request model=${studioModel} via Google AI Studio Key`);

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

    yield* streamSSEResponse(response, originalModel, onThoughtOnly);
}

/**
 * Send non-streaming message to Google AI Studio with BYOK API key
 * @param {Object} anthropicRequest - Anthropic format request
 * @param {Object} byokAccount - Account with apiKey and settings
 * @returns {Promise<Object>} Anthropic format response
 */
export async function sendGeminiByokMessage(anthropicRequest, byokAccount) {
    const originalModel = anthropicRequest.model;
    const studioModel = mapToGeminiStudioModel(originalModel);
    const googlePayload = convertAnthropicToGoogle(anthropicRequest, true);
    const apiKey = byokAccount.apiKey || byokAccount.byokApiKey;

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
    logger.info(`[Gemini-BYOK] 🔑 Executing non-streaming request model=${studioModel} via Google AI Studio Key`);

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
        throw new Error(`Gemini-BYOK Error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    return await parseThinkingSSEResponse(response, originalModel);
}
