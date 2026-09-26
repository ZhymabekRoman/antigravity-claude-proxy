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
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Stream SSE response and yield Anthropic-format events
 *
 * @param {Response} response - The HTTP response with SSE body
 * @param {string} originalModel - The original model name
 * @param {Function} [onThoughtOnly] - Optional async callback to retrieve continuation stream when model emits 0 text/tools
 * @yields {Object} Anthropic-format SSE events
 */
export async function* streamSSEResponse(response, originalModel, onThoughtOnly = null, isSideQuestion = false) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let accumulatedThinkingText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let thoughtsTokens = 0;
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

                // Extract usage metadata (including cache tokens).
                // NOTE: Google only sends real numeric counts (promptTokenCount, candidatesTokenCount,
                // cachedContentTokenCount, thoughtsTokenCount) in the LAST SSE chunk. All earlier
                // chunks only carry { trafficType: "ON_DEMAND" } with no numeric counts.
                if (innerResponse.usageMetadata) {
                    const um = innerResponse.usageMetadata;
                    const scale = (typeof config?.tokenUsageScale === 'number' && config.tokenUsageScale > 0) ? config.tokenUsageScale : 0.95;
                    if (um.promptTokenCount != null)    inputTokens     = Math.round(um.promptTokenCount * scale);
                    if (um.cachedContentTokenCount != null) cacheReadTokens = Math.round(um.cachedContentTokenCount * scale);
                    // Bug 2 fix: candidatesTokenCount is visible output tokens only.
                    // thoughtsTokenCount are reasoning/thinking tokens — track separately and sum
                    // them into outputTokens so the reported count reflects total generation cost.
                    if (um.candidatesTokenCount != null) outputTokens   = Math.round(um.candidatesTokenCount * scale);
                    if (um.thoughtsTokenCount    != null) thoughtsTokens = Math.round(um.thoughtsTokenCount * scale);
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

                // Bug 1 fix: message_start must carry accurate input/cache token counts, but Google
                // only sends those in the last SSE chunk. Strategy: when we see the first chunk with
                // content parts, buffer all content events from that chunk, then yield message_start
                // (with whatever inputTokens/cacheReadTokens are known at this moment) followed
                // immediately by the buffered events. If usageMetadata arrived in the same chunk as
                // the first content parts (common pattern: last chunk has both), message_start will
                // have the real numbers. If it's an earlier chunk, it will have 0 — unavoidable
                // without full-stream buffering which would destroy streaming latency.
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;

                    // Collect all content events from this first-content chunk before yielding
                    // message_start, so we can emit them atomically right after.
                    const pendingEvents = [];

                    for (const part of parts) {
                        if (part.thought === true) {
                            const text = part.text || '';
                            const signature = part.thoughtSignature || '';

                            if (currentBlockType !== 'thinking') {
                                if (currentBlockType !== null) {
                                    pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                                    blockIndex++;
                                }
                                currentBlockType = 'thinking';
                                currentThinkingSignature = '';
                                pendingEvents.push({
                                    type: 'content_block_start',
                                    index: blockIndex,
                                    content_block: { type: 'thinking', thinking: '' }
                                });
                            }

                            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                                currentThinkingSignature = signature;
                                const modelFamily = getModelFamily(originalModel);
                                cacheThinkingSignature(signature, modelFamily);
                            }

                            if (text) {
                                accumulatedThinkingText += text;
                                pendingEvents.push({
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'thinking_delta', thinking: text }
                                });
                            } else if (signature && currentBlockType === 'thinking') {
                                pendingEvents.push({
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'thinking_delta', thinking: ' ' }
                                });
                            }

                        } else if (part.text !== undefined) {
                            if (part.text === '') continue;
                            hasEmittedTextOrTool = true;

                            if (currentBlockType !== 'text') {
                                if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                    pendingEvents.push({
                                        type: 'content_block_delta',
                                        index: blockIndex,
                                        delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                    });
                                    currentThinkingSignature = '';
                                }
                                if (currentBlockType !== null) {
                                    pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                                    blockIndex++;
                                }
                                currentBlockType = 'text';
                                pendingEvents.push({
                                    type: 'content_block_start',
                                    index: blockIndex,
                                    content_block: { type: 'text', text: '' }
                                });
                            }
                            pendingEvents.push({
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'text_delta', text: part.text }
                            });

                        } else if (part.functionCall) {
                            hasEmittedTextOrTool = true;

                            if (isSideQuestion) {
                                // Claude Code /btw strictly disallows tool_use blocks.
                                // If the model attempts a tool call during /btw, convert it to explanatory text
                                // so Claude Code does not abort with "(The model tried to call <tool> instead of answering directly)"
                                const target = part.functionCall.args?.file_path || part.functionCall.args?.command || '';
                                const noteText = `\n\n_[Note: Model attempted to consult \`${part.functionCall.name}\`${target ? ` (\`${target}\`)` : ''}, but side questions (/btw) run in direct-answer mode. Please ask in the main conversation if tool execution is needed.]_\n\n`;

                                if (currentBlockType !== 'text') {
                                    if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                        pendingEvents.push({
                                            type: 'content_block_delta',
                                            index: blockIndex,
                                            delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                        });
                                        currentThinkingSignature = '';
                                    }
                                    if (currentBlockType !== null) {
                                        pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                                        blockIndex++;
                                    }
                                    currentBlockType = 'text';
                                    pendingEvents.push({
                                        type: 'content_block_start',
                                        index: blockIndex,
                                        content_block: { type: 'text', text: '' }
                                    });
                                }
                                pendingEvents.push({
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: {
                                        type: 'text_delta',
                                        text: noteText
                                    }
                                });
                                continue;
                            }

                            const functionCallSignature = part.thoughtSignature || '';

                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                pendingEvents.push({
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                });
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                                blockIndex++;
                            }
                            currentBlockType = 'tool_use';
                            stopReason = 'tool_use';

                            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                            const toolUseBlock = {
                                type: 'tool_use',
                                id: toolId,
                                name: part.functionCall.name,
                                input: {}
                            };

                            if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                                toolUseBlock.thoughtSignature = functionCallSignature;
                                cacheSignature(toolId, functionCallSignature);
                            }

                            pendingEvents.push({
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: toolUseBlock
                            });

                            let toolArgs = part.functionCall.args || {};
                            if (part.functionCall.name === 'EnterPlanMode' || part.functionCall.name === 'ExitPlanMode') {
                                toolArgs = {};
                            }

                            pendingEvents.push({
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolArgs) }
                            });

                        } else if (part.inlineData) {
                            hasEmittedTextOrTool = true;
                            if (currentBlockType !== null) {
                                pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                                blockIndex++;
                            }
                            currentBlockType = 'image';
                            pendingEvents.push({
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
                            });
                            pendingEvents.push({ type: 'content_block_stop', index: blockIndex });
                            blockIndex++;
                            currentBlockType = null;
                        }
                    }

                    // Emit message_start with the freshest token counts seen so far.
                    // If usageMetadata arrived in this same chunk (last-chunk pattern), these are
                    // real numbers. Otherwise they will be 0 — unavoidable without full buffering.
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
                                input_tokens: Math.max(0, inputTokens - cacheReadTokens),
                                output_tokens: 0,
                                cache_read_input_tokens: cacheReadTokens,
                                cache_creation_input_tokens: 0
                            }
                        }
                    };

                    // Flush all buffered content events from this first-content chunk
                    for (const ev of pendingEvents) yield ev;

                    // Check finish reason for first-chunk finishReason
                    if (firstCandidate.finishReason) {
                        if (firstCandidate.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
                        else if (firstCandidate.finishReason === 'STOP') stopReason = 'end_turn';
                    }

                    continue; // all parts for this chunk already processed above
                }

                // Process each part for subsequent chunks (after message_start has already fired)
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

                        if (isSideQuestion) {
                            // Claude Code /btw strictly disallows tool_use blocks.
                            // If the model attempts a tool call during /btw, convert it to explanatory text
                            // so Claude Code does not abort with "(The model tried to call <tool> instead of answering directly)"
                            const target = part.functionCall.args?.file_path || part.functionCall.args?.command || '';
                            const noteText = `\n\n_[Note: Model attempted to consult \`${part.functionCall.name}\`${target ? ` (\`${target}\`)` : ''}, but side questions (/btw) run in direct-answer mode. Please ask in the main conversation if tool execution is needed.]_\n\n`;

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
                                delta: {
                                    type: 'text_delta',
                                    text: noteText
                                }
                            };
                            continue;
                        }

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

    // Emit message_delta with final accurate usage (always correct — reads from last SSE chunk).
    // input_tokens  = uncached portion (promptTokenCount - cachedContentTokenCount)
    // output_tokens = visible tokens + thinking tokens (candidatesTokenCount + thoughtsTokenCount)
    // cache_read_input_tokens = cached portion
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: {
            input_tokens: Math.max(0, inputTokens - cacheReadTokens),
            output_tokens: outputTokens + thoughtsTokens,
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
export async function* parseGoogleContinuationStream(response, isSideQuestion = false) {
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
                    const scale = (typeof config?.tokenUsageScale === 'number' && config.tokenUsageScale > 0) ? config.tokenUsageScale : 0.95;
                    outputTokens += Math.round(innerResponse.usageMetadata.candidatesTokenCount * scale);
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const parts = firstCandidate.content?.parts || [];

                for (const part of parts) {
                    if (part.functionCall) {
                        if (isSideQuestion) {
                            const target = part.functionCall.args?.file_path || part.functionCall.args?.command || '';
                            const noteText = `\n\n_[Note: Model attempted to consult \`${part.functionCall.name}\`${target ? ` (\`${target}\`)` : ''}, but side questions (/btw) run in direct-answer mode. Please ask in the main conversation if tool execution is needed.]_\n\n`;
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
                                delta: { type: 'text_delta', text: noteText }
                            };
                            continue;
                        }

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
