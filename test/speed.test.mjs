// The composer's Speed: Fast and Ultrafast processing where the provider sells it, the request body
// it changes, the fallback after a rate limit, what each reply records and costs, and how a
// conversation's speed reaches its Pi and its agents.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { ANTHROPIC_FAST_BETA, SPEED_COOLDOWN_MS, createSpeed, effectiveSpeed, speedOptions, speedUsed, withSpeed } from '../agent/pidesk-speed.mjs';
import { createSubagentTool } from '../agent/pidesk-subagent.mjs';
import pideskBridge from '../agent/pidesk-bridge.js';
import { SessionManager } from '../app/main/session-manager.mjs';
import { speedTier } from '../app/renderer/src/transcript.js';

const sol = { provider: 'openai', api: 'openai-responses', id: 'gpt-6.1-sol' };
const terra = { provider: 'openai', api: 'openai-responses', id: 'gpt-6.1-terra' };
const opus = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5' };
const opus48 = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-8' };
const cost = () => ({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 });
const reply = (model, extra = {}) => ({ role: 'assistant', provider: model.provider, api: model.api, model: model.id, timestamp: 1, content: [{ type: 'text', text: 'ok' }],
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: cost() }, stopReason: 'stop', ...extra });
const decode = line => JSON.parse(Buffer.from(line.split(' ')[1], 'base64').toString('utf8'));

test('the models that offer Fast and Ultrafast, among the configured ones', () => {
  assert.deepEqual(speedOptions(sol), ['standard', 'fast', 'ultrafast']);
  assert.deepEqual(speedOptions({ ...sol, id: 'gpt-6-astra' }), ['standard', 'fast', 'ultrafast']);
  assert.deepEqual(speedOptions(terra), ['standard', 'fast'], 'Fast mode, but no Ultrafast');
  assert.deepEqual(speedOptions({ ...sol, api: 'openai-completions' }), ['standard', 'fast'], 'Ultrafast is Responses-only');
  assert.deepEqual(speedOptions(opus), ['standard', 'fast']);
  assert.deepEqual(speedOptions(opus48), ['standard', 'fast']);
  for (const model of [
    { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5' }, // not among the models OpenAI's guide names
    { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-sonnet-5' },
    { provider: 'super-relay', api: 'openai-responses', id: 'model_hub/modelhub-gpt-6-astra-ada2s-kernel' }, // a relay need not pass it on
    { provider: 'deepseek', api: 'openai-completions', id: 'deepseek-flash' },
    { provider: 'super-relay-lp', api: 'anthropic-messages', id: 'openai/qwen3.8-27b' },
    null, undefined,
  ]) assert.deepEqual(speedOptions(model), [], JSON.stringify(model));
  assert.equal(effectiveSpeed('ultrafast', ['standard', 'fast']), 'fast', 'the fastest slower speed the model offers');
  assert.equal(effectiveSpeed('fast', []), 'standard');
});

test('the request body: OpenAI service_tier, Anthropic speed (with the beta for preview models)', () => {
  assert.deepEqual(withSpeed({ model: 'gpt-6.1-sol', input: [] }, sol, 'ultrafast'), { model: 'gpt-6.1-sol', input: [], service_tier: 'ultrafast' });
  assert.deepEqual(withSpeed({ model: 'claude-opus-5-5', betas: ['a'] }, opus, 'fast'), { model: 'claude-opus-5-5', betas: ['a'], speed: 'fast' });
  assert.deepEqual(withSpeed({ model: 'claude-opus-4-8', betas: ['a', ANTHROPIC_FAST_BETA] }, opus48, 'fast').betas, ['a', ANTHROPIC_FAST_BETA]);
  assert.deepEqual(withSpeed({ model: 'claude-opus-4-8' }, opus48, 'fast').betas, [ANTHROPIC_FAST_BETA]);
  assert.equal(withSpeed({ model: 'gpt-6.1-terra' }, terra, 'ultrafast'), undefined, 'not offered');
  assert.equal(withSpeed({ model: 'other' }, sol, 'fast'), undefined, 'a request for another model');
  assert.equal(withSpeed({ model: 'gpt-6.1-sol' }, sol, 'standard'), undefined);
});

test('the speed providers report, from their stream events', () => {
  assert.equal(speedUsed({ type: 'response.completed', response: { service_tier: 'default' } }), 'standard');
  assert.equal(speedUsed({ type: 'response.completed', response: { service_tier: 'priority' } }), 'fast');
  assert.equal(speedUsed({ type: 'response.completed', response: { service_tier: 'ultrafast' } }), 'ultrafast');
  assert.equal(speedUsed({ type: 'response.created', response: { service_tier: 'auto' } }), null);
  assert.equal(speedUsed({ object: 'chat.completion.chunk', service_tier: 'fast' }), 'fast');
  assert.equal(speedUsed({ type: 'message_start', message: { usage: { speed: 'fast' } } }), 'fast');
  assert.equal(speedUsed({ type: 'message_delta', usage: { speed: 'standard' } }), 'standard');
  assert.equal(speedUsed({ type: 'content_block_delta' }), null);
});

test('a reply records its speed and is priced at it; pi-ai already prices OpenAI Fast', () => {
  const speed = createSpeed({ speed: 'fast' });
  const anthropic = speed.request(opus, { model: 'claude-opus-5-5' });
  assert.equal(anthropic.payload.speed, 'fast');
  anthropic.event({ type: 'message_delta', usage: { speed: 'fast' } });
  const done = anthropic.finish(reply(opus));
  assert.deepEqual(done.__speed, { requested: 'fast', sent: 'fast', used: 'fast' });
  assert.deepEqual(done.usage.cost, { input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5, total: 7.5 }, 'Anthropic fast mode is 2x');
  const openai = speed.request(sol, { model: 'gpt-6.1-sol' });
  openai.event({ type: 'response.completed', response: { service_tier: 'fast' } });
  assert.deepEqual(openai.finish(reply(sol)).usage.cost, cost(), 'unchanged: pi-ai priced it from service_tier');
  speed.set('ultrafast');
  const ultra = speed.request(sol, { model: 'gpt-6.1-sol' });
  ultra.event({ type: 'response.completed', response: { service_tier: 'ultrafast' } });
  assert.equal(ultra.finish(reply(sol)).usage.cost.total, 3.75 * 6, 'Ultrafast is 6x');
  const downgraded = speed.request(sol, { model: 'gpt-6.1-sol' });
  downgraded.event({ type: 'response.completed', response: { service_tier: 'default' } });
  const ran = downgraded.finish(reply(sol));
  assert.deepEqual(ran.__speed, { requested: 'ultrafast', sent: 'ultrafast', used: 'standard' });
  assert.deepEqual(ran.usage.cost, cost(), 'ran at standard speed and price');
  assert.match(speedTier(ran).title, /The provider ran it at Standard speed/);
  const narrower = speed.request(terra, { model: 'gpt-6.1-terra' });
  assert.equal(narrower.payload.service_tier, 'fast', 'Ultrafast asked for, Fast is the fastest this model offers');
  assert.deepEqual(narrower.finish(reply(terra)).__speed, { requested: 'ultrafast', sent: 'fast', reason: 'model' });
  speed.set('standard');
  assert.equal(speed.request(sol, { model: 'gpt-6.1-sol' }), null, 'standard changes nothing and records nothing');
  assert.equal(createSpeed({ speed: 'fast' }).request({ provider: 'deepseek', api: 'openai-completions', id: 'deepseek-flash' }, { model: 'deepseek-flash' }), null);
});

test('a rate limit at the faster speed rests it for a few minutes instead of failing the run', () => {
  let now = 0;
  const speed = createSpeed({ speed: 'fast', now: () => now });
  const limited = speed.request(opus, { model: 'claude-opus-5-5' });
  limited.finish(reply(opus, { stopReason: 'error', errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Fast mode rate limit exceeded"}}' }));
  const retry = speed.request(opus, { model: 'claude-opus-5-5' });
  assert.equal(retry.payload, undefined, "Pi's retry goes at standard speed");
  const record = retry.finish(reply(opus));
  assert.deepEqual(record.__speed, { requested: 'fast', sent: 'standard', reason: 'resting' });
  assert.deepEqual(speedTier(record), { label: 'Standard', slower: true, title: 'Asked for Fast. Fast was rate limited or at capacity a moment ago, so requests go at Standard speed for a few minutes.' });
  now += SPEED_COOLDOWN_MS - 1;
  assert.equal(speed.request(opus, { model: 'claude-opus-5-5' }).payload, undefined, 'no switching back and forth: every switch misses the prompt cache');
  now += 1;
  assert.equal(speed.request(opus, { model: 'claude-opus-5-5' }).payload.speed, 'fast');
  const overloaded = speed.request(opus, { model: 'claude-opus-5-5' });
  overloaded.finish(reply(opus, { stopReason: 'error', errorMessage: '529 {"type":"error","error":{"type":"overloaded_error"}}' }));
  assert.equal(speed.request(opus, { model: 'claude-opus-5-5' }).payload, undefined, 'out of fast capacity (529) too');
  speed.set('standard'); speed.set('fast');
  assert.equal(speed.request(opus, { model: 'claude-opus-5-5' }).payload.speed, 'fast', 'choosing a speed again tries it at once');
  const failed = createSpeed({ speed: 'fast', now: () => now });
  failed.request(opus, { model: 'claude-opus-5-5' }).finish(reply(opus, { stopReason: 'error', errorMessage: '400 invalid_request_error: max_tokens' }));
  assert.equal(failed.request(opus, { model: 'claude-opus-5-5' }).payload.speed, 'fast', 'other errors keep the speed');
  assert.deepEqual(speedTier({ __speed: { requested: 'fast', sent: 'fast', used: 'fast' } }), { label: 'Fast', slower: false, title: 'This reply ran at Fast speed, billed at Fast rates.' });
  assert.equal(speedTier({ __speed: { requested: 'standard', sent: 'standard' } }), null);
  assert.equal(speedTier({}), null);
});

function fakePi() {
  const handlers = new Map(), commands = new Map();
  let active = [];
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { active.push(tool.name); }, registerProvider() {}, registerCommand(name, command) { commands.set(name, command); },
    getActiveTools: () => [...active], setActiveTools(names) { active = [...names]; },
  };
  // As Pi's extension runner: payload handlers chain, message_end handlers see earlier changes.
  const request = (payload, model) => (handlers.get('before_provider_request') ?? []).reduce((p, h) => h({ type: 'before_provider_request', payload: p }, { model }) ?? p, payload);
  const stream = (model, data) => { for (const h of handlers.get('provider_stream_event') ?? []) h({ type: 'provider_stream_event', provider: model.provider, api: model.api, model: model.id, data }); };
  const end = message => (handlers.get('message_end') ?? []).reduce((m, h) => h({ type: 'message_end', message: m })?.message ?? m, message);
  const config = value => commands.get('pidesk-config').handler(Buffer.from(JSON.stringify(value)).toString('base64'));
  return { pi, request, stream, end, config };
}

test('the bridge starts at the boot record speed and follows /pidesk-config', () => {
  process.env.PIDESK_BOOT = JSON.stringify({ providers: [], config: { subagents: 'limited', speed: 'fast', ultra: false } });
  const { pi, request, stream, end, config } = fakePi();
  pideskBridge(pi);
  assert.equal(request({ model: 'claude-opus-5-5' }, opus).speed, 'fast');
  stream(opus, { type: 'message_delta', usage: { speed: 'fast' } });
  assert.deepEqual(end(reply(opus)).__speed, { requested: 'fast', sent: 'fast', used: 'fast' });
  assert.equal(request({ model: 'deepseek-flash' }, { provider: 'deepseek', api: 'openai-completions', id: 'deepseek-flash' }).service_tier, undefined);
  config({ subagents: 'limited', speed: 'ultrafast' });
  assert.equal(request({ model: 'gpt-6.1-sol' }, sol).service_tier, 'ultrafast');
  config({ subagents: 'limited', speed: 'standard', ultra: false });
  const plain = request({ model: 'gpt-6.1-sol' }, sol);
  assert.equal(plain.service_tier, undefined);
  assert.equal(end(reply(sol)).__speed, undefined, 'nothing recorded at standard speed');
});

test("agents' requests go at the conversation's speed and are priced at it", async t => {
  const model = { ...opus, name: 'Opus', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
  const bodies = [];
  const ctx = {
    cwd: '/workspace', model, thinkingLevel: 'medium', getSystemPrompt: () => 'PARENT',
    sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) },
    tools: ['read'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}) })),
    modelRegistry: { streamSimple(m, _context, options) {
      const s = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        bodies.push(await options.onPayload?.({ model: m.id, max_tokens: 1 }, m) ?? { model: m.id, max_tokens: 1 });
        await options.onProviderStreamEvent?.({ type: 'message_delta', usage: { speed: 'fast' } }, m);
        s.push({ type: 'done', reason: 'stop', message: reply(m) }); s.end();
      });
      return s;
    } },
    executeTool: async () => ({ result: { content: [{ type: 'text', text: 'ok' }], details: {} }, isError: false }),
  };
  const speed = createSpeed({ speed: 'fast' });
  const c = createSubagentTool({ notify() {}, publish() {}, isIdle: () => false, speed });
  t.after(() => c.shutdown());
  const result = await c.tool.execute('call-1', { tasks: [{ name: 'Find the parser', task: 'Find where the parser is defined.' }], background: false }, undefined, undefined, ctx);
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(bodies[0].speed, 'fast');
  assert.equal(result.details.results[0].usage.cost.total, 7.5, 'priced at 2x');
});

test("a conversation's speed reaches its Pi: in the boot record, then by command when it changes", async () => {
  const record = { id: 's1', title: 'T', environmentId: 'local', cwd: '/w', model: { provider: 'anthropic', id: 'claude-opus-5-5' } };
  const store = { settings: { providers: [], defaults: { subagents: 'limited' } }, sessions: [record], saveSessions() {}, getKey: () => null };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  assert.deepEqual(manager.bootConfig(record), { subagents: 'limited', speed: 'standard', ultra: false });
  const sent = [];
  manager.runtimes.set('s1', { status: 'connected', configKey: JSON.stringify(manager.bootConfig(record)), session: { prompt: async line => { sent.push(line); } } });
  await manager.setSpeed('s1', 'fast');
  assert.equal(record.speed, 'fast');
  assert.deepEqual(sent.map(decode), [{ subagents: 'limited', speed: 'fast', ultra: false }]);
  await manager.setSpeed('s1', 'fast');
  assert.equal(sent.length, 1, 'not sent again while unchanged');
  assert.deepEqual(manager.bootConfig(record), { subagents: 'limited', speed: 'fast', ultra: false }, 'a restarted Pi boots at it');
  await manager.setSpeed('s1', 'standard');
  assert.ok(!Object.hasOwn(record, 'speed'), 'a record keeps a speed only when it is not standard');
  assert.deepEqual(decode(sent[1]), { subagents: 'limited', speed: 'standard', ultra: false });
  await assert.rejects(manager.setSpeed('s1', 'warp'), /Unknown speed/);
  store.settings.defaults.subagents = 'off';
  manager.configChanged(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(decode(sent[2]), { subagents: 'off', speed: 'standard', ultra: false }, 'Settings changes keep each conversation its own speed');
});
