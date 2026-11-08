// Pure regressions for GitHub CI. No app, model request or live relay required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, speedDisplay, speedReply, usageOf } from '../app/renderer/src/transcript.js';

const timing = overrides => ({ source: 'agent', complete: true, requestStart: 0, start: 800, first: 1000, last: 2000, end: 2500,
  chars: 400, deltas: 3, weight: 100, firstWeight: 10, thinkingChars: 0, ...overrides });
const message = overrides => ({ role: 'assistant', timestamp: 0, provider: 'example', model: 'example-model', stopReason: 'stop',
  content: [{ type: 'text', text: 'x'.repeat(400) }], usage: { input: 200, cacheRead: 50, cacheWrite: 10, output: 100, reasoning: 0, cost: { total: 0.2 } },
  __timing: timing(), ...overrides });
const usage = overrides => usageOf([message(overrides)]);
const unavailable = u => {
  assert.equal(u.tps, null); assert.equal(u.genMs, 0); assert.equal(u.genOut, 0);
  assert.equal(u.speedBasis, null); assert.equal(u.speedScope, null);
  assert.equal(speedDisplay(u).value, '—'); assert.equal(speedDisplay(u).label, 'Speed unavailable');
};

test('request TPS includes pre-header wait, TTFT, all output tokens and completion trailers', () => {
  const m = message(), before = structuredClone(m), u = usageOf([m]);
  assert.equal(u.tps, 40); assert.equal(u.genOut, 100); assert.equal(u.genMs, 2500);
  assert.equal(u.speedBasis, 'request'); assert.equal(u.speedScope, 'all');
  assert.equal(u.speedEstimated, true); assert.equal(u.speedTokensEstimated, false); assert.equal(u.speedTimeEstimated, false);
  assert.equal(u.output, 100); assert.equal(u.prompt, 260); assert.equal(u.cacheHit, 50 / 260);
  const display = speedDisplay(u);
  assert.equal(display.value, '~40.0'); assert.equal(display.label, 'Request TPS');
  assert.match(display.title, /including time to first token \(TTFT\) and completion trailers/);
  assert.match(display.title, /Excludes tool execution and gaps between calls/);
  assert.match(display.title, /Includes the first chunk and reasoning once/);
  assert.deepEqual(m, before);
});

test('longer TTFT and delayed completion lower request TPS, irrespective of chunk allocation', () => {
  for (const ttft of [1000, 600000]) for (const tail of [100, 600000]) {
    for (const firstWeight of [1, 10, 99, undefined]) {
      const end = ttft + 1000 + tail;
      const u = usage({ durationMs: 1, __timing: timing({ first: ttft, last: ttft + 1000, end, firstWeight }) });
      assert.equal(u.tps, 100 / (end / 1000)); assert.equal(u.genMs, end); assert.equal(u.genOut, 100);
    }
  }
});

test('single-chunk, burst, empty-delta and missing-chunk metadata do not change full request TPS', () => {
  for (const patch of [{ first: 2000, last: 2000, deltas: 1 }, { first: null, last: null, deltas: 0 },
    { weight: undefined, firstWeight: undefined }, { first: 2015, last: 2031, chars: 13016, deltas: 110 },
    { answer: { interrupted: true } }, { genStart: 2200 }, { thinkingChars: 0 }]) {
    const u = usage({ __timing: timing(patch) });
    assert.equal(u.genOut, 100); assert.equal(u.genMs, 2500); assert.equal(u.tps, 40);
  }
  assert.equal(usage({ __timing: timing({ start: 0, end: 10 }) }).tps, 10000, 'valid high TPS is not clamped');
});

test('explicit per-call duration is usable without source timing and never uses receipt windows', () => {
  for (const durationMs of [1, 500, 3000, 900000]) {
    for (const __timing of [undefined, timing({ source: 'renderer' }), timing({ source: undefined }), timing({ complete: false })]) {
      const u = usage({ durationMs, __timing });
      assert.equal(u.tps, 100 / (durationMs / 1000)); assert.equal(u.speedBasis, 'request');
    }
  }
  for (const source of [undefined, 'renderer', 'unknown']) unavailable(usage({ __timing: timing({ source }) }));
  for (const durationMs of [undefined, null, 0, -1, NaN, Infinity, '3000']) unavailable(usage({ durationMs, __timing: undefined }));
});

test('older source history uses its pre-request message timestamp, never first/last or message_start alone', () => {
  for (const source of ['agent', 'relay']) {
    const old = timing({ source, requestStart: undefined, start: 2000, first: 2100, last: 2200, end: 2500 });
    const u = usage({ __timing: old });
    assert.equal(u.tps, 40); assert.equal(u.speedTimeEstimated, true);
    assert.equal(speedDisplay(u).label, 'Request TPS (estimated)');
    assert.match(speedDisplay(u).title, /approximate request start/);
    for (const timestamp of [undefined, null, -1, NaN, Infinity, '0', 3000]) unavailable(usage({ timestamp, __timing: old }));
  }
});

test('malformed request timing cannot produce negative or fabricated request TPS', () => {
  for (const patch of [{ requestStart: -1 }, { requestStart: 900 }, { requestStart: '0' }, { requestStart: Infinity },
    { end: 100 }, { end: NaN }, { start: null }, { start: -1 }, { complete: false }]) {
    unavailable(usage({ timestamp: undefined, __timing: timing(patch) }));
  }
  unavailable(usage({ __timing: timing({ start: 0, end: 0 }) }));
});

test('slow and fast relay replay and history restore preserve source request TPS', t => {
  let now = 100000; t.mock.method(Date, 'now', () => now);
  for (const delay of [1, 1000, 60000]) {
    const final = message();
    let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: final });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(400) } });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_end', message: final });
    assert.deepEqual(transcript.messages[0].__timing, final.__timing);
    assert.equal(usageOf(transcript.messages).tps, 40);
    const persisted = JSON.parse(JSON.stringify(final));
    assert.equal(usageOf(fromHistory([persisted], { 0: timing({ source: 'renderer' }) }).messages).tps, 40);
    assert.equal(usageOf(fromHistory([message({ __timing: undefined })], { 0: final.__timing }).messages).tps, 40);
  }
});

test('mid-reply attach uses supplied duration, never a manufactured receipt window', () => {
  let transcript = applyEvent(emptyTranscript(), { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  transcript = applyEvent(transcript, { type: 'message_end', message: message({ __timing: undefined, durationMs: 3000 }) });
  assert.equal(transcript.messages[0].__timing, undefined);
  assert.equal(usageOf(transcript.messages).tps, 100 / 3);
});

test('hidden, summarized, redacted and fully streamed reasoning remain part of output exactly once', () => {
  for (const block of [undefined, { type: 'thinking', thinking: 'A summary' }, { type: 'thinking', thinking: 'x'.repeat(1600) },
    { type: 'thinking', redacted: true, thinkingSignature: 'opaque' }]) {
    for (const reasoning of [400, undefined]) {
      const u = usage({ usage: { output: 500, reasoning }, __usageProvenance: { thinking: 'summary' },
        content: [...(block ? [block] : []), { type: 'text', text: 'x'.repeat(400) }] });
      assert.equal(u.tps, 200); assert.equal(u.genOut, 500); assert.equal(u.genMs, 2500);
      assert.equal(u.speedScope, 'all'); assert.equal(u.speedTokensEstimated, false);
      assert.equal(u.output, 500); assert.equal(u.reasoning, reasoning ?? 0);
      assert.equal(speedDisplay(u).label, 'Request TPS');
    }
  }
});

test('placeholder and missing counts estimate available output without rewriting usage', () => {
  for (const content of [[{ type: 'text', text: 'x'.repeat(400) }], [{ type: 'thinking', thinking: 'x'.repeat(400) }],
    [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(400) } }]]) {
    for (const output of [undefined, null, 0, -1, NaN, Infinity, '100', 1]) {
      const m = message({ content, usage: { output, input: 12, cost: { total: 0.02 } } }), before = structuredClone(m), u = usageOf([m]);
      assert.equal(u.output, output === 1 ? 1 : 0); assert.equal(u.input, 12); assert.equal(u.cost, 0.02);
      assert.equal(u.speedTokensEstimated, true); assert.ok(u.genOut >= 100); assert.equal(u.tps, u.genOut / 2.5);
      assert.equal(speedDisplay(u).label, 'Request TPS (estimated)');
      assert.match(speedDisplay(u).title, /Provider token totals remain unchanged/);
      assert.deepEqual(m, before);
    }
  }
  unavailable(usage({ usage: undefined })); unavailable(usage({ usage: { output: 0 }, content: [] }));
  const reasoning = usage({ usage: { output: 1, reasoning: 80 }, content: [
    { type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }],
  });
  assert.equal(reasoning.genOut, 100, '20 estimated answer + 80 reasoning, not counted twice');
  const text = '中文测试'.repeat(100);
  assert.equal(estimateTokens(text), 400);
  assert.equal(usage({ usage: { output: 1 }, content: [{ type: 'text', text }] }).genOut, 400);
});

test('genuine positive counts and bridge estimates retain their provenance', () => {
  assert.equal(usage({ usage: { output: 1 }, content: [{ type: 'text', text: 'OK' }] }).genOut, 1);
  for (const output of [2, 16, 100]) {
    const u = usage({ usage: { output }, content: [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(10000) } }] });
    assert.equal(u.genOut, output); assert.equal(u.speedTokensEstimated, false);
  }
  const bridge = usage({ __usageProvenance: { source: 'estimated', cache: 'unknown' } });
  assert.equal(bridge.speedTokensEstimated, true); assert.equal(bridge.cacheHit, null);
});

test('aggregate TPS sums matching call output and durations, excluding tools, gaps and untimed calls', () => {
  const first = message(), second = message({ timestamp: 600000, usage: { output: 500, reasoning: 400 },
    __timing: timing({ requestStart: 600000, start: 601000, first: 602000, last: 603000, end: 607500 }) });
  const tool = { role: 'toolResult', toolName: 'bash', durationMs: 500000 };
  const untimed = message({ __timing: undefined });
  const u = usageOf([first, tool, second, untimed]);
  assert.equal(u.genMs, 10000); assert.equal(u.genOut, 600); assert.equal(u.tps, 60);
  assert.equal(u.output, 700); assert.equal(u.speedPartial, true); assert.equal(u.speedScope, 'all');
  assert.match(speedDisplay(u).title, /Only calls with usable timing/);
  assert.equal(usageOf([second, first]).tps, 60);
  assert.equal(usageOf([first, second]).speedPartial, false);
  const child = { role: 'toolResult', toolName: 'subagent', usage: { input: 10, output: 900, reasoning: 800 }, details: { results: [{ turns: 2 }] }, durationMs: 1 };
  const withChild = usageOf([first, child]);
  assert.equal(withChild.output, 1000); assert.equal(withChild.calls, 3); assert.equal(withChild.tps, 40);
});

test('unfinished, failed and aborted calls keep usage but do not claim final request TPS', () => {
  for (const stopReason of ['pending', 'deferred', 'error', 'aborted']) {
    const u = usage({ stopReason }); assert.equal(u.output, 100); unavailable(u);
  }
  unavailable(usage({ errorMessage: 'This operation was aborted' }));
});

test('each short, burst and tool-only reply shows its own request TPS', () => {
  const first = message();
  for (const output of [7, 38, 118]) {
    const last = message({ timestamp: 1, usage: { output }, content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
      __timing: timing({ first: 1000, last: 1000, end: 1273, deltas: 1 }) });
    assert.equal(speedReply([first, last]), last);
    assert.equal(usageOf([last]).tps, output / 1.273);
  }
  const untimed = message({ __timing: undefined });
  assert.equal(speedReply([first, untimed]), first);
  assert.match(speedDisplay(usageOf([first]), { earlier: true }).title, /no usable output or request timing/);
  const other = { ...untimed, model: 'other-model' };
  assert.equal(speedReply([first, other]), other, 'never borrow another model\'s speed');
  assert.equal(speedReply([]), undefined);
});
