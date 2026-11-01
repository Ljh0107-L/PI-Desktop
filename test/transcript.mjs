// Pure regressions, also imported by e2e.mjs so CI exercises them.
import assert from 'node:assert/strict';
import { applyEvent, collapseWork, displayBlocks, emptyTranscript, fromHistory, usageOf } from '../app/renderer/src/transcript.js';

const message = { role: 'assistant', timestamp: 1000, content: [], usage: { input: 10000, cacheRead: 30000, output: 600, reasoning: 400 }, durationMs: 6000 };
const deliveredInBurst = { start: 100000, first: 100001, last: 100061, end: 100062, est: 600, chars: 2400 };
assert.equal(usageOf([{ ...message, __timing: deliveredInBurst }]).tps, 100);
assert.equal(usageOf(fromHistory([message], { 1000: deliveredInBurst }).messages).tps, 100);
assert.equal(usageOf([{ ...message, durationMs: 500 }]).tps, 1200, 'do not arbitrarily clamp genuine high throughput');
for (const ms of [undefined, null, 0, -10, NaN, Infinity, '6000']) {
  assert.equal(usageOf([{ ...message, durationMs: undefined }]).tps, null, 'no duration and no timing means no speed');
}
for (const output of [undefined, 0, -1, Infinity, NaN]) {
  assert.equal(usageOf([{ ...message, usage: { output } }]).tps, null);
}
assert.equal(usageOf([message, { ...message, usage: { output: 400 }, durationMs: 2000 }]).tps, 125);
// A buffered relay replay is not a generation window; fall back to API duration.
let t = applyEvent(emptyTranscript(), { type: 'message_start', message });
t = applyEvent(t, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'buffered output' } });
t = applyEvent(t, { type: 'message_end', message });
assert.equal(usageOf(t.messages).tps, 100);

const tools = { kind: 'tools', key: 'g1', calls: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: {} }] };
const thought = { kind: 'thinking', key: 'h1', hidden: true };
const original = collapseWork([tools])[0];
assert.equal(collapseWork([thought, tools])[0].key, original.key, 'final hidden reasoning must not remount an expanded group');
assert.equal(collapseWork([tools, { ...thought, key: 'k2' }])[0].key, original.key);
const text = { kind: 'text', key: 't2', text: 'Progress stays visible' };
assert.deepEqual(collapseWork([tools, text, thought]).map(b => b.kind), ['work', 'text', 'thinking']);
const user = { role: 'user', timestamp: 10, content: 'Edit a file' };
const edited = { ...message, content: [{ type: 'toolCall', id: 'edit-a', name: 'write', arguments: { path: 'a.txt', content: 'hello' } }] };
const editing = { ...emptyTranscript(), loaded: true, messages: [user, edited], tools: { 'edit-a': { status: 'done' } } };
const footer = displayBlocks(editing).find(b => b.kind === 'usage');
const inFlight = applyEvent(editing, { type: 'message_start', message: { ...message, timestamp: 2000 } });
const streamingFooter = displayBlocks(inFlight).find(b => b.kind === 'usage');
assert.deepEqual(streamingFooter.changes, footer.changes, 'file changes stay visible during the next model call');
assert.equal(streamingFooter.key, footer.key);
assert.equal(displayBlocks({ ...editing, messages: [...editing.messages, { ...user, timestamp: 3000 }] }).find(b => b.kind === 'usage').key, footer.key, 'new user prompt must not remount the old footer');
assert.equal(usageOf([{ ...message, usage: { output: 12, reasoning: 0 } }]).reasoningReported, true, 'reported zero differs from missing reasoning');
assert.equal(usageOf([{ ...message, usage: { output: 12 } }]).reasoningReported, false);
console.log('PASS  transcript regressions: source-timed TPS, replay, missing timing, stable groups/footers, reasoning');

// Provider token counts that are clearly below the visible text (Cursor Gemini)
// are replaced by a text estimate for speed, and marked estimated.
const longGreeting = { ...message, timestamp: 5000, durationMs: 5886, usage: { output: 16 }, content: [{ type: 'text', text: 'x'.repeat(662) }] };
const estimatedSpeed = usageOf([longGreeting]);
assert.equal(estimatedSpeed.speedEstimated, true);
assert.equal(Math.round(estimatedSpeed.tps), 28, 'estimated Cursor TPS with API-duration fallback');
// Cursor timing: first→last is the generation window; visible text is used because output=16 is implausible.
const cursorTiming = { start: 0, first: 1000, last: 3190, end: 3300, chars: 662, est: 185 };
const cursorWindow = usageOf([{ ...longGreeting, __timing: cursorTiming }]);
assert.equal(cursorWindow.speedEstimated, true);
assert.equal(Math.round(cursorWindow.tps), 76, 'Cursor TPS uses first→last');
// A fast relay with a plausible token count keeps the provider count and first→last window.
const fast = { ...message, timestamp: 6000, durationMs: 799, usage: { output: 1009 }, content: [{ type: 'text', text: 'x'.repeat(3645) }] };
const qwenTiming = { start: 0, first: 1000, last: 1566, end: 1799, chars: 3645, est: 960 };
const fastSpeed = usageOf([{ ...fast, __timing: qwenTiming }]);
assert.equal(fastSpeed.speedEstimated, false);
assert.equal(Math.round(fastSpeed.tps), 1783, 'Qwen TPS uses first→last, not full API duration');
// A very dense replay burst falls back to the full API duration.
const burstSpeed = usageOf([{ ...fast, __timing: { start: 0, first: 1000, last: 1060, end: 1100, chars: 3645, est: 960 } }]);
assert.equal(Math.round(burstSpeed.tps), 1263, 'buffered replay falls back to API duration');
// Hidden reasoning has no text stream: use API duration, not the tiny timing window.
const hidden = { ...message, timestamp: 7000, durationMs: 6000, usage: { output: 400 }, content: [{ type: 'text', text: 'Answer' }] };
const hiddenTiming = { start: 0, first: 1000, last: 1155, end: 6000, chars: 30, est: null };
assert.equal(Math.round(usageOf([{ ...hidden, __timing: hiddenTiming }]).tps), 67, 'hidden reasoning with too little text falls back to API duration');
console.log('PASS  transcript generation-window TPS: first→last, Cursor estimate, burst fallback');
