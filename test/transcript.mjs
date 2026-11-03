// Pure regressions, also imported by e2e.mjs so CI exercises them.
import assert from 'node:assert/strict';
import { applyEvent, collapseWork, displayBlocks, emptyTranscript, fromHistory, isAbortText, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

const message = { role: 'assistant', timestamp: 1000, content: [], usage: { input: 10000, cacheRead: 30000, output: 600, reasoning: 400 }, durationMs: 6000 };
const deliveredInBurst = { start: 100000, first: 100001, last: 100061, end: 100062, est: 600, chars: 2400 };
assert.equal(usageOf([{ ...message, __timing: deliveredInBurst }]).tps, null);
assert.equal(usageOf(fromHistory([message], { 1000: deliveredInBurst }).messages).tps, null);
for (const ms of [500, 6000, undefined, null, 0, -10, NaN, Infinity, '6000']) {
  const u = usageOf([{ ...message, durationMs: ms }]);
  assert.equal(u.tps, null, 'request duration never substitutes for generation timing');
  assert.equal(u.genOut, 0);
  assert.equal(speedDisplay(u).label, 'Speed unavailable');
}
for (const output of [undefined, 0, -1, Infinity, NaN]) {
  assert.equal(usageOf([{ ...message, usage: { output } }]).tps, null);
}
assert.equal(usageOf([message, { ...message, usage: { output: 400 }, durationMs: 2000 }]).tps, null);
const generated = { ...message, usage: { output: 200 }, content: [{ type: 'text', text: 'x'.repeat(400) }] };
const sourceTiming = { source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 2100, chars: 400, deltas: 3, weight: 100, firstWeight: 10, thinkingChars: 0 };
const generatedUsage = usageOf([{ ...generated, __timing: sourceTiming }]);
assert.equal(generatedUsage.tps, 180, 'exclude TTFT and the first chunk from the generation sample');
assert.equal(generatedUsage.output, 200, 'generation sampling never changes provider usage');
assert.equal(generatedUsage.genMs, 1000);
assert.equal(generatedUsage.genOut, 180);
assert.equal(generatedUsage.speedBasis, 'generation');
assert.equal(generatedUsage.speedScope, 'all');
assert.equal(speedDisplay(generatedUsage).label, 'Generation');
assert.equal(usageOf(fromHistory([generated], { 1000: sourceTiming }).messages).tps, 180, 'persisted source timing retains the generation sample');
// A buffered relay replay is not a generation window, even with an API duration.
let t = applyEvent(emptyTranscript(), { type: 'message_start', message });
t = applyEvent(t, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'buffered output' } });
t = applyEvent(t, { type: 'message_end', message });
assert.equal(usageOf(t.messages).tps, null);

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
console.log('PASS  transcript regressions: generation-only TPS, replay, missing timing, stable groups/footers, reasoning');

// Character heuristics cannot establish that a positive provider count is wrong. Keep reported
// counts authoritative; missing usage or a one-token placeholder may need a token estimate,
// but neither reported nor estimated tokens establish speed without source timing.
const longGreeting = { ...message, timestamp: 5000, durationMs: 5886, usage: { output: 16 }, content: [{ type: 'text', text: 'x'.repeat(662) }] };
const reportedSpeed = usageOf([longGreeting]);
assert.equal(reportedSpeed.speedEstimated, false);
assert.equal(reportedSpeed.output, 16);
assert.equal(reportedSpeed.genOut, 0);
assert.equal(reportedSpeed.speedBasis, null);
assert.equal(reportedSpeed.tps, null);
// Legacy receipt timestamps do not become source timing just because the delivery window looks plausible.
const cursorTiming = { start: 0, first: 1000, last: 3190, end: 3300, chars: 662, est: 185 };
const cursorWindow = usageOf([{ ...longGreeting, __timing: cursorTiming }]);
assert.equal(cursorWindow.tps, null);
assert.equal(cursorWindow.speedBasis, null);
const fast = { ...message, timestamp: 6000, durationMs: 1799, usage: { output: 1009 }, content: [{ type: 'text', text: 'x'.repeat(4000) }] };
const qwenTiming = { source: 'relay', complete: true, deltas: 3, start: 0, first: 1000, last: 1566, end: 1799, chars: 4000, thinkingChars: 0, weight: 1000, firstWeight: 100 };
const fastSpeed = usageOf([{ ...fast, __timing: qwenTiming }]);
assert.equal(fastSpeed.speedEstimated, true, 'first→last chunk timing is approximate even with reported usage');
assert.equal(fastSpeed.speedTokensEstimated, false);
assert.equal(fastSpeed.speedBasis, 'generation');
assert.equal(Math.round(fastSpeed.tps), 1604, 'source-observed throughput subtracts the first chunk, without clamping high TPS');
const burstSpeed = usageOf([{ ...fast, __timing: { ...qwenTiming, last: 1060, end: 1100 } }]);
assert.equal(burstSpeed.tps, null);
assert.equal(burstSpeed.genOut, 0);
assert.equal(speedDisplay(burstSpeed).label, 'Speed unavailable', 'a dense source burst never falls back to request duration');
for (const patch of [{ weight: undefined }, { firstWeight: undefined }]) {
  assert.equal(usageOf([{ ...generated, __timing: { ...sourceTiming, ...patch } }]).tps, null, 'older source timing cannot account for the first chunk');
}
const hidden = { ...message, timestamp: 7000, durationMs: 6000, usage: { output: 500, reasoning: 400 }, content: [{ type: 'text', text: 'x'.repeat(400) }] };
assert.equal(usageOf([{ ...hidden, __timing: sourceTiming }]).tps, null, 'hidden reasoning needs a separate answer timing window');
const answerTiming = { first: 1000, last: 2000, chars: 400, deltas: 3, weight: 100, firstWeight: 10 };
const answerUsage = usageOf([{ ...hidden, __timing: { ...sourceTiming, answer: answerTiming } }]);
assert.equal(answerUsage.tps, 90, 'subtract hidden reasoning before applying the first-answer-chunk correction');
assert.equal(answerUsage.genOut, 90);
assert.equal(answerUsage.output, 500);
assert.equal(answerUsage.reasoning, 400);
assert.equal(answerUsage.speedScope, 'answer');
assert.equal(speedDisplay(answerUsage).label, 'Answer generation');
assert.equal(usageOf([{ ...hidden, __timing: { ...sourceTiming, answer: { ...answerTiming, firstWeight: undefined } } }]).tps, null);
console.log('PASS  transcript speed provenance: authoritative counts, generation samples, first-chunk correction, hidden-answer scope, no request fallback');

// A user stop can arrive as an ordinary error message; it must not look like a provider failure.
for (const text of ['This operation was aborted', 'Request was aborted', 'AbortError: The operation was aborted', 'Error: request was aborted']) {
  assert.equal(isAbortText(text), true, `abort text classified: ${text}`);
}
assert.equal(isAbortText('400: maximum context length exceeded'), false);
const interrupted = { ...message, timestamp: 8000, stopReason: 'error', errorMessage: 'This operation was aborted', content: [{ type: 'text', text: 'Partial answer' }] };
const interruptedBlocks = displayBlocks({ ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: 'do work', timestamp: 7000 }, interrupted] });
assert.equal(interruptedBlocks.some(b => b.kind === 'error'), false, 'aborted turn is not a red error');
assert.equal(interruptedBlocks.some(b => b.kind === 'notice' && b.text === 'Interrupted'), true, 'aborted turn shows a neutral interruption notice');
const failed = { ...message, timestamp: 9000, stopReason: 'error', errorMessage: 'terminated', content: [] };
assert.equal(displayBlocks({ ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: 'do work', timestamp: 8500 }, failed] }).some(b => b.kind === 'error'), true, 'real failures stay errors');
console.log('PASS  aborted turns render as interruption notices, not errors');

// Tool arguments count for the generation window, but a large write body must not
// be mistaken for a low reported token count and inflate the estimated speed.
const writeCall = { ...message, timestamp: 10000, usage: { output: 100 }, content: [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(10000) } }], __timing: { source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 2100, chars: 10000, deltas: 3, weight: 2500, firstWeight: 250 } };
const writeUsage = usageOf([writeCall]);
assert.equal(writeUsage.speedTokensEstimated, false, 'large tool arguments do not replace a plausible reported output');
assert.equal(writeUsage.output, 100);
assert.equal(writeUsage.genOut, 90);
assert.equal(writeUsage.tps, 90);
console.log('PASS  tool-call TPS: arguments cover the window without inflating reported output');
