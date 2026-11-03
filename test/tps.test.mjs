// Pure regressions for GitHub CI. No app, model request or live relay required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

const timing = overrides => ({ source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 2100,
  chars: 400, deltas: 3, weight: 100, firstWeight: 10, thinkingChars: 0, ...overrides });
const answerTiming = overrides => ({ first: 1000, last: 2000, chars: 400, deltas: 3, weight: 100, firstWeight: 10, ...overrides });
const message = overrides => ({ role: 'assistant', timestamp: 1000, provider: 'example', model: 'example-model', stopReason: 'stop',
  content: [{ type: 'text', text: 'x'.repeat(400) }], usage: { input: 200, cacheRead: 50, cacheWrite: 10, output: 100, reasoning: 0, cost: { total: 0.2 } },
  durationMs: 3000, __timing: timing(), ...overrides });
const usage = overrides => usageOf([message(overrides)]);
const unavailable = u => {
  assert.equal(u.tps, null); assert.equal(u.genMs, 0); assert.equal(u.genOut, 0);
  assert.equal(u.speedBasis, null); assert.equal(u.speedScope, null);
  assert.equal(speedDisplay(u).value, '—'); assert.equal(speedDisplay(u).label, 'Speed unavailable');
};

test('TPS measures generation after the first chunk, not the full request or TTFT', () => {
  const u = usage();
  assert.equal(u.tps, 90); assert.equal(u.genOut, 90); assert.equal(u.genMs, 1000);
  assert.equal(u.speedBasis, 'generation'); assert.equal(u.speedScope, 'all');
  assert.equal(u.speedEstimated, true); assert.equal(u.speedTokensEstimated, false);
  assert.equal(u.output, 100); assert.equal(u.prompt, 260); assert.equal(u.cacheHit, 50 / 260);
  assert.equal(u.durationMs, 2100, 'timestamp zero remains valid for activity duration');
  const display = speedDisplay(u);
  assert.equal(display.value, '~90.0'); assert.equal(display.label, 'Generation');
  assert.match(display.title, /Excludes TTFT, tool execution and completion trailers/);
  assert.match(display.title, /First-chunk tokens.*excluded/);
  assert.match(display.title, /not server decode-only TPS/);
});

test('huge prefill, delayed completion trailers and arbitrary request duration never change TPS', () => {
  for (const ttft of [1000, 600000]) for (const tail of [100, 600000]) {
    for (const durationMs of [undefined, null, 0, -1, NaN, Infinity, '3000', 1, 3000, 900000]) {
      const u = usage({ durationMs, __timing: timing({ first: ttft, last: ttft + 1000, end: ttft + 1000 + tail }) });
      assert.equal(u.tps, 90); assert.equal(u.genMs, 1000);
    }
  }
});

test('request-only and legacy source/renderer timings never become generation speed', () => {
  for (const durationMs of [1, 500, 3000, 900000]) unavailable(usage({ durationMs, __timing: undefined }));
  for (const source of [undefined, 'renderer', 'unknown']) unavailable(usage({ __timing: timing({ source }) }));
  for (const source of ['agent', 'relay']) {
    assert.equal(usage({ __timing: timing({ source }) }).tps, 90);
    unavailable(usage({ __timing: timing({ source, weight: undefined }) }));
    unavailable(usage({ __timing: timing({ source, firstWeight: undefined }) }));
  }
});

test('slow or fast replay and history restore use source clocks and retain first-chunk weights', t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  for (const delay of [1, 1000, 60000]) {
    const final = message();
    let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: final });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(400) } });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_end', message: final });
    assert.deepEqual(transcript.messages[0].__timing, final.__timing);
    assert.equal(usageOf(transcript.messages).tps, 90);
    const stale = timing({ source: 'renderer', first: 100000, last: 100001, end: 100002 });
    assert.deepEqual(fromHistory(transcript.messages, { 1000: stale }).messages[0].__timing, final.__timing);
    assert.equal(usageOf(fromHistory([message({ __timing: undefined })], { 1000: final.__timing }).messages).tps, 90);
    const legacy = { ...final, __timing: undefined };
    unavailable(usageOf(applyEvent(transcript, { type: 'message_end', message: legacy }).messages.slice(-1)));
  }
});

test('mid-reply attach needs a complete source sample, not a manufactured receipt window', () => {
  let transcript = applyEvent(emptyTranscript(), { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  transcript = applyEvent(transcript, { type: 'message_end', message: message({ __timing: undefined }) });
  assert.equal(transcript.messages[0].__timing, undefined);
  unavailable(usageOf(transcript.messages));
  assert.equal(usageOf(applyEvent(emptyTranscript(), { type: 'message_end', message: message() }).messages).tps, 90);
});

test('empty deltas remain activity-only and do not establish first-token timing', t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const m = message({ __timing: undefined });
  let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: m });
  now = 50;
  transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '' } });
  assert.equal(transcript.live.__tFirst, undefined); assert.equal(transcript.live.__deltas, 0);
  now = 100;
  transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thinking' } });
  now = 200;
  transcript = applyEvent(transcript, { type: 'message_end', message: m });
  assert.equal(transcript.messages[0].__timing.start, 0);
  assert.equal(transcript.messages[0].__timing.first, 100);
  assert.equal(transcript.messages[0].__timing.deltas, 1);
  unavailable(usageOf(transcript.messages));
});

test('incomplete, malformed, single-chunk, short and dense windows report unavailable, never request averages', () => {
  for (const patch of [
    { complete: false }, { complete: undefined }, { deltas: 1 }, { deltas: 0 }, { deltas: 2.5 }, { deltas: '3' },
    { start: -1 }, { first: undefined }, { first: NaN }, { last: Infinity }, { first: '1000' },
    { first: -1 }, { last: 999 }, { last: 1000 }, { end: 1500 }, { last: 1100 },
    { last: 1500, chars: 20000 }, { chars: 10 }, { chars: -1 }, { chars: Infinity },
    { weight: undefined }, { weight: 0 }, { weight: NaN }, { weight: Infinity }, { weight: '100' },
    { firstWeight: undefined }, { firstWeight: 0 }, { firstWeight: -1 }, { firstWeight: 100 },
    { firstWeight: 200 }, { firstWeight: Infinity }, { firstWeight: '10' },
  ]) unavailable(usage({ __timing: timing(patch) }));
  const fast = usage({ usage: { output: 1000 }, content: [{ type: 'text', text: 'x'.repeat(4000) }],
    __timing: timing({ last: 1500, end: 1600, chars: 4000, weight: 1000, firstWeight: 100 }) });
  assert.equal(fast.tps, 1800, 'valid high throughput is not arbitrarily capped');
});

test('a large first chunk cannot inflate throughput of the tiny remaining window', () => {
  for (const firstWeight of [1, 10, 50, 90, 99]) {
    const u = usage({ __timing: timing({ firstWeight }) });
    assert.equal(u.genOut, 100 - firstWeight); assert.equal(u.tps, 100 - firstWeight);
    assert.equal(u.output, 100, 'sampling does not rewrite billed tokens');
  }
});

test('placeholder estimates cover text, thinking and tool-only output but never rewrite usage', () => {
  for (const content of [
    [{ type: 'text', text: 'x'.repeat(400) }],
    [{ type: 'thinking', thinking: 'x'.repeat(400) }],
    [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(400) } }],
  ]) {
    const m = message({ provider: 'cursor', content, usage: { input: 12, output: 1, cost: { total: 0.02 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', __timing: timing({ chars: 500, thinkingChars: content[0].type === 'thinking' ? 400 : 0 }) });
    const before = structuredClone(m), u = usageOf([m]);
    assert.equal(u.output, 1); assert.equal(u.input, 12); assert.equal(u.cost, 0.02);
    assert.equal(u.speedTokensEstimated, true); assert.ok(u.genOut >= 90); assert.equal(u.tps, u.genOut);
    assert.match(speedDisplay(u).value, /^~/); assert.match(speedDisplay(u).title, /Provider token totals remain unchanged/);
    assert.deepEqual(m, before);
  }
});

test('invalid output counts can estimate speed only with a valid generation window', () => {
  for (const output of [undefined, null, 0, -1, NaN, Infinity, '100']) {
    const u = usage({ usage: { output } });
    assert.equal(u.output, 0); assert.equal(u.speedTokensEstimated, true); assert.equal(u.tps, 90);
    unavailable(usage({ usage: { output }, __timing: undefined }));
  }
  unavailable(usage({ usage: undefined }));
  unavailable(usage({ usage: { output: 0 }, content: [] }));
});

test('genuine positive counts in compressible text/tool bodies remain provider-reported', () => {
  unavailable(usage({ usage: { output: 1 }, content: [{ type: 'text', text: 'OK' }] }));
  for (const content of [
    [{ type: 'text', text: 'x'.repeat(10000) }],
    [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(10000) } }],
  ]) for (const output of [2, 16, 100]) {
    const u = usage({ content, usage: { output }, __timing: timing({ chars: 10030, weight: 2500, firstWeight: 250 }) });
    assert.equal(u.output, output); assert.equal(u.genOut, output * 0.9); assert.equal(u.speedTokensEstimated, false);
  }
});

test('hidden, summarized or redacted reasoning uses answer tokens and its own first/last window', () => {
  for (const thinking of [undefined, { type: 'thinking', thinking: 'A summary' }, { type: 'thinking', redacted: true, thinkingSignature: 'opaque' }]) {
    const overrides = { usage: { output: 500, reasoning: 400 }, content: [...(thinking ? [thinking] : []), { type: 'text', text: 'x'.repeat(400) }],
      __timing: timing({ first: 10, chars: 450, answer: answerTiming() }) };
    const u = usage(overrides);
    assert.equal(u.speedScope, 'answer'); assert.equal(u.tps, 90); assert.equal(u.genMs, 1000);
    assert.equal(u.genOut, 90); assert.equal(u.output, 500); assert.equal(u.reasoning, 400);
    assert.equal(speedDisplay(u).label, 'Answer generation');
    unavailable(usage({ ...overrides, __timing: timing() }));
    unavailable(usage({ ...overrides, __timing: timing({ answer: answerTiming({ firstWeight: undefined }) }) }));
  }
});

test('summary provenance overrides even a long thinking summary, with unknown counts explicitly estimated', () => {
  const content = [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(400) }];
  const source = timing({ first: 10, chars: 720, thinkingChars: 320, answer: answerTiming() });
  for (const reasoning of [400, undefined]) {
    const u = usage({ content, usage: { output: 500, reasoning }, __timing: source, __usageProvenance: { thinking: 'summary' } });
    assert.equal(u.speedScope, 'answer'); assert.equal(u.genOut, 90); assert.equal(u.genMs, 1000);
    assert.equal(u.speedTokensEstimated, reasoning == null); assert.equal(u.output, 500);
  }
  for (const reasoning of [500, 600]) unavailable(usage({ content, usage: { output: 500, reasoning }, __timing: source, __usageProvenance: { thinking: 'summary' } }));
});

test('fully streamed reasoning counts once; unstreamed final thinking is not proof of a full window', () => {
  const content = [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }];
  const source = timing({ thinkingChars: 320 });
  const u = usage({ usage: { output: 100, reasoning: 80 }, content, __timing: source });
  assert.equal(u.speedScope, 'all'); assert.equal(u.genOut, 90);
  const placeholder = usage({ usage: { output: 1, reasoning: 80 }, content, __timing: source });
  assert.equal(placeholder.genOut, 90, '(20 estimated answer + 80 reasoning) × 90%, not double counted');
  assert.equal(placeholder.output, 1); assert.equal(placeholder.reasoning, 80); assert.equal(placeholder.speedTokensEstimated, true);
  unavailable(usage({ content, usage: { output: 100, reasoning: 80 }, __timing: timing() }));
  unavailable(usage({ content, usage: { output: 100 }, __timing: timing() }));
});

test('an answer window spanning interleaved thinking is unavailable even with valid timestamps', () => {
  unavailable(usage({ usage: { output: 500, reasoning: 400 },
    __timing: timing({ answer: answerTiming({ interrupted: true }) }) }));
});

test('session speed sums only valid generation tokens and time, excluding tool gaps and untimed calls', () => {
  const first = message();
  const second = message({ timestamp: 2000, usage: { output: 200 }, content: [{ type: 'text', text: 'x'.repeat(800) }], durationMs: 900000,
    __timing: timing({ start: 600000, first: 601000, last: 605000, end: 605100, chars: 800, weight: 200, firstWeight: 20 }) });
  const tool = { role: 'toolResult', toolName: 'bash', durationMs: 500000 };
  const untimed = message({ timestamp: 3000, __timing: undefined, durationMs: 1 });
  const u = usageOf([first, tool, second, untimed]);
  assert.equal(u.speedBasis, 'generation'); assert.equal(u.genMs, 5000); assert.equal(u.genOut, 270); assert.equal(u.tps, 54);
  assert.equal(u.output, 400); assert.equal(u.speedPartial, true);
  assert.match(speedDisplay(u).title, /Only calls with usable timing/);
  assert.equal(usageOf([first, second]).speedPartial, false);
  unavailable(usageOf([untimed]));
});

test('full generation and answer-only scopes never mix in the same speed aggregate', () => {
  const all = message();
  const answer = message({ usage: { output: 500, reasoning: 400 }, __timing: timing({ answer: answerTiming({ last: 1500 }) }) });
  const u = usageOf([all, answer]);
  assert.equal(u.speedScope, 'answer'); assert.equal(u.speedPartial, true);
  assert.equal(u.genMs, 500); assert.equal(u.genOut, 90); assert.equal(u.tps, 180); assert.equal(u.output, 600);
  const reversed = usageOf([answer, all]);
  assert.equal(reversed.speedScope, 'all'); assert.equal(reversed.tps, 90); assert.equal(reversed.speedPartial, true);
});

test('parallel subagents add authoritative usage, never main-model TPS', () => {
  const child = { role: 'toolResult', toolName: 'subagent', usage: { input: 10, output: 900, reasoning: 800, cost: { total: 1 } }, details: { results: [{ turns: 2 }] }, durationMs: 1 };
  const u = usageOf([message(), child]);
  assert.equal(u.output, 1000); assert.equal(u.reasoning, 800); assert.equal(u.calls, 3);
  assert.equal(u.genOut, 90); assert.equal(u.genMs, 1000); assert.equal(u.tps, 90);
});

test('unfinished, failed and aborted calls keep billed counts without claiming final speed', () => {
  for (const stopReason of ['pending', 'deferred', 'error', 'aborted']) {
    const u = usage({ stopReason }); assert.equal(u.output, 100); unavailable(u);
  }
  unavailable(usage({ errorMessage: 'This operation was aborted' }));
});

test('CJK estimates are explicit and never change provider totals', () => {
  const text = '中文测试'.repeat(100);
  assert.equal(estimateTokens(text), 400);
  const u = usage({ usage: { output: 1 }, content: [{ type: 'text', text }], __timing: timing({ weight: 400, firstWeight: 40 }) });
  assert.equal(u.genOut, 360); assert.equal(u.output, 1); assert.equal(u.speedTokensEstimated, true);
});
