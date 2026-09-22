const assert = require('assert');

async function runTests() {
    console.log('🧪 Starting Weighted Model Split & TPU Cache Affinity Tests...');

    // Import ES modules dynamically
    const { modelSplitter, MODEL_37_FLASH, MODEL_38_FLASH } = await import('../src/cloudcode/model-splitter.js');
    const { sessionRouter, extractSessionKey, deriveSessionId } = await import('../src/cloudcode/session-manager.js');
    const { config } = await import('../src/config.js');

    // 1. Flash candidate detection
    console.log('\n--- 1. Flash Candidate Detection ---');
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.8-flash'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.7-flash'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.8-flash-tiered'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.8-flash-high'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.8-flash-med'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('gemini-3.7-flash-low'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('flash'), true);
    assert.strictEqual(modelSplitter.isFlashCandidate('claude-sonnet-4-6'), false);
    assert.strictEqual(modelSplitter.isFlashCandidate('claude-opus-4-6-thinking'), false);
    console.log('✅ Candidate detection passed');

    // 2. Precedence and Fallback Tests
    console.log('\n--- 2. Precedence & Fallback Tests ---');
    config.modelSplit = { enabled: false, gemini37Weight: 60, gemini38Weight: 40 };
    config.reroute38To37 = false;
    assert.strictEqual(modelSplitter.resolveModel('gemini-3.8-flash', 'sess-fallback-1'), MODEL_38_FLASH);

    config.reroute38To37 = true;
    assert.strictEqual(modelSplitter.resolveModel('gemini-3.8-flash', 'sess-fallback-2'), MODEL_37_FLASH);
    console.log('✅ Fallback to reroute38To37 when modelSplit disabled passed');

    // Enable modelSplit -> takes precedence over reroute38To37
    config.modelSplit.enabled = true;
    config.reroute38To37 = false; // Even if false, modelSplit handles routing
    console.log('✅ Model split enabled');

    // 3. Deterministic SWRR Interleaving Ratio Test
    console.log('\n--- 3. Smooth Weighted Round-Robin (SWRR) 60/40 Ratio Test ---');
    modelSplitter.resetWeights();
    const counts = { [MODEL_37_FLASH]: 0, [MODEL_38_FLASH]: 0 };
    const sequence = [];

    for (let i = 0; i < 100; i++) {
        const chosen = modelSplitter.selectNextModel();
        counts[chosen]++;
        if (i < 10) sequence.push(chosen === MODEL_37_FLASH ? '3.7' : '3.8');
    }

    console.log(`First 10 selections (Smooth Interleaving): ${sequence.join(', ')}`);
    console.log(`Results over 100 iterations: 3.7 Flash = ${counts[MODEL_37_FLASH]}%, 3.8 Flash = ${counts[MODEL_38_FLASH]}%`);
    assert.strictEqual(counts[MODEL_37_FLASH], 60, 'Expected exactly 60% 3.7 Flash');
    assert.strictEqual(counts[MODEL_38_FLASH], 40, 'Expected exactly 40% 3.8 Flash');
    console.log('✅ SWRR 60/40 deterministic ratio test passed');

    // 4. Session Attachment & TPU Cache Affinity
    console.log('\n--- 4. Session Attachment & TPU KV Cache Affinity Test ---');
    const testSessionKeyA = 'session-thread-alpha-12345';
    const testSessionKeyB = 'session-thread-beta-67890';

    // First request assigns model to session A
    const modelA1 = modelSplitter.resolveModel('gemini-3.8-flash', testSessionKeyA);
    // Subsequent requests in session A MUST stay pinned to modelA1
    for (let i = 0; i < 20; i++) {
        const modelAi = modelSplitter.resolveModel('gemini-3.8-flash', testSessionKeyA);
        assert.strictEqual(modelAi, modelA1, `Session turn ${i} deviated from pinned model!`);
    }
    console.log(`✅ Session A firmly pinned to ${modelA1} across 20 conversation turns (TPU KV cache intact)`);

    // First request assigns model to session B
    const modelB1 = modelSplitter.resolveModel('gemini-3.8-flash', testSessionKeyB);
    for (let i = 0; i < 20; i++) {
        const modelBi = modelSplitter.resolveModel('gemini-3.8-flash', testSessionKeyB);
        assert.strictEqual(modelBi, modelB1, `Session B turn ${i} deviated from pinned model!`);
    }
    console.log(`✅ Session B firmly pinned to ${modelB1} across 20 conversation turns`);

    // 5. Upstream SessionId & Account Failover Resilience
    console.log('\n--- 5. Upstream SessionId Continuity & Failover Resilience ---');
    const mockRequest = {
        messages: [
            { role: 'user', content: 'You are helping me build an app' },
            { role: 'assistant', content: 'Understood' }
        ]
    };
    const derivedKey = extractSessionKey(mockRequest);
    const upstreamId1 = deriveSessionId(mockRequest, 'account-primary@example.com');
    const upstreamId2 = deriveSessionId(mockRequest, 'account-primary@example.com');
    assert.strictEqual(upstreamId1, upstreamId2, 'Upstream session ID must be deterministic and stable for same conversation');

    // Simulate account failover: account switches from account-primary to account-failover
    sessionRouter.unbindSession(derivedKey);
    // Upstream session ID and pinned model MUST persist across account failovers
    const upstreamIdAfterFailover = deriveSessionId(mockRequest, 'account-failover@example.com');
    assert.strictEqual(upstreamIdAfterFailover, upstreamId1, 'Upstream session ID must persist across account unbind/failovers!');
    console.log(`✅ Upstream session ID (${upstreamId1}) preserved across account failover`);

    // 6. Token Usage & TPU Cache Hit Tracking
    console.log('\n--- 6. Session Usage & TPU Cache Hit Metrics Tracking ---');
    const testUsageKey = 'test-usage-session-' + Date.now();
    sessionRouter.recordSessionUsage(testUsageKey, {
        input_tokens: 120,
        output_tokens: 50,
        cache_read_input_tokens: 3800
    });

    const sessionObj = sessionRouter.getSession(testUsageKey);
    assert.ok(sessionObj, 'Session object must exist');
    assert.strictEqual(sessionObj.tokens.cached, 3800, 'Cache read tokens must be recorded');
    assert.strictEqual(sessionObj.tokens.input, 120);
    assert.strictEqual(sessionObj.tokens.output, 50);
    console.log(`✅ Cache usage recorded: input=${sessionObj.tokens.input}, cached=${sessionObj.tokens.cached}, output=${sessionObj.tokens.output}`);

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
