import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { Agent, setGlobalDispatcher } from 'undici';
import { config } from '../config.js';
import { logger } from './logger.js';

// High-performance connection pool with HTTP keep-alive for Google APIs
// Eliminates 150-300ms TCP/TLS handshake overhead per tool call turn
const globalDispatcher = new Agent({
    keepAliveTimeout: 60000,      // 60 seconds keep-alive timeout
    keepAliveMaxTimeout: 600000,  // 10 minutes max socket lifetime
    pipelining: 1,
    connections: 50,              // Pool size for multi-account concurrent requests
    connect: {
        timeout: 10000            // 10 second connect timeout
    }
});

try {
    setGlobalDispatcher(globalDispatcher);
} catch (e) {
    // Fallback if dispatcher already locked
}

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
 * This semaphore caps in-flight Google AI generation requests to MAX_CONCURRENT_REQUESTS
 * globally across all sessions. Excess requests queue instead of firing
 * immediately, so accounts never see burst 429s from the proxy itself.
 *
 * NOTE: Only AI generation calls (streamGenerateContent/generateContent) go through
 * the semaphore. Management calls (OAuth, quota, loadCodeAssist) bypass it entirely
 * to prevent semaphore starvation from WebUI polling and internal housekeeping.
 */
const MAX_CONCURRENT_REQUESTS = config.maxConcurrentRequests || 12; // 1 per account
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

// Outbound Request Pacer (Per-Account Leaky Bucket):
//
// OLD design: a single global sequential Promise chain (800ms gap).
//   Problem: in agent mode, 20 tool calls with 1 account = 16s of pure pacer wait.
//   Worse: with 3 concurrent sessions, requests to DIFFERENT accounts were still
//   serialized through one chain — defeating the entire account pool benefit.
//
// NEW design: per-account pacers at 200ms gap.
//   - Requests to different accounts run truly in parallel.
//   - Per-account burst protection is still enforced (no more than 5 RPM burst
//     from a single account, matching Google's per-second quota window).
//   - The account email is extracted from the Authorization header or passed
//     via a custom x-account-key header by throttledFetch callers.
const MIN_OUTBOUND_GAP_MS = config.outboundGapMs || 200; // 200ms per-account gap (was: 800ms global)
const _accountPacers = new Map(); // accountKey -> { lastTime: number, queue: Promise }

function _getPacerKey(options) {
    // Extract account key from headers: x-account-key (injected by buildHeaders) or fallback
    const headers = options?.headers || {};
    return headers['x-account-key'] || headers['X-Account-Key'] || 'default';
}

function _paceOutboundRequest(pacerKey) {
    if (!_accountPacers.has(pacerKey)) {
        _accountPacers.set(pacerKey, { lastTime: 0, queue: Promise.resolve() });
    }
    const pacer = _accountPacers.get(pacerKey);
    pacer.queue = pacer.queue.then(async () => {
        const now = Date.now();
        const elapsed = now - pacer.lastTime;
        if (elapsed < MIN_OUTBOUND_GAP_MS) {
            const waitMs = MIN_OUTBOUND_GAP_MS - elapsed;
            logger.debug(`[Pacer] ⏱️ account=${pacerKey} waiting ${waitMs}ms (gap=${MIN_OUTBOUND_GAP_MS}ms)`);
            await sleep(waitMs);
        }
        pacer.lastTime = Date.now();
    });
    return pacer.queue;
}

// Response timeout for AI generation requests (TTFB).
// Prevents semaphore slot leaks when Google accepts the TCP connection but stalls
// on headers for minutes with large payloads (1600+ messages, 77+ tools).
// Set to 12 minutes to accommodate very large prompts where TPU processing is slow.
const FETCH_TIMEOUT_MS = config.fetchTimeoutMs || 720_000; // 12 minutes

export async function throttledFetch(url, options) {
    const urlStr = typeof url === 'string' ? url : url?.toString?.() || '';
    const isCloudCodeAiEndpoint = urlStr.includes('cloudcode-pa.googleapis.com') && (urlStr.includes('streamGenerateContent') || urlStr.includes('generateContent'));

    // Strip internal x-account-key before sending to upstream (not a real API header)
    let fetchOptions = options;
    if (options?.headers?.['x-account-key'] || options?.headers?.['X-Account-Key']) {
        const { 'x-account-key': _ak, 'X-Account-Key': _AK, ...cleanHeaders } = options.headers;
        fetchOptions = { ...options, headers: cleanHeaders };
    }

    // Non-AI calls (OAuth, loadCodeAssist, fetchAvailableModels, quota checks) bypass
    // the semaphore entirely. These management calls were competing with AI generation
    // for the same 7 slots, causing agent requests to queue behind 24+ WebUI polling
    // calls per minute and starving actual agent work.
    if (!isCloudCodeAiEndpoint) {
        return await fetch(url, fetchOptions);
    }

    // AI generation requests: apply semaphore + per-account pacer + response timeout
    const queuedAt = Date.now();
    const wasQueued = _activeRequests >= MAX_CONCURRENT_REQUESTS;
    await _acquireSemaphore();
    const waitedMs = Date.now() - queuedAt;
    if (wasQueued && waitedMs > 100) {
        logger.info(`[Semaphore] ⏳ Request waited ${waitedMs}ms in queue | Active: ${_activeRequests}/${MAX_CONCURRENT_REQUESTS}`);
    }
    try {
        const pacerKey = _getPacerKey(options);
        await _paceOutboundRequest(pacerKey);

        // Apply response timeout to prevent semaphore slot leaks on hung connections
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const signals = [controller.signal, options?.signal].filter(Boolean);
            const mergedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
            return await fetch(url, { ...fetchOptions, signal: mergedSignal });
        } finally {
            clearTimeout(timeoutId);
        }
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
