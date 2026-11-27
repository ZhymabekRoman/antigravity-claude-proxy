/**
 * Instruction lift: Claude Code ships CLAUDE.md / RTK.md / MEMORY.md as a <system-reminder> text block at the top of
 * the FIRST user message ("Codebase and user instructions are shown below ..."). Gemini follows the system channel
 * far better than a user-turn block buried under hundreds of thousands of tokens of history, so move that block
 * into systemInstruction. The block text is moved verbatim (only sanitized like the rest of the system prompt).
 */
const RULES_BLOCK_RE = /^\s*<system-reminder>\s*Codebase and user instructions are shown below/i;

const toBlocks = c => (typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : null));

/**
 * @param {Array} messages Anthropic messages
 * @returns {{ rules: string|null, messages: Array }} `messages` is the same array when nothing was lifted
 */
export function liftInstructionReminder(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return { rules: null, messages };
    const idx = messages.findIndex(m => m && m.role === 'user');
    if (idx === -1) return { rules: null, messages };
    const first = messages[idx];
    const blocks = toBlocks(first.content);
    if (!blocks) return { rules: null, messages };
    const hit = blocks.findIndex(b => b?.type === 'text' && typeof b.text === 'string' && RULES_BLOCK_RE.test(b.text));
    if (hit === -1) return { rules: null, messages };
    const rules = blocks[hit].text;
    const rest = blocks.filter((_, i) => i !== hit);
    const out = messages.slice();
    if (rest.length === 0) out.splice(idx, 1);                       // nothing else in that turn
    else out[idx] = { ...first, content: rest };
    return { rules, messages: out };
}

const SKILL_INJECTION_RE = /^\s*Base directory for this skill:/i;
const SKILL_HINT = '[Skill loaded above is reference material for the task you were ALREADY doing. Do not acknowledge it and do not wait for a new task: continue the previous task now and follow the skill\'s process.]';

/**
 * Claude Code delivers a loaded skill as a separate user text block ("Base directory for this skill: ..."). Gemini
 * treats that as the newest user instruction, replies "I acknowledge the skill, ready for the next task" and ends the
 * turn (the agent silently drops its real task). Append a short, deterministic continuation hint to every such block.
 * @returns {Array} same array when no skill block is present
 */
export function annotateSkillInjections(messages) {
    if (!Array.isArray(messages)) return messages;
    let changed = false;
    const out = messages.map(m => {
        if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m;
        if (!m.content.some(b => b?.type === 'text' && typeof b.text === 'string' && SKILL_INJECTION_RE.test(b.text) && !b.text.includes(SKILL_HINT))) return m;
        changed = true;
        const content = m.content.map(b => (b?.type === 'text' && typeof b.text === 'string' && SKILL_INJECTION_RE.test(b.text) && !b.text.includes(SKILL_HINT))
            ? { ...b, text: `${b.text}\n\n${SKILL_HINT}` } : b);
        return { ...m, content };
    });
    return changed ? out : messages;
}
