import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMetrics } from '../agent/pidesk-bridge.js';
import { usageOf } from '../app/renderer/src/transcript.js';

function fixture() {
  const handlers = new Map(); let now = 0;
  registerMetrics({ on(name, fn) { handlers.set(name, fn); } }, () => now);
  return { emit: (name, event = {}) => handlers.get(name)(event), time: value => { now = value; } };
}
const msg = () => ({ role: 'assistant', timestamp: 42, provider: 'cursor', model: 'fixture',
  content: [{ type: 'text', text: 'x'.repeat(400) }], stopReason: 'stop', durationMs: 3000,
  usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 } });

test('agent timing is persisted before relay replay and ignores empty/non-generation events', () => {
  const f = fixture(), message = msg();
  f.emit('turn_start'); f.emit('message_start', { message });
  f.time(10); f.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: '' } });
  f.time(1000); f.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(200) } });
  f.time(2000); f.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(200) } });
  f.time(2100); const result = f.emit('message_end', { message }).message;
  assert.deepEqual(result.__timing, { source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 2100, chars: 400, deltas: 2, thinkingChars: 0, think: null });
  assert.equal(usageOf([result]).tps, 100);
  assert.equal(message.__timing, undefined, 'do not mutate input events');
  assert.deepEqual(JSON.parse(JSON.stringify(result)).__timing, result.__timing);
  assert.equal(f.emit('message_end', { message }), undefined, 'no duplicate or previous-call timing');
});

test('raw bridge provenance survives normalization without retaining raw events', () => {
  const f = fixture(), message = msg();
  f.emit('turn_start'); f.emit('message_start', { message });
  f.emit('provider_stream_event', { provider: 'cursor', model: 'fixture', data: {
    type: 'message_delta', usage: { cursor2api: { source: 'estimated', cache: 'unknown' } }, private: 'do not persist',
  } });
  f.time(3000); const result = f.emit('message_end', { message }).message;
  assert.deepEqual(result.__usageProvenance, { provider: 'cursor', model: 'fixture', source: 'estimated', cache: 'unknown', thinking: 'summary' });
  assert.ok(!JSON.stringify(result).includes('do not persist'));
  const usage = usageOf([result]);
  assert.equal(usage.output, 100); assert.equal(usage.genOut, 100);
  assert.equal(usage.speedTokensEstimated, true); assert.equal(usage.usageEstimated, true);
  assert.equal(usage.cacheHit, null); assert.equal(usage.cacheUnknown, true);
  f.emit('turn_start'); f.emit('message_start', { message });
  assert.equal(f.emit('message_end', { message }).message.__usageProvenance, undefined);
});

test('summary reasoning never appears to be full reasoning throughput', () => {
  const message = { ...msg(), content: [{ type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }],
    usage: { output: 100, reasoning: 80 }, __usageProvenance: { source: 'upstream', thinking: 'summary' },
    __timing: { source: 'agent', complete: true, start: 0, first: 1000, last: 2000, end: 3000, chars: 400, thinkingChars: 320, deltas: 4 } };
  assert.equal(usageOf([message]).speedBasis, 'request');
});

test('unrelated messages, provider events and session shutdown cannot contaminate timing', () => {
  const f = fixture(), message = msg();
  f.emit('turn_start'); f.emit('message_start', { message });
  f.emit('provider_stream_event', { provider: 'different', model: 'fixture', data: { usage: { cursor2api: { source: 'estimated' } } } });
  assert.equal(f.emit('message_end', { message: { role: 'user' } }), undefined);
  f.emit('session_shutdown');
  assert.equal(f.emit('message_end', { message }), undefined);
  f.emit('message_start', { message });
  f.emit('message_update', { message: { ...message, timestamp: 99 }, assistantMessageEvent: { type: 'text_delta', delta: 'not this call' } });
  assert.equal(f.emit('message_end', { message }).message.__timing.chars, 0);
});
