/**
 * Dynamic Upstream Provider Router
 *
 * Matches incoming model requests against declaratively configured upstream providers.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sanitizeForCopilot } from './copilot-fallback.js';
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
 * Determine if an incoming request originated from a subagent
 * @param {Object} req Express request object
 * @returns {boolean}
 */
export function isSubagentRequest(req) {
    if (!req) return false;

    // 0. Explicit main session guard
    const querySource = req.body?.querySource;
    if (typeof querySource === 'string' && (querySource.startsWith('repl_main_thread') || querySource === 'main')) {
        return false;
    }

    // 1. Direct querySource check in request body (subagents start with "agent:")
    if (typeof querySource === 'string' && querySource.startsWith('agent:')) {
        return true;
    }

    // 2. Billing / attribution header check (where Claude Code sets cc_is_subagent=true)
    const billingHeader = req.headers?.['x-anthropic-billing-header'] || '';
    if (billingHeader.includes('cc_is_subagent=true')) {
        return true;
    }

    // 3. Precise system prompt markers (tags injected strictly for subagents/sidechains)
    const system = req.body?.system;
    if (system) {
        const sysStr = typeof system === 'string' ? system : JSON.stringify(system);
        if (
            sysStr.includes('cc_is_subagent=true') ||
            sysStr.includes('<observed_from_primary_session>')
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Get configured subagent upstream if enabled
 * @returns {{ name: string, config: Object, overrideModel?: string } | null}
 */
export function getSubagentUpstream() {
    const subagentConfig = config.subagentRouting;
    if (!subagentConfig || subagentConfig.enabled === false) {
        return null;
    }

    // If an upstream name is referenced
    if (subagentConfig.upstream && config.upstreams?.[subagentConfig.upstream]) {
        const upstream = config.upstreams[subagentConfig.upstream];
        if (upstream.enabled !== false) {
            return {
                name: subagentConfig.upstream,
                config: upstream,
                overrideModel: subagentConfig.model || undefined
            };
        }
    }

    // If configured inline with baseUrl and apiKey
    if (subagentConfig.baseUrl) {
        return {
            name: 'subagent-router',
            config: {
                type: 'anthropic-pass-through',
                baseUrl: subagentConfig.baseUrl,
                apiKey: subagentConfig.apiKey || '',
                enabled: true
            },
            overrideModel: subagentConfig.model || undefined
        };
    }

    return null;
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
    if (upstream.config.sanitizeForCopilot) request = sanitizeForCopilot(request, upstream.config.targetModel || request.model);
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
    if (upstream.config.sanitizeForCopilot) request = sanitizeForCopilot(request, upstream.config.targetModel || request.model);
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
