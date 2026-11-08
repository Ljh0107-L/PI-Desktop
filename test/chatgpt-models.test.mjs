// CI-only model configuration regressions: official metadata, selection, and real runtime sync.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { chatGPTModels, chatGPTModelOverrides, chatGPTProvider } from '../agent/pidesk-chatgpt.mjs';
import { CHATGPT_PROVIDER } from '../agent/pidesk-chatgpt-vault.mjs';
import { ChatGPTLogin } from '../app/main/chatgpt.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { parseTokens, tokenField, toRow, fromRow, pickedRows } from '../app/renderer/src/model-settings.js';
import { speedOptions, withSpeed, createSpeed } from '../agent/pidesk-speed.mjs';
import { speedTier } from '../app/renderer/src/transcript.js';

const provider = openaiProvider(), official = provider.getModels();
const astra = official.find(m => m.id === 'gpt-6-astra'), sol = official.find(m => m.id === 'gpt-6.1-sol');
const config = models => ({ vaultId: randomUUID(), capability: 'a'.repeat(64), socketPath: '/tmp/fixture.sock', models });

test('all official token limits survive editor round trips without binary-unit rounding', () => {
  for (const model of official) {
    const saved = fromRow(toRow(model));
    assert.equal(saved.contextWindow, model.contextWindow, model.id);
    assert.equal(saved.maxTokens, model.maxTokens, model.id);
    assert.deepEqual(chatGPTModelOverrides(official, [saved]), [{ id: model.id }]);
  }
  assert.equal(tokenField(272000), '272000'); assert.equal(tokenField(128000), '128000');
  assert.equal(tokenField(131072), '131072'); assert.equal(parseTokens('128K'), 131072);
  for (const invalid of ['', '0', '-1', 'NaN', 'Infinity', '3.14', '1.2.3K']) assert.equal(parseTokens(invalid), undefined);
});

test('selected models inherit official defaults and retain only explicit safe overrides', () => {
  const selection = chatGPTModelOverrides(official, [{ ...astra, contextWindow: 512000, maxTokens: 64000, name: 'My Astra',
    baseUrl: 'https://untrusted.invalid', headers: { Authorization: 'do-not-send' }, api: 'other' }, { id: sol.id }]);
  assert.deepEqual(selection, [{ id: astra.id, name: 'My Astra', contextWindow: 512000, maxTokens: 64000 }, { id: sol.id }]);
  const models = chatGPTProvider(config(selection)).getModels();
  assert.deepEqual(models.map(m => m.id), [astra.id, sol.id]);
  assert.equal(models[0].contextWindow, 512000); assert.equal(models[0].maxTokens, 64000);
  assert.equal(models[0].baseUrl, astra.baseUrl); assert.equal(models[0].api, astra.api);
  assert.equal(models[1].contextWindow, sol.contextWindow); assert.deepEqual(models[1].thinkingLevelMap, sol.thinkingLevelMap);
  assert.deepEqual(models[1].input, sol.input); assert.equal(models[1].pideskChatGPTSettings, 2);
  assert.equal(models[1].compat.supportsMidConvoEffort, false, 'the subscription protocol, not API-key-only configuration updates');
  assert.equal(chatGPTModels(provider, []).length, 0, 'selecting none does not accidentally enable every model');
  for (const selection of [[{ id: 'unknown' }], [{ id: astra.id }, { id: astra.id }], [{ id: astra.id, maxTokens: -1 }],
    [{ id: astra.id, contextWindow: '1M' }], [{ id: astra.id, maxTokens: 99999999 }]]) assert.throws(() => chatGPTModelOverrides(official, selection));
});

test('picker selections preserve edits; deselected and re-added models use official defaults', () => {
  const edited = { ...toRow(astra), contextWindow: '512000' };
  const selected = pickedRows([edited], [astra, sol], new Set([astra.id, sol.id]));
  assert.equal(selected[0], edited); assert.equal(selected[1].maxTokens, String(sol.maxTokens));
  assert.equal(pickedRows(selected, [astra, sol], new Set([sol.id])).length, 1);
  assert.equal(pickedRows([], [astra, sol], new Set([astra.id]))[0].contextWindow, String(astra.contextWindow));
});

test('global ChatGPT model preferences persist across environments without touching credentials', () => {
  let changed = 0, writes = 0;
  const account = () => ({ connected: true, authProvider: 'openai-codex', vaultId: randomUUID(), runDir: '/tmp/fixture' });
  const store = { settings: { providers: [{ id: 'openai', kind: 'builtin' }], chatgpt: { accounts: { local: account(), remote: account() } } },
    saveSettings: () => writes++, getKey: () => 'a'.repeat(64) };
  const login = new ChatGPTLogin({ store, provider, configured: () => changed++, target: () => { throw Error('No host calls for model settings'); } });
  const accounts = structuredClone(store.settings.chatgpt.accounts);
  login.saveModels([{ id: astra.id, contextWindow: 512000 }, { id: sol.id }]);
  assert.equal(changed, 1); assert.equal(writes, 1);
  assert.deepEqual(login.catalog().map(m => m.id), [astra.id, sol.id]);
  assert.deepEqual(login.catalog()[0].environments, ['local', 'remote']);
  assert.equal(login.modelSettings().available.find(m => m.id === astra.id).contextWindow, astra.contextWindow);
  assert.equal(login.config('remote').models[0].contextWindow, 512000);
  assert.deepEqual(store.settings.chatgpt.accounts, accounts); assert.equal(store.settings.providers[0].id, 'openai');
  login.saveModels([]); assert.deepEqual(login.catalog(), []);
  login.saveModels(null); assert.equal(login.catalog().length, official.length);
  assert.equal(login.config('local').models, undefined);
});

test('ChatGPT Fast and Ultrafast use the requested wire tier, cooldown and subscription wording', () => {
  for (const id of [astra.id, sol.id, 'gpt-6-luna', 'gpt-5.6-sol']) {
    const model = { provider: CHATGPT_PROVIDER, api: 'openai-responses', id };
    const offered = [astra.id, sol.id].includes(id) ? ['standard', 'fast', 'ultrafast'] : ['standard', 'fast'];
    assert.deepEqual(speedOptions(model), offered);
    assert.equal(withSpeed({ model: id }, model, 'fast').service_tier, 'fast');
    const speed = createSpeed({ speed: 'ultrafast' }), attempt = speed.request(model, { model: id });
    assert.equal(attempt.payload.service_tier, offered.at(-1));
    attempt.event({ response: { service_tier: offered.at(-1) } });
    const done = attempt.finish({ provider: CHATGPT_PROVIDER, stopReason: 'stop', usage: { cost: { total: 0 } } });
    assert.doesNotMatch(speedTier(done).title, /billed at/);
    attempt.finish({ stopReason: 'error', errorMessage: '429 rate limit' });
    assert.notEqual(speed.request(model, { model: id }).payload?.service_tier, offered.at(-1));
  }
});

test('changing selected ChatGPT limits reapplies a running model even when its ID is unchanged', async t => {
  const record = { id: 'model-settings', environmentId: 'local', model: { provider: CHATGPT_PROVIDER, id: astra.id }, thinkingLevel: 'high' };
  const store = { settings: { providers: [] }, sessions: [record], getKey: () => null };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  const calls = [];
  const session = { id: record.id, prompt: async line => calls.push(line),
    setModel: async (provider, id) => calls.push({ provider, id }), request: async type => { calls.push(type); return {}; } };
  const runtime = { session, status: 'connected', providersVersion: 0, chatgptSettingsReady: true,
    applied: { model: record.model, thinkingLevel: 'high' } };
  manager.runtimes.set(record.id, runtime);
  manager.chatgpt = { config: () => ({ ...config([{ id: astra.id, contextWindow: 512000 }]), id: CHATGPT_PROVIDER, kind: 'subscription' }),
    catalog: () => [{ id: astra.id, environments: ['local'] }], ensure: async () => {} };
  manager.providersChanged();
  for (let i = 0; i < 20 && !calls.some(c => c?.provider === CHATGPT_PROVIDER); i++) await new Promise(r => setImmediate(r));
  assert.ok(calls.some(c => c?.provider === CHATGPT_PROVIDER && c.id === astra.id));
  const registration = JSON.parse(Buffer.from(calls.find(c => typeof c === 'string' && c.startsWith('/pidesk-providers')).split(' ')[1], 'base64'));
  assert.equal(registration[0].models[0].contextWindow, 512000);
});
