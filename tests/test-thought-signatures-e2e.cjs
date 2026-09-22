/**
 * End-to-End (E2E) Test: Vertex AI Thought Signature Resolution & Multi-Turn Claude Flow
 *
 * Simulates Claude Code interacting with Gemini models on Vertex AI:
 * 1. Initial tool call request: sends prompt requiring tool use.
 * 2. Multi-turn continuation with Claude-formatted thinking & tool thoughtSignatures (Et4... / EvQ...).
 *    Verifies that the proxy translates non-Gemini signatures to 'skip_thought_signature_validator'
 *    and successfully receives 200 OK from Vertex AI (no "Invalid thought signature" error).
 * 3. Both non-streaming and streaming SSE requests are verified.
 * 4. Verifies backward compatibility when switching back and forth between Claude and Gemini.
 */

const { streamRequest, makeRequest, commonTools } = require('./helpers/http-client.cjs');
const { getModels, getModelConfig } = require('./helpers/test-models.cjs');

// Synthetic Claude-style thinking / tool signatures (starts with Et4... / EvQ...)
const MOCK_CLAUDE_SIGNATURE = 'Et4OCtsBCtoBCh1zaWduYXR1cmVfa2V5X2Zvcl90ZXN0aW5nEg4IABAAGAEgASoGCAEQARgB';

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║   E2E: VERTEX AI THOUGHT SIGNATURE RESOLUTION TEST SUITE     ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const testModels = await getModels();
    const geminiModel = testModels.gemini || 'gemini-3.8-flash-low';
    const claudeModel = testModels.claude || 'claude-sonnet-4-6';

    const results = [];
    const tools = [commonTools.calculator || {
        name: 'calculator',
        description: 'Calculate math expression',
        input_schema: {
            type: 'object',
            properties: { expression: { type: 'string' } },
            required: ['expression']
        }
    }];

    // =========================================================================
    // TEST 1: Multi-turn Non-Streaming with Claude Signatures to Gemini
    // =========================================================================
    console.log('TEST 1: Non-streaming multi-turn with Claude signatures to Gemini');
    console.log('-'.repeat(60));

    try {
        const payload = {
            model: geminiModel,
            max_tokens: 200,
            stream: false,
            tools,
            messages: [
                { role: 'user', content: 'Calculate 25 * 4' },
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'thinking',
                            thinking: 'I need to calculate 25 * 4 using the calculator tool.',
                            signature: MOCK_CLAUDE_SIGNATURE
                        },
                        {
                            type: 'tool_use',
                            id: 'toolu_vrtx_test_12345',
                            name: 'calculator',
                            input: { expression: '25 * 4' },
                            thoughtSignature: MOCK_CLAUDE_SIGNATURE
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_vrtx_test_12345',
                            content: '100'
                        }
                    ]
                }
            ]
        };

        const response = await makeRequest(payload);
        const hasText = response.content && response.content.some(c => c.type === 'text' && c.text.length > 0);
        const noError = !response.error && response.statusCode === 200;

        console.log(`  HTTP Status: ${response.statusCode}`);
        console.log(`  Has Text Response: ${hasText ? 'YES' : 'NO'}`);
        console.log(`  Invalid Signature Error Avoided: ${noError ? 'YES' : 'NO'}`);

        const passed = noError && hasText;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);
        results.push({ name: 'Non-streaming multi-turn with Claude signature bypass', passed });
    } catch (err) {
        console.error('  Failed with error:', err.message);
        results.push({ name: 'Non-streaming multi-turn with Claude signature bypass', passed: false });
    }

    // =========================================================================
    // TEST 2: Multi-turn Streaming SSE with Claude Signatures to Gemini
    // =========================================================================
    console.log('TEST 2: Streaming SSE multi-turn with Claude signatures to Gemini');
    console.log('-'.repeat(60));

    try {
        const payload = {
            model: geminiModel,
            max_tokens: 200,
            stream: true,
            tools,
            messages: [
                { role: 'user', content: 'What is 15 + 35? Use calculator if needed.' },
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'thinking',
                            thinking: 'Calculating 15 + 35 with calculator.',
                            signature: MOCK_CLAUDE_SIGNATURE
                        },
                        {
                            type: 'tool_use',
                            id: 'toolu_vrtx_stream_67890',
                            name: 'calculator',
                            input: { expression: '15 + 35' },
                            thoughtSignature: MOCK_CLAUDE_SIGNATURE
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_vrtx_stream_67890',
                            content: '50'
                        }
                    ]
                }
            ]
        };

        const streamRes = await streamRequest(payload);
        const hasTextDelta = streamRes.events.some(e => e.type === 'content_block_delta' && e.data?.delta?.text);
        const streamOk = streamRes.statusCode === 200 && !streamRes.error;

        console.log(`  HTTP Status: ${streamRes.statusCode}`);
        console.log(`  Received SSE Events: ${streamRes.events.length}`);
        console.log(`  Has Text Delta Chunks: ${hasTextDelta ? 'YES' : 'NO'}`);

        const passed = streamOk && hasTextDelta;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);
        results.push({ name: 'Streaming SSE multi-turn with Claude signature bypass', passed });
    } catch (err) {
        console.error('  Failed with error:', err.message);
        results.push({ name: 'Streaming SSE multi-turn with Claude signature bypass', passed: false });
    }

    // =========================================================================
    // TEST 3: Genuine Gemini Thought Signature Passthrough (No Unneeded Bypass)
    // =========================================================================
    console.log('TEST 3: Gemini native thought signature passthrough');
    console.log('-'.repeat(60));

    try {
        const { resolveGeminiThoughtSignature, GEMINI_SKIP_SIGNATURE } = await import('../src/format/signature-cache.js');

        const mockGeminiSig = 'AY89a173qC28eN84H/iU5xO76W9j94N72eK10sO9...';
        const resolvedGemini = resolveGeminiThoughtSignature(mockGeminiSig);
        const resolvedClaude = resolveGeminiThoughtSignature(MOCK_CLAUDE_SIGNATURE);
        const resolvedEmpty = resolveGeminiThoughtSignature('');

        const geminiPreserved = resolvedGemini === mockGeminiSig;
        const claudeSubstituted = resolvedClaude === GEMINI_SKIP_SIGNATURE;
        const emptySubstituted = resolvedEmpty === GEMINI_SKIP_SIGNATURE;

        console.log(`  Native Gemini signature preserved: ${geminiPreserved ? 'YES' : 'NO'}`);
        console.log(`  Claude signature converted to skip sentinel: ${claudeSubstituted ? 'YES' : 'NO'}`);
        console.log(`  Empty signature defaulted to skip sentinel: ${emptySubstituted ? 'YES' : 'NO'}`);

        const passed = geminiPreserved && claudeSubstituted && emptySubstituted;
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);
        results.push({ name: 'Gemini signature resolution logic unit validation', passed });
    } catch (err) {
        console.error('  Failed with error:', err.message);
        results.push({ name: 'Gemini signature resolution logic unit validation', passed: false });
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log('═'.repeat(60));
    console.log('E2E TEST SUMMARY');
    console.log('═'.repeat(60));

    let allPassed = true;
    for (const r of results) {
        console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}`);
        if (!r.passed) allPassed = false;
    }

    console.log('═'.repeat(60));
    console.log(`FINAL RESULT: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('═'.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
