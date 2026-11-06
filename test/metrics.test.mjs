import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMetrics } from '../agent/pidesk-bridge.js';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

function fixture() {
  const handlers = new Map(); let now = 0;
  registerMetrics({ on(name, fn) { handlers.set(name, fn); } }, () => now);
  return { emit: (name, event = {}, ctx) => handlers.get(name)(event, ctx), time: value => { now = value; } };
}
const msg = () => ({ role: 'assistant', timestamp: 42, provider: 'cursor', model: 'fixture',
  content: [{ type: 'text', text: 'x'.repeat(400) }], stopReason: 'stop', durationMs: 3000,
  usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 } });
const delta = (f, message, time, text, type = 'text_delta') => {
  f.time(time); f.emit('message_update', { message, assistantMessageEvent: Object.freeze({ type, delta: text }) });
};
const finish = (f, message, time) => {
  f.time(time); return f.emit('message_end', { message }).message;
};
const raw = (f, message, data) => f.emit('provider_stream_event', { provider: message.provider, model: message.model, api: message.api, data });
const nativeAnthropic = () => ({ ...msg(), provider: 'anthropic', model: 'claude-fixture', api: 'anthropic-messages' });
const request = (f, message, thinking = { type: 'adaptive', display: 'summarized' }) =>
  f.emit('before_provider_request', { payload: { model: message.model, thinking } },
    { model: { provider: message.provider, id: message.model, api: message.api } });
const thinkingStart = (f, message, time) => {
  f.time(time); f.emit('message_update', { message, assistantMessageEvent: Object.freeze({ type: 'thinking_start' }) });
};
const frozen = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};

test('agent timing excludes the first chunk and persists bounded root and answer counters', () => {
  const f = fixture(), message = frozen(msg());
  f.emit('turn_start'); f.emit('message_start', { message });
  for (const event of [{ type: 'text_delta', delta: '' }, { type: 'text_start', delta: 'not output' },
    { type: 'text_end', content: 'not a delta' }, { type: 'thinking_delta', delta: null }]) {
    f.time(10); f.emit('message_update', { message, assistantMessageEvent: frozen(event) });
  }
  delta(f, message, 1000, 'x'.repeat(200));
  delta(f, message, 2000, 'x'.repeat(200));
  const result = finish(f, message, 2100);
  assert.deepEqual(result.__timing, { source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 2100,
    chars: 400, deltas: 2, weight: 100, firstWeight: 50,
    answer: { first: 1000, last: 2000, chars: 400, deltas: 2, weight: 100, firstWeight: 50 },
    thinkingChars: 0, think: null });
  const usage = usageOf([result]);
  assert.equal(usage.tps, 50); assert.equal(usage.genOut, 50); assert.equal(usage.output, 100);
  assert.equal(usage.genMs, 1000); assert.equal(usage.speedBasis, 'generation');
  assert.equal(usage.speedScope, 'all'); assert.equal(usage.speedEstimated, true);
  assert.equal(speedDisplay(usage).label, 'Generation');
  assert.equal(message.__timing, undefined, 'do not mutate input messages');
  assert.equal(f.emit('message_end', { message }), undefined, 'no duplicate or previous-call timing');
});

test('generation TPS is invariant under huge TTFT and delayed usage/end trailers', () => {
  for (const ttft of [1000, 600000]) {
    for (const trailer of [100, 600000]) {
      const f = fixture(), message = { ...msg(), durationMs: ttft + 1000 + trailer };
      f.emit('message_start', { message });
      delta(f, message, ttft, 'x'.repeat(200));
      delta(f, message, ttft + 1000, 'x'.repeat(200));
      f.time(ttft + 1000 + trailer);
      raw(f, message, { type: 'response.completed', response: { usage: { output_tokens: 100 } } });
      const result = finish(f, message, ttft + 1000 + trailer), usage = usageOf([result]);
      assert.equal(result.__timing.first, ttft); assert.equal(result.__timing.last, ttft + 1000);
      assert.equal(usage.tps, 50); assert.equal(usage.genOut, 50); assert.equal(usage.genMs, 1000);
      assert.equal(usage.output, 100);
    }
  }
});

test('all coalesced first-timestamp deltas are removed from the TPS numerator', () => {
  const f = fixture(), message = msg();
  f.emit('message_start', { message });
  delta(f, message, 1000, 'x'.repeat(100));
  delta(f, message, 1000, 'x'.repeat(100));
  delta(f, message, 2000, 'x'.repeat(200));
  const result = finish(f, message, 2100);
  assert.equal(result.__timing.deltas, 3); assert.equal(result.__timing.firstWeight, 50);
  assert.equal(result.__timing.answer.firstWeight, 50);
  assert.equal(usageOf([result]).tps, 50); assert.equal(usageOf([result]).genOut, 50);
});

test('weighting matches renderer CJK estimates without keeping generated content', () => {
  const f = fixture();
  const first = '\u3000あ㐀中文한豈Ａ', last = 'abc🙂'.repeat(40);
  const message = { ...msg(), content: [{ type: 'text', text: first + last }],
    usage: { output: estimateTokens(first + last) } };
  f.emit('message_start', { message });
  delta(f, message, 1000, first); delta(f, message, 2000, last);
  const result = finish(f, message, 2100);
  assert.equal(result.__timing.weight, estimateTokens(first + last));
  assert.equal(result.__timing.firstWeight, estimateTokens(first));
  assert.equal(result.__timing.answer.weight, result.__timing.weight);
  assert.ok(Math.abs(usageOf([result]).genOut - estimateTokens(last)) < 1e-9);
  assert.ok(Math.abs(usageOf([result]).tps - estimateTokens(last)) < 1e-9);
  assert.ok(!JSON.stringify(result.__timing).includes(first));
});

test('raw Cursor provenance survives normalization without input mutation or raw event retention', () => {
  for (const usagePath of ['usage', 'message', 'response']) {
    const f = fixture(), message = frozen(msg());
    f.emit('turn_start'); f.emit('message_start', { message });
    const usage = { cursor2api: { source: 'estimated', cache: 'unknown' } };
    const data = frozen({ type: 'message_delta', ...(usagePath === 'usage' ? { usage } : { [usagePath]: { usage } }),
      private: 'do not persist' });
    const before = JSON.stringify(data);
    raw(f, message, data);
    const result = finish(f, message, 3000);
    assert.deepEqual(result.__usageProvenance, { provider: 'cursor', model: 'fixture', source: 'estimated', cache: 'unknown', thinking: 'summary' });
    assert.equal(JSON.stringify(data), before); assert.equal(message.__usageProvenance, undefined);
    assert.ok(!JSON.stringify(result).includes('do not persist'));
    const totals = usageOf([result]);
    assert.equal(totals.output, 100); assert.equal(totals.speedBasis, 'response', 'summarized reasoning: only a whole-response estimate');
    assert.equal(totals.usageEstimated, true); assert.equal(totals.cacheHit, null); assert.equal(totals.cacheUnknown, true);
    assert.equal(speedDisplay(totals).label, 'Generation (estimated)');
    f.emit('turn_start'); f.emit('message_start', { message });
    assert.equal(f.emit('message_end', { message }).message.__usageProvenance, undefined);
  }
});

test('OpenAI Responses summary events identify summary reasoning without a Cursor marker', () => {
  for (const type of ['response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done']) {
    const f = fixture(), message = { ...msg(), provider: 'openai', model: 'reasoning-fixture', api: 'openai-responses' };
    f.emit('message_start', { message });
    const event = frozen({ provider: message.provider, model: message.model, api: 'openai-responses',
      data: { type, delta: 'private summary text', part: { text: 'private summary text' } } });
    const before = JSON.stringify(event);
    f.emit('provider_stream_event', event);
    const result = finish(f, message, 3000);
    assert.deepEqual(result.__usageProvenance, { provider: 'openai', model: 'reasoning-fixture', thinking: 'summary' });
    assert.equal(result.__usageProvenance.source, undefined, 'do not invent usage/cache provenance');
    assert.equal(result.__usageProvenance.cache, undefined);
    assert.equal(JSON.stringify(event), before);
    assert.ok(!JSON.stringify(result).includes('private summary text'));
  }
});

test('native Anthropic summarized or omitted thinking uses answer TPS even for long answers and missing counts', () => {
  for (const display of ['summarized', 'omitted']) {
    for (const reasoning of [80, undefined]) {
      const f = fixture(), message = frozen({ ...nativeAnthropic(), durationMs: 600000,
        content: [...(display === 'summarized' ? [{ type: 'thinking', thinking: 'x'.repeat(320) }] : []),
          { type: 'text', text: 'x'.repeat(4000) }],
        usage: { output: reasoning === undefined ? 1800 : 1080, ...(reasoning === undefined ? {} : { reasoning }) } });
      f.emit('turn_start'); request(f, message, { type: 'adaptive', display });
      f.emit('message_start', { message: { role: 'user' } }); // does not consume the request flag
      f.emit('message_start', { message });
      if (display === 'summarized') {
        raw(f, message, { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } });
        thinkingStart(f, message, 1000); delta(f, message, 1000, 'x'.repeat(320), 'thinking_delta');
      }
      delta(f, message, 10000, 'x'.repeat(2000)); delta(f, message, 11000, 'x'.repeat(2000));
      const result = finish(f, message, 600000), usage = usageOf([result]);
      assert.deepEqual(result.__usageProvenance, { provider: message.provider, model: message.model,
        thinking: 'summary', thinkingSource: 'request', thinkingDisplay: display });
      assert.equal(result.__timing.answer.interrupted, undefined);
      assert.equal(usage.speedScope, 'answer'); assert.equal(usage.genMs, 1000);
      assert.equal(usage.genOut, 500); assert.equal(usage.tps, 500);
      assert.equal(usage.output, message.usage.output); assert.equal(usage.reasoning, reasoning ?? 0);
      assert.equal(usage.speedTokensEstimated, reasoning === undefined);
      assert.equal(message.__usageProvenance, undefined);
    }
  }
});

test('request observation retains only the display enum and does not mutate request or context', () => {
  const f = fixture(), message = frozen(nativeAnthropic());
  const event = frozen({ payload: { model: message.model, thinking: { type: 'enabled', display: 'summarized', budget_tokens: 10000 },
    messages: [{ content: 'private request text' }], metadata: { user_id: 'private user' } } });
  const ctx = frozen({ model: { id: message.model, provider: message.provider, api: message.api,
    apiKey: 'private credential', headers: { authorization: 'private header' } } });
  const before = JSON.stringify({ event, ctx });
  assert.equal(f.emit('before_provider_request', event, ctx), undefined, 'notification must not replace the payload');
  f.emit('message_start', { message });
  const result = finish(f, message, 3000);
  assert.deepEqual(result.__usageProvenance, { provider: message.provider, model: message.model,
    thinking: 'summary', thinkingSource: 'request', thinkingDisplay: 'summarized' });
  assert.equal(JSON.stringify({ event, ctx }), before);
  assert.ok(!JSON.stringify(result).includes('private'));
  f.emit('message_start', { message: { ...message, timestamp: 43 } });
  assert.equal(finish(f, { ...message, timestamp: 43 }, 4000).__usageProvenance, undefined, 'consume only once');
});

test('pending display is reset on turn/session boundaries, replaced requests, and mismatched assistant identity', () => {
  for (const boundary of ['turn_start', 'session_start', 'session_shutdown']) {
    const f = fixture(), message = nativeAnthropic();
    request(f, message); f.emit(boundary); f.emit('message_start', { message });
    assert.equal(finish(f, message, 3000).__usageProvenance, undefined);
  }
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { api: 'openai-responses' }]) {
    const f = fixture(), message = nativeAnthropic(), other = { ...message, ...patch };
    request(f, message); f.emit('message_start', { message: other });
    assert.equal(finish(f, other, 3000).__usageProvenance, undefined);
    f.emit('message_start', { message });
    assert.equal(finish(f, message, 4000).__usageProvenance, undefined, 'mismatch must not leave a stale flag');
  }
  for (const thinking of [undefined, { type: 'disabled', display: 'summarized' }, { type: 'enabled' },
    { type: 'enabled', display: 'arbitrary private text' }]) {
    const f = fixture(), message = nativeAnthropic();
    request(f, message);
    f.emit('before_provider_request', { payload: { model: message.model, thinking } },
      { model: { id: message.model, provider: message.provider, api: message.api } });
    f.emit('message_start', { message });
    assert.equal(finish(f, message, 3000).__usageProvenance, undefined, 'a newer request replaces the old flag');
  }
  const f = fixture(), message = nativeAnthropic();
  f.emit('message_start', { message });
  request(f, message); // an instrumented nested/background call cannot label the current or next message
  assert.equal(finish(f, message, 3000).__usageProvenance, undefined);
  f.emit('message_start', { message });
  assert.equal(finish(f, message, 4000).__usageProvenance, undefined);
});

test('request display capture requires matching serialized model and Anthropic API in the real hook context', () => {
  for (const model of [undefined, { id: 'different', provider: 'anthropic', api: 'anthropic-messages' },
    { id: 'claude-fixture', provider: 'anthropic', api: 'openai-responses' }]) {
    const f = fixture(), message = nativeAnthropic();
    // Top-level provider/model/api are not in the runner's request event contract and cannot scope it.
    f.emit('before_provider_request', { provider: message.provider, model: message.model, api: message.api,
      payload: { model: message.model, thinking: { type: 'adaptive', display: 'summarized' } } }, { model });
    f.emit('message_start', { message });
    assert.equal(finish(f, message, 3000).__usageProvenance, undefined);
  }
});

test('raw Anthropic thinking conservatively marks unavailable request provenance and preserves Cursor evidence', () => {
  for (const block of ['thinking', 'redacted_thinking']) {
    for (const markerFirst of [true, false]) {
      const f = fixture(), message = nativeAnthropic();
      f.emit('message_start', { message });
      const thinking = frozen({ type: 'content_block_start', content_block: { type: block, data: 'private encrypted data' } });
      const cursor = frozen({ type: 'message_delta', usage: { cursor2api: { source: 'upstream', cache: 'reported' } } });
      const before = JSON.stringify(thinking);
      for (const data of markerFirst ? [cursor, thinking] : [thinking, cursor]) raw(f, message, data);
      const result = finish(f, message, 3000);
      assert.deepEqual(result.__usageProvenance, { provider: message.provider, model: message.model,
        source: 'upstream', cache: 'reported', thinking: 'summary', thinkingSource: 'anthropic-block' });
      assert.equal(JSON.stringify(thinking), before); assert.ok(!JSON.stringify(result).includes('private encrypted data'));
    }
  }
  const f = fixture(), message = nativeAnthropic();
  request(f, message); f.emit('message_start', { message });
  raw(f, message, { usage: { cursor2api: { source: 'estimated', cache: 'unknown' } } });
  assert.deepEqual(finish(f, message, 3000).__usageProvenance, { provider: message.provider, model: message.model,
    thinking: 'summary', thinkingSource: 'request', thinkingDisplay: 'summarized', source: 'estimated', cache: 'unknown' });
});

test('native Anthropic raw thinking without request metadata still excludes unreported reasoning work', () => {
  const f = fixture(), message = { ...nativeAnthropic(), durationMs: 600000, content: [
    { type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(4000) },
  ], usage: { output: 1800 } };
  f.emit('message_start', { message });
  raw(f, message, { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } });
  delta(f, message, 1000, 'x'.repeat(320), 'thinking_delta');
  delta(f, message, 10000, 'x'.repeat(2000)); delta(f, message, 11000, 'x'.repeat(2000));
  const result = finish(f, message, 600000), usage = usageOf([result]);
  assert.deepEqual(result.__usageProvenance, { provider: message.provider, model: message.model,
    thinking: 'summary', thinkingSource: 'anthropic-block' });
  assert.equal(usage.speedScope, 'answer'); assert.equal(usage.speedTokensEstimated, true);
  assert.equal(usage.tps, 500); assert.equal(usage.genMs, 1000); assert.equal(usage.output, 1800);
});

test('raw Anthropic fallback requires a matching API and a thinking block', () => {
  for (const api of ['openai-responses', undefined]) {
    const f = fixture(), message = nativeAnthropic();
    f.emit('message_start', { message });
    raw(f, { ...message, api }, { type: 'content_block_start', content_block: { type: 'thinking' } });
    raw(f, message, { type: 'content_block_start', content_block: { type: 'text' } });
    assert.equal(finish(f, message, 3000).__usageProvenance, undefined);
  }
});

test('summary detection preserves Cursor source/cache markers in either event order', () => {
  for (const summaryFirst of [true, false]) {
    const f = fixture(), message = msg();
    f.emit('message_start', { message });
    const marker = { type: 'response.completed', response: { usage: { cursor2api: { source: 'upstream', cache: 'reported' } } } };
    const summary = { type: 'response.reasoning_summary_text.delta', delta: 'summary' };
    for (const event of summaryFirst ? [summary, marker] : [marker, summary]) raw(f, message, frozen(event));
    const result = finish(f, message, 3000);
    assert.deepEqual(result.__usageProvenance, { provider: 'cursor', model: 'fixture', source: 'upstream', cache: 'reported', thinking: 'summary' });
  }
});

test('summary, hidden and redacted reasoning use the answer-only generation window', () => {
  for (const kind of ['summary', 'hidden', 'redacted']) {
    const f = fixture(), message = { ...msg(), durationMs: 11100,
      content: [
        ...(kind === 'hidden' ? [] : [{ type: 'thinking', thinking: kind === 'summary' ? 'x'.repeat(320) : '',
          ...(kind === 'redacted' ? { redacted: true, thinkingSignature: 'opaque' } : {}) }]),
        { type: 'text', text: 'x'.repeat(80) },
      ], usage: { output: 100, reasoning: 80 } };
    f.emit('message_start', { message });
    if (kind === 'summary') {
      raw(f, message, { type: 'response.reasoning_summary_text.delta', delta: 'x'.repeat(160) });
      delta(f, message, 1000, 'x'.repeat(160), 'thinking_delta');
      delta(f, message, 2000, 'x'.repeat(160), 'thinking_delta');
    }
    delta(f, message, 10000, 'x'.repeat(40)); delta(f, message, 11000, 'x'.repeat(40));
    const result = finish(f, message, 11100), usage = usageOf([result]);
    assert.deepEqual(result.__timing.answer, { first: 10000, last: 11000, chars: 80, deltas: 2, weight: 20, firstWeight: 10 });
    if (kind === 'summary') {
      assert.equal(result.__timing.first, 1000); assert.equal(result.__timing.chars, 400);
      assert.equal(result.__timing.weight, 100); assert.equal(result.__timing.firstWeight, 40);
      assert.equal(result.__timing.thinkingChars, 320); assert.equal(result.__timing.think, 9000);
    }
    assert.equal(usage.tps, 10); assert.equal(usage.genOut, 10); assert.equal(usage.genMs, 1000);
    assert.equal(usage.output, 100); assert.equal(usage.reasoning, 80);
    assert.equal(usage.speedBasis, 'generation'); assert.equal(usage.speedScope, 'answer');
    assert.equal(speedDisplay(usage).label, 'Answer generation');
  }
});

test('fully streamed reasoning uses the root window and includes reasoning only once', () => {
  const f = fixture(), message = { ...msg(), durationMs: 11100, content: [
    { type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) },
  ], usage: { output: 100, reasoning: 80 } };
  f.emit('message_start', { message });
  delta(f, message, 1000, 'x'.repeat(160), 'thinking_delta');
  delta(f, message, 2000, 'x'.repeat(160), 'thinking_delta');
  delta(f, message, 10000, 'x'.repeat(40)); delta(f, message, 11000, 'x'.repeat(40));
  const result = finish(f, message, 11100), usage = usageOf([result]);
  assert.equal(result.__usageProvenance, undefined);
  assert.equal(usage.speedScope, 'all'); assert.equal(usage.genMs, 10000);
  assert.equal(usage.genOut, 60); assert.equal(usage.tps, 6);
  assert.equal(usage.output, 100); assert.equal(usage.reasoning, 80);
});

test('summary reasoning with unknown reasoning usage estimates answer tokens, not hidden work', () => {
  const f = fixture(), message = { ...msg(), content: [
    { type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) },
  ], usage: { output: 100 } };
  f.emit('message_start', { message });
  raw(f, message, { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } });
  delta(f, message, 1000, 'x'.repeat(320), 'thinking_delta');
  delta(f, message, 2000, 'x'.repeat(40)); delta(f, message, 3000, 'x'.repeat(40));
  const usage = usageOf([finish(f, message, 3100)]);
  assert.equal(usage.tps, 10); assert.equal(usage.genOut, 10); assert.equal(usage.output, 100);
  assert.equal(usage.speedScope, 'answer'); assert.equal(usage.speedTokensEstimated, true);
});

test('answer output resumed after summarized or redacted thinking has no measured TPS', () => {
  for (const kind of ['summary', 'native-summary', 'redacted']) {
    for (const resumedType of ['text_delta', 'toolcall_delta']) {
      const f = fixture(), message = { ...(kind === 'native-summary' ? nativeAnthropic() : msg()), durationMs: 600000, content: [
        { type: 'text', text: 'x'.repeat(200) },
        { type: 'thinking', thinking: kind !== 'redacted' ? 'x'.repeat(320) : '', ...(kind === 'redacted' ? { redacted: true } : {}) },
        ...(resumedType === 'text_delta' ? [{ type: 'text', text: 'x'.repeat(200) }] :
          [{ type: 'toolCall', name: 'emit', arguments: { value: 'x'.repeat(200) } }]),
      ], usage: { output: 180, reasoning: 80 } };
      if (kind === 'native-summary') request(f, message);
      f.emit('message_start', { message });
      delta(f, message, 1000, 'x'.repeat(200));
      if (kind !== 'redacted') {
        raw(f, message, kind === 'native-summary'
          ? { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }
          : { type: 'response.reasoning_summary_text.delta', delta: 'summary' });
        // Some transports only emit thinking_delta; no thinking_start is needed to mark a gap.
        delta(f, message, 100000, 'x'.repeat(320), 'thinking_delta');
      } else thinkingStart(f, message, 100000); // redacted thinking has no text deltas
      delta(f, message, 201000, 'x'.repeat(200), resumedType);
      const result = finish(f, message, 600000), usage = usageOf([result]);
      assert.equal(result.__timing.answer.interrupted, true);
      assert.equal(result.__timing.answer.last - result.__timing.answer.first, 200000);
      assert.equal(result.__timing.interrupted, undefined, 'the root stream is not an answer-only sample');
      // An interrupted answer window is never measured. The speed is an estimate: from Anthropic's
      // content block, which marked when output began, else over the whole response.
      const basis = kind === 'native-summary' ? 'start' : 'response';
      assert.equal(usage.speedBasis, basis); assert.equal(usage.genMs, kind === 'native-summary' ? 200000 : 600000);
      assert.equal(usage.output, 180); assert.equal(usage.reasoning, 80);
      assert.equal(speedDisplay(usage).label, 'Generation (estimated)');
      const persisted = JSON.parse(JSON.stringify(result));
      assert.equal(persisted.__timing.answer.interrupted, true);
      assert.equal(usageOf(fromHistory([persisted]).messages).speedBasis, basis);
      assert.equal(usageOf(applyEvent(emptyTranscript(), { type: 'message_end', message: persisted }).messages).speedBasis, basis);
    }
  }
});

test('thinking before the answer or after its last delta does not interrupt the answer window', () => {
  for (const kind of ['summary', 'redacted']) {
    for (const position of ['before', 'after']) {
      const f = fixture(), message = { ...msg(), durationMs: 600000, content: [
        { type: 'thinking', thinking: kind === 'summary' ? 'x'.repeat(320) : '', ...(kind === 'redacted' ? { redacted: true } : {}) },
        { type: 'text', text: 'x'.repeat(400) },
      ], usage: { output: 180, reasoning: 80 } };
      f.emit('message_start', { message });
      const thinking = time => {
        if (kind === 'summary') raw(f, message, { type: 'response.reasoning_summary_text.delta', delta: 'summary' });
        thinkingStart(f, message, time);
        if (kind === 'summary') delta(f, message, time, 'x'.repeat(320), 'thinking_delta');
      };
      if (position === 'before') thinking(1000);
      delta(f, message, 100000, 'x'.repeat(200)); delta(f, message, 101000, 'x'.repeat(200));
      if (position === 'after') thinking(200000);
      // Non-output events and empty deltas after a boundary do not extend the answer window.
      delta(f, message, 300000, '', 'toolcall_delta');
      f.emit('message_update', { message, assistantMessageEvent: { type: 'text_end', content: 'not a delta' } });
      const result = finish(f, message, 600000), usage = usageOf([result]);
      assert.equal(result.__timing.answer.interrupted, undefined, 'omit false to preserve stored window shape');
      assert.equal(usage.speedScope, 'answer'); assert.equal(usage.genMs, 1000);
      assert.equal(usage.genOut, 50); assert.equal(usage.tps, 50);
    }
  }
});

test('interleaved fully streamed reasoning can still use the uninterrupted root sample', () => {
  const f = fixture(), message = { ...msg(), durationMs: 600000, content: [
    { type: 'text', text: 'x'.repeat(200) }, { type: 'thinking', thinking: 'x'.repeat(320) },
    { type: 'text', text: 'x'.repeat(200) },
  ], usage: { output: 180, reasoning: 80 } };
  f.emit('message_start', { message });
  delta(f, message, 1000, 'x'.repeat(200)); thinkingStart(f, message, 2000);
  delta(f, message, 100000, 'x'.repeat(320), 'thinking_delta');
  delta(f, message, 201000, 'x'.repeat(200));
  const result = finish(f, message, 600000), usage = usageOf([result]);
  assert.equal(result.__timing.answer.interrupted, true); assert.equal(result.__timing.interrupted, undefined);
  assert.equal(result.__usageProvenance, undefined); assert.equal(usage.speedScope, 'all');
  assert.equal(usage.genMs, 200000); assert.equal(usage.genOut, 130); assert.equal(usage.tps, 0.65);
});

test('text and tool argument deltas share an answer window; thinking stays in the root only', () => {
  const f = fixture(), message = msg();
  f.emit('message_start', { message });
  delta(f, message, 1000, '思考', 'thinking_delta');
  delta(f, message, 2000, 'done');
  delta(f, message, 2000, '{"x":', 'toolcall_delta');
  delta(f, message, 3000, '1}', 'toolcall_delta');
  const timing = finish(f, message, 10000).__timing;
  assert.deepEqual(timing.answer, { first: 2000, last: 3000, chars: 11, deltas: 3, weight: 2.75, firstWeight: 2.25 });
  assert.equal(timing.first, 1000); assert.equal(timing.last, 3000); assert.equal(timing.deltas, 4);
  assert.equal(timing.chars, 13); assert.equal(timing.weight, 4.75); assert.equal(timing.firstWeight, 2);
  assert.equal(timing.thinkingChars, 2); assert.equal(timing.think, 1000);
});

test('source timing and provenance survive JSON history and delayed relay replay unchanged', () => {
  const f = fixture(), message = msg();
  f.emit('message_start', { message });
  raw(f, message, { type: 'response.reasoning_summary_text.delta', delta: 'summary' });
  delta(f, message, 1000, 'x'.repeat(200)); delta(f, message, 2000, 'x'.repeat(200));
  const result = finish(f, message, 2100);
  const persisted = JSON.parse(JSON.stringify({ type: 'message', message: result })).message;
  const history = fromHistory([persisted], { [message.timestamp]: { source: 'renderer', start: 900000, end: 900001 } });
  const replay = applyEvent(emptyTranscript(), { type: 'message_end', message: persisted });
  for (const messages of [history.messages, replay.messages]) {
    assert.deepEqual(messages[0].__timing, result.__timing);
    assert.deepEqual(messages[0].__usageProvenance, result.__usageProvenance);
    assert.deepEqual(usageOf(messages), usageOf([result]));
    assert.equal(usageOf(messages).tps, 50);
  }
});

test('unrelated messages and provider/model/API events cannot contaminate an active call', () => {
  const f = fixture(), message = { ...msg(), api: 'openai-responses' };
  f.emit('message_start', { message });
  raw(f, message, { usage: { cursor2api: { source: 'upstream', cache: 'reported' } } });
  delta(f, message, 1000, 'x'.repeat(200));
  for (const unrelated of [{ ...message, timestamp: 99 }, { ...message, provider: 'different' },
    { ...message, model: 'different' }, { ...message, api: 'different' }, { role: 'user', timestamp: message.timestamp }]) {
    delta(f, unrelated, 1100, 'not this call');
    thinkingStart(f, unrelated, 1150);
    assert.equal(f.emit('message_end', { message: unrelated }), undefined);
  }
  for (const unrelated of [{ ...message, provider: 'different' }, { ...message, model: 'different' },
    { ...message, api: 'different' }, { ...message, api: undefined }]) {
    raw(f, unrelated, { usage: { cursor2api: { source: 'estimated', cache: 'unknown' } } });
    raw(f, unrelated, { type: 'response.reasoning_summary_text.delta', delta: 'not this call' });
  }
  delta(f, message, 2000, 'x'.repeat(200));
  const result = finish(f, message, 2100);
  assert.equal(result.__timing.chars, 400); assert.equal(result.__timing.firstWeight, 50);
  assert.equal(result.__timing.answer.interrupted, undefined);
  assert.equal(result.__usageProvenance.source, 'upstream'); assert.equal(result.__usageProvenance.cache, 'reported');
});

test('turn/session resets and replacing an unfinished call discard all counters and provenance', () => {
  for (const boundary of ['turn_start', 'session_start', 'session_shutdown', 'message_start']) {
    const f = fixture(), message = msg(), next = { ...msg(), timestamp: 43 };
    raw(f, message, { usage: { cursor2api: { source: 'estimated' } } }); // no active call
    f.emit('message_start', { message });
    raw(f, message, { type: 'response.reasoning_summary_text.delta', delta: 'old summary' });
    delta(f, message, 1000, 'old answer');
    thinkingStart(f, message, 1100); delta(f, message, 1200, 'resumed answer');
    if (boundary === 'message_start') f.emit(boundary, { message: next });
    else {
      f.emit(boundary);
      assert.equal(f.emit('message_end', { message }), undefined);
      raw(f, message, { usage: { cursor2api: { source: 'estimated' } } }); // late trailer
      f.emit('message_start', { message: next });
    }
    assert.equal(f.emit('message_end', { message }), undefined, 'old end must not consume the next call');
    const result = finish(f, next, 3000);
    assert.equal(result.__usageProvenance, undefined); assert.equal(result.__timing.chars, 0);
    assert.equal(result.__timing.weight, 0); assert.equal(result.__timing.firstWeight, 0);
    assert.deepEqual(result.__timing.answer, { first: null, last: null, chars: 0, deltas: 0, weight: 0, firstWeight: 0 });
    assert.equal(usageOf([result]).speedBasis, 'response', 'no measured window survives the reset');
  }
});

test('the bridge records when the provider began its output: the first output item or content block', () => {
  for (const [api, first, later] of [
    ['openai-responses', { type: 'response.output_item.added', item: { type: 'reasoning' } }, { type: 'response.output_item.added', item: { type: 'message' } }],
    ['anthropic-messages', { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_start', content_block: { type: 'text', text: '' } }],
  ]) {
    const f = fixture(), message = { ...msg(), api, usage: { output: 500, reasoning: 300 } };
    f.time(100); f.emit('message_start', { message });
    f.time(150); raw(f, message, { type: 'response.created' }); // not output yet
    f.time(400); raw(f, message, first);
    f.time(3000); raw(f, message, later);
    delta(f, message, 3000, 'x'.repeat(200)); delta(f, message, 5400, 'x'.repeat(200));
    const result = finish(f, message, 5500);
    assert.equal(result.__timing.genStart, 400, api);
    // The answer streamed long enough to time: its own rate, not the span from the marker.
    const usage = usageOf([result]);
    assert.equal(usage.speedBasis, 'generation', api); assert.equal(usage.speedScope, 'answer', api);
  }
  // Chat Completions streams reasoning visibly: no marker, the visible window as before.
  const f = fixture(), message = msg();
  f.emit('message_start', { message });
  raw(f, message, { object: 'chat.completion.chunk', choices: [{ delta: { reasoning_content: 'x' } }] });
  delta(f, message, 1000, 'x'.repeat(200)); delta(f, message, 2000, 'x'.repeat(200));
  assert.equal(finish(f, message, 2100).__timing.genStart, undefined);
});
