// Pure regressions, also imported by e2e.mjs so CI exercises them.
import assert from 'node:assert/strict';
import { applyEvent, collapseWork, displayBlocks, emptyTranscript, fromHistory, usageOf } from '../app/renderer/src/transcript.js';

const message = { role: 'assistant', timestamp: 1000, content: [], usage: { input: 10000, cacheRead: 30000, output: 600, reasoning: 400 }, durationMs: 6000 };
const deliveredInBurst = { start: 100000, first: 100001, last: 100061, end: 100062, est: 600, chars: 2400 };
assert.equal(usageOf([{ ...message, __timing: deliveredInBurst }]).tps, 100);
assert.equal(usageOf(fromHistory([message], { 1000: deliveredInBurst }).messages).tps, 100);
assert.equal(usageOf([{ ...message, durationMs: 500 }]).tps, 1200, 'do not arbitrarily clamp genuine high throughput');
for (const ms of [undefined, null, 0, -10, NaN, Infinity, '6000']) {
  assert.equal(usageOf([{ ...message, durationMs: ms, __timing: deliveredInBurst }]).tps, null, 'do not reuse UI timing for untimed replies');
}
for (const output of [undefined, 0, -1, Infinity, NaN]) {
  assert.equal(usageOf([{ ...message, usage: { output } }]).tps, null);
}
assert.equal(usageOf([message, { ...message, usage: { output: 400 }, durationMs: 2000 }]).tps, 125);
// Receiving a whole relay replay immediately must not alter API timing.
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
