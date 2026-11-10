/**
 * Test for Banned Account Handling & ToS Violation Detection
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        BANNED ACCOUNT & TOS VIOLATION TEST SUITE            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { isAccountBanned } = await import('../src/cloudcode/rate-limit-state.js');
    const { markInvalid, clearInvalid } = await import('../src/account-manager/rate-limits.js');
    const { loadAccounts, saveAccounts } = await import('../src/account-manager/storage.js');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { unlink } = await import('fs/promises');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${e.message}`);
            failed++;
        }
    }

    async function testAsync(name, fn) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    function assertFalse(value, message = '') {
        if (value) {
            throw new Error(message || 'Expected false but got true');
        }
    }

    console.log('── isAccountBanned() Detection ─────────────────────────────────');
    test('detects Google ToS ban message', () => {
        const msg = 'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.';
        assertTrue(isAccountBanned(msg));
    });

    test('detects TOS_VIOLATION error reason in JSON', () => {
        const json = JSON.stringify({
            error: {
                code: 403,
                message: 'Forbidden',
                details: [{ reason: 'TOS_VIOLATION', domain: 'cloudcode-pa.googleapis.com' }]
            }
        });
        assertTrue(isAccountBanned(json));
    });

    test('detects ACCOUNT_BANNED prefix', () => {
        assertTrue(isAccountBanned('ACCOUNT_BANNED: Google Cloud Code disabled'));
    });

    test('does NOT detect generic 403 or permission denied', () => {
        assertFalse(isAccountBanned('PERMISSION_DENIED: The caller does not have permission'));
        assertFalse(isAccountBanned('403 Forbidden'));
        assertFalse(isAccountBanned(''));
        assertFalse(isAccountBanned(null));
    });

    console.log('\n── markInvalid() & clearInvalid() ──────────────────────────────');
    test('markInvalid sets isBanned to true for ToS violation', () => {
        const accounts = [{ email: 'banned@example.com' }];
        markInvalid(accounts, 'banned@example.com', 'Account banned — Gemini disabled for Terms of Service violation');
        assertTrue(accounts[0].isInvalid, 'Should be invalid');
        assertTrue(accounts[0].isBanned, 'Should be banned');
        assertEqual(accounts[0].invalidReason, 'Account banned — Gemini disabled for Terms of Service violation');
    });

    test('markInvalid sets isBanned to false for standard verification challenge', () => {
        const accounts = [{ email: 'challenge@example.com' }];
        markInvalid(accounts, 'challenge@example.com', 'Account requires verification', 'https://verify.url');
        assertTrue(accounts[0].isInvalid, 'Should be invalid');
        assertFalse(accounts[0].isBanned, 'Should NOT be banned');
    });

    test('clearInvalid resets isBanned and isInvalid', () => {
        const accounts = [{ email: 'banned@example.com', isInvalid: true, isBanned: true, invalidReason: 'Banned' }];
        clearInvalid(accounts, 'banned@example.com');
        assertFalse(accounts[0].isInvalid, 'Should not be invalid');
        assertFalse(accounts[0].isBanned, 'Should not be banned');
        assertEqual(accounts[0].invalidReason, null);
    });

    console.log('\n── Storage Persistence & Startup Preservation ─────────────────');
    await testAsync('loadAccounts preserves isBanned and isInvalid permanently', async () => {
        const testPath = join(tmpdir(), `test-accounts-ban-${Date.now()}.json`);
        const initialAccounts = [
            {
                email: 'banned@example.com',
                source: 'oauth',
                isBanned: true,
                isInvalid: true,
                invalidReason: 'Account banned — Gemini disabled for Terms of Service violation',
                invalidAt: Date.now() - 3600000 // 1 hour ago
            },
            {
                email: 'healthy@example.com',
                source: 'oauth',
                isInvalid: false
            }
        ];

        try {
            await saveAccounts(testPath, initialAccounts, {}, 0);
            const { accounts } = await loadAccounts(testPath);
            const bannedAcc = accounts.find(a => a.email === 'banned@example.com');
            const healthyAcc = accounts.find(a => a.email === 'healthy@example.com');

            assertTrue(bannedAcc.isBanned, 'bannedAcc must have isBanned: true');
            assertTrue(bannedAcc.isInvalid, 'bannedAcc must maintain isInvalid: true');
            assertEqual(bannedAcc.invalidReason, 'Account banned — Gemini disabled for Terms of Service violation');

            assertFalse(healthyAcc.isInvalid, 'healthyAcc must remain valid');
            assertFalse(healthyAcc.isBanned, 'healthyAcc must not be banned');
        } finally {
            await unlink(testPath).catch(() => {});
        }
    });

    console.log(`\n══════════════════════════════════════════════════════════════`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`══════════════════════════════════════════════════════════════\n`);

    if (failed > 0) {
        process.exit(1);
    }
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
