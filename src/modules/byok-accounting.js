/**
 * Gemini BYOK Cost & Usage Accounting Module
 *
 * Tracks token consumption and approximate USD costs for Google AI Studio
 * (generativelanguage.googleapis.com) BYOK API keys.
 * Supports configurable spend caps ($) with preemptive gating and comprehensive reports.
 */

import { logger } from '../utils/logger.js';

/**
 * Google AI Studio Pay-as-you-go reference pricing (per 1,000,000 tokens)
 * Flash: $0.075 prompt, $0.30 output/thinking, $0.01875 cached prompt read
 * Pro:   $1.25 prompt,  $5.00 output/thinking, $0.3125 cached prompt read
 */
export const GEMINI_STUDIO_PRICING = {
    flash: {
        inputPerMillion: 0.075,
        outputPerMillion: 0.30,
        cacheReadPerMillion: 0.01875,
        inputPerToken: 0.075 / 1000000,
        outputPerToken: 0.30 / 1000000,
        cacheReadPerToken: 0.01875 / 1000000
    },
    pro: {
        inputPerMillion: 1.25,
        outputPerMillion: 5.00,
        cacheReadPerMillion: 0.3125,
        inputPerToken: 1.25 / 1000000,
        outputPerToken: 5.00 / 1000000,
        cacheReadPerToken: 0.3125 / 1000000
    }
};

/**
 * Calculate approximate USD cost for a Gemini request based on model tier and tokens
 * @param {string} modelId 
 * @param {Object} tokens - { inputTokens, outputTokens, cacheTokens }
 * @returns {{ costUsd: number, isPro: boolean, rates: Object }}
 */
export function calculateGeminiCost(modelId, { inputTokens = 0, outputTokens = 0, cacheTokens = 0 } = {}) {
    const m = (modelId || '').toLowerCase();
    const isPro = m.includes('pro') || m.includes('opus') || m.includes('3.1');
    const rates = isPro ? GEMINI_STUDIO_PRICING.pro : GEMINI_STUDIO_PRICING.flash;

    const inputCost = (inputTokens || 0) * rates.inputPerToken;
    const outputCost = (outputTokens || 0) * rates.outputPerToken;
    const cacheCost = (cacheTokens || 0) * rates.cacheReadPerToken;
    const totalCost = +(inputCost + outputCost + cacheCost).toFixed(6);

    return {
        costUsd: totalCost,
        isPro,
        rates
    };
}

/**
 * Record token spend and USD cost for a BYOK account
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID requested
 * @param {Object} usage - Anthropic format usage { input_tokens, output_tokens, cache_read_input_tokens }
 * @param {Object} [accountManager] - AccountManager instance to persist changes
 * @returns {number} Cost of this specific request in USD
 */
export function recordByokSpend(account, modelId, usage, accountManager = null) {
    if (!account || !usage) return 0;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheTokens = usage.cache_read_input_tokens || 0;
    const totalTokens = inputTokens + outputTokens + cacheTokens;

    const { costUsd } = calculateGeminiCost(modelId, { inputTokens, outputTokens, cacheTokens });

    // Initialize spendStats on account if missing
    if (!account.spendStats) {
        account.spendStats = {
            totalRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalTokens: 0,
            costByModel: {},
            lastResetAt: null
        };
    }

    const stats = account.spendStats;
    stats.totalRequests = (stats.totalRequests || 0) + 1;
    stats.inputTokens = (stats.inputTokens || 0) + inputTokens;
    stats.outputTokens = (stats.outputTokens || 0) + outputTokens;
    stats.cacheTokens = (stats.cacheTokens || 0) + cacheTokens;
    stats.totalTokens = (stats.totalTokens || 0) + totalTokens;

    if (!stats.costByModel) stats.costByModel = {};
    const modelKey = modelId || 'gemini-3.7-flash';
    if (!stats.costByModel[modelKey]) {
        stats.costByModel[modelKey] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            costUsd: 0
        };
    }
    const mStats = stats.costByModel[modelKey];
    mStats.requests = (mStats.requests || 0) + 1;
    mStats.inputTokens = (mStats.inputTokens || 0) + inputTokens;
    mStats.outputTokens = (mStats.outputTokens || 0) + outputTokens;
    mStats.cacheTokens = (mStats.cacheTokens || 0) + cacheTokens;
    mStats.costUsd = +(mStats.costUsd + costUsd).toFixed(6);

    account.currentSpendUsd = +((account.currentSpendUsd || 0) + costUsd).toFixed(6);

    const spendCap = account.spendCapUsd;
    const capInfo = (typeof spendCap === 'number' && spendCap > 0) ? ` / $${spendCap.toFixed(2)} cap` : '';
    logger.info(`[Gemini-BYOK] 💰 Account ${account.email}: req cost +$${costUsd.toFixed(5)} (${inputTokens} in, ${outputTokens} out, ${cacheTokens} cached) -> total $${account.currentSpendUsd.toFixed(4)}${capInfo}`);

    if (typeof spendCap === 'number' && spendCap > 0 && account.currentSpendUsd >= spendCap) {
        logger.warn(`[Gemini-BYOK] 🛑 SPEND CAP REACHED for ${account.email}: $${account.currentSpendUsd.toFixed(4)} >= $${spendCap.toFixed(2)}. Account gated from further requests.`);
    }

    // Persist changes asynchronously to disk
    if (accountManager && typeof accountManager.saveToDisk === 'function') {
        accountManager.saveToDisk().catch(err => {
            logger.error('[Gemini-BYOK] Failed to save account spend to disk:', err.message);
        });
    }

    return costUsd;
}

/**
 * Reset accumulated spend and stats for a BYOK account
 * @param {Object} account 
 */
export function resetByokSpend(account) {
    if (!account) return;
    account.currentSpendUsd = 0;
    account.spendStats = {
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        costByModel: {},
        lastResetAt: new Date().toISOString()
    };
}

/**
 * Check if a BYOK account has exceeded its spend cap
 * @param {Object} account 
 * @returns {boolean} True if spend cap is active and reached
 */
export function isByokSpendCapped(account) {
    if (!account) return false;
    const spendCap = account.spendCapUsd;
    if (typeof spendCap !== 'number' || spendCap <= 0) return false;
    return (account.currentSpendUsd || 0) >= spendCap;
}

/**
 * Mask an API key for safe display (e.g. AIzaSy...4a9z)
 * @param {string} key 
 * @returns {string} Masked key
 */
export function maskApiKey(key) {
    if (!key || typeof key !== 'string') return '-';
    if (key.length <= 10) return '***';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * Generate a comprehensive usage & spend report for all BYOK accounts
 * @param {Array<Object>} accounts - List of all accounts
 * @returns {Object} Report structure
 */
export function generateUsageReport(accounts = []) {
    const trackedAccounts = accounts.filter(a => a.source === 'gemini-byok' || (a.apiKey && !a.refreshToken) || a.byokApiKey || a.gcpProject);

    let totalSpendUsd = 0;
    let totalCapUsd = 0;
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let cappedCount = 0;
    const overallSpendByModel = {};

    const accountReports = trackedAccounts.map(acc => {
        const isVertex = !!acc.gcpProject;
        const spendCap = typeof acc.spendCapUsd === 'number' && acc.spendCapUsd > 0 ? acc.spendCapUsd : null;
        const currentSpend = acc.currentSpendUsd || 0;
        const isCapped = spendCap !== null && currentSpend >= spendCap;
        const capPercentage = spendCap ? Math.min(100, +((currentSpend / spendCap) * 100).toFixed(1)) : null;
        const remainingCap = spendCap ? Math.max(0, +(spendCap - currentSpend).toFixed(4)) : null;

        if (spendCap) totalCapUsd += spendCap;
        totalSpendUsd += currentSpend;
        if (isCapped) cappedCount++;

        const stats = acc.spendStats || {
            totalRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalTokens: 0,
            costByModel: {},
            lastResetAt: null
        };

        totalRequests += (stats.totalRequests || 0);
        totalInputTokens += (stats.inputTokens || 0);
        totalOutputTokens += (stats.outputTokens || 0);
        totalCacheTokens += (stats.cacheTokens || 0);

        // Aggregate per-model stats
        for (const [model, mStat] of Object.entries(stats.costByModel || {})) {
            if (!overallSpendByModel[model]) {
                overallSpendByModel[model] = {
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    totalTokens: 0,
                    costUsd: 0
                };
            }
            overallSpendByModel[model].requests += (mStat.requests || 0);
            overallSpendByModel[model].inputTokens += (mStat.inputTokens || 0);
            overallSpendByModel[model].outputTokens += (mStat.outputTokens || 0);
            overallSpendByModel[model].cacheTokens += (mStat.cacheTokens || 0);
            overallSpendByModel[model].totalTokens += ((mStat.inputTokens || 0) + (mStat.outputTokens || 0) + (mStat.cacheTokens || 0));
            overallSpendByModel[model].costUsd = +(overallSpendByModel[model].costUsd + (mStat.costUsd || 0)).toFixed(6);
        }

        let status = 'OK';
        if (acc.enabled === false) status = 'DISABLED';
        else if (isCapped) status = 'SPEND_CAP_REACHED';
        else if (acc.isInvalid) status = 'INVALID';

        return {
            email: acc.email,
            source: isVertex ? 'vertex-ai' : acc.source,
            isVertex,
            gcpProject: acc.gcpProject || null,
            description: isVertex ? `Vertex AI (${acc.gcpProject})` : (acc.description || 'Google AI Studio Key'),
            apiKeyMasked: isVertex ? `GCP: ${acc.gcpProject}` : maskApiKey(acc.apiKey || acc.byokApiKey),
            enabled: acc.enabled !== false,
            spendCapUsd: spendCap,
            currentSpendUsd: +currentSpend.toFixed(4),
            capRemainingUsd: remainingCap,
            capPercentage: capPercentage,
            isCapped,
            status,
            totalRequests: stats.totalRequests || 0,
            tokens: {
                input: stats.inputTokens || 0,
                output: stats.outputTokens || 0,
                cached: stats.cacheTokens || 0,
                total: stats.totalTokens || 0
            },
            costByModel: stats.costByModel || {},
            lastUsed: acc.lastUsed ? new Date(acc.lastUsed).toISOString() : null,
            lastResetAt: stats.lastResetAt || null
        };
    });

    return {
        timestamp: new Date().toISOString(),
        summary: {
            totalByokAccounts: trackedAccounts.length,
            activeAccounts: trackedAccounts.filter(a => a.enabled !== false).length,
            cappedAccounts: cappedCount,
            totalSpendUsd: +totalSpendUsd.toFixed(4),
            totalCapUsd: +totalCapUsd.toFixed(2),
            totalRequests,
            totalTokens: {
                input: totalInputTokens,
                output: totalOutputTokens,
                cached: totalCacheTokens,
                total: totalInputTokens + totalOutputTokens + totalCacheTokens
            },
            spendByModel: overallSpendByModel
        },
        pricingReference: {
            flash: {
                promptPer1M: `$${GEMINI_STUDIO_PRICING.flash.inputPerMillion}`,
                outputPer1M: `$${GEMINI_STUDIO_PRICING.flash.outputPerMillion}`,
                cachedPer1M: `$${GEMINI_STUDIO_PRICING.flash.cacheReadPerMillion}`
            },
            pro: {
                promptPer1M: `$${GEMINI_STUDIO_PRICING.pro.inputPerMillion}`,
                outputPer1M: `$${GEMINI_STUDIO_PRICING.pro.outputPerMillion}`,
                cachedPer1M: `$${GEMINI_STUDIO_PRICING.pro.cacheReadPerMillion}`
            }
        },
        accounts: accountReports
    };
}

/**
 * Format a usage report as an ASCII table string for CLI/terminal
 * @param {Object} report - Output of generateUsageReport()
 * @returns {string} Formatted plain text table
 */
export function formatUsageReportTable(report) {
    const lines = [];
    const ts = new Date(report.timestamp).toLocaleString();
    lines.push('='.repeat(95));
    lines.push(`                   GEMINI BYOK & VERTEX PAYG USAGE & SPEND REPORT`);
    lines.push(`                             ${ts}`);
    lines.push('='.repeat(95));
    lines.push('');

    // Summary
    const s = report.summary;
    const capStr = s.totalCapUsd > 0 ? ` / $${s.totalCapUsd.toFixed(2)} (${((s.totalSpendUsd / s.totalCapUsd) * 100).toFixed(1)}%)` : ' (No Total Cap)';
    lines.push('Summary:');
    lines.push(`  Total Tracked Accounts: ${s.totalByokAccounts} (${s.activeAccounts} Active, ${s.cappedAccounts} Capped)`);
    lines.push(`  Total Spend:          $${s.totalSpendUsd.toFixed(4)}${capStr}`);
    lines.push(`  Total Requests:       ${s.totalRequests.toLocaleString()}`);
    lines.push(`  Total Tokens:         ${s.totalTokens.total.toLocaleString()} (${s.totalTokens.input.toLocaleString()} In, ${s.totalTokens.output.toLocaleString()} Out, ${s.totalTokens.cached.toLocaleString()} Cached)`);
    lines.push('');

    // Accounts Table
    lines.push('Accounts:');
    const colEmail = 24;
    const colSpend = 24;
    const colStatus = 18;
    const colReq = 10;
    const colTokens = 16;

    const accHeader = 'Account'.padEnd(colEmail) +
                      'Spend / Cap'.padEnd(colSpend) +
                      'Status'.padEnd(colStatus) +
                      'Requests'.padEnd(colReq) +
                      'Total Tokens';
    lines.push(accHeader);
    lines.push('─'.repeat(colEmail + colSpend + colStatus + colReq + colTokens));

    if (report.accounts.length === 0) {
        lines.push('  No Gemini BYOK accounts configured.');
    } else {
        for (const acc of report.accounts) {
            const email = (acc.email || '').slice(0, colEmail - 2).padEnd(colEmail);
            const spend = acc.spendCapUsd !== null
                ? `$${acc.currentSpendUsd.toFixed(2)} / $${acc.spendCapUsd.toFixed(2)} (${acc.capPercentage}%)`
                : `$${acc.currentSpendUsd.toFixed(4)} (No Cap)`;
            const spendCol = spend.slice(0, colSpend - 1).padEnd(colSpend);
            const statusCol = acc.status.slice(0, colStatus - 1).padEnd(colStatus);
            const reqCol = String(acc.totalRequests).padEnd(colReq);
            const tokCol = acc.tokens.total.toLocaleString();
            lines.push(email + spendCol + statusCol + reqCol + tokCol);
        }
    }
    lines.push('');

    // Model breakdown table
    const models = Object.entries(s.spendByModel);
    if (models.length > 0) {
        lines.push('Model Breakdown:');
        const colMod = 24;
        const colMReq = 10;
        const colMIn = 14;
        const colMOut = 14;
        const colMCost = 12;

        const mHeader = 'Model'.padEnd(colMod) +
                        'Requests'.padEnd(colMReq) +
                        'Input Tokens'.padEnd(colMIn) +
                        'Output Tokens'.padEnd(colMOut) +
                        'Cost ($)';
        lines.push(mHeader);
        lines.push('─'.repeat(colMod + colMReq + colMIn + colMOut + colMCost));

        for (const [model, stats] of models) {
            const mName = model.slice(0, colMod - 2).padEnd(colMod);
            const req = String(stats.requests).padEnd(colMReq);
            const inTok = stats.inputTokens.toLocaleString().padEnd(colMIn);
            const outTok = stats.outputTokens.toLocaleString().padEnd(colMOut);
            const cost = `$${stats.costUsd.toFixed(4)}`;
            lines.push(mName + req + inTok + outTok + cost);
        }
        lines.push('='.repeat(95));
    }

    return lines.join('\n');
}
