/**
 * Generic Anthropic Pass-Through Adapter
 *
 * Forwards native Anthropic Messages API requests directly to any
 * Anthropic-compatible upstream provider (CheaperInference, OpenRouter, self-hosted gateways).
 */

import { fetch as undiciFetch } from 'undici';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

/**
 * Clean model tag suffixes like [1m], [thinking], [200k]
 * @param {string} model 
 * @returns {string} Clean model identifier
 */
export function cleanModelName(model) {
    if (!model) return model;
    return model.replace(/\[.*?\]$/, '').trim();
}

/**
 * Build request payload for Anthropic-compatible upstream
 * @param {Object} anthropicRequest - Client request
 * @param {string} targetModel - Resolved model name
 * @returns {Object} Clean payload
 */
function buildUpstreamPayload(anthropicRequest, targetModel) {
    const payload = { ...anthropicRequest };
    payload.model = targetModel || cleanModelName(anthropicRequest.model);
    
    // Ensure max_tokens is present
    if (!payload.max_tokens) {
        payload.max_tokens = 4096;
    }

    // Strip synthetic DeferredToolPlaceholder sentinel and broken built-in WebSearch
    // so non-Anthropic pass-through backends (Strata / llama.cpp / OpenRouter) never expose them as callable tools.
    if (Array.isArray(payload.tools)) {
        payload.tools = payload.tools.filter(tool => {
            const name = tool.name || tool.function?.name || '';
            return name !== 'DeferredToolPlaceholder' && name !== 'WebSearch' && name !== 'web_search_builtin';
        });
    }

    return payload;
}

/**
 * Stream Anthropic Messages response from upstream provider
 *
 * @param {Object} anthropicRequest - The client's Anthropic request
 * @param {Object} upstreamConfig - Upstream provider config (baseUrl, apiKey, etc.)
 * @yields {Object} Anthropic SSE event objects
 */
export async function* streamAnthropicPassThrough(anthropicRequest, upstreamConfig) {
    const targetModel = upstreamConfig.targetModel || cleanModelName(anthropicRequest.model);
    const payload = buildUpstreamPayload(anthropicRequest, targetModel);
    payload.stream = true;

    const baseUrl = upstreamConfig.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;
    const apiKey = upstreamConfig.apiKey;

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'antigravity-proxy/1.110.0'
    };

    logger.info(`[Upstream][PassThrough] 🌐 Dispatching stream request -> ${url} (model: ${targetModel})`);

    const tStart = Date.now();
    const response = await undiciFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`[Upstream][PassThrough] ❌ Error HTTP ${response.status} from ${baseUrl}: ${errorText.slice(0, 300)}`);
        throw new Error(`Upstream API Error (${response.status}): ${errorText}`);
    }

    const scale = (typeof config?.tokenUsageScale === 'number' && config.tokenUsageScale > 0) ? config.tokenUsageScale : 1.0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText || jsonText === '[DONE]') continue;

            try {
                const event = JSON.parse(jsonText);
                eventCount++;

                // Apply token usage scaling if event carries usage
                if (event.usage && scale !== 1.0) {
                    if (event.usage.input_tokens != null) {
                        event.usage.input_tokens = Math.round(event.usage.input_tokens * scale);
                    }
                    if (event.usage.cache_read_input_tokens != null) {
                        event.usage.cache_read_input_tokens = Math.round(event.usage.cache_read_input_tokens * scale);
                    }
                    if (event.usage.output_tokens != null) {
                        event.usage.output_tokens = Math.round(event.usage.output_tokens * scale);
                    }
                }
                if (event.message?.usage && scale !== 1.0) {
                    if (event.message.usage.input_tokens != null) {
                        event.message.usage.input_tokens = Math.round(event.message.usage.input_tokens * scale);
                    }
                    if (event.message.usage.cache_read_input_tokens != null) {
                        event.message.usage.cache_read_input_tokens = Math.round(event.message.usage.cache_read_input_tokens * scale);
                    }
                }

                yield event;
            } catch (e) {
                // Ignore SSE non-JSON or partial comment lines
            }
        }
    }

    const totalDuration = Date.now() - tStart;
    logger.info(`[Upstream][PassThrough] ✅ Stream complete: ${eventCount} SSE events sent in ${totalDuration}ms for model ${targetModel}`);
}

/**
 * Non-streaming Anthropic Messages request to upstream provider
 *
 * @param {Object} anthropicRequest - The client's Anthropic request
 * @param {Object} upstreamConfig - Upstream provider config (baseUrl, apiKey, etc.)
 * @returns {Promise<Object>} Anthropic Messages response object
 */
export async function sendAnthropicPassThrough(anthropicRequest, upstreamConfig) {
    const targetModel = upstreamConfig.targetModel || cleanModelName(anthropicRequest.model);
    const payload = buildUpstreamPayload(anthropicRequest, targetModel);
    payload.stream = false;

    const baseUrl = upstreamConfig.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;
    const apiKey = upstreamConfig.apiKey;

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'antigravity-proxy/1.110.0'
    };

    logger.info(`[Upstream][PassThrough] 🌐 Dispatching non-streaming request -> ${url} (model: ${targetModel})`);

    const response = await undiciFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error(`[Upstream][PassThrough] ❌ Error HTTP ${response.status} from ${baseUrl}: ${errorText.slice(0, 300)}`);
        throw new Error(`Upstream API Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const scale = (typeof config?.tokenUsageScale === 'number' && config.tokenUsageScale > 0) ? config.tokenUsageScale : 1.0;

    if (data.usage && scale !== 1.0) {
        if (data.usage.input_tokens != null) data.usage.input_tokens = Math.round(data.usage.input_tokens * scale);
        if (data.usage.cache_read_input_tokens != null) data.usage.cache_read_input_tokens = Math.round(data.usage.cache_read_input_tokens * scale);
        if (data.usage.output_tokens != null) data.usage.output_tokens = Math.round(data.usage.output_tokens * scale);
    }

    return data;
}
