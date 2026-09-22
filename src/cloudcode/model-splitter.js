/**
 * Model Splitter with Smooth Weighted Round-Robin (SWRR)
 * 
 * Implements Nginx-style Smooth Weighted Round-Robin for model allocation
 * with session-level stickiness to maximize Google TPU KV prompt cache hits.
 */

import { isModelSplitEnabled, getModelSplitWeights, isReroute38To37 } from '../constants.js';
import { logger } from '../utils/logger.js';
import { sessionRouter } from './session-manager.js';

export const MODEL_37_FLASH = 'gemini-3.7-flash-tiered';
export const MODEL_38_FLASH = 'gemini-3.8-flash-tiered';

/**
 * Check if a requested model string is a Flash candidate subject to splitting
 * @param {string} model 
 * @returns {boolean}
 */
export function isFlashCandidate(model) {
    if (!model || typeof model !== 'string') return false;
    const m = model.toLowerCase();
    return (
        m.includes('3.8-flash') ||
        m.includes('3-8-flash') ||
        m.includes('3.7-flash') ||
        m.includes('3-7-flash') ||
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

        // 1. Session Attachment: Check if this session already has a pinned model
        if (sessionKey && sessionKey !== 'anon') {
            const pinnedModel = sessionRouter.getPinnedModel(sessionKey);
            if (pinnedModel && (pinnedModel === MODEL_37_FLASH || pinnedModel === MODEL_38_FLASH)) {
                logger.info(`[ModelSplitter] 🎯 Session ${sessionKey} attached to pinned model: ${pinnedModel} (TPU cache affinity preserved)`);
                return pinnedModel;
            }
        }

        // 2. If Model Split is enabled, use Smooth Weighted Round-Robin
        if (isModelSplitEnabled()) {
            const selectedModel = this.selectNextModel();
            // Pre-pin the model to the session in SessionRouter
            if (sessionKey && sessionKey !== 'anon') {
                sessionRouter.pinModel(sessionKey, selectedModel);
            }
            logger.info(`[ModelSplitter] ⚖️ New session ${sessionKey}: pinned to ${selectedModel} via weighted split`);
            return selectedModel;
        }

        // 3. Fallback: When Model Split disabled, check reroute38To37 toggle
        if (isReroute38To37()) {
            return MODEL_37_FLASH;
        }

        // 4. Default direct mapping based on requested string
        const m = requestedModel.toLowerCase();
        if (m.includes('3.7-flash') || m.includes('3-7-flash')) {
            return MODEL_37_FLASH;
        }
        return MODEL_38_FLASH;
    }
}

export const modelSplitter = new ModelSplitter();
