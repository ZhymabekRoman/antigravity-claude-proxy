/**
 * Redact Mode Utility
 * Replaces sensitive account data with anonymous labels for screenshots.
 * Optimized for high-throughput log streaming.
 */
let _cachedRegexes = null;
let _cachedAccountCount = 0;

function getRedactPatterns() {
    const accounts = Alpine.store('data')?.accounts || [];
    if (_cachedRegexes && _cachedAccountCount === accounts.length) {
        return _cachedRegexes;
    }
    _cachedAccountCount = accounts.length;
    _cachedRegexes = accounts.map((acc, idx) => {
        if (!acc.email) return null;
        const escaped = acc.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const emailRegex = new RegExp(escaped, 'g');
        const user = acc.email.split('@')[0];
        const userRegex = user ? new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g') : null;
        return { label: `Account ${idx + 1}`, emailRegex, userRegex };
    }).filter(Boolean);
    return _cachedRegexes;
}

window.Redact = {
    email(email) {
        if (!Alpine.store('settings')?.redactMode || !email) return email;
        const accounts = Alpine.store('data')?.accounts || [];
        const idx = accounts.findIndex(a => a.email === email || (a.email && a.email.split('@')[0] === email));
        return idx >= 0 ? `Account ${idx + 1}` : 'Account';
    },

    logMessage(message) {
        if (!Alpine.store('settings')?.redactMode || !message) return message;
        const patterns = getRedactPatterns();
        let result = message;
        for (let i = 0; i < patterns.length; i++) {
            const p = patterns[i];
            result = result.replace(p.emailRegex, p.label);
            if (p.userRegex) {
                result = result.replace(p.userRegex, p.label);
            }
        }
        return result;
    }
};

