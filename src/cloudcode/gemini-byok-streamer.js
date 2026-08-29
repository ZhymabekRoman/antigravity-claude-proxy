/**
 * Gemini BYOK Streamer & Message Handler
 * 
 * Directly executes requests against Google AI Studio (generativelanguage.googleapis.com)
 * using a user-provided Gemini API Key (gemini-byok).
 */

import { convertAnthropicToGoogle } from '../format/index.js';
import { streamSSEResponse } from './sse-streamer.js';
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
    if (!model) return 'gemini-2.5-flash';
    const m = model.toLowerCase();
    if (m.includes('3.7-flash') || m.includes('3-7-flash')) return 'gemini-2.5-flash'; // Fallback mapping until 3.7 Studio availability
    if (m.includes('3.7-pro') || m.includes('3-7-pro')) return 'gemini-2.5-pro';
    if (m.includes('2.5-pro') || m.includes('2-5-pro')) return 'gemini-2.5-pro';
    if (m.includes('2.5-flash') || m.includes('2-5-flash')) return 'gemini-2.5-flash';
    if (m.includes('2.0-flash')) return 'gemini-2.0-flash';
    if (m.includes('1.5-pro')) return 'gemini-1.5-pro';
    if (m.includes('1.5-flash')) return 'gemini-1.5-flash';
    if (m.startsWith('gemini-')) return model;
    return 'gemini-2.5-flash';
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

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${byokAccount.apiKey}&alt=sse`;
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

    yield* streamSSEResponse(response, originalModel);
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

    const url = `${GEMINI_API_BASE}/${studioModel}:streamGenerateContent?key=${byokAccount.apiKey}&alt=sse`;
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
