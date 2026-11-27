/** Compaction request detection (routes /compact + auto-compact to one model). */
async function run() {
    const { isCompactRequest } = await import('../src/format/request-converter.js');
    let passed = 0, failed = 0;
    const test = (n, fn) => { try { fn(); console.log(`✓ ${n}`); passed++; } catch (e) { console.log(`✗ ${n}\n  ${e.message}`); failed++; } };
    const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
    const PROMPT = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests.';
    test('detects compaction prompt in last user turn (array content)', () => {
        ok(isCompactRequest([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x' }, { role: 'user', content: [{ type: 'text', text: PROMPT }] }]));
    });
    test('detects compaction prompt (string content)', () => ok(isCompactRequest([{ role: 'user', content: PROMPT }])));
    test('ordinary chat is not compaction', () => ok(!isCompactRequest([{ role: 'user', content: 'please summarize this file' }])));
    test('only the LAST user turn counts', () => ok(!isCompactRequest([{ role: 'user', content: PROMPT }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'thanks, now fix the bug' }])));
    test('tool_result tail is not compaction', () => ok(!isCompactRequest([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }])));
    console.log(`\nTests passed: ${passed}/${passed + failed}`);
    if (failed) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
