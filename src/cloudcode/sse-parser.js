/**
 * SSE Parser for Cloud Code
 *
 * Parses SSE responses for non-streaming thinking models.
 * Accumulates all parts and returns a single response.
 */

import { convertGoogleToAnthropic } from '../format/index.js';
import { ContentFilterError, EmptyResponseError } from '../errors.js';
import { SOFT_REFUSAL_TEXT_RE } from './sse-streamer.js';
import { logger } from '../utils/logger.js';

/**
 * Parse SSE response for thinking models and accumulate all parts
 *
 * @param {Response} response - The HTTP response with SSE body
 * @param {string} originalModel - The original model name
 * @returns {Promise<Object>} Anthropic-format response object
 */
export async function parseThinkingSSEResponse(response, originalModel, onThoughtOnly = null) {
    let accumulatedThinkingText = '';
    let accumulatedThinkingSignature = '';
    let accumulatedText = '';
    const finalParts = [];
    let usageMetadata = {};
    let finishReason = 'STOP';

    const flushThinking = () => {
        if (accumulatedThinkingText) {
            finalParts.push({
                thought: true,
                text: accumulatedThinkingText,
                thoughtSignature: accumulatedThinkingSignature
            });
            accumulatedThinkingText = '';
            accumulatedThinkingSignature = '';
        }
    };

    const flushText = () => {
        if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
            accumulatedText = '';
        }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                if (innerResponse.usageMetadata) {
                    usageMetadata = innerResponse.usageMetadata;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const blockReason = innerResponse.promptFeedback?.blockReason;
                const FILTER_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII', 'OTHER', 'IMAGE_SAFETY']);
                if (blockReason || (firstCandidate.finishReason && FILTER_REASONS.has(firstCandidate.finishReason) && finalParts.every(p => p.thought))) {
                    const reason = blockReason || firstCandidate.finishReason;
                    logger.warn(`[CloudCode] 🛡️ Content filter triggered (${reason}) in non-streaming SSE on model ${originalModel}`);
                    throw new ContentFilterError(`Content filter triggered: ${reason}`, reason);
                }
                if (firstCandidate.finishReason) {
                    finishReason = firstCandidate.finishReason;
                }

                const parts = firstCandidate.content?.parts || [];
                for (const part of parts) {
                    if (part.thought === true) {
                        flushText();
                        accumulatedThinkingText += (part.text || '');
                        if (part.thoughtSignature) {
                            accumulatedThinkingSignature = part.thoughtSignature;
                        }
                    } else if (part.functionCall) {
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    } else if (part.text !== undefined) {
                        if (!part.text) continue;
                        flushThinking();
                        accumulatedText += part.text;
                    } else if (part.inlineData) {
                        // Handle image content
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    }
                }
            } catch (e) {
                if (e instanceof ContentFilterError || e?.name === 'ContentFilterError') {
                    throw e;
                }
                logger.debug('[CloudCode] SSE parse warning:', e.message, 'Raw:', jsonText.slice(0, 100));
            }
        }
    }

    flushThinking();
    flushText();

    // Detect soft-refusal banner returned as normal text on Hydrogen
    if (typeof originalModel === 'string' && /gemini|hydrogen|argon/i.test(originalModel)) {
        const visibleText = finalParts.filter(p => !p.thought && p.text).map(p => p.text).join('');
        if (SOFT_REFUSAL_TEXT_RE.test(visibleText)) {
            logger.warn(`[CloudCode] 🛡️ Soft content filter refusal detected in non-streaming SSE on model ${originalModel}`);
            throw new ContentFilterError('Content filter soft refusal in response text', 'SOFT_REFUSAL');
        }
    }

    // AUTO-RETRY CONTINUATION: If model emitted only thinking and no text/tools
    const hasTextOrTool = finalParts.some(p => !p.thought);
    if (!hasTextOrTool && onThoughtOnly) {
        logger.info('[CloudCode] 🔄 Non-streaming thought-only response detected. Invoking auto-retry continuation...');
        try {
            const contParts = await onThoughtOnly({
                accumulatedThinkingText: finalParts.map(p => p.text || '').join('')
            });
            if (contParts && contParts.length > 0) {
                finalParts.push(...contParts);
            }
        } catch (e) {
            logger.warn('[CloudCode] Non-streaming continuation error:', e.message);
        }
    }

    // Fallback if still empty
    if (!finalParts.some(p => !p.thought)) {
        finalParts.push({ text: 'Thinking complete.' });
    }

    const accumulatedResponse = {
        candidates: [{ content: { parts: finalParts }, finishReason }],
        usageMetadata
    };

    const partTypes = finalParts.map(p => p.thought ? 'thought' : (p.functionCall ? 'functionCall' : (p.inlineData ? 'inlineData' : 'text')));
    logger.debug('[CloudCode] Response received (SSE), part types:', partTypes);
    if (finalParts.some(p => p.thought)) {
        const thinkingPart = finalParts.find(p => p.thought);
        logger.debug('[CloudCode] Thinking signature length:', thinkingPart?.thoughtSignature?.length || 0);
    }

    return convertGoogleToAnthropic(accumulatedResponse, originalModel);
}
