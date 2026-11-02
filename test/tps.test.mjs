// Pure regressions for GitHub CI. Do not require an app, model request or live relay.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

const timing = overrides => ({ source: 'relay', complete: true, start: 0, first: 1000, last: 2000, end: 2100, chars: 400, deltas: 3, thinkingChars: 0, ...overrides });
const message = overrides => ({ role: 'assistant', timestamp: 1000, provider: 'example', model: 'example-model', stopReason: 'stop', content: [{ type: 'text', text: 'x'.repeat(400) }], usage: { input: 200, cacheRead: 50, cacheWrite: 10, output: 100, reasoning: 0, cost: { total: 0.2 } }, durationMs: 3000, ...overrides });
const usage = overrides => usageOf([message(overrides)]);

test('request averages explicitly include prefill and never claim generation-only TPS', () => {
  const u = usage();
  assert.equal(u.tps, 100 / 3);
  assert.equal(u.speedBasis, 'request');
  assert.equal(u.speedEstimated, false);
  assert.equal(u.prompt, 260);
  assert.equal(u.cacheHit, 50 / 260);
  const display = speedDisplay(u);
  assert.equal(display.value, '33.3');
  assert.equal(display.label, 'Request avg');
  assert.match(display.title, /including queueing, prefill and reasoning/);
  assert.match(display.title, /Not generation-only TPS/);
});

test('complete source-observed streaming is approximate and uses its own denominator', () => {
  const u = usage({ __timing: timing() });
  assert.equal(u.tps, 100);
  assert.equal(u.speedBasis, 'stream');
  assert.equal(u.speedEstimated, true);
  assert.equal(u.speedTokensEstimated, false);
  assert.equal(u.durationMs, 2100, 'timestamp zero is valid');
  assert.equal(speedDisplay(u).value, '~100');
  assert.equal(speedDisplay(u).label, 'Stream avg');
  assert.match(speedDisplay(u).title, /not server decode-only TPS/);
});

test('plausible renderer windows and old persisted timings cannot prove generation speed', () => {
  for (const source of [undefined, 'renderer', 'unknown']) {
    const u = usage({ __timing: timing({ source }) });
    assert.equal(u.tps, 100 / 3);
    assert.equal(u.speedBasis, 'request');
    assert.equal(usage({ durationMs: undefined, __timing: timing({ source }) }).tps, null);
  }
});

test('slow replay preserves the host clock, not desktop receipt spacing', t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const final = message({ __timing: timing() });
  let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: final });
  now += 60000;
  transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(400) } });
  now += 60000;
  transcript = applyEvent(transcript, { type: 'message_end', message: final });
  assert.deepEqual(transcript.messages[0].__timing, final.__timing);
  assert.equal(usageOf(transcript.messages).tps, 100);
  const stale = timing({ source: 'renderer', first: 100000, last: 100001, end: 100002 });
  assert.deepEqual(fromHistory(transcript.messages, { 1000: stale }).messages[0].__timing, final.__timing, 'history cannot overwrite supplied source timing with a stale receipt cache');
  assert.equal(usageOf(fromHistory([message()], { 1000: final.__timing }).messages).tps, 100, 'source timing survives the existing timing store');
});

test('legacy relay replay is request-average only, whether fast or throttled', t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  for (const delay of [1, 1000, 60000]) {
    let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: message() });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(200) } });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(200) } });
    transcript = applyEvent(transcript, { type: 'message_end', message: message() });
    assert.equal(transcript.messages[0].__timing.source, 'renderer');
    assert.equal(usageOf(transcript.messages).tps, 100 / 3);
    assert.equal(usageOf(transcript.messages).speedBasis, 'request');
  }
});

test('mid-reply attach does not invent a complete renderer timing window', () => {
  let transcript = applyEvent(emptyTranscript(), { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  transcript = applyEvent(transcript, { type: 'message_end', message: message({ durationMs: undefined }) });
  assert.equal(transcript.messages[0].__timing, undefined);
  assert.equal(usageOf(transcript.messages).tps, null);
  const withSource = applyEvent(emptyTranscript(), { type: 'message_end', message: message({ __timing: timing() }) });
  assert.equal(usageOf(withSource.messages).tps, 100, 'a complete source timing survives a mid-reply attach');
});

test('empty deltas do not establish first-token timing or count as chunks', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: message() });
  now = 50;
  transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '' } });
  assert.equal(transcript.live.__tFirst, undefined);
  assert.equal(transcript.live.__deltas, 0);
  now = 100;
  transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thinking' } });
  now = 200;
  transcript = applyEvent(transcript, { type: 'message_end', message: message() });
  assert.equal(transcript.messages[0].__timing.start, 0);
  assert.equal(transcript.messages[0].__timing.first, 100);
  assert.equal(transcript.messages[0].__timing.deltas, 1);
  assert.equal(transcript.messages[0].__timing.thinkingChars, 8);
});

test('incomplete, short, malformed, one-chunk and dense source windows fall back explicitly', () => {
  for (const patch of [
    { complete: false }, { complete: undefined }, { deltas: 1 }, { deltas: 0 },
    { first: undefined }, { first: NaN }, { last: Infinity }, { first: '1000' },
    { first: -1 }, { last: 999 }, { last: 1000 }, { end: 1500 },
    { last: 1100 }, { last: 1500, chars: 20000 }, { chars: 10 }, { chars: Infinity },
    { first: 1000, last: 5000, end: 5100 },
  ]) {
    const u = usage({ __timing: timing(patch) });
    assert.equal(u.speedBasis, 'request', JSON.stringify(patch));
    assert.equal(u.tps, 100 / 3);
  }
  const fast = usage({ content: [], usage: { output: 10000 }, durationMs: 500 });
  assert.equal(fast.tps, 20000, 'valid high request throughput is not arbitrarily capped');
});

test('Cursor one-token placeholders estimate speed for text, thinking and tool-only output, never totals', () => {
  const variants = [
    [{ type: 'text', text: 'x'.repeat(400) }],
    [{ type: 'thinking', thinking: 'x'.repeat(400) }],
    [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(400) } }],
  ];
  for (const content of variants) {
    const m = message({ provider: 'cursor', content, usage: { input: 12, output: 1, cost: { total: 0.02 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop' });
    const before = structuredClone(m);
    const u = usageOf([m]);
    assert.equal(u.output, 1);
    assert.equal(u.input, 12);
    assert.equal(u.cost, 0.02);
    assert.equal(u.speedTokensEstimated, true);
    assert.ok(u.genOut >= 100);
    assert.equal(u.tps, u.genOut / 3);
    assert.match(speedDisplay(u).value, /^~/);
    assert.match(speedDisplay(u).title, /Provider token totals remain unchanged/);
    assert.deepEqual(m, before, 'provider messages remain unchanged');
  }
});

test('missing usage estimates may describe speed but do not manufacture reported output', () => {
  for (const output of [undefined, null, 0, -1, NaN, Infinity, '100']) {
    const u = usage({ usage: { output } });
    assert.equal(u.output, 0);
    assert.equal(u.speedTokensEstimated, true);
    assert.equal(u.tps, 100 / 3);
  }
  assert.equal(usageOf([message({ usage: undefined })]).tps, null);
  assert.equal(usage({ usage: { output: 0 }, content: [] }).tps, null);
});

test('genuine small counts and large compressible text/tool bodies stay provider-reported', () => {
  assert.equal(usage({ usage: { output: 1 }, content: [{ type: 'text', text: 'OK' }] }).genOut, 1);
  for (const content of [
    [{ type: 'text', text: 'x'.repeat(10000) }],
    [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(10000) } }],
  ]) {
    for (const output of [2, 16, 100]) {
      const u = usage({ content, usage: { output } });
      assert.equal(u.output, output);
      assert.equal(u.genOut, output);
      assert.equal(u.speedTokensEstimated, false);
    }
  }
});

test('tool arguments participate in source-window coverage without overriding a real count', () => {
  const content = [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(400) } }];
  const u = usage({ content, stopReason: 'toolUse', __timing: timing({ chars: 430 }) });
  assert.equal(u.speedBasis, 'stream');
  assert.equal(u.genOut, 100);
  assert.equal(u.speedTokensEstimated, false);
});

test('hidden, summarized, redacted and unstreamed reasoning never divides by just the answer window', () => {
  for (const thinking of [undefined, { type: 'thinking', thinking: 'A summary' }, { type: 'thinking', redacted: true, thinkingSignature: 'opaque' }]) {
    const u = usage({ usage: { output: 500, reasoning: 400 }, content: [...(thinking ? [thinking] : []), { type: 'text', text: 'x'.repeat(400) }], __timing: timing({ chars: 450 }) });
    assert.equal(u.speedBasis, 'request');
    assert.equal(u.genOut, 500, 'reasoning is already included in output');
    assert.equal(u.output, 500);
    assert.equal(u.reasoning, 400);
  }
  const unstreamed = usage({ usage: { output: 100, reasoning: 80 }, content: [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }], __timing: timing() });
  assert.equal(unstreamed.speedBasis, 'request', 'final thinking text without thinking deltas cannot cover the source window');
});

test('fully streamed reasoning counts once, including in placeholder estimates', () => {
  const content = [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }];
  const source = timing({ thinkingChars: 320 });
  const u = usage({ usage: { output: 100, reasoning: 80 }, content, __timing: source });
  assert.equal(u.speedBasis, 'stream');
  assert.equal(u.genOut, 100);
  const placeholder = usage({ usage: { output: 1, reasoning: 80 }, content, __timing: source });
  assert.equal(placeholder.genOut, 100, '20 estimated answer + 80 reported reasoning, not 180');
  assert.equal(placeholder.output, 1);
  assert.equal(placeholder.reasoning, 80);
  assert.equal(placeholder.speedTokensEstimated, true);
});

test('invalid and missing API durations do not become zero, NaN or stale TPS', () => {
  for (const durationMs of [undefined, null, 0, -1, Infinity, NaN, '3000']) {
    const u = usage({ durationMs });
    assert.equal(u.tps, null);
    assert.equal(u.speedBasis, null);
    assert.equal(speedDisplay(u).value, '—');
    assert.equal(speedDisplay(u).label, 'Speed unavailable');
  }
  const noApi = usage({ durationMs: undefined, __timing: timing() });
  assert.equal(noApi.tps, 100, 'a complete source stream does not require API duration');
});

test('session speed never mixes streaming denominators with full-request durations', () => {
  const streamed = message({ __timing: timing() });
  const requestOnly = message({ timestamp: 2000, usage: { output: 200 }, durationMs: 4000 });
  const u = usageOf([streamed, requestOnly]);
  assert.equal(u.speedBasis, 'request');
  assert.equal(u.genMs, 7000);
  assert.equal(u.genOut, 300);
  assert.equal(u.tps, 300 / 7);
  assert.equal(u.speedPartial, false);
  const untimed = message({ timestamp: 3000, durationMs: undefined });
  const partial = usageOf([streamed, requestOnly, untimed]);
  assert.equal(partial.output, 400);
  assert.equal(partial.genOut, 300);
  assert.equal(partial.speedPartial, true);
  assert.match(speedDisplay(partial).title, /Only calls with usable timing/);
});

test('parallel subagent work adds authoritative usage, never main-model TPS', () => {
  const child = { role: 'toolResult', toolName: 'subagent', usage: { input: 10, output: 900, reasoning: 800, cost: { total: 1 } }, details: { results: [{ turns: 2 }] }, durationMs: 1 };
  const u = usageOf([message(), child]);
  assert.equal(u.output, 1000);
  assert.equal(u.reasoning, 800);
  assert.equal(u.calls, 3);
  assert.equal(u.genOut, 100);
  assert.equal(u.genMs, 3000);
  assert.equal(u.tps, 100 / 3);
});

test('unfinished, failed and aborted calls keep billed counts without claiming final speed', () => {
  for (const stopReason of ['pending', 'deferred', 'error', 'aborted']) {
    const u = usage({ stopReason });
    assert.equal(u.output, 100);
    assert.equal(u.tps, null);
  }
  assert.equal(usage({ errorMessage: 'This operation was aborted' }).tps, null);
});

test('CJK estimates are explicit and do not alter authoritative counts', () => {
  const text = '中文测试'.repeat(100);
  assert.equal(estimateTokens(text), 400);
  const u = usage({ usage: { output: 1 }, content: [{ type: 'text', text }] });
  assert.equal(u.genOut, 400);
  assert.equal(u.output, 1);
  assert.equal(u.speedTokensEstimated, true);
});
