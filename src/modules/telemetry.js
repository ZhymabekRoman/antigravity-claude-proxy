/**
 * Telemetry & AutoExacto Benchmarks Module
 *
 * Tracks, aggregates, and persists real-time LLM telemetry and agent benchmarks:
 * 1. Throughput (Tokens/s)
 * 2. Latency (TTFT - Time To First Token)
 * 3. E2E Latency (End-to-End Turn Duration)
 * 4. AutoExacto Benchmarks (Schema fidelity, turn completion, agent evaluation score)
 * 5. Tool Call Error Rate (% of tool executions returning errors)
 * 6. Structured Output Error Rate (% of format recovery incidents)
 * 7. Cache Hit Rate (Google TPU prompt cache hit ratio & tokens saved)
 */

import fs from 'fs';
import path from 'path';
import { TELEMETRY_PERSISTENCE_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

const ROLLING_WINDOW_SIZE = 100; // Keep last 100 samples for moving averages & percentiles

class TelemetryCollector {
    #ttftSamples = [];
    #e2eSamples = [];
    #throughputSamples = [];
    
    // Counters
    #totalTurns = 0;
    #successfulTurns = 0;
    #totalOutputTokens = 0;
    #totalInputTokens = 0;
    #totalCachedTokens = 0;
    #totalStreamingMs = 0;
    #peakThroughput = 0;

    // Tool & format error counters
    #totalToolCalls = 0;
    #failedToolCalls = 0;
    #formatErrors = 0;

    #saveTimer = null;
    #isDirty = false;

    constructor() {
        this.#loadFromDisk();
    }

    #loadFromDisk() {
        try {
            if (fs.existsSync(TELEMETRY_PERSISTENCE_PATH)) {
                const raw = fs.readFileSync(TELEMETRY_PERSISTENCE_PATH, 'utf8');
                const data = JSON.parse(raw);
                this.#ttftSamples = Array.isArray(data.ttftSamples) ? data.ttftSamples.slice(-ROLLING_WINDOW_SIZE) : [];
                this.#e2eSamples = Array.isArray(data.e2eSamples) ? data.e2eSamples.slice(-ROLLING_WINDOW_SIZE) : [];
                this.#throughputSamples = Array.isArray(data.throughputSamples) ? data.throughputSamples.slice(-ROLLING_WINDOW_SIZE) : [];

                this.#totalTurns = Number(data.totalTurns) || 0;
                this.#successfulTurns = Number(data.successfulTurns) || 0;
                this.#totalOutputTokens = Number(data.totalOutputTokens) || 0;
                this.#totalInputTokens = Number(data.totalInputTokens) || 0;
                this.#totalCachedTokens = Number(data.totalCachedTokens) || 0;
                this.#totalStreamingMs = Number(data.totalStreamingMs) || 0;
                this.#peakThroughput = Number(data.peakThroughput) || 0;

                this.#totalToolCalls = Number(data.totalToolCalls) || 0;
                this.#failedToolCalls = Number(data.failedToolCalls) || 0;
                this.#formatErrors = Number(data.formatErrors) || 0;

                logger.info(`[Telemetry] Restored telemetry data (${this.#totalTurns} lifetime turns)`);
            }
        } catch (e) {
            logger.warn(`[Telemetry] Failed to load telemetry from disk: ${e.message}`);
        }
    }

    #scheduleSave() {
        this.#isDirty = true;
        if (this.#saveTimer) return;
        this.#saveTimer = setTimeout(() => {
            this.#saveTimer = null;
            this.#saveToDisk();
        }, 2000);
    }

    #saveToDisk() {
        if (!this.#isDirty) return;
        try {
            const dir = path.dirname(TELEMETRY_PERSISTENCE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const payload = {
                ttftSamples: this.#ttftSamples,
                e2eSamples: this.#e2eSamples,
                throughputSamples: this.#throughputSamples,
                totalTurns: this.#totalTurns,
                successfulTurns: this.#successfulTurns,
                totalOutputTokens: this.#totalOutputTokens,
                totalInputTokens: this.#totalInputTokens,
                totalCachedTokens: this.#totalCachedTokens,
                totalStreamingMs: this.#totalStreamingMs,
                peakThroughput: this.#peakThroughput,
                totalToolCalls: this.#totalToolCalls,
                failedToolCalls: this.#failedToolCalls,
                formatErrors: this.#formatErrors,
                updatedAt: Date.now()
            };

            const tmp = `${TELEMETRY_PERSISTENCE_PATH}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tmp, TELEMETRY_PERSISTENCE_PATH);
            this.#isDirty = false;
        } catch (e) {
            logger.warn(`[Telemetry] Failed to save telemetry to disk: ${e.message}`);
        }
    }

    /**
     * Record a completed LLM turn
     */
    recordTurn(params = {}) {
        const {
            ttftMs = 0,
            e2eLatencyMs = 0,
            streamDurationMs = 0,
            outputTokens = 0,
            inputTokens = 0,
            cachedTokens = 0,
            toolCalls = 0,
            toolErrors = 0,
            formatErrors = 0,
            success = true
        } = params;

        this.#totalTurns++;
        if (success) this.#successfulTurns++;

        // Latency
        if (ttftMs > 0) {
            this.#ttftSamples.push(ttftMs);
            if (this.#ttftSamples.length > ROLLING_WINDOW_SIZE) this.#ttftSamples.shift();
        }
        if (e2eLatencyMs > 0) {
            this.#e2eSamples.push(e2eLatencyMs);
            if (this.#e2eSamples.length > ROLLING_WINDOW_SIZE) this.#e2eSamples.shift();
        }

        // Throughput
        if (outputTokens > 0) {
            this.#totalOutputTokens += outputTokens;
            if (streamDurationMs >= 10) {
                this.#totalStreamingMs += streamDurationMs;
                const tokPerSec = Number((outputTokens / (streamDurationMs / 1000)).toFixed(1));
                if (tokPerSec > 0 && tokPerSec < 2000) {
                    this.#throughputSamples.push(tokPerSec);
                    if (this.#throughputSamples.length > ROLLING_WINDOW_SIZE) this.#throughputSamples.shift();
                    if (tokPerSec > this.#peakThroughput) this.#peakThroughput = tokPerSec;
                }
            }
        }

        // Cache tokens
        if (inputTokens > 0) this.#totalInputTokens += inputTokens;
        if (cachedTokens > 0) this.#totalCachedTokens += cachedTokens;

        // Tool calls & errors
        if (toolCalls > 0) this.#totalToolCalls += toolCalls;
        if (toolErrors > 0) this.#failedToolCalls += toolErrors;
        if (formatErrors > 0) this.#formatErrors += formatErrors;

        this.#scheduleSave();
    }

    /**
     * Compute percentiles for an array of numbers
     */
    #computeStats(samples) {
        if (!samples || samples.length === 0) {
            return { avg: 0, p50: 0, p95: 0, min: 0, max: 0, count: 0 };
        }
        const sorted = [...samples].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((a, b) => a + b, 0);
        const avg = Number((sum / count).toFixed(1));
        const min = sorted[0];
        const max = sorted[count - 1];
        const p50 = sorted[Math.floor(count * 0.5)];
        const p95 = sorted[Math.floor(count * 0.95)] || max;
        return { avg, p50, p95, min, max, count };
    }

    /**
     * Get aggregated telemetry report for API & WebUI
     */
    getMetrics() {
        const ttftStats = this.#computeStats(this.#ttftSamples);
        const e2eStats = this.#computeStats(this.#e2eSamples);
        const throughputStats = this.#computeStats(this.#throughputSamples);

        // Throughput
        const currentTokPerSec = throughputStats.count > 0 ? throughputStats.avg : 0;
        const lifetimeAvgTokPerSec = this.#totalStreamingMs > 0
            ? Number((this.#totalOutputTokens / (this.#totalStreamingMs / 1000)).toFixed(1))
            : currentTokPerSec;

        // Cache Hit Rate
        const totalPromptTokens = this.#totalInputTokens + this.#totalCachedTokens;
        const cacheHitRate = totalPromptTokens > 0
            ? Number(((this.#totalCachedTokens / totalPromptTokens) * 100).toFixed(1))
            : 0;

        // Tool Call Error Rate
        const toolErrorRate = this.#totalToolCalls > 0
            ? Number(((this.#failedToolCalls / this.#totalToolCalls) * 100).toFixed(1))
            : 0;
        const toolSuccessRate = Number((100 - toolErrorRate).toFixed(1));

        // Structured Output Error Rate
        const structuredOutputErrorRate = this.#totalTurns > 0
            ? Number(((this.#formatErrors / this.#totalTurns) * 100).toFixed(1))
            : 0;
        const structuredSuccessRate = Number((100 - structuredOutputErrorRate).toFixed(1));

        // Turn Success Rate
        const turnSuccessRate = this.#totalTurns > 0
            ? Number(((this.#successfulTurns / this.#totalTurns) * 100).toFixed(1))
            : 100;

        // AutoExacto Benchmark Composite Score (0-100)
        let exactoScore = 100;
        if (this.#totalTurns > 0) {
            exactoScore = Number((
                (structuredSuccessRate * 0.50) +
                (toolSuccessRate * 0.30) +
                (turnSuccessRate * 0.20)
            ).toFixed(1));
        }

        let exactoGrade = 'S+';
        let exactoRating = 'OPTIMAL [EXACTO GOLD]';
        let exactoColor = 'emerald';
        if (exactoScore >= 99) {
            exactoGrade = 'S+';
            exactoRating = 'OPTIMAL [EXACTO GOLD]';
            exactoColor = 'emerald';
        } else if (exactoScore >= 97) {
            exactoGrade = 'A+';
            exactoRating = 'EXCELLENT [EXACTO PASS]';
            exactoColor = 'cyan';
        } else if (exactoScore >= 92) {
            exactoGrade = 'A';
            exactoRating = 'HEALTHY';
            exactoColor = 'blue';
        } else if (exactoScore >= 85) {
            exactoGrade = 'B';
            exactoRating = 'DEGRADED';
            exactoColor = 'amber';
        } else {
            exactoGrade = 'C';
            exactoRating = 'ATTENTION NEEDED';
            exactoColor = 'rose';
        }

        return {
            throughput: {
                current: currentTokPerSec,
                peak: this.#peakThroughput || currentTokPerSec,
                lifetimeAvg: lifetimeAvgTokPerSec,
                totalOutputTokens: this.#totalOutputTokens,
                unit: 'tok/s'
            },
            latency: {
                ttft: {
                    avgMs: ttftStats.avg,
                    p50Ms: ttftStats.p50,
                    p95Ms: ttftStats.p95,
                    minMs: ttftStats.min,
                    maxMs: ttftStats.max,
                    unit: 'ms'
                }
            },
            e2eLatency: {
                avgMs: e2eStats.avg,
                p50Ms: e2eStats.p50,
                p95Ms: e2eStats.p95,
                minMs: e2eStats.min,
                maxMs: e2eStats.max,
                formattedAvg: e2eStats.avg >= 1000 ? (e2eStats.avg / 1000).toFixed(2) + 's' : Math.round(e2eStats.avg) + 'ms'
            },
            autoExacto: {
                score: exactoScore,
                grade: exactoGrade,
                rating: exactoRating,
                color: exactoColor,
                turnSuccessRate: turnSuccessRate,
                schemaFidelityRate: structuredSuccessRate,
                totalBenchmarkTurns: this.#totalTurns
            },
            toolCallErrorRate: {
                errorRate: toolErrorRate,
                successRate: toolSuccessRate,
                totalCalls: this.#totalToolCalls,
                failedCalls: this.#failedToolCalls
            },
            structuredOutputErrorRate: {
                errorRate: structuredOutputErrorRate,
                successRate: structuredSuccessRate,
                formatErrors: this.#formatErrors,
                totalTurns: this.#totalTurns
            },
            cacheHitRate: {
                hitRate: cacheHitRate,
                cachedTokens: this.#totalCachedTokens,
                totalPromptTokens: totalPromptTokens,
                savedTokensFormatted: formatTokenCount(this.#totalCachedTokens)
            },
            totalTurns: this.#totalTurns,
            updatedAt: Date.now()
        };
    }
}

function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

export const telemetry = new TelemetryCollector();
export default telemetry;
