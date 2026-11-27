/** Transient Google 400 ("could not be processed by the model") must be classified as retryable, not a client error. */
async function run() {
    const m = await import('../src/errors.js');
    let passed = 0, failed = 0;
    const test = (n, fn) => { try { fn(); console.log(`✓ ${n}`); passed++; } catch (e) { console.log(`✗ ${n}\n  ${e.message}`); failed++; } };
    const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };
    const T = '{"error":{"code":400,"message":"The request could not be processed by the model. Please retry; if the error persists, reduce the size of the prompt or conversation history.","status":"INVALID_ARGUMENT"}}';
    test('detects the transient message', () => ok(m.isTransientProcessingError(T)));
    test('does not match real client errors', () => {
        ok(!m.isTransientProcessingError('prompt is too long: 900000 tokens > 200000'));
        ok(!m.isTransientProcessingError('Invalid JSON payload received'));
    });
    test('exhausted error is an overloaded_error (never invalid_request_error)', () => {
        const e = m.transientProcessingError(T);
        ok(e.name === 'TransientProcessingError' && /^overloaded_error:/.test(e.message) && !/invalid_request_error/.test(e.message));
    });
    test('retry budget is bounded', () => ok(m.TRANSIENT_400_MAX_RETRIES === 3 && m.TRANSIENT_400_DELAYS_MS.length >= 1));
    console.log(`\nTests passed: ${passed}/${passed + failed}`);
    if (failed) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
