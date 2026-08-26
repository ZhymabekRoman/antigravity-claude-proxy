import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    );
}

/**
 * Global concurrency semaphore for Google API requests.
 *
 * All Claude Code sessions share the same proxy process, so they compete
 * for the same pool of 7 Google accounts. Without a concurrency cap, 5+
 * parallel sessions + subagents fire 20-50 simultaneous requests, every
 * account gets 429'd, and agents hang indefinitely.
 *
 * This semaphore caps in-flight Google API requests to MAX_CONCURRENT_REQUESTS
 * globally across all sessions. Excess requests queue instead of firing
 * immediately, so accounts never see burst 429s from the proxy itself.
 */
const MAX_CONCURRENT_REQUESTS = config.maxConcurrentRequests || 7; // 1 per account
let _activeRequests = 0;
const _waitQueue = [];
let _totalQueued = 0;
let _totalServed = 0;
let _totalDropped429 = 0;

/** Expose live semaphore stats for /health and logging */
export function getSemaphoreStats() {
    return {
        active: _activeRequests,
        queued: _waitQueue.length,
        max: MAX_CONCURRENT_REQUESTS,
        totalServed: _totalServed,
        totalQueued: _totalQueued,
        total429s: _totalDropped429
    };
}

/** Increment 429 counter (called from streaming-handler) */
export function recordRateLimitHit() {
    _totalDropped429++;
}

function _acquireSemaphore() {
    if (_activeRequests < MAX_CONCURRENT_REQUESTS) {
        _activeRequests++;
        _totalServed++;
        return Promise.resolve();
    }
    // Queue is full - log once every 5 queued items to avoid spam
    _totalQueued++;
    if (_totalQueued % 5 === 1 || _waitQueue.length >= 5) {
        logger.warn(`[Semaphore] 🚦 Queue depth: ${_waitQueue.length + 1} | Active: ${_activeRequests}/${MAX_CONCURRENT_REQUESTS} | Total queued: ${_totalQueued}`);
    }
    return new Promise(resolve => _waitQueue.push(resolve));
}

function _releaseSemaphore() {
    if (_waitQueue.length > 0) {
        const next = _waitQueue.shift();
        // Active count stays same - we pass the slot directly
        _totalServed++;
        next();
        if (_waitQueue.length > 0) {
            logger.debug(`[Semaphore] ✅ Slot released → handed to next waiter | Queue remaining: ${_waitQueue.length} | Active: ${_activeRequests}/${MAX_CONCURRENT_REQUESTS}`);
        }
    } else {
        _activeRequests--;
        logger.debug(`[Semaphore] ✅ Slot released | Active: ${_activeRequests}/${MAX_CONCURRENT_REQUESTS} | Queue: empty`);
    }
}

/**
 * Throttled fetch: globally rate-limited to MAX_CONCURRENT_REQUESTS
 * in-flight at any moment. Prevents thundering herd 429s when multiple
 * Claude Code sessions issue parallel requests.
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function throttledFetch(url, options) {
    const queuedAt = Date.now();
    const wasQueued = _activeRequests >= MAX_CONCURRENT_REQUESTS;
    await _acquireSemaphore();
    const waitedMs = Date.now() - queuedAt;
    if (wasQueued && waitedMs > 100) {
        logger.info(`[Semaphore] ⏳ Request waited ${waitedMs}ms in queue | Active: ${_activeRequests}/${MAX_CONCURRENT_REQUESTS}`);
    }
    try {
        return await fetch(url, options);
    } finally {
        _releaseSemaphore();
    }
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}
