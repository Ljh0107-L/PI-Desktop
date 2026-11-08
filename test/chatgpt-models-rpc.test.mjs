// Bundled Pi integration, in GitHub CI only. Model metadata changes need no inference or OAuth call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageExtensions } from '../app/main/extensions.mjs';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport } from '../core/transports.mjs';

test('bundled Pi applies selected ChatGPT models and exact edited limits without an auth request', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-model-rpc-'));
  let session;
  t.after(async () => { await session?.stop(); rmSync(root, { recursive: true, force: true }); });
  const bridge = stageExtensions(resolve('agent'), join(root, 'ext'));
  const provider = { id: 'pidesk-chatgpt', kind: 'subscription', authProvider: 'openai-codex', vaultId: randomUUID(), capability: 'a'.repeat(64),
    socketPath: join(root, 'no-auth-owner.sock'), models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] };
  session = new PiSession({ id: 'models', boot: { providers: [provider] },
    transport: localTransport({ node: process.execPath, cwd: root, agentDir: join(root, 'agent'),
      piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), extensions: [bridge], piArgs: ['--no-session'] }) });
  await session.start();
  const before = (await session.request('get_available_models')).models.filter(m => m.provider === provider.id);
  assert.deepEqual(new Set(before.map(m => m.id)), new Set(['gpt-6-astra', 'gpt-6.1-sol']));
  const astra = before.find(m => m.id === 'gpt-6-astra');
  assert.equal(astra.contextWindow, 272000); assert.equal(astra.maxTokens, 128000);
  assert.equal(astra.pideskChatGPTSettings, 2);
  assert.equal(astra.api, 'openai-codex-responses');
  assert.equal(astra.baseUrl, 'https://chatgpt.com/backend-api');
  await session.setModel(provider.id, 'gpt-6-astra');
  const next = { ...provider, models: [{ id: 'gpt-6-astra', contextWindow: 512000, maxTokens: 64000 }] };
  await session.prompt(`/pidesk-providers ${Buffer.from(JSON.stringify([next])).toString('base64')}`);
  const after = (await session.request('get_available_models')).models.filter(m => m.provider === provider.id);
  assert.equal(after.length, 1); assert.equal(after[0].maxTokens, 64000);
  await session.setModel(provider.id, 'gpt-6-astra');
  const state = await session.state();
  assert.equal(state.model.contextWindow, 512000); assert.equal(state.model.maxTokens, 64000);
  assert.equal(state.model.provider, provider.id);
});
