/**
 * HTTP Transport & Persistent Keep-Alive Connection Pool
 *
 * Configures undici dispatcher with:
 * - Persistent HTTP/1.1 & HTTP/2 connection pooling
 * - TCP_NODELAY (disable Nagle algorithm for lowest TTFB)
 * - 2-minute idle socket reuse & 10-minute maximum socket lifetime
 * - Background warm-up pings to Google Cloud Code endpoints to eliminate cold TLS handshakes
 * - Transparent proxy fallback if HTTP_PROXY is defined
 */

import { Agent, ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import { logger } from './logger.js';

const WARMUP_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com'
];

let warmerInterval = null;

/**
 * Initialize high-performance HTTP connection dispatcher and start connection warmer
 */
export function initHttpTransport() {
    const proxyUrl = process.env.http_proxy ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.HTTPS_PROXY;

    if (proxyUrl) {
        try {
            const proxyAgent = new ProxyAgent(proxyUrl);
            setGlobalDispatcher(proxyAgent);
            logger.info(`[Transport] Configured upstream ProxyAgent: ${proxyUrl}`);
            return;
        } catch (error) {
            logger.error(`[Transport] Failed to configure proxy: ${error.message}`);
        }
    }

    // High-performance agent tuned for streaming and low-latency API calls
    const agent = new Agent({
        keepAliveTimeout: 120000,      // 2 minutes idle keep-alive socket reuse
        keepAliveMaxTimeout: 600000,   // 10 minutes max socket lifetime
        keepAliveTimeoutThreshold: 2000,
        pipelining: 1,
        connections: 64,               // Connection pool size
        connect: {
            keepAlive: true,
            keepAliveInitialDelay: 10000,
            noDelay: true              // TCP_NODELAY: Disable Nagle algorithm for instant packet delivery
        }
    });

    setGlobalDispatcher(agent);
    logger.info('[Transport] ⚡ HTTP Persistent Keep-Alive pool active (TCP_NODELAY enabled, 120s keepAlive)');

    // Start background socket warmer
    startConnectionWarmer();
}

/**
 * Periodically warm up TCP/TLS sockets to Google API endpoints
 */
function startConnectionWarmer() {
    if (warmerInterval) return;

    // Run warm-up immediately on startup, then every 40 seconds
    warmSockets();
    warmerInterval = setInterval(warmSockets, 40000);
    if (warmerInterval.unref) {
        warmerInterval.unref(); // Don't block process exit
    }
}

/**
 * Ping Google API endpoints to pre-warm TLS 1.3 handshakes & keep sockets hot
 */
async function warmSockets() {
    for (const url of WARMUP_ENDPOINTS) {
        try {
            // Lightweight HEAD / OPTIONS request keeps TLS socket open in pool
            await undiciFetch(url, {
                method: 'HEAD',
                headers: {
                    'User-Agent': 'antigravity/1.110.0',
                    'Connection': 'keep-alive'
                },
                signal: AbortSignal.timeout(3000)
            }).catch(() => {});
        } catch (_) {}
    }
}

// Auto-initialize on import
initHttpTransport();
