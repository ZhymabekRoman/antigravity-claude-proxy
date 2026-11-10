/**
 * Account Storage
 *
 * Handles loading and saving account configuration to disk.
 */

import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Load accounts from the config file
 *
 * @param {string} configPath - Path to the config file
 * @returns {Promise<{accounts: Array, settings: Object, activeIndex: number}>}
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    try {
        // Check if config file exists using async access
        await access(configPath, fsConstants.F_OK);
        const configData = await readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);

        const accounts = (config.accounts || []).map(acc => {
            const isBanned = Boolean(acc.isBanned ||
                (acc.invalidReason && (
                    acc.invalidReason.toLowerCase().includes('banned') ||
                    acc.invalidReason.toLowerCase().includes('terms of service') ||
                    acc.invalidReason.toLowerCase().includes('tos_violation')
                ))
            );
            // Reset invalid flag on startup for transient errors - give accounts a fresh chance
            // Verification errors (verifyUrl) auto-clear if older than 30 minutes (transient Google challenges)
            // Permanent ToS bans (isBanned) NEVER auto-clear
            const hasRecentVerification = Boolean(acc.verifyUrl && (!acc.invalidAt || (Date.now() - acc.invalidAt < 30 * 60 * 1000)));
            const shouldRemainInvalid = isBanned || hasRecentVerification;

            return {
                ...acc,
                lastUsed: acc.lastUsed || null,
                enabled: acc.enabled !== false, // Default to true if not specified
                isBanned: isBanned,
                isInvalid: shouldRemainInvalid ? (acc.isInvalid || false) : false,
                invalidReason: shouldRemainInvalid ? (acc.invalidReason || null) : null,
                verifyUrl: hasRecentVerification ? acc.verifyUrl : null,
                modelRateLimits: acc.modelRateLimits || {},
            // New fields for subscription and quota tracking
            subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
            quota: acc.quota || { models: {}, lastChecked: null },
            // Quota threshold settings (per-account and per-model overrides)
            quotaThreshold: acc.quotaThreshold,  // undefined means use global
            modelQuotaThresholds: acc.modelQuotaThresholds || {},
            // BYOK Spend Cap & Accounting
            spendCapUsd: typeof acc.spendCapUsd === 'number' ? acc.spendCapUsd : (acc.spendCapUsd === null ? null : undefined),
            currentSpendUsd: typeof acc.currentSpendUsd === 'number' ? acc.currentSpendUsd : 0,
            spendStats: acc.spendStats || null
        };
    });

        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        // Clamp activeIndex to valid range
        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[AccountManager] Loaded ${accounts.length} account(s) from config`);

        return { accounts, settings, activeIndex };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // No config file - return empty
            logger.info('[AccountManager] No config file found. Using Antigravity database (single account mode)');
        } else {
            logger.error('[AccountManager] Failed to load config:', error.message);
        }
        return { accounts: [], settings: {}, activeIndex: 0 };
    }
}

/**
 * Load the default account from Antigravity's database
 *
 * @param {string} dbPath - Optional path to the database
 * @returns {{accounts: Array, tokenCache: Map}}
 */
export function loadDefaultAccount(dbPath) {
    try {
        const authData = getAuthStatus(dbPath);
        if (authData?.apiKey) {
            const account = {
                email: authData.email || 'default@antigravity',
                source: 'database',
                lastUsed: null,
                modelRateLimits: {}
            };

            const tokenCache = new Map();
            tokenCache.set(account.email, {
                token: authData.apiKey,
                extractedAt: Date.now()
            });

            logger.info(`[AccountManager] Loaded default account: ${account.email}`);

            return { accounts: [account], tokenCache };
        }
    } catch (error) {
        logger.error('[AccountManager] Failed to load default account:', error.message);
    }

    return { accounts: [], tokenCache: new Map() };
}

/**
 * Save account configuration to disk
 *
 * @param {string} configPath - Path to the config file
 * @param {Array} accounts - Array of account objects
 * @param {Object} settings - Settings object
 * @param {number} activeIndex - Current active account index
 */
export async function saveAccounts(configPath, accounts, settings, activeIndex) {
    // Serialize writes to prevent concurrent corruption
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const mergedAccounts = [...accounts];

        const config = {
            accounts: mergedAccounts.map(acc => ({
                email: acc.email,
                source: acc.source,
                mode: acc.mode || acc.byokMode || undefined,
                description: acc.description || undefined,
                byokApiKey: acc.byokApiKey || (acc.source === 'gemini-byok' ? acc.apiKey : undefined),
                byokMode: acc.byokMode || acc.mode || undefined,
                enabled: acc.enabled !== false,
                dbPath: acc.dbPath || null,
                refreshToken: acc.source === 'oauth' ? acc.refreshToken : undefined,
                apiKey: (acc.source === 'manual' || acc.source === 'gemini-byok') ? (acc.apiKey || acc.byokApiKey) : undefined,
                projectId: acc.projectId || undefined,
                addedAt: acc.addedAt || undefined,
                isBanned: acc.isBanned ? true : undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                verifyUrl: acc.verifyUrl || null,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed,
                subscription: acc.subscription || { tier: 'unknown', projectId: null, detectedAt: null },
                gcpProject: acc.gcpProject || undefined,
                authMethod: acc.authMethod || undefined,
                quota: acc.quota || { models: {}, lastChecked: null },
                quotaThreshold: acc.quotaThreshold,
                modelQuotaThresholds: Object.keys(acc.modelQuotaThresholds || {}).length > 0 ? acc.modelQuotaThresholds : undefined,
                spendCapUsd: typeof acc.spendCapUsd === 'number' ? acc.spendCapUsd : undefined,
                currentSpendUsd: typeof acc.currentSpendUsd === 'number' ? acc.currentSpendUsd : undefined,
                spendStats: acc.spendStats || undefined
            })),
            settings: settings,
            activeIndex: activeIndex
        };

        const json = JSON.stringify(config, null, 2);

        // Validate JSON before writing (prevent saving corrupt data)
        JSON.parse(json);

        // Atomic write: write to temp file then rename
        const tmpPath = configPath + '.tmp';
        await writeFile(tmpPath, json);
        await rename(tmpPath, configPath);
    } catch (error) {
        logger.error('[AccountManager] Failed to save config:', error.message);
    } finally {
        resolve();
    }
}
