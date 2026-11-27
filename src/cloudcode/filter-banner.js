/**
 * Gemini safety-filter banner ("This request was blocked by Gemini's filters ...").
 *
 * Google sometimes returns that banner as ordinary assistant TEXT instead of an error. If it is passed through,
 * Claude Code stores it as a normal assistant turn and re-sends it as context forever. Single source of truth
 * for: detecting it in responses (sse-streamer / sse-parser) and scrubbing it from already-polluted history
 * (format/request-converter).
 */
export const SOFT_REFUSAL_TEXT_RE = /This request was blocked by Gemini'?s filters\.|blocked by Gemini'?s filters|They can occasionally trigger by mistake on safe coding|violate our (?:safety|usage|content) polic/i;

// A whole assistant text block that IS the banner (not a long discussion that merely quotes it)
const BANNER_BLOCK_RE = /^\s*This request was blocked by Gemini'?s filters\./i;
const BANNER_MAX_LEN = 1200;

export function isFilterBannerText(text) {
    return typeof text === 'string' && text.length <= BANNER_MAX_LEN && BANNER_BLOCK_RE.test(text);
}

const toBlocks = c => (typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []));

/**
 * Remove assistant turns that consist only of the filter banner (plus thinking) from Anthropic-format history,
 * then merge the user turns that become adjacent. Returns the same array when nothing was found.
 * @param {Array} messages
 * @returns {{ messages: Array, removed: number }}
 */
export function stripFilterBannerFromMessages(messages) {
    if (!Array.isArray(messages)) return { messages, removed: 0 };
    let removed = 0;
    const kept = [];
    for (const m of messages) {
        if (m && m.role === 'assistant') {
            const blocks = toBlocks(m.content);
            const hasBanner = blocks.some(b => b?.type === 'text' && isFilterBannerText(b.text));
            if (hasBanner) {
                const rest = blocks.filter(b => !(b?.type === 'text' && isFilterBannerText(b.text)) && b?.type !== 'thinking' && b?.type !== 'redacted_thinking' && !(b?.type === 'text' && !String(b.text || '').trim()));
                if (rest.length === 0) { removed++; continue; }          // banner-only turn -> drop
                kept.push({ ...m, content: blocks.filter(b => !(b?.type === 'text' && isFilterBannerText(b.text))) });
                removed++;
                continue;
            }
        }
        kept.push(m);
    }
    if (!removed) return { messages, removed: 0 };
    const merged = [];
    for (const m of kept) {
        const prev = merged[merged.length - 1];
        if (prev && m && prev.role === 'user' && m.role === 'user') {
            merged[merged.length - 1] = { ...prev, content: [...toBlocks(prev.content), ...toBlocks(m.content)] };
        } else merged.push(m);
    }
    return { messages: merged, removed };
}
