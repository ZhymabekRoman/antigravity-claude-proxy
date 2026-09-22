/**
 * Dynamic Upstream Provider Router
 *
 * Matches incoming model requests against declaratively configured upstream providers.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
    streamAnthropicPassThrough,
    sendAnthropicPassThrough,
    cleanModelName
} from './adapters/anthropic-pass-through.js';

/**
 * Check if a model string matches a pattern (supports * wildcards)
 * @param {string} pattern - Glob pattern e.g. "glm-*", "qwen-*"
 * @param {string} model - Target model name
 * @returns {boolean}
 */
function matchPattern(pattern, model) {
    if (!pattern || !model) return false;
    if (pattern === '*' || pattern === model) return true;
    
    // Convert simple glob pattern to RegExp
    const regexPattern = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    try {
        return new RegExp(regexPattern, 'i').test(model);
    } catch {
        return false;
    }
}

/**
 * Find matching upstream provider for the given model
 * @param {string} rawModel - Model name requested by client
 * @returns {{ name: string, config: Object } | null} Matching upstream or null
 */
export function findUpstreamForModel(rawModel) {
    const upstreams = config.upstreams || {};
    const model = cleanModelName(rawModel).toLowerCase();

    for (const [name, upstream] of Object.entries(upstreams)) {
        if (!upstream || upstream.enabled === false) continue;
        const models = Array.isArray(upstream.models) ? upstream.models : [];

        for (const pattern of models) {
            if (matchPattern(pattern.toLowerCase(), model)) {
                return {
                    name,
                    config: upstream
                };
            }
        }
    }

    return null;
}

/**
 * Dispatch streaming request to custom upstream provider
 * @param {Object} request - Anthropic request body
 * @param {Object} upstream - Matched upstream descriptor
 * @yields {Object} SSE events
 */
export async function* streamCustomUpstream(request, upstream) {
    const type = upstream.config.type || 'anthropic-pass-through';

    switch (type) {
        case 'anthropic-pass-through':
        case 'anthropic-native':
        case 'anthropic':
            yield* streamAnthropicPassThrough(request, upstream.config);
            break;

        default:
            logger.warn(`[UpstreamRouter] Unknown upstream provider type "${type}" for ${upstream.name}, defaulting to pass-through`);
            yield* streamAnthropicPassThrough(request, upstream.config);
            break;
    }
}

/**
 * Dispatch non-streaming request to custom upstream provider
 * @param {Object} request - Anthropic request body
 * @param {Object} upstream - Matched upstream descriptor
 * @returns {Promise<Object>} Anthropic response body
 */
export async function sendCustomUpstream(request, upstream) {
    const type = upstream.config.type || 'anthropic-pass-through';

    switch (type) {
        case 'anthropic-pass-through':
        case 'anthropic-native':
        case 'anthropic':
            return await sendAnthropicPassThrough(request, upstream.config);

        default:
            logger.warn(`[UpstreamRouter] Unknown upstream provider type "${type}" for ${upstream.name}, defaulting to pass-through`);
            return await sendAnthropicPassThrough(request, upstream.config);
    }
}
