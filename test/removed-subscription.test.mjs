// Removing subscription integration must never silently select a paid API-key model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../app/main/session-manager.mjs';
import { isRetiredProvider, RETIRED_PROVIDER_MESSAGE } from '../core/retired-providers.mjs';
import { modelForEnvironment, modelsForEnvironment } from '../app/renderer/src/model-catalog.js';
import { parseTokens, toRow, fromRow, pickedRows } from '../app/renderer/src/model-settings.js';
import { EXTENSION_FILES, OBSOLETE_FILES } from '../app/main/extensions.mjs';
import { speedOptions } from '../agent/pidesk-speed.mjs';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const selected = { provider: 'pidesk-chatgpt', id: 'gpt-6-astra' };

test('old subscription selections stay explicit and cannot reappear in model menus', () => {
  const catalog = [{ provider: 'openai', id: 'gpt-6-astra' }, selected];
  assert.equal(isRetiredProvider(selected.provider), true);
  assert.equal(isRetiredProvider('openai'), false);
  assert.deepEqual(modelsForEnvironment(catalog, 'local'), [catalog[0]]);
  assert.deepEqual(modelForEnvironment(catalog, 'local', selected), selected);
  assert.deepEqual(modelForEnvironment([], 'remote', selected), selected);
  assert.deepEqual(speedOptions({ ...selected, api: 'openai-codex-responses' }), []);
  assert.deepEqual(speedOptions({ provider: 'openai', id: selected.id, api: 'openai-responses' }), ['standard', 'fast', 'ultrafast']);
});

test('retired conversations remain readable but cannot start, prewarm or send a paid fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-retired-'));
  const file = join(root, 'session.jsonl');
  const lines = [
    { type: 'session', version: 3, id: 'old', cwd: root, timestamp: new Date().toISOString() },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'assistant', ...selected, model: selected.id, content: [{ type: 'text', text: 'Saved subscription answer' }], timestamp: 1, stopReason: 'stop' } },
  ];
  const original = lines.map(l => JSON.stringify(l)).join('\n') + '\n'; writeFileSync(file, original);
  const record = { id: 'old', environmentId: 'local', cwd: root, model: selected, piSessionFile: file };
  const store = { settings: { providers: [], chatgpt: { accounts: { local: { connected: true } } } }, sessions: [record],
    saveSessions() {}, getKey() { throw Error('No credential access is needed'); } };
  const manager = new SessionManager({ store, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  t.after(() => { clearInterval(manager.sweeper); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(await manager.catalog(), []); assert.deepEqual(manager.bootProviders(), []);
  assert.equal(await manager.prewarm({ environmentId: 'local', model: selected }), false);
  for (const action of [() => manager.create({ environmentId: 'local', model: selected }), () => manager.ensureStarted('old'),
    () => manager.prompt('old', 'Must not send'), () => manager.setModel('old', selected.provider, selected.id)]) {
    await assert.rejects(action(), error => error.message === RETIRED_PROVIDER_MESSAGE);
  }
  const page = await manager.historyPage('old', { prefetch: true });
  assert.equal(page.messages[0].content[0].text, 'Saved subscription answer');
  assert.equal(readFileSync(file, 'utf8'), original); assert.equal(manager.runtimes.size, 0); assert.equal(store.sessions.length, 1);
  await manager.setModel('old', 'openai', 'gpt-6-astra');
  assert.deepEqual(record.model, { provider: 'openai', id: 'gpt-6-astra' }, 'only an explicit model selection opts into an API provider');
});

test('subscription records and credentials are ignored without being deleted', () => {
  const settings = { providers: [{ id: 'pidesk-chatgpt', kind: 'subscription' }, { id: 'openai', kind: 'builtin' }], chatgpt: { accounts: { local: { connected: true, vaultId: 'old-vault' } } } };
  const snapshot = structuredClone(settings), accessed = [];
  const manager = new SessionManager({ store: { settings, sessions: [], getKey: id => { accessed.push(id); return 'existing-api-key'; } }, environments: () => [], local: {} });
  try {
    assert.deepEqual(manager.bootProviders().map(p => p.id), ['openai']); assert.deepEqual(accessed, ['openai']);
    assert.deepEqual(settings, snapshot);
    assert.ok(!EXTENSION_FILES.some(name => name.includes('chatgpt')));
    assert.ok(OBSOLETE_FILES.includes('pidesk-chatgpt-auth.mjs'));
  } finally { clearInterval(manager.sweeper); }
});

test('Models retains exact token defaults and picker edits after subscription removal', () => {
  const available = openaiProvider().getModels();
  for (const m of available) {
    const saved = fromRow(toRow(m)); assert.equal(saved.contextWindow, m.contextWindow); assert.equal(saved.maxTokens, m.maxTokens);
  }
  const edited = { ...toRow(available[0]), contextWindow: '512000' };
  assert.equal(pickedRows([edited], available, new Set([edited.id]))[0], edited);
  assert.equal(parseTokens('128K'), 131072); assert.equal(parseTokens('272000'), 272000);
  const customDefaults = fromRow(toRow({ id: 'custom-model' }));
  assert.equal(customDefaults.contextWindow, 800000);
  assert.equal(customDefaults.maxTokens, 32768);
});
