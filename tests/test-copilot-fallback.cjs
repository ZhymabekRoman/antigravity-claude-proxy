/**
 * Copilot fallback unit tests (pure logic + live copilot-api smoke when reachable).
 */
(async () => {
    const m = await import('../src/providers/copilot-fallback.js');
    const { config } = await import('../src/config.js');
    let failed = 0;
    const ok = (c, n) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) failed++; };

    ok(config.copilotFallback?.enabled === true, 'enabled by default');
    ok(m.shouldFallbackToCopilot(new Error('All accounts rate-limited for x')), 'rate limit triggers fallback');
    ok(m.shouldFallbackToCopilot(new Error('No accounts available')), 'no accounts triggers fallback');
    ok(!m.shouldFallbackToCopilot(new Error('prompt is too long: 900000 tokens > 850000 maximum')), 'prompt too long does NOT fallback');
    ok(!m.shouldFallbackToCopilot(new Error('invalid_request_error: bad tool schema')), 'invalid request does NOT fallback');
    ok(m.mapToCopilotModel('claude-opus-5-5-high') === 'fusion-standard', 'hardcoded gemini-3.8-flash (opus)');
    ok(m.mapToCopilotModel('gemini-3.8-flash-tiered') === 'fusion-standard', 'hardcoded gemini-3.8-flash (gemini)');
    ok(config.copilotFallback.always === false, 'always flag off by default');
    ok(!m.isAlwaysCopilot(), 'isAlwaysCopilot false by default');
    config.copilotFallback.always = true;
    ok(m.isAlwaysCopilot() && m.getCopilotUpstream().config.targetModel === 'fusion-standard', 'always flag -> gemini-3.8-flash upstream');
    config.copilotFallback.always = false;
    ok(!m.canFallbackToCopilot({ messages: [{ role: 'user', content: 'x'.repeat(4000000) }] }), 'oversized prompt skipped');
    ok(m.canFallbackToCopilot({ messages: [{ role: 'user', content: 'hi' }] }), 'small prompt allowed');

    const san = m.sanitizeForCopilot({ model: 'x', messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] }
    ] }, 'gemini-3.8-flash');
    ok(san.messages[san.messages.length - 1].role === 'user', 'conversation ending with assistant gets trailing user turn');
    const san2 = m.sanitizeForCopilot({ model: 'x', messages: [
        { role: 'user', content: 'a' }, { role: 'user', content: 'b' }
    ] }, 'gemini-3.8-flash');
    ok(san2.messages.length === 1, 'consecutive same-role messages merged');

    const san3 = m.sanitizeForCopilot({ model: 'x', messages: [
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' }, { role: 'system', content: 'hook ctx' }
    ] }, 'gemini-3.8-flash');
    ok(san3.messages.length === 3 && san3.messages.every(x => x.role !== 'system') && san3.messages[2].role === 'user', 'role:system messages folded into user turn');

    config.copilotFallback.enabled = false;
    ok(!m.shouldFallbackToCopilot(new Error('rate-limited')), 'disabled flag respected');
    config.copilotFallback.enabled = true;

    try {
        const r = await m.sendCopilotFallback({
            model: 'claude-sonnet-5-5-low', max_tokens: 30, stream: false,
            thinking: { type: 'enabled', budget_tokens: 2000 },
            messages: [
                { role: 'user', content: 'say ok' },
                { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'sig' }, { type: 'text', text: 'hmm' }] },
                { role: 'user', content: 'say ok' }
            ]
        }, new Error('rate-limited'));
        ok(r?.content?.length > 0, `live copilot-api non-stream reply: ${JSON.stringify(r.content?.[0]?.text)}`);
        let n = 0;
        for await (const e of m.streamCopilotFallback({ model: 'claude-haiku-4-5', max_tokens: 30, stream: true, messages: [{ role: 'user', content: 'say ok' }] }, new Error('429'))) n++;
        ok(n > 2, `live copilot-api stream events: ${n}`);
    } catch (e) { console.log('(live smoke skipped/failed:', e.message, ')'); failed++; }

    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
})();
