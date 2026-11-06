// Pure regressions for GitHub CI. No app, model request or live relay required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, MIN_SPEED_TOKENS, speedDisplay, speedReply, usageOf } from '../app/renderer/src/transcript.js';

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
// Without a measurable source window the speed is estimated from the reply, never left blank.
const estimate = (u, basis, tps) => {
  assert.equal(u.speedBasis, basis);
  if (tps !== undefined) assert.ok(Math.abs(u.tps - tps) < 1e-6, `${u.tps} ≈ ${tps}`);
  else assert.ok(Number.isFinite(u.tps) && u.tps > 0);
  const display = speedDisplay(u);
  assert.match(display.value, /^~/); assert.equal(display.label, 'Generation (estimated)'); assert.match(display.title, /^Estimated/);
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

test('request-only, receipt and legacy timings give a marked estimate instead of nothing', () => {
  for (const durationMs of [500, 3000, 900000]) estimate(usage({ durationMs, __timing: undefined }), 'response', 100 / (durationMs / 1000));
  unavailable(usage({ durationMs: 1, __timing: undefined }));
  for (const source of [undefined, 'renderer', 'unknown']) estimate(usage({ __timing: timing({ source }) }), 'window', 90);
  for (const source of ['agent', 'relay']) {
    assert.equal(usage({ __timing: timing({ source }) }).tps, 90);
    assert.equal(usage({ __timing: timing({ source }) }).speedBasis, 'generation', 'a clean source window stays a measurement');
    estimate(usage({ __timing: timing({ source, weight: undefined }) }), 'window', 100 * 2 / 3);
    estimate(usage({ __timing: timing({ source, firstWeight: undefined }) }), 'window', 100 * 2 / 3);
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
    estimate(usageOf(applyEvent(transcript, { type: 'message_end', message: legacy }).messages.slice(-1)), 'response', 100 / 3);
  }
});

test('mid-reply attach estimates from the whole response instead of a manufactured receipt window', () => {
  let transcript = applyEvent(emptyTranscript(), { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  transcript = applyEvent(transcript, { type: 'message_end', message: message({ __timing: undefined }) });
  assert.equal(transcript.messages[0].__timing, undefined);
  estimate(usageOf(transcript.messages), 'response', 100 / 3);
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
  estimate(usageOf(transcript.messages), 'response', 100 / 3);
});

test('incomplete, malformed, single-chunk, short and dense windows still give a marked estimate', () => {
  for (const patch of [
    { complete: false }, { complete: undefined }, { deltas: 1 }, { deltas: 0 }, { deltas: 2.5 }, { deltas: '3' },
    { start: -1 }, { first: undefined }, { first: NaN }, { last: Infinity }, { first: '1000' },
    { first: -1 }, { last: 999 }, { last: 1000 }, { end: 1500 }, { last: 1100 },
    { last: 1500, chars: 20000 }, { chars: 10 }, { chars: -1 }, { chars: Infinity },
    { weight: undefined }, { weight: 0 }, { weight: NaN }, { weight: Infinity }, { weight: '100' },
    { firstWeight: undefined }, { firstWeight: 0 }, { firstWeight: -1 }, { firstWeight: 100 },
    { firstWeight: 200 }, { firstWeight: Infinity }, { firstWeight: '10' },
  ]) {
    const u = usage({ __timing: timing(patch) });
    assert.ok(['window', 'response'].includes(u.speedBasis), JSON.stringify(patch));
    estimate(u, u.speedBasis);
  }
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

test('invalid output counts estimate tokens from the visible reply', () => {
  for (const output of [undefined, null, 0, -1, NaN, Infinity, '100']) {
    const u = usage({ usage: { output } });
    assert.equal(u.output, 0); assert.equal(u.speedTokensEstimated, true); assert.equal(u.tps, 90);
    const fallback = usage({ usage: { output }, __timing: undefined });
    estimate(fallback, 'response', estimateTokens('x'.repeat(400)) / 3);
    assert.equal(fallback.speedTokensEstimated, true);
  }
  unavailable(usage({ usage: undefined }));
  unavailable(usage({ usage: { output: 0 }, content: [] }));
});

test('genuine positive counts in compressible text/tool bodies remain provider-reported', () => {
  estimate(usage({ usage: { output: 1 }, content: [{ type: 'text', text: 'OK' }] }), 'window', 0.9);
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
    // Without a usable answer window: the whole response, which also covers the hidden reasoning.
    estimate(usage({ ...overrides, __timing: timing() }), 'response', 500 / 3);
    estimate(usage({ ...overrides, __timing: timing({ answer: answerTiming({ firstWeight: undefined }) }) }), 'response', 500 / 3);
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
  for (const reasoning of [500, 600]) estimate(usage({ content, usage: { output: 500, reasoning }, __timing: source, __usageProvenance: { thinking: 'summary' } }), 'response', 500 / 3);
});

test('fully streamed reasoning counts once; unstreamed final thinking is not proof of a full window', () => {
  const content = [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }];
  const source = timing({ thinkingChars: 320 });
  const u = usage({ usage: { output: 100, reasoning: 80 }, content, __timing: source });
  assert.equal(u.speedScope, 'all'); assert.equal(u.genOut, 90);
  const placeholder = usage({ usage: { output: 1, reasoning: 80 }, content, __timing: source });
  assert.equal(placeholder.genOut, 90, '(20 estimated answer + 80 reasoning) × 90%, not double counted');
  assert.equal(placeholder.output, 1); assert.equal(placeholder.reasoning, 80); assert.equal(placeholder.speedTokensEstimated, true);
  // Visible reasoning without its own chunk accounting: the observed output window, estimated.
  estimate(usage({ content, usage: { output: 100, reasoning: 80 }, __timing: timing() }), 'window', 90);
  estimate(usage({ content, usage: { output: 100 }, __timing: timing() }), 'window', 90);
});

test('an answer window spanning interleaved thinking falls back to the whole response', () => {
  estimate(usage({ usage: { output: 500, reasoning: 400 },
    __timing: timing({ answer: answerTiming({ interrupted: true }) }) }), 'response', 500 / 3);
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

// Timings of real streams (Pi Desktop's pipeline, November 2026). genStart is when the provider began
// its output (the bridge records it from the raw stream): before hidden reasoning, but the span from
// there also holds reading the prompt and summarizing the reasoning. gpt-6.1-sol's answer streamed at
// 58 tok/s, its "reasoning" span at 32; at Ultrafast 850 against 59.
test('hidden reasoning: the answer is timed, and the provider\'s start marker is only a fallback', () => {
  // gpt-6.1-sol: reasoning item opened at 2694 ms, answer streamed 4285→10211, 435 output tokens (69 reasoning).
  const sol = usage({ usage: { output: 435, reasoning: 69 }, content: [{ type: 'text', text: '中'.repeat(553) }],
    __timing: timing({ start: 0, genStart: 2694, first: 4285, last: 10211, end: 10459, chars: 553, deltas: 360, weight: 553, firstWeight: 1,
      answer: answerTiming({ first: 4285, last: 10211, chars: 553, deltas: 360, weight: 553, firstWeight: 1 }) }) });
  assert.equal(sol.speedBasis, 'generation'); assert.equal(sol.speedScope, 'answer');
  assert.ok(Math.abs(sol.tps - (366 * 552 / 553) / 5.926) < 1e-9, `${sol.tps}`); // 61.7, as the app showed before the marker
  const display = speedDisplay(sol);
  assert.equal(display.label, 'Answer generation'); assert.match(display.title, /generated at the same speed but cannot be timed/);
  // One answer chunk after hidden reasoning (first === last): estimated from the marker, which errs low.
  const oneChunk = usage({ usage: { output: 300, reasoning: 280 }, __timing: timing({ genStart: 500, first: 6500, last: 6500, end: 6600 }) });
  estimate(oneChunk, 'start', 50);
  assert.match(speedDisplay(oneChunk).title, /too short to time on its own/);
  assert.match(speedDisplay(oneChunk).title, /real generation speed is higher/);
});

test('a relay that delivers the whole reply at once is estimated, not measured from the marker', () => {
  // qwen3.8-27b via an Anthropic-compatible relay: 113 events in 16 ms after a 2 s wait.
  const burst = usage({ usage: { output: 3460 }, content: [{ type: 'text', text: 'x'.repeat(660) }], durationMs: 2035,
    __timing: timing({ start: 0, genStart: 2015, first: 2015, last: 2031, end: 2035, chars: 13016, deltas: 110, weight: 3254, firstWeight: 2 }) });
  assert.equal(burst.speedBasis, 'response');
  // A marker after the first chunk, or before the message started, is not trusted either.
  for (const genStart of [7000, -1]) assert.notEqual(usage({ usage: { output: 300, reasoning: 280 }, __timing: timing({ genStart, first: 6500, last: 6500, end: 6600 }) }).speedBasis, 'start', `genStart ${genStart}`);
});

test('the Usage card times the latest reply long enough to time, not a few-token "done"', () => {
  const long = message({ timestamp: 1, usage: { output: 400 }, content: [{ type: 'text', text: 'x'.repeat(1600) }], __timing: timing({ first: 500, last: 8500, end: 8600, chars: 1600 }) });
  const done = message({ timestamp: 2, usage: { output: 7 }, content: [{ type: 'text', text: '已写入' }], durationMs: 1273, __timing: timing({ first: 1251, last: 1253, end: 1273, chars: 3, deltas: 1 }) });
  assert.equal(speedReply([long, done]), long);
  assert.equal(speedReply([long]), long);
  assert.equal(speedReply([done]), done, 'nothing longer: the last reply');
  assert.equal(MIN_SPEED_TOKENS, 64);
  const shown = speedDisplay(usageOf([long]), { earlier: true });
  assert.equal(shown.value, '~45.0'); assert.match(shown.title, /the last one was too short, or arrived in bursts/); // 360 tokens after the first chunk over 8 s
  // A burst of tool-call arguments (deepseek-flash: 118 tokens in 0.3 s, estimated) yields to the measured
  // generation before it; another model's replies never stand in for this one's.
  const burst = message({ timestamp: 3, usage: { output: 118 }, content: [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(400) } }], __timing: timing({ first: 500, last: 790, deltas: 3, firstWeight: undefined }) });
  assert.equal(usageOf([burst]).speedBasis, 'window');
  assert.equal(speedReply([long, burst]), long);
  const other = message({ timestamp: 4, model: 'other-model', usage: { output: 7 }, __timing: timing({ first: 100, last: 101 }) });
  assert.equal(speedReply([long, other]), other, 'the last model has nothing to time: its own last reply');
});
