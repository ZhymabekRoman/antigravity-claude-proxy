/**
 * Tests for Gemini BYOK Spend Accounting & Usage Reporting
 */

const assert = require('assert');
const {
    calculateGeminiCost,
    recordByokSpend,
    resetByokSpend,
    isByokSpendCapped,
    generateUsageReport,
    formatUsageReportTable
} = require('../src/modules/byok-accounting.js');

console.log('─── Gemini BYOK Spend Accounting Tests ───');

// Test 1: calculateGeminiCost for Flash
{
    const usage = { inputTokens: 1000000, outputTokens: 1000000, cacheTokens: 1000000 };
    const flashCost = calculateGeminiCost('gemini-2.5-flash', usage);
    // Flash rates: 0.075 + 0.30 + 0.01875 = 0.39375
    assert.strictEqual(flashCost.isPro, false);
    assert.strictEqual(flashCost.costUsd, 0.39375);
    console.log('✓ calculateGeminiCost accurately calculates Flash token pricing');
}

// Test 2: calculateGeminiCost for Pro
{
    const usage = { inputTokens: 1000000, outputTokens: 1000000, cacheTokens: 1000000 };
    const proCost = calculateGeminiCost('gemini-2.5-pro', usage);
    // Pro rates: 1.25 + 5.00 + 0.3125 = 6.5625
    assert.strictEqual(proCost.isPro, true);
    assert.strictEqual(proCost.costUsd, 6.5625);
    console.log('✓ calculateGeminiCost accurately calculates Pro token pricing');
}

// Test 3: recordByokSpend updates currentSpendUsd and spendStats
{
    const account = {
        email: 'test-byok@example.com',
        source: 'gemini-byok',
        currentSpendUsd: 0.50,
        spendCapUsd: 1.00
    };

    // 100k input, 50k output on flash -> (0.1 * 0.075) + (0.05 * 0.30) = 0.0075 + 0.015 = 0.0225
    const reqCost = recordByokSpend(account, 'gemini-3.7-flash', {
        input_tokens: 100000,
        output_tokens: 50000,
        cache_read_input_tokens: 0
    });

    assert.strictEqual(reqCost, 0.0225);
    assert.strictEqual(account.currentSpendUsd, 0.5225);
    assert.strictEqual(account.spendStats.totalRequests, 1);
    assert.strictEqual(account.spendStats.inputTokens, 100000);
    assert.strictEqual(account.spendStats.outputTokens, 50000);
    assert.strictEqual(isByokSpendCapped(account), false);
    console.log('✓ recordByokSpend accumulates cost and tracks request stats');
}

// Test 4: isByokSpendCapped detects cap exceeded
{
    const account = {
        email: 'capped@example.com',
        source: 'gemini-byok',
        currentSpendUsd: 5.05,
        spendCapUsd: 5.00
    };
    assert.strictEqual(isByokSpendCapped(account), true);

    const uncapped = {
        email: 'uncapped@example.com',
        source: 'gemini-byok',
        currentSpendUsd: 20.00,
        spendCapUsd: null
    };
    assert.strictEqual(isByokSpendCapped(uncapped), false);
    console.log('✓ isByokSpendCapped correctly gates when budget exceeded');
}

// Test 5: resetByokSpend resets counters
{
    const account = {
        email: 'reset@example.com',
        source: 'gemini-byok',
        currentSpendUsd: 12.34,
        spendStats: { totalRequests: 55, totalTokens: 999999 }
    };
    resetByokSpend(account);
    assert.strictEqual(account.currentSpendUsd, 0);
    assert.strictEqual(account.spendStats.totalRequests, 0);
    assert.ok(account.spendStats.lastResetAt);
    console.log('✓ resetByokSpend resets counters and records timestamp');
}

// Test 6: generateUsageReport and formatUsageReportTable
{
    const accounts = [
        {
            email: 'byok1@example.com',
            source: 'gemini-byok',
            apiKey: 'AIzaSy1234567890abcdef',
            currentSpendUsd: 1.25,
            spendCapUsd: 5.00,
            spendStats: {
                totalRequests: 10,
                inputTokens: 50000,
                outputTokens: 20000,
                cacheTokens: 0,
                totalTokens: 70000,
                costByModel: {
                    'gemini-3.7-flash': { requests: 10, inputTokens: 50000, outputTokens: 20000, cacheTokens: 0, costUsd: 1.25 }
                }
            }
        },
        {
            email: 'byok-capped@example.com',
            source: 'gemini-byok',
            apiKey: 'AIzaSy9876543210fedcba',
            currentSpendUsd: 10.50,
            spendCapUsd: 10.00,
            spendStats: {
                totalRequests: 25,
                inputTokens: 200000,
                outputTokens: 100000,
                cacheTokens: 0,
                totalTokens: 30000,
                costByModel: {
                    'gemini-2.5-pro': { requests: 25, inputTokens: 200000, outputTokens: 100000, cacheTokens: 0, costUsd: 10.50 }
                }
            }
        },
        {
            email: 'oauth@example.com',
            source: 'oauth'
        }
    ];

    const report = generateUsageReport(accounts);
    assert.strictEqual(report.summary.totalByokAccounts, 2);
    assert.strictEqual(report.summary.cappedAccounts, 1);
    assert.strictEqual(report.summary.totalSpendUsd, 11.75);
    assert.strictEqual(report.summary.totalCapUsd, 15.00);

    const tableStr = formatUsageReportTable(report);
    assert.ok(tableStr.includes('GEMINI BYOK USAGE & SPEND REPORT'));
    assert.ok(tableStr.includes('byok1@example.com'));
    assert.ok(tableStr.includes('SPEND_CAP_REACHED'));
    console.log('✓ generateUsageReport & formatUsageReportTable produce accurate report outputs');
}

console.log('\nAll byok-accounting tests passed successfully!');
