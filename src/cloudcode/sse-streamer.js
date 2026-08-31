/**
 * SSE Streamer for Cloud Code
 *
 * Streams SSE events in real-time, converting Google format to Anthropic format.
 * Handles thinking blocks, text blocks, and tool use blocks.
 */

import crypto from 'crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { EmptyResponseError } from '../errors.js';
import { cacheSignature, cacheThinkingSignature } from '../format/signature-cache.js';
import { logger } from '../utils/logger.js';

/**
 * Stream SSE response and yield Anthropic-format events
 *
 * @param {Response} response - The HTTP response with SSE body
 * @param {string} originalModel - The original model name
 * @param {Function} [onThoughtOnly] - Optional async callback to retrieve continuation stream when model emits 0 text/tools
 * @yields {Object} Anthropic-format SSE events
 */
export async function* streamSSEResponse(response, originalModel, onThoughtOnly = null) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let accumulatedThinkingText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let stopReason = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let hasEmittedTextOrTool = false;

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
                const googleEvent = JSON.parse(jsonText);
                const innerResponse = googleEvent.response || googleEvent;

                // Extract usage metadata (including cache tokens)
                if (innerResponse.usageMetadata) {
                    inputTokens = innerResponse.usageMetadata.promptTokenCount || 0;
                    outputTokens = innerResponse.usageMetadata.candidatesTokenCount || 0;
                    cacheReadTokens = innerResponse.usageMetadata.cachedContentTokenCount || 0;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};

                // Log server-side Google Search Grounding if active
                const grounding = firstCandidate.groundingMetadata || innerResponse.groundingMetadata;
                if (grounding?.webSearchQueries?.length > 0) {
                    logger.info(`[GoogleSearch] 🔍 Server-side web grounding active: ${grounding.webSearchQueries.join(', ')}`);
                }

                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                // Emit message_start on first data
                // Note: input_tokens = promptTokenCount - cachedContentTokenCount (Antigravity includes cached in total)
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: originalModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: {
                                input_tokens: inputTokens - cacheReadTokens,
                                output_tokens: 0,
                                cache_read_input_tokens: cacheReadTokens,
                                cache_creation_input_tokens: 0
                            }
                        }
                    };
                }

                // Process each part
                for (const part of parts) {
                    if (part.thought === true) {
                        // Handle thinking block
                        const text = part.text || '';
                        const signature = part.thoughtSignature || '';

                        if (currentBlockType !== 'thinking') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'thinking';
                            currentThinkingSignature = '';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            };
                        }

                        if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                            currentThinkingSignature = signature;
                            // Cache thinking signature with model family for cross-model compatibility
                            const modelFamily = getModelFamily(originalModel);
                            cacheThinkingSignature(signature, modelFamily);
                        }

                        if (text) {
                            accumulatedThinkingText += text;
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'thinking_delta', thinking: text }
                            };
                        } else if (signature && currentBlockType === 'thinking') {
                            // Instant Thinking Pulse: when Gemini emits silent reasoning tokens or signature
                            // with empty text, yield a pulse so Claude Code immediately displays the thinking state
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'thinking_delta', thinking: ' ' }
                            };
                        }

                    } else if (part.text !== undefined) {
                        // Skip empty text parts (but preserve whitespace-only chunks for proper spacing)
                        if (part.text === '') {
                            continue;
                        }

                        hasEmittedTextOrTool = true;

                        // Handle regular text
                        if (currentBlockType !== 'text') {
                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'text', text: '' }
                            };
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: part.text }
                        };

                    } else if (part.functionCall) {
                        hasEmittedTextOrTool = true;
                        // Handle tool use
                        // For Gemini 3+, capture thoughtSignature from the functionCall part
                        // The signature is a sibling to functionCall, not inside it
                        const functionCallSignature = part.thoughtSignature || '';

                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';

                        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

                        // For Gemini, include the thoughtSignature in the tool_use block
                        // so it can be sent back in subsequent requests
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: toolId,
                            name: part.functionCall.name,
                            input: {}
                        };

                        // Store the signature in the tool_use block for later retrieval
                        if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                            toolUseBlock.thoughtSignature = functionCallSignature;
                            // Cache for future requests (Claude Code may strip this field)
                            cacheSignature(toolId, functionCallSignature);
                        }

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: toolUseBlock
                        };

                        let toolArgs = part.functionCall.args || {};
                        if (part.functionCall.name === 'EnterPlanMode' || part.functionCall.name === 'ExitPlanMode') {
                            toolArgs = {};
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(toolArgs)
                            }
                        };
                    } else if (part.inlineData) {
                        hasEmittedTextOrTool = true;
                        // Handle image content from Google format
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'image';

                        // Emit image block as a complete block
                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: part.inlineData.mimeType || 'image/png',
                                    data: part.inlineData.data
                                }
                            }
                        };

                        yield { type: 'content_block_stop', index: blockIndex };
                        blockIndex++;
                        currentBlockType = null;
                    }
                }

                // Check finish reason
                if (firstCandidate.finishReason) {
                    if (firstCandidate.finishReason === 'MAX_TOKENS') {
                        stopReason = 'max_tokens';
                    } else if (firstCandidate.finishReason === 'STOP') {
                        stopReason = 'end_turn';
                    }
                }

            } catch (parseError) {
                logger.warn('[CloudCode] SSE parse error:', parseError.message);
            }
        }
    }

    // Handle no content received - throw error to trigger retry in streaming-handler
    if (!hasEmittedStart) {
        logger.warn('[CloudCode] No content parts received, throwing for retry');
        throw new EmptyResponseError('No content parts received from API');
    } else {
        // Close open thinking/text block
        if (currentBlockType !== null) {
            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                };
            }
            yield { type: 'content_block_stop', index: blockIndex };
            currentBlockType = null;
        }

        // AUTO-RETRY CONTINUATION: If model emitted ONLY thinking and NO text/tool_use,
        // invoke onThoughtOnly to seamlessly fetch and stream the actual tool calls/text!
        if (!hasEmittedTextOrTool && onThoughtOnly) {
            logger.info(`[CloudCode] 🔄 Thought-only response detected (${accumulatedThinkingText.length} chars). Invoking auto-retry continuation...`);
            try {
                const continuationStream = await onThoughtOnly({
                    accumulatedThinkingText,
                    accumulatedThinkingSignature: currentThinkingSignature
                });
                if (continuationStream) {
                    for await (const contEvent of continuationStream) {
                        if (contEvent.type === 'content_block_start') {
                            blockIndex++;
                            yield { ...contEvent, index: blockIndex };
                            hasEmittedTextOrTool = true;
                        } else if (contEvent.type === 'content_block_delta') {
                            yield { ...contEvent, index: blockIndex };
                            hasEmittedTextOrTool = true;
                        } else if (contEvent.type === 'content_block_stop') {
                            yield { ...contEvent, index: blockIndex };
                        } else if (contEvent.type === 'message_delta') {
                            if (contEvent.delta?.stop_reason) {
                                stopReason = contEvent.delta.stop_reason;
                            }
                            if (contEvent.usage?.output_tokens) {
                                outputTokens += contEvent.usage.output_tokens;
                            }
                        }
                    }
                }
            } catch (contErr) {
                logger.warn('[CloudCode] Auto-retry continuation error:', contErr.message);
            }
        }

        // RECOVERY FALLBACK: If continuation also yielded nothing,
        // yield a fallback text block so Claude Code does not crash on empty content.
        if (!hasEmittedTextOrTool) {
            blockIndex++;
            logger.info('[CloudCode] 💡 Model emitted reasoning without text, yielding completion text block');
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' }
            };
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: 'Thinking complete.' }
            };
            yield { type: 'content_block_stop', index: blockIndex };
        }
    }

    // Emit message_delta and message_stop
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: {
            input_tokens: Math.max(0, inputTokens - cacheReadTokens),
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0
        }
    };

    yield { type: 'message_stop' };
}

/**
 * Parse Google SSE continuation stream (where thinking is disabled) and yield Anthropic content events
 * @param {Response} response 
 * @yields {Object} Anthropic content events
 */
export async function* parseGoogleContinuationStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentBlockType = null;
    let stopReason = 'end_turn';
    let outputTokens = 0;

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
                const googleEvent = JSON.parse(jsonText);
                const innerResponse = googleEvent.response || googleEvent;
                if (innerResponse.usageMetadata?.candidatesTokenCount) {
                    outputTokens += innerResponse.usageMetadata.candidatesTokenCount;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const parts = firstCandidate.content?.parts || [];

                for (const part of parts) {
                    if (part.functionCall) {
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop' };
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';
                        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                        yield {
                            type: 'content_block_start',
                            content_block: {
                                type: 'tool_use',
                                id: toolId,
                                name: part.functionCall.name,
                                input: {}
                            }
                        };
                        const args = part.functionCall.args || {};
                        yield {
                            type: 'content_block_delta',
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(args)
                            }
                        };
                        yield { type: 'content_block_stop' };
                        currentBlockType = null;
                    } else if (part.text !== undefined && part.text !== '') {
                        if (currentBlockType !== 'text') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop' };
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                content_block: { type: 'text', text: '' }
                            };
                        }
                        yield {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: part.text }
                        };
                    }
                }

                if (firstCandidate.finishReason === 'STOP' && stopReason !== 'tool_use') {
                    stopReason = 'end_turn';
                }
            } catch (e) {
                // ignore parse warning
            }
        }
    }

    if (currentBlockType !== null) {
        yield { type: 'content_block_stop' };
    }

    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
    };
}
