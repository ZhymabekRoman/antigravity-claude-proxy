/**
 * Model Splitter with Smooth Weighted Round-Robin (SWRR)
 * 
 * Implements Nginx-style Smooth Weighted Round-Robin for model allocation
 * with session-level stickiness to maximize Google TPU KV prompt cache hits.
 */

import { isModelSplitEnabled, getModelSplitWeights, isReroute38To37 } from '../constants.js';
import { logger } from '../utils/logger.js';
import { sessionRouter } from './session-manager.js';

export const MODEL_37_FLASH = 'gemini-4-hydrogen-high';
export const MODEL_38_FLASH = 'gemini-4-hydrogen-high';
export const MODEL_HYDROGEN_LOW = 'gemini-4-hydrogen-low';
export const MODEL_HYDROGEN_MEDIUM = 'gemini-4-hydrogen-medium';
export const MODEL_HYDROGEN_HIGH = 'gemini-4-hydrogen-high';
export const MODEL_HYDROGEN_XHIGH = 'gemini-4-hydrogen-xhigh';

/**
 * Map a Gemini 4 Hydrogen model (or Flash alias) to its matching Gemini 3.8 Flash model
 * when content/safety filters are triggered.
 * @param {string} model
 * @returns {string}
 */
export function getFilterFallback38Model(model) {
    const m = (model || '').toLowerCase();
    if (m.endsWith('-low') || m === 'flash-low') return 'gemini-3.8-flash-low';
    if (m.endsWith('-medium') || m.endsWith('-med') || m === 'flash-med' || m === 'flash-medium') return 'gemini-3.8-flash-medium';
    return 'gemini-3.8-flash-high';
}
export function isFlashCandidate(model) {
    if (!model || typeof model !== 'string') return false;
    const m = model.toLowerCase();
    return (
        m.includes('3.8-flash') ||
        m.includes('3-8-flash') ||
        m.includes('3.7-flash') ||
        m.includes('3-7-flash') ||
        m.includes('hydrogen') ||
        m === 'flash' ||
        m === 'flash-low' ||
        m === 'flash-med' ||
        m === 'flash-medium' ||
        m === 'flash-high' ||
        m === 'gemini-flash'
    );
}

export class ModelSplitter {
    #currentWeights = {
        [MODEL_37_FLASH]: 0,
        [MODEL_38_FLASH]: 0
    };

    /**
     * Check if a model is a Flash candidate
     */
    isFlashCandidate(model) {
        return isFlashCandidate(model);
    }

    /**
     * Reset SWRR weights (primarily for testing/recalibration)
     */
    resetWeights() {
        this.#currentWeights = {
            [MODEL_37_FLASH]: 0,
            [MODEL_38_FLASH]: 0
        };
    }

    /**
     * Select the next model using Smooth Weighted Round-Robin (SWRR).
     * Guarantees smooth interleaving without clustering (e.g. 60/40 produces [3.7, 3.8, 3.7, 3.7, 3.8, ...]).
     *
     * @returns {string} Selected model ID (gemini-3.7-flash-tiered or gemini-3.8-flash-tiered)
     */
    selectNextModel() {
        const { w37, w38 } = getModelSplitWeights();
        const effectiveWeights = {
            [MODEL_37_FLASH]: Math.max(0, w37),
            [MODEL_38_FLASH]: Math.max(0, w38)
        };
        const totalWeight = effectiveWeights[MODEL_37_FLASH] + effectiveWeights[MODEL_38_FLASH];

        if (totalWeight <= 0) {
            return MODEL_37_FLASH;
        }

        // SWRR Step 1: Add effective weight to current weight for each candidate
        this.#currentWeights[MODEL_37_FLASH] = (this.#currentWeights[MODEL_37_FLASH] || 0) + effectiveWeights[MODEL_37_FLASH];
        this.#currentWeights[MODEL_38_FLASH] = (this.#currentWeights[MODEL_38_FLASH] || 0) + effectiveWeights[MODEL_38_FLASH];

        // SWRR Step 2: Pick candidate with highest current weight
        let bestModel = MODEL_37_FLASH;
        if (this.#currentWeights[MODEL_38_FLASH] > this.#currentWeights[MODEL_37_FLASH]) {
            bestModel = MODEL_38_FLASH;
        }

        // SWRR Step 3: Subtract total weight from the selected candidate's current weight
        this.#currentWeights[bestModel] -= totalWeight;

        logger.info(`[ModelSplitter] ⚖️ SWRR selected ${bestModel} (configured weights: 3.7=${w37}%, 3.8=${w38}%)`);
        return bestModel;
    }

    /**
     * Resolve the target model for an incoming request.
     * Enforces session-attachment: existing sessions strictly retain their pinned model.
     * New sessions sample from SWRR if model splitting is enabled.
     *
     * @param {string} requestedModel - Model string from client request
     * @param {string} sessionKey - Fingerprint for the session
     * @returns {string} Resolved canonical model ID
     */
    resolveModel(requestedModel, sessionKey) {
        if (!isFlashCandidate(requestedModel)) {
            return requestedModel;
        }

        // 1. If this session was pinned to Gemini 3.8 Flash due to a content/safety filter trigger,
        // stick to Gemini 3.8 Flash for the remainder of the session!
        if (sessionKey && sessionKey !== 'anon') {
            const pinnedModel = sessionRouter.getActivePin(sessionKey);
            if (pinnedModel && pinnedModel.includes('3.8-flash')) {
                logger.info(`[ModelSplitter] 🛡️ Session ${sessionKey} is filter-pinned to ${pinnedModel} — sticking to Gemini 3.8 Flash`);
                return pinnedModel;
            }
        }

        const m = requestedModel.toLowerCase();
        // Redirect all 3.8-flash / 3.7-flash / hydrogen variants directly to the matching gemini-4-hydrogen tier
        if (m.endsWith('-xhigh') || m === 'hydrogen-xhigh') {
            return MODEL_HYDROGEN_XHIGH;
        }
        if (m.endsWith('-low') || m === 'flash-low' || m === 'hydrogen-low') {
            return MODEL_HYDROGEN_LOW;
        }
        if (m.endsWith('-medium') || m.endsWith('-med') || m === 'flash-med' || m === 'flash-medium' || m === 'hydrogen-medium' || m === 'hydrogen-med') {
            return MODEL_HYDROGEN_MEDIUM;
        }
        // Default all gemini-3.8-flash, gemini-3.8-flash-tiered, gemini-3.8-flash-high, gemini-4-hydrogen, etc. to gemini-4-hydrogen-high
        return MODEL_HYDROGEN_HIGH;
    }
}

export const modelSplitter = new ModelSplitter();
