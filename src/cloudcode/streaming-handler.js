/**
 * Streaming Handler for Cloud Code
 *
 * Handles streaming message requests with multi-account support,
 * retry logic, and endpoint failover.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_EMPTY_RESPONSE_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS,
    DEFAULT_COOLDOWN_MS,
    SWITCH_ACCOUNT_DELAY_MS,
    MAX_CONSECUTIVE_FAILURES,
    EXTENDED_COOLDOWN_MS,
    CAPACITY_BACKOFF_TIERS_MS,
    MAX_CAPACITY_RETRIES,
    BACKOFF_BY_ERROR_TYPE
} from '../constants.js';
import { isRateLimitError, isAuthError, isEmptyResponseError, isAccountForbiddenError, AccountForbiddenError } from '../errors.js';
import { formatDuration, sleep, isNetworkError, throttledFetch, getSemaphoreStats, recordRateLimitHit } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { streamSSEResponse } from './sse-streamer.js';
import { getFallbackModel } from '../fallback-config.js';
import {
    getRateLimitBackoff,
    clearRateLimitState,
    isPermanentAuthFailure,
    isModelCapacityExhausted,
    isValidationRequired,
    extractVerificationUrl,
    isAccountBanned,
    calculateSmartBackoff
} from './rate-limit-state.js';
import { sessionRouter, extractSessionKey } from './session-manager.js';
import crypto from 'crypto';

import { streamGeminiByok } from './gemini-byok-streamer.js';

/**
 * Send a streaming request to Cloud Code with multi-account support
 * Streams events in real-time as they arrive from the server
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} anthropicRequest.model - Model name to use
 * @param {Array} anthropicRequest.messages - Array of message objects
 * @param {number} [anthropicRequest.max_tokens] - Maximum tokens to generate
 * @param {Object} [anthropicRequest.thinking] - Thinking configuration
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @yields {Object} Anthropic-format SSE events (message_start, content_block_start, content_block_delta, etc.)
 * @throws {Error} If max retries exceeded or no accounts available
 */
export async function* sendMessageStream(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;
    let totalRateLimitWaitMs = 0;

    // Check if model is a Gemini model and a gemini-byok default account is configured
    const byokDefault = accountManager.getGeminiByokDefaultAccount?.(model);
    if (byokDefault) {
        yield* streamGeminiByok(anthropicRequest, byokDefault);
        return;
    }

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    const maxAttempts = MAX_RETRIES;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Clear any expired rate limits before picking
        accountManager.clearExpiredLimits();

        // Get available accounts for this model
        const availableAccounts = accountManager.getAvailableAccounts(model);
        const totalAccounts = accountManager.getAccountCount();
        const lockedCount = totalAccounts - availableAccounts.length;
        const semStats = getSemaphoreStats();
        logger.debug(`[Pool] model=${model} attempt=${attempt + 1}/${maxAttempts} | available=${availableAccounts.length}/${totalAccounts} (locked=${lockedCount}) | semaphore: active=${semStats.active}/${semStats.max} queued=${semStats.queued} served=${semStats.totalServed} 429s=${semStats.total429s}`);

        // If no accounts available, check if we should wait or throw error
        if (availableAccounts.length === 0) {
            // Check for Gemini-BYOK fallback account
            const byokFallback = accountManager.getGeminiByokFallbackAccount?.();
            if (byokFallback) {
                logger.info(`[CloudCode] 🔀 All Cloud Code accounts unavailable for ${model}, routing to Gemini-BYOK key`);
                yield* streamGeminiByok(anthropicRequest, byokFallback);
                return;
            }

            // All accounts invalid? Fail immediately — they need user intervention (WebUI FIX button)
            if (accountManager.isAllAccountsInvalid()) {
                const invalidAccounts = accountManager.getInvalidAccounts();
                const reasons = [...new Set(invalidAccounts.map(a => a.invalidReason).filter(Boolean))];
                throw new Error(
                    `All accounts are invalid: ${reasons.join('; ') || 'unknown reason'}. Visit the WebUI to fix them.`
                );
            }

            if (accountManager.isAllRateLimited(model)) {
                if (fallbackEnabled) {
                    const fallbackModel = getFallbackModel(model);
                    if (fallbackModel && fallbackModel !== model) {
                        logger.info(`[CloudCode] 🔀 All accounts rate-limited for ${model}, dynamically falling back to ${fallbackModel}`);
                        const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                        yield* sendMessageStream(fallbackRequest, accountManager, false);
                        return;
                    }
                }
                const minWaitMs = accountManager.getMinWaitTimeMs(model);
                if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
                    throw new Error(`All accounts rate-limited for ${model}. Shortest wait: ${formatDuration(minWaitMs)}`);
                }
                const sleepTime = Math.min(minWaitMs, 3000);
                totalRateLimitWaitMs += sleepTime;
                if (totalRateLimitWaitMs > 30000) {
                    throw new Error(`All accounts rate-limited for ${model}. Please try again shortly.`);
                }
                logger.warn(`[CloudCode] All accounts rate-limited. Waiting ${sleepTime}ms before retry (${totalRateLimitWaitMs}ms total, shortest wait: ${formatDuration(minWaitMs)})...`);
                await sleep(sleepTime);
                accountManager.clearExpiredLimits();
                continue;
            }

            // No accounts available and not rate-limited
            throw new Error('No accounts available');
        }

        // Extract session key for sticky routing
        const sessionKey = extractSessionKey(anthropicRequest);
        const pinnedAccount = sessionRouter.getPinnedAccount(sessionKey, model, availableAccounts);

        let account = pinnedAccount;
        let waitMs = 0;

        // If no pinned account or previous account is no longer healthy, select via strategy
        if (!account) {
            const selected = accountManager.selectAccount(model, { sessionKey });
            account = selected.account;
            waitMs = selected.waitMs;
            if (account) {
                sessionRouter.bindSession(sessionKey, account.email, model);
            }
        }

        // If strategy returns a wait time without an account, sleep and retry
        if (!account && waitMs > 0) {
            logger.info(`[CloudCode] Waiting ${formatDuration(waitMs)} for account...`);
            await sleep(waitMs + 500);
            attempt--; // CRITICAL FIX: Don't count strategy wait as failure
            continue;
        }

        // If strategy returns an account with throttle wait (fallback mode), apply delay
        // This prevents overwhelming the API when using emergency/lastResort fallbacks
        if (account && waitMs > 0) {
            logger.debug(`[CloudCode] Throttling request (${waitMs}ms) - fallback mode active`);
            await sleep(waitMs);
        }

        if (!account) {
            logger.warn(`[CloudCode] Strategy returned no account for ${model} (attempt ${attempt + 1}/${maxAttempts})`);
            continue;
        }

        logger.info(`[CloudCode] 🎯 Attempt ${attempt + 1}/${maxAttempts} for ${model} -> selected account: ${account.email} (pinned: ${account === pinnedAccount})`);

        // Check for Account-level Gemini-BYOK key with default routing for Gemini models
        const isGeminiModel = model.toLowerCase().startsWith('gemini') || model.toLowerCase().includes('flash') || model.toLowerCase().includes('pro');
        if (account.byokApiKey && account.byokMode === 'default_for_gemini_models' && isGeminiModel) {
            logger.info(`[CloudCode] 🔑 Executing ${model} via ${account.email}'s attached Gemini-BYOK key`);
            yield* streamGeminiByok(anthropicRequest, { apiKey: account.byokApiKey });
            return;
        }

        try {
            // ── PROFILING: token fetch ──────────────────────────────────────────
            const t0 = Date.now();
            const token = await accountManager.getTokenForAccount(account);
            const tokenMs = Date.now() - t0;

            // ── PROFILING: project fetch ────────────────────────────────────────
            const t1 = Date.now();
            const project = await accountManager.getProjectForAccount(account, token);
            const projectMs = Date.now() - t1;

            const payload = buildCloudCodeRequest(anthropicRequest, project, account.email);

            logger.info(`[CloudCode] 🔑 Token & project resolved for ${account.email} (token: ${tokenMs}ms, project: ${projectMs}ms, project: ${project || 'default'})`);

            // Try each endpoint with index-based loop for capacity retry support
            let lastError = null;
            let capacityRetryCount = 0;
            let rpmRetryCount = 0;     // RPM burst retries — retries same account when quota is available
            let endpointIndex = 0;

            while (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
                const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex];
                try {
                    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
                    logger.info(`[CloudCode] 🌐 Dispatching stream request -> ${endpoint} (account: ${account.email})`);

                    // ── PROFILING: HTTP TTFB ────────────────────────────────────
                    const tFetch = Date.now();
                    const response = await throttledFetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, 'text/event-stream', payload.request.sessionId, account.email),
                        body: JSON.stringify(payload)
                    });
                    const ttfbMs = Date.now() - tFetch;
                    if (response.ok) {
                        logger.info(`[PERF][CloudCode] ⚡ TTFB=${ttfbMs}ms endpoint=${endpoint} account=${account.email}${ttfbMs > 3000 ? ' ⚠️ SLOW_TTFB' : ''}`);
                    }

                    if (!response.ok) {
                        const errorText = await response.text();
                        const reqSummary = {
                            model,
                            msgs: payload.generationConfig?.candidateCount || payload.contents?.length || '?',
                            tools: payload.tools?.flatMap(t => t.functionDeclarations || []).map(f => f.name).length || 0,
                            sessionId: payload.request?.sessionId || 'none',
                            contentRoles: payload.contents?.map(c => c.role).join(',') || 'empty',
                            lastMsgPreview: JSON.stringify(payload.contents?.at(-1)?.parts?.[0])?.substring(0, 200) || 'none',
                            headers: Object.fromEntries(Object.entries(buildHeaders(token, model, 'text/event-stream', payload.request?.sessionId, account.email)).filter(([k]) => !k.toLowerCase().includes('auth'))),
                        };
                        logger.warn(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);
                        logger.warn(`[CloudCode] ❗ Failed request details: ${JSON.stringify(reqSummary)}`);

                        if (response.status === 401) {
                            // Check for permanent auth failures
                            if (isPermanentAuthFailure(errorText)) {
                                logger.error(`[CloudCode] Permanent auth failure for ${account.email}: ${errorText.substring(0, 100)}`);
                                accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                throw new Error(`AUTH_INVALID_PERMANENT: ${errorText}`);
                            }

                            // Transient auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            endpointIndex++;
                            continue;
                        }

                        if (response.status === 429 || (response.status === 400 && isRateLimitError({ message: errorText }))) {
                            recordRateLimitHit(); // track global 429 counter
                            const resetMs = parseResetTime(response, errorText);
                            const consecutiveFailures = accountManager.getConsecutiveFailures?.(account.email) || 0;
                            const semStats = getSemaphoreStats();
                            logger.info(`[Pool] 429 on ${account.email} | pool: ${accountManager.getAvailableAccounts(model).length - 1}/${accountManager.getAccountCount()} now available | sem: active=${semStats.active}/${semStats.max} queued=${semStats.queued} total429s=${semStats.total429s}`);

                            // Check if capacity issue (NOT quota) - retry same endpoint with progressive backoff
                            if (isModelCapacityExhausted(errorText)) {
                                if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                    // Progressive capacity backoff tiers
                                    const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                    const waitMs = resetMs || CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                    capacityRetryCount++;
                                    // Track failures for progressive backoff escalation (matches opencode-antigravity-auth)
                                    accountManager.incrementConsecutiveFailures(account.email);
                                    logger.info(`[CloudCode] Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                    await sleep(waitMs);
                                    // Don't increment endpointIndex - retry same endpoint
                                    continue;
                                }
                                // Max capacity retries exceeded - treat as quota exhaustion
                                logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded, switching account`);
                            }

                            // ── RPM vs Quota detection via quota cross-reference ──────────
                            // Google's RESOURCE_EXHAUSTED is identical for RPM rate limits and
                            // daily quota exhaustion. The ONLY way to tell them apart is to check
                            // the account's known remaining quota from fetchAvailableModels.
                            // This fraction is passed to calculateSmartBackoff→parseRateLimitReason
                            // so RPM gets classified as RATE_LIMIT_EXCEEDED (short lockout, switch
                            // account) instead of QUOTA_EXHAUSTED (long lockout).
                            const knownQuota = account.quota?.models?.[model]?.remainingFraction ?? null;

                            // Get rate limit backoff with exponential backoff and state reset
                            const backoff = getRateLimitBackoff(account.email, model, resetMs);

                            // For very short rate limits (< 1 second), always wait and retry
                            // Switching accounts won't help when all accounts have per-second rate limits
                            if (resetMs !== null && resetMs < 1000) {
                                const waitMs = resetMs;
                                logger.info(`[CloudCode] Short rate limit on ${account.email} (${resetMs}ms), waiting and retrying...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            }

                            // If within dedup window AND reset time is >= 1s, check for fallback endpoint or switch account
                            if (backoff.isDuplicate) {
                                if (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                                    logger.info(`[CloudCode] Rate limit on ${endpoint} for ${account.email}, trying fallback endpoint...`);
                                    endpointIndex++;
                                    continue;
                                }
                                const smartBackoffMs = calculateSmartBackoff(errorText, resetMs, consecutiveFailures, knownQuota);
                                logger.info(`[CloudCode] Skipping retry due to recent rate limit on ${account.email} (attempt ${backoff.attempt}), switching account...`);
                                accountManager.markRateLimited(account.email, smartBackoffMs, model);
                                throw new Error(`RATE_LIMITED_DEDUP: ${errorText}`);
                            }

                            // Calculate smart backoff based on error type + known quota context
                            const smartBackoffMs = calculateSmartBackoff(errorText, resetMs, consecutiveFailures, knownQuota);

                            // Decision: wait and retry OR try next endpoint OR switch account
                            // First 429 gets a quick 1s retry (FIRST_RETRY_DELAY_MS)
                            if (backoff.attempt === 1 && smartBackoffMs <= DEFAULT_COOLDOWN_MS) {
                                // Quick 1s retry on first 429 (matches opencode-antigravity-auth)
                                const waitMs = backoff.delayMs;
                                accountManager.markRateLimited(account.email, waitMs, model);
                                logger.info(`[CloudCode] First rate limit on ${account.email}, quick retry after ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                continue;
                            } else if (endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                                // Multi-endpoint fallthrough: if primary (PROD) is rate-limited/exhausted, try secondary (STAGE/DAILY) for this account!
                                logger.info(`[CloudCode] Rate limit on ${endpoint} for ${account.email}, falling back to next endpoint (${ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex + 1]})...`);
                                endpointIndex++;
                                continue;
                            } else if (smartBackoffMs > DEFAULT_COOLDOWN_MS) {
                                // Long-term quota exhaustion across all endpoints - switch account fast
                                logger.info(`[CloudCode] Quota exhausted across all endpoints for ${account.email} (${formatDuration(smartBackoffMs)}), switching account...`);
                                if (SWITCH_ACCOUNT_DELAY_MS > 0) await sleep(SWITCH_ACCOUNT_DELAY_MS);
                                accountManager.markRateLimited(account.email, smartBackoffMs, model);
                                throw new Error(`QUOTA_EXHAUSTED: ${errorText}`);
                            } else {
                                // Short-term rate limit - use exponential backoff delay
                                const waitMs = backoff.delayMs;
                                accountManager.markRateLimited(account.email, waitMs, model);
                                logger.info(`[CloudCode] Rate limit on ${account.email} (attempt ${backoff.attempt}), waiting ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                continue;
                            }
                        }

                        // Check for 503/529 MODEL_CAPACITY_EXHAUSTED - use progressive backoff like 429 capacity
                        // 529 = Site Overloaded (same treatment as 503)
                        if ((response.status === 503 || response.status === 529) && isModelCapacityExhausted(errorText)) {
                            if (capacityRetryCount < MAX_CAPACITY_RETRIES) {
                                // Progressive capacity backoff tiers (same as 429 capacity handling)
                                const tierIndex = Math.min(capacityRetryCount, CAPACITY_BACKOFF_TIERS_MS.length - 1);
                                const waitMs = CAPACITY_BACKOFF_TIERS_MS[tierIndex];
                                capacityRetryCount++;
                                accountManager.incrementConsecutiveFailures(account.email);
                                logger.info(`[CloudCode] ${response.status} Model capacity exhausted, retry ${capacityRetryCount}/${MAX_CAPACITY_RETRIES} after ${formatDuration(waitMs)}...`);
                                await sleep(waitMs);
                                // Don't increment endpointIndex - retry same endpoint
                                continue;
                            }
                            // Max capacity retries exceeded - switch account
                            logger.warn(`[CloudCode] Max capacity retries (${MAX_CAPACITY_RETRIES}) exceeded on ${response.status}, switching account`);
                            accountManager.markRateLimited(account.email, BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED, model);
                            throw new Error(`CAPACITY_EXHAUSTED: ${errorText}`);
                        }

                        // 400 errors are client errors - fail immediately, don't retry or switch accounts
                        // Examples: token limit exceeded, invalid schema, malformed request
                        if (response.status === 400) {
                            logger.error(`[CloudCode] Invalid request (400): ${errorText.substring(0, 200)}`);
                            throw new Error(`invalid_request_error: ${errorText}`);
                        }

                        // 403 with VALIDATION_REQUIRED or PERMISSION_DENIED is an account-level error
                        // The account needs validation (captcha, terms, etc.) - trying different endpoints won't help
                        // Mark account as invalid (requires user intervention) and rotate (fixes #248)
                        if (response.status === 403 && isValidationRequired(errorText)) {
                            const verifyUrl = extractVerificationUrl(errorText);
                            logger.warn(`[CloudCode] 403 VALIDATION_REQUIRED/PERMISSION_DENIED for ${account.email}, marking invalid and rotating account...`);
                            accountManager.markInvalid(account.email, 'Account requires verification', verifyUrl);
                            throw new AccountForbiddenError(errorText, account.email);
                        }

                        // 403 with permanent ToS ban — account is permanently disabled by Google
                        // Unlike VALIDATION_REQUIRED, this cannot be resolved by verification
                        if (response.status === 403 && isAccountBanned(errorText)) {
                            logger.warn(`[CloudCode] 403 ToS BANNED for ${account.email}, marking invalid permanently...`);
                            accountManager.markInvalid(account.email, 'Account banned — Gemini disabled for Terms of Service violation');
                            throw new AccountForbiddenError(errorText, account.email);
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);

                        // Try next endpoint for 403/404/5xx errors (matches opencode-antigravity-auth behavior)
                        if (response.status === 403 || response.status === 404) {
                            logger.warn(`[CloudCode] ${response.status} at ${endpoint}..`);
                        } else if (response.status >= 500) {
                            logger.warn(`[CloudCode] ${response.status} stream error, waiting 1s before retry...`);
                            await sleep(1000);
                        }

                        endpointIndex++;
                        continue;
                    }

                    // Stream the response with retry logic for empty responses
                    let currentResponse = response;

                    for (let emptyRetries = 0; emptyRetries <= MAX_EMPTY_RESPONSE_RETRIES; emptyRetries++) {
                        try {
                            // ── PROFILING: stream duration ──────────────────────
                            const tStream = Date.now();
                            let outputTokens = 0;
                            for await (const event of streamSSEResponse(currentResponse, anthropicRequest.model)) {
                                // Log Google TPU Prompt Cache metrics from message_delta (where Google emits final usage)
                                if (event?.type === 'message_delta' && event?.usage) {
                                    const u = event.usage;
                                    const cached = u.cache_read_input_tokens || 0;
                                    const input = u.input_tokens || 0;
                                    const total = cached + input;
                                    if (cached > 0) {
                                        const pct = ((cached / total) * 100).toFixed(1);
                                        logger.info(`[CACHE][TPU-HIT] ⚡ ${cached}/${total} tokens (${pct}%) served from Google TPU prompt cache`);
                                    } else if (input > 0) {
                                        logger.info(`[CACHE][TPU-MISS] ❄️ ${input} input tokens ingested cold (first turn / cache expired)`);
                                    }
                                    if (u.output_tokens) {
                                        outputTokens = u.output_tokens;
                                    }
                                }
                                yield event;
                            }
                            const streamMs = Date.now() - tStream;
                            const tokPerSec = outputTokens > 0 ? (outputTokens / (streamMs / 1000)).toFixed(1) : 'N/A';
                            logger.info(`[PERF][CloudCode] stream=${streamMs}ms outputTokens=${outputTokens} throughput=${tokPerSec} tok/s account=${account.email}${streamMs > 30000 ? ' ⚠️ SLOW_STREAM' : ''}`);
                            logger.debug('[CloudCode] Stream completed');
                            // Clear rate limit state on success
                            clearRateLimitState(account.email, model);
                            accountManager.notifySuccess(account, model);
                            return;
                        } catch (streamError) {
                            // Only retry on EmptyResponseError
                            if (!isEmptyResponseError(streamError)) {
                                throw streamError;
                            }

                            // Check if we have retries left
                            if (emptyRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
                                logger.error(`[CloudCode] Empty response after ${MAX_EMPTY_RESPONSE_RETRIES} retries`);
                                yield* emitEmptyResponseFallback(anthropicRequest.model);
                                return;
                            }

                            // Exponential backoff: 500ms, 1000ms, 2000ms
                            const backoffMs = 500 * Math.pow(2, emptyRetries);
                            logger.warn(`[CloudCode] Empty response, retry ${emptyRetries + 1}/${MAX_EMPTY_RESPONSE_RETRIES} after ${backoffMs}ms...`);
                            await sleep(backoffMs);

                            // Refetch the response
                            currentResponse = await throttledFetch(url, {
                                method: 'POST',
                                headers: buildHeaders(token, model, 'text/event-stream', payload.request.sessionId, account.email),
                                body: JSON.stringify(payload)
                            });

                            // Handle specific error codes on retry
                            if (!currentResponse.ok) {
                                const retryErrorText = await currentResponse.text();

                                // Rate limit error - mark account and throw to trigger account switch
                                if (currentResponse.status === 429) {
                                    const resetMs = parseResetTime(currentResponse, retryErrorText);
                                    accountManager.markRateLimited(account.email, resetMs, model);
                                    throw new Error(`429 RESOURCE_EXHAUSTED during retry: ${retryErrorText}`);
                                }

                                // Auth error - check for permanent failure
                                if (currentResponse.status === 401) {
                                    if (isPermanentAuthFailure(retryErrorText)) {
                                        logger.error(`[CloudCode] Permanent auth failure during retry for ${account.email}`);
                                        accountManager.markInvalid(account.email, 'Token revoked - re-authentication required');
                                        throw new Error(`AUTH_INVALID_PERMANENT: ${retryErrorText}`);
                                    }
                                    accountManager.clearTokenCache(account.email);
                                    accountManager.clearProjectCache(account.email);
                                    throw new Error(`401 AUTH_INVALID during retry: ${retryErrorText}`);
                                }

                                // For 5xx errors, continue retrying
                                if (currentResponse.status >= 500) {
                                    logger.warn(`[CloudCode] Retry got ${currentResponse.status}, will retry...`);
                                    await sleep(1000);
                                    currentResponse = await throttledFetch(url, {
                                        method: 'POST',
                                        headers: buildHeaders(token, model, 'text/event-stream', payload.request.sessionId, account.email),
                                        body: JSON.stringify(payload)
                                    });
                                    if (currentResponse.ok) {
                                        continue;
                                    }
                                }

                                throw new Error(`Empty response retry failed: ${currentResponse.status} - ${retryErrorText}`);
                            }
                        }
                    }

                } catch (endpointError) {
                    if (isRateLimitError(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    if (isEmptyResponseError(endpointError)) {
                        throw endpointError;
                    }
                    // 403 account-level errors - re-throw to trigger account rotation
                    if (isAccountForbiddenError(endpointError)) {
                        throw endpointError;
                    }
                    // 400 errors are client errors - re-throw immediately, don't retry
                    if (endpointError.message?.includes('400')) {
                        throw endpointError;
                    }
                    logger.warn(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                    endpointIndex++;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                if (lastError.is429 || lastError.message?.includes('429') || lastError.message?.includes('RESOURCE_EXHAUSTED')) {
                    logger.warn(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs, model);
                    throw new Error(`Rate limited: ${lastError.errorText || lastError.message}`);
                }
                // For 404 or transient endpoint errors on this account, notify failure and rotate to next account!
                accountManager.notifyFailure(account, model);
                logger.warn(`[CloudCode] Account ${account.email} failed on all endpoints (${lastError.message}), trying next account...`);
                continue;
            }

        } catch (error) {
            // Check for Account-level Gemini-BYOK key fallback on rate limit or quota exhaustion
            if (account.byokApiKey && (isRateLimitError(error) || error.message?.includes('RESOURCE_EXHAUSTED') || error.message?.includes('QUOTA_EXHAUSTED') || isAccountForbiddenError(error))) {
                logger.info(`[CloudCode] 🔀 Account ${account.email} hit limit, executing fallback via account's attached Gemini-BYOK key`);
                yield* streamGeminiByok(anthropicRequest, { apiKey: account.byokApiKey });
                return;
            }

            if (isRateLimitError(error)) {
                // Rate limited - already marked, notify strategy and continue to next account
                accountManager.notifyRateLimit(account, model);
                logger.info(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthError(error)) {
                // Auth invalid - already marked, continue to next account
                logger.warn(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            if (isAccountForbiddenError(error)) {
                // 403 VALIDATION_REQUIRED / PERMISSION_DENIED - account-level error
                // Already marked with cooldown, notify strategy and rotate to next account
                accountManager.notifyFailure(account, model);
                logger.warn(`[CloudCode] Account ${account.email} forbidden (403 VALIDATION_REQUIRED), trying next...`);
                continue;
            }
            // Handle 5xx errors
            if (error.message.includes('API error 5') || error.message.includes('500') || error.message.includes('503')) {
                accountManager.notifyFailure(account, model);

                // Track 5xx errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Account ${account.email} failed with 5xx stream error (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next...`);
                }
                continue;
            }

            if (isNetworkError(error)) {
                accountManager.notifyFailure(account, model);

                // Track network errors for extended cooldown
                // Note: markRateLimited already increments consecutiveFailures internally
                const currentFailures = accountManager.getConsecutiveFailures(account.email);
                if (currentFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
                    logger.warn(`[CloudCode] Account ${account.email} has ${currentFailures + 1} consecutive network failures, applying extended cooldown (${formatDuration(EXTENDED_COOLDOWN_MS)})`);
                    accountManager.markRateLimited(account.email, EXTENDED_COOLDOWN_MS, model);
                } else {
                    accountManager.incrementConsecutiveFailures(account.email);
                    logger.warn(`[CloudCode] Network error for ${account.email} (stream) (${currentFailures + 1}/${MAX_CONSECUTIVE_FAILURES}), trying next account... (${error.message})`);
                }
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    // All retries exhausted - try fallback model if enabled
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[CloudCode] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel} (streaming)`);
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            yield* sendMessageStream(fallbackRequest, accountManager, false);
            return;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Emit a fallback message when all retry attempts fail with empty response
 * @param {string} model - The model name
 * @yields {Object} Anthropic-format SSE events for empty response fallback
 */
function* emitEmptyResponseFallback(model) {
    // Use proper message ID format consistent with Anthropic API
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };

    yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    };

    yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '[No response after retries - please try again]' }
    };

    yield { type: 'content_block_stop', index: 0 };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 }
    };

    yield { type: 'message_stop' };
}
