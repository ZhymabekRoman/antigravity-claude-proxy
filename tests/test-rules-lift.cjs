/** Instruction lift: CLAUDE.md reminder moves from first user turn into systemInstruction (Gemini). */
async function run() {
    const require_hint = await import('../src/format/rules-lift.js');
    const { liftInstructionReminder } = require_hint;
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    let passed = 0, failed = 0;
    const test = (n, fn) => { try { fn(); console.log(`✓ ${n}`); passed++; } catch (e) { console.log(`✗ ${n}\n  ${e.message}`); failed++; } };
    const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
    const RULES = '<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /x/CLAUDE.md:\n# Rule A\nNever poll.\n</system-reminder>';
    const msgs = () => [{ role: 'user', content: [{ type: 'text', text: RULES }, { type: 'text', text: '<system-reminder>\ngitStatus: clean\n</system-reminder>' }, { type: 'text', text: 'do the task' }] }];

    test('lifts only the rules block, keeps the rest of the turn', () => {
        const { rules, messages } = liftInstructionReminder(msgs());
        ok(rules === RULES, 'rules text verbatim');
        ok(messages[0].content.length === 2 && messages[0].content[1].text === 'do the task');
    });
    test('no rules block -> same array, null rules', () => {
        const m = [{ role: 'user', content: 'hi' }];
        const r = liftInstructionReminder(m);
        ok(r.rules === null && r.messages === m);
    });
    test('Gemini request: rules in systemInstruction, not in contents', () => {
        const g = convertAnthropicToGoogle({ model: 'gemini-4-hydrogen-medium', messages: msgs() });
        ok(g.systemInstruction.parts.some(p => p.text.includes('Never poll.')), 'rules in system');
        ok(!JSON.stringify(g.contents).includes('Never poll.'), 'rules left in contents');
        ok(JSON.stringify(g.contents).includes('do the task'));
    });
    test('Claude model request is untouched', () => {
        const g = convertAnthropicToGoogle({ model: 'claude-sonnet-5-5-medium', messages: msgs() });
        ok(JSON.stringify(g.contents).includes('Never poll.'), 'claude path must keep rules in user turn');
    });
    test('skill injection block gets a continuation hint, once', () => {
        const { annotateSkillInjections } = require_hint;
        const m = [{ role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n# Skill' }] }];
        const a = annotateSkillInjections(m);
        ok(a[0].content[0].text.includes('continue the previous task'), 'hint missing');
        ok(annotateSkillInjections(a) === a, 'not idempotent');
        const plain = [{ role: 'user', content: 'hi' }];
        ok(annotateSkillInjections(plain) === plain, 'plain message changed');
    });
    test('Gemini request carries the hint, Claude request does not', () => {
        const msgs = [{ role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n# S' }] }];
        ok(JSON.stringify(convertAnthropicToGoogle({ model: 'gemini-4-hydrogen-medium', messages: msgs }).contents).includes('continue the previous task'));
        ok(!JSON.stringify(convertAnthropicToGoogle({ model: 'claude-sonnet-5-5-medium', messages: msgs }).contents).includes('continue the previous task'));
    });
    console.log(`\nTests passed: ${passed}/${passed + failed}`);
    if (failed) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
