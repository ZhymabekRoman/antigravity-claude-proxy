/** Filter-banner scrub: the Gemini "blocked by filters" text must never stay in model context. */
async function run() {
    const { stripFilterBannerFromMessages, isFilterBannerText } = await import('../src/cloudcode/filter-banner.js');
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    let passed = 0, failed = 0;
    const test = (n, fn) => { try { fn(); console.log(`✓ ${n}`); passed++; } catch (e) { console.log(`✗ ${n}\n  ${e.message}`); failed++; } };
    const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
    const BANNER = "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries. Please try rephrasing your prompt. You can send feedback or read more about our policies here.";

    test('detects a full banner block, ignores long discussions that quote it', () => {
        ok(isFilterBannerText(BANNER));
        ok(!isFilterBannerText('We saw: ' + BANNER));
        ok(!isFilterBannerText(BANNER + ' x'.repeat(700)));
    });
    test('drops banner-only assistant turn and merges adjacent user turns', () => {
        const msgs = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: [{ type: 'text', text: BANNER }] },
            { role: 'user', content: [{ type: 'text', text: 'second' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] }
        ];
        const { messages, removed } = stripFilterBannerFromMessages(msgs);
        ok(removed === 1, 'removed=' + removed);
        ok(messages.length === 2 && messages[0].role === 'user' && messages[1].role === 'assistant', JSON.stringify(messages));
        ok(JSON.stringify(messages[0].content).includes('first') && JSON.stringify(messages[0].content).includes('second'), 'merged');
    });
    test('keeps other blocks of a mixed assistant turn (tool_use)', () => {
        const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: BANNER }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }];
        const { messages } = stripFilterBannerFromMessages(msgs);
        ok(messages[1].content.length === 1 && messages[1].content[0].type === 'tool_use');
    });
    test('no banner -> same array reference', () => {
        const msgs = [{ role: 'user', content: 'hi' }];
        ok(stripFilterBannerFromMessages(msgs).messages === msgs);
    });
    test('convertAnthropicToGoogle never sends the banner upstream', () => {
        const g = convertAnthropicToGoogle({ model: 'gemini-4-hydrogen-medium', messages: [
            { role: 'user', content: 'q1' }, { role: 'assistant', content: [{ type: 'text', text: BANNER }] }, { role: 'user', content: 'q2' }] });
        ok(!JSON.stringify(g).includes('blocked by Gemini'), 'banner leaked');
        ok(JSON.stringify(g.contents).includes('q1') && JSON.stringify(g.contents).includes('q2'));
    });
    console.log(`\nTests passed: ${passed}/${passed + failed}`);
    if (failed) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
