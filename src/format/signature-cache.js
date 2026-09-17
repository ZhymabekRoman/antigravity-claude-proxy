/**
 * Signature Cache
 * In-memory cache for Gemini thoughtSignatures
 *
 * Gemini models require thoughtSignature on tool calls, but Claude Code
 * strips non-standard fields. This cache stores signatures by tool_use_id
 * so they can be restored in subsequent requests.
 *
 * Also caches thinking block signatures with model family for cross-model
 * compatibility checking.
 */

import { GEMINI_SIGNATURE_CACHE_TTL_MS, MIN_SIGNATURE_LENGTH, GEMINI_SKIP_SIGNATURE } from '../constants.js';

export { GEMINI_SKIP_SIGNATURE };

const signatureCache = new Map();
const thinkingSignatureCache = new Map();

/**
 * Store a signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @param {string} signature - The thoughtSignature to cache
 */
export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    signatureCache.set(toolUseId, {
        signature,
        timestamp: Date.now()
    });
}

/**
 * Get a cached signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @returns {string|null} The cached signature or null if not found/expired
 */
export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    const entry = signatureCache.get(toolUseId);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
        signatureCache.delete(toolUseId);
        return null;
    }

    return entry.signature;
}

/**
 * Cache a thinking block signature with its model family
 * @param {string} signature - The thinking signature to cache
 * @param {string} modelFamily - The model family ('claude' or 'gemini')
 */
export function cacheThinkingSignature(signature, modelFamily) {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    thinkingSignatureCache.set(signature, {
        modelFamily,
        timestamp: Date.now()
    });
}

/**
 * Get the cached model family for a thinking signature
 * @param {string} signature - The signature to look up
 * @returns {string|null} 'claude', 'gemini', or null if not found/expired
 */
export function getCachedSignatureFamily(signature) {
    if (!signature) return null;

    // Check prefix fast-path first (stateless across restarts)
    if (isGeminiThoughtSignature(signature)) return 'gemini';
    if (isClaudeThoughtSignature(signature)) return 'claude';

    const entry = thinkingSignatureCache.get(signature);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
        thinkingSignatureCache.delete(signature);
        return null;
    }

    return entry.modelFamily;
}

/**
 * Check if a signature is a genuine Gemini-generated cryptographic signature.
 * Gemini Base64 HMAC signatures start with AY89a1 or AY89a/ (Protobuf binary tag 0x01 0x8F 0x3D 0x6B)
 * or Protobuf field tag 0x12 (Base64 starts with E... like Er, Eu, Et, Ep, Eq, Ev, Eo, Es)
 * with minimum length >= MIN_SIGNATURE_LENGTH.
 * @param {string} signature
 * @returns {boolean}
 */
export function isGeminiThoughtSignature(signature) {
    if (!signature || typeof signature !== 'string') return false;
    if (signature.startsWith('skip_thought_signature')) return false;
    if (signature.startsWith('AY89a1') || signature.startsWith('AY89a/')) return true;
    // CloudCode / Vertex AI protobuf binary signatures (tag 0x12, length >= 50)
    if (signature.length >= MIN_SIGNATURE_LENGTH && /^[A-Za-z0-9+/=]+$/.test(signature)) {
        return true;
    }
    return false;
}

/**
 * Check if a signature is an Anthropic Claude cryptographic signature.
 * Anthropic Base64 signatures begin with Et4..., EvQ..., Ev8..., or EmI... (Protobuf tag 0x12)
 * @param {string} signature
 * @returns {boolean}
 */
export function isClaudeThoughtSignature(signature) {
    if (!signature || typeof signature !== 'string') return false;
    return /^(Et4|EvQ|Ev8|EmI)/.test(signature);
}

/**
 * Resolve a valid thought signature for a Gemini model.
 * If the signature is a genuine Gemini signature, preserves it.
 * Otherwise (missing, Claude-generated, synthetic, or cold-cache unknown), returns GEMINI_SKIP_SIGNATURE.
 *
 * @param {string|null|undefined} signature - The raw signature from client or cache
 * @returns {string} Safe signature for Gemini on Vertex AI and Cloud Code
 */
export function resolveGeminiThoughtSignature(signature) {
    if (!signature || signature === GEMINI_SKIP_SIGNATURE) {
        return GEMINI_SKIP_SIGNATURE;
    }
    if (isGeminiThoughtSignature(signature) || getCachedSignatureFamily(signature) === 'gemini') {
        return signature;
    }
    return GEMINI_SKIP_SIGNATURE;
}

/**
 * Clear all entries from the thinking signature cache.
 * Used for testing cold cache scenarios.
 */
export function clearThinkingSignatureCache() {
    thinkingSignatureCache.clear();
}

