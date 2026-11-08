// Gemini models behind custom endpoints whose id doesn't name the model (Volcengine Ark's ep-… ids).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { geminiAlias, geminiModel, geminiStream } from '../agent/pidesk-gemini.mjs';
import pideskBridge from '../agent/pidesk-bridge.js';

const ARGON = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
const catalog = id => ({ 'gemini-4-argon': { thinkingLevelMap: ARGON }, 'gemini-2.5-flash': { thinkingLevelMap: { off: 'off', low: 'low' } } })[id];

test('a model whose id names no Gemini model is the Gemini model its id or name gives', () => {
  assert.equal(geminiAlias({ id: 'ep-20261104202510-wbfrp', name: 'gemini-4-argon' }, catalog), 'gemini-4-argon');
  assert.equal(geminiAlias({ id: 'ep-1', name: 'Gemini 4 Argon (Ark)' }, catalog), 'gemini-4-argon', 'a display name, shortened to the catalog model');
  assert.equal(geminiAlias({ id: 'google/gemini-2.5-flash-preview-0925' }, catalog), 'gemini-2.5-flash', 'a vendor prefix');
  assert.equal(geminiAlias({ id: 'ep-2', name: 'gemini-5-pro' }, catalog), 'gemini-5-pro', 'not in the catalog: the name as it is');
  for (const model of [{ id: 'gemini-2.5-pro', name: 'gemini-4-argon' }, { id: 'models/gemini-4-argon' }, { id: 'Gemini-4-Argon' }, { id: 'gemma-4-27b' },
    { id: 'ep-3', name: 'ep-3' }, { id: 'ep-4', name: 'Relay model' }, { id: 'ep-5' }])
    assert.equal(geminiAlias(model, catalog), undefined, JSON.stringify(model));
});

test('it takes its catalog model\'s thinking levels unless Settings gives some', () => {
  assert.deepEqual(geminiModel({ id: 'ep-1', name: 'gemini-4-argon', reasoning: true }, catalog).thinkingLevelMap, ARGON);
  const own = { low: 'low', high: 'high' };
  assert.equal(geminiModel({ id: 'ep-1', name: 'gemini-4-argon', thinkingLevelMap: own }, catalog).thinkingLevelMap, own);
  const plain = { id: 'gemini-2.5-pro' };
  assert.equal(geminiModel(plain, catalog), plain);
});

// A stand-in for pi-ai's Gemini adapter: records its calls, asks for the payload, then replies "hi"
// under the model id it was given (or fails while streaming).
function fakeAdapter({ fail = false } = {}) {
  const calls = [];
  const adapter = () => ({ streamSimple(model, context, options) {
    const call = { model, context, options };
    calls.push(call);
    const stream = new AssistantMessageEventStream();
    // Installed synchronously: geminiStream starts for-await as soon as it has the stream, before any microtask runs.
    if (fail) stream[Symbol.asyncIterator] = async function* () { throw new Error('socket hang up'); };
    queueMicrotask(async () => {
      call.payload = await options?.onPayload?.({ model: model.id, contents: [] }, model);
      if (fail) return;
      const message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now() };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  } });
  return { adapter, calls };
}
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return { events, result: await stream.result() }; };

test('an aliased model streams under its alias: earlier replies too, while the request and the reply keep the endpoint id', async () => {
  const { adapter, calls } = fakeAdapter();
  const stream = geminiStream([{ id: 'ep-1', name: 'gemini-4-argon' }, { id: 'gemini-2.5-pro' }], { adapter, catalog });
  const model = { id: 'ep-1', name: 'gemini-4-argon', api: 'google-generative-ai', provider: 'relay' };
  const earlier = { role: 'assistant', provider: 'relay', model: 'ep-1', content: [] };
  const elsewhere = { role: 'assistant', provider: 'other', model: 'ep-1', content: [] };
  const hooked = [];
  const { events, result } = await collect(stream(model, { messages: [{ role: 'user', content: 'x' }, earlier, elsewhere] }, { onPayload: (payload, m) => { hooked.push({ payload, m }); } }));
  assert.equal(calls[0].model.id, 'gemini-4-argon');
  assert.deepEqual(calls[0].context.messages.map(m => m.model), [undefined, 'gemini-4-argon', 'ep-1'], 'only this model\'s replies');
  assert.equal(earlier.model, 'ep-1', 'the conversation itself is untouched');
  assert.equal(calls[0].payload.model, 'ep-1', 'the request names the endpoint id');
  assert.equal(hooked[0].payload.model, 'ep-1');
  assert.equal(hooked[0].m, model, 'Pi\'s request hooks see the model as registered');
  assert.deepEqual(events.map(e => (e.partial ?? e.message).model), ['ep-1', 'ep-1']);
  assert.equal(result.model, 'ep-1');

  const plain = { id: 'gemini-2.5-pro', api: 'google-generative-ai', provider: 'relay' };
  const context = { messages: [] };
  await collect(stream(plain, context, {}));
  assert.equal(calls[1].model, plain, 'a model with a Gemini id goes through unchanged');
  assert.equal(calls[1].context, context);
});

test('a stream that breaks ends with an error under the endpoint id', async () => {
  const { adapter } = fakeAdapter({ fail: true });
  const stream = geminiStream([{ id: 'ep-1', name: 'gemini-4-argon' }], { adapter, catalog });
  const { events, result } = await collect(stream({ id: 'ep-1', name: 'gemini-4-argon', api: 'google-generative-ai', provider: 'relay' }, { messages: [] }, {}));
  assert.deepEqual(events.map(e => e.type), ['error']);
  assert.equal(result.stopReason, 'error');
  assert.equal(result.model, 'ep-1');
  assert.match(result.errorMessage, /socket hang up/);
});

test('the bridge streams Google-protocol providers with such models itself, and registers the rest as before', t => {
  const saved = process.env.PIDESK_BOOT;
  t.after(() => { if (saved === undefined) delete process.env.PIDESK_BOOT; else process.env.PIDESK_BOOT = saved; });
  process.env.PIDESK_BOOT = JSON.stringify({ providers: [
    { id: 'ark', name: 'Ark', api: 'google-generative-ai', baseUrl: 'https://ark.example.com/v1beta', apiKey: 'k1', models: [{ id: 'ep-20261104202510-wbfrp', name: 'gemini-4-argon', reasoning: true }] },
    { id: 'relay', name: 'Relay', api: 'google-generative-ai', baseUrl: 'https://relay.example.com/v1beta', apiKey: 'k2', models: [{ id: 'gemini-2.5-pro', reasoning: true }] },
    { id: 'gateway', name: 'Gateway', api: 'openai-completions', baseUrl: 'https://gw.example.com/v1', apiKey: 'k3', models: [{ id: 'ep-9', name: 'gemini-4-argon' }] },
  ] });
  const registered = new Map();
  pideskBridge({ on() {}, registerTool() {}, registerCommand() {}, registerProvider(id, config) { registered.set(id, config); } });
  const ark = registered.get('ark');
  assert.equal(typeof ark.streamSimple, 'function');
  assert.deepEqual(ark.models[0].thinkingLevelMap, ARGON, 'Pi\'s catalog: Gemini 4 Argon accepts low, medium and high');
  assert.equal(ark.models[0].id, 'ep-20261104202510-wbfrp', 'still registered under the endpoint id');
  assert.equal(registered.get('relay').streamSimple, undefined);
  assert.equal(registered.get('gateway').streamSimple, undefined, 'only the Google protocol');
});
