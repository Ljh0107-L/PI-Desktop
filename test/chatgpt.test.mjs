// CI-only OAuth/storage/provider regressions. All tokens and network endpoints are fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatGPTCredentials, CHATGPT_PROVIDER, chatGPTCapability, chatGPTVaultPath, openChatGPT, sealChatGPT } from '../agent/pidesk-chatgpt-vault.mjs';
import { ChatGPTAuthHost, chatGPTRequest, serveChatGPT } from '../agent/pidesk-chatgpt-auth.mjs';
import { chatGPTModels, chatGPTProvider } from '../agent/pidesk-chatgpt.mjs';
import { ChatGPTLogin } from '../app/main/chatgpt.mjs';
import { modelsForEnvironment, modelForEnvironment } from '../app/renderer/src/model-catalog.js';
import { usageOf } from '../app/renderer/src/transcript.js';

const credential = overrides => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000,
  clientId: 'fixture-client', scopes: ['chatgpt.tokens.use.direct'], ...overrides });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-oauth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const waitFor = async fn => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture timed out');
};

test('OAuth vaults are private, authenticated ciphertext and never overwrite provider/history files', async t => {
  const root = temporary(t), key = randomBytes(32).toString('hex'), path = chatGPTVaultPath(root, randomUUID());
  const vault = new ChatGPTCredentials(path, key), value = credential();
  const history = join(root, 'session.jsonl'); writeFileSync(history, 'original history\n');
  await vault.modify('openai', async () => value);
  const encoded = readFileSync(path, 'utf8');
  assert.ok(!encoded.includes(value.access)); assert.ok(!encoded.includes(value.refresh));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await vault.read('openai'), value);
  assert.deepEqual(await vault.list(), [{ providerId: 'openai', type: 'oauth' }]);
  assert.throws(() => openChatGPT(encoded, randomBytes(32).toString('hex')));
  const broken = JSON.parse(encoded), bytes = Buffer.from(broken.data, 'base64'); bytes[30] ^= 1;
  writeFileSync(path, JSON.stringify({ ...broken, data: bytes.toString('base64') }));
  await assert.rejects(vault.read('openai'));
  await assert.rejects(vault.modify('openai', async () => credential({ refresh: 'do-not-overwrite' })));
  assert.notEqual(readFileSync(path, 'utf8'), encoded);
  assert.equal(readFileSync(history, 'utf8'), 'original history\n');
});

test('vault mutations serialize refresh/login/logout and cancelled writes preserve the old grant', async t => {
  const root = temporary(t), key = randomBytes(32).toString('hex');
  const vault = new ChatGPTCredentials(chatGPTVaultPath(root, randomUUID()), key);
  await vault.modify('openai', async () => credential({ generation: 0 }));
  await Promise.all(Array.from({ length: 12 }, () => vault.modify('openai', async current => {
    await new Promise(r => setTimeout(r, 2)); return { ...current, generation: current.generation + 1 };
  })));
  assert.equal((await vault.read('openai')).generation, 12);
  const controller = new AbortController();
  await assert.rejects(vault.modify('openai', async () => { controller.abort(); return credential({ refresh: 'not-saved' }); }, { signal: controller.signal }));
  assert.equal((await vault.read('openai')).refresh, 'fixture-refresh');
  await vault.delete('openai'); assert.equal(await vault.read('openai'), undefined);
  assert.deepEqual(await vault.list(), []);
});

test('host capabilities cannot read refresh tokens, install grants, or log out another environment', async t => {
  const root = temporary(t), key = randomBytes(32).toString('hex'), vaultId = randomUUID();
  const host = new ChatGPTAuthHost();
  const configure = { op: 'configure', vaultId, key, agentDir: root, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), encoded: sealChatGPT({ openai: credential() }, key) };
  const ready = await host.handle(configure);
  assert.deepEqual(ready, { ok: true, connected: true });
  const access = await host.handle({ op: 'access', vaultId, capability: chatGPTCapability(key) });
  assert.deepEqual(access, { ok: true, access: 'fixture-access' }); assert.equal(access.refresh, undefined);
  await assert.rejects(host.handle({ op: 'access', vaultId, capability: 'wrong' }));
  await assert.rejects(host.handle({ op: 'logout', vaultId, key: chatGPTCapability(key) }));
  await assert.rejects(host.handle({ ...configure, key: randomBytes(32).toString('hex') }));
  await host.handle({ op: 'logout', vaultId, key });
  await assert.rejects(host.handle({ op: 'access', vaultId, capability: chatGPTCapability(key) }));
});

test('private socket failures and cancellation are bounded and never return raw provider errors', async t => {
  const root = temporary(t), host = { handle: async () => { throw new Error('private fixture-refresh'); } };
  const server = await serveChatGPT(root, host); t.after(() => new Promise(r => server.close(r)));
  const socket = join(root, 'chatgpt.sock');
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  await assert.rejects(chatGPTRequest(socket, { op: 'access' }), error => !error.message.includes('fixture-refresh'));
  await assert.rejects(chatGPTRequest(join(root, 'missing.sock'), {}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chatGPTRequest(socket, {}, { signal: controller.signal }));
});

test('an independent host owner refreshes after desktop disconnect and restores rotated ciphertext', async t => {
  const root = temporary(t), key = randomBytes(32).toString('hex'), vaultId = randomUUID();
  let refreshes = 0, previous = 'fixture-refresh';
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', data => { body += data; });
    request.on('end', () => {
      if (request.url !== '/refresh' || JSON.parse(body).refresh !== previous) { response.writeHead(400).end(); return; }
      refreshes++; previous = `fixture-refresh-${refreshes}`;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ access: `fixture-access-${refreshes}`, refresh: previous, expires: Date.now() + 3600000 }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const worker = spawn(process.execPath, [resolve('test/chatgpt-host-fixture.mjs'), root, `http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (worker.exitCode !== null || worker.signalCode) return; const closed = new Promise(r => worker.once('close', r)); worker.kill(); await closed; });
  await new Promise((resolve, reject) => { worker.stdout.once('data', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`fixture exited ${code}`)); }); });
  const socket = join(root, 'chatgpt.sock');
  await chatGPTRequest(socket, { op: 'configure', vaultId, key, encoded: sealChatGPT({ openai: credential({ expires: 0 }) }, key),
    agentDir: root, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js') });
  // The configuring connection is gone. New Pi clients contact the remote owner directly.
  const results = await Promise.all(Array.from({ length: 8 }, () => chatGPTRequest(socket, { op: 'access', vaultId, capability: chatGPTCapability(key) })));
  assert.equal(refreshes, 1); assert.ok(results.every(r => r.access === 'fixture-access-1'));
  const path = chatGPTVaultPath(root, vaultId), encoded = readFileSync(path, 'utf8');
  assert.ok(!encoded.includes(previous)); assert.equal(openChatGPT(encoded, key).openai.refresh, previous);
  // Reopening after a process restart must read the rotated token, not the desktop's old copy.
  const restored = new ChatGPTCredentials(path, key);
  assert.equal((await restored.read('openai')).refresh, 'fixture-refresh-1');
  await chatGPTRequest(socket, { op: 'logout', vaultId, key });
  await assert.rejects(chatGPTRequest(socket, { op: 'access', vaultId, capability: chatGPTCapability(key) }));
});

function loginFixture(t) {
  const root = temporary(t), keys = new Map(), opened = [], hosts = new Map();
  const store = { settings: { providers: [{ id: 'openai', kind: 'builtin' }] },
    getKey: id => keys.get(id), setKey: (id, key) => keys.set(id, key), saveSettings() {} };
  keys.set('openai', 'untouched-api-key');
  const target = async id => ({ env: { id, kind: id === 'local' ? 'local' : 'ssh' }, agentDir: join(root, id), runDir: join(root, id), piCli: resolve('unused-cli') });
  let options;
  const provider = { getModels: () => [{ id: 'fixture-model', name: 'Fixture', api: 'openai-responses', contextWindow: 128000, maxTokens: 16000, reasoning: true }], auth: { oauth: {
    async login(interaction, supplied) {
      options = supplied;
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/fixture' });
      const value = await interaction.prompt({ type: 'manual_code', signal: interaction.signal });
      if (value !== 'approved') throw new Error('private fixture-refresh-token');
      return credential({ clientId: supplied.getDeviceId() });
    },
  } } };
  const login = new ChatGPTLogin({ store, target, provider, openExternal: async url => { opened.push(url); }, probe: async () => {},
    run: async (target, message) => {
      if (!hosts.has(target.env.id)) hosts.set(target.env.id, new ChatGPTAuthHost({ loadModels: async () => ({}) }));
      return hosts.get(target.env.id).handle(message);
    },
  });
  t.after(() => login.close());
  return { login, store, keys, opened, options: () => options };
}

test('browser login is per environment, cancellable, encrypted and separate from API keys', async t => {
  const { login, store, keys, opened, options } = loginFixture(t);
  await login.start('local'); await waitFor(() => login.status().login?.manual);
  assert.equal(opened[0], 'https://auth.openai.com/fixture'); assert.equal(options().agentName, 'Pi Desktop');
  await assert.rejects(login.start('ssh:fixture'), /other ChatGPT/);
  await login.cancel(); assert.equal(login.status().login, null); assert.equal(login.catalog().length, 0);
  for (const environment of ['local', 'ssh:fixture']) {
    await login.start(environment); await waitFor(() => login.status().login?.manual);
    login.submit('approved'); await waitFor(() => !login.status().login);
    assert.equal(login.status().accounts[environment].connected, true);
    await login.ensure(environment);
  }
  const [local, remote] = ['local', 'ssh:fixture'].map(id => store.settings.chatgpt.accounts[id]);
  assert.notEqual(local.deviceId, remote.deviceId); assert.notEqual(local.vaultId, remote.vaultId);
  assert.equal(keys.get('openai'), 'untouched-api-key'); assert.deepEqual(store.settings.providers, [{ id: 'openai', kind: 'builtin' }]);
  assert.doesNotMatch(JSON.stringify(login.status()), /access|refresh|capability|vaultId/);
  assert.equal(login.catalog()[0].provider, CHATGPT_PROVIDER);
  assert.deepEqual(login.catalog()[0].environments, ['local', 'ssh:fixture']);
  await login.logout('local'); assert.equal(login.config('local'), null);
  assert.deepEqual(login.catalog()[0].environments, ['ssh:fixture']);
  assert.equal(login.config('ssh:fixture').capability.length, 64);
});

test('provider response details never reach the login status or overwrite a good grant', async t => {
  const { login } = loginFixture(t);
  await login.start('local'); await waitFor(() => login.status().login?.manual);
  login.submit('wrong'); await waitFor(() => login.status().login?.state === 'failed');
  assert.doesNotMatch(JSON.stringify(login.status()), /fixture-refresh/);
  assert.equal(login.config('local'), null); assert.equal(login.catalog().length, 0);
});

test('subscription models preserve context/effort and use native streaming, not a second chat engine', async () => {
  let resolved;
  const base = { getModels: () => [{ provider: 'openai', id: 'fixture', api: 'openai-responses', contextWindow: 128000, maxTokens: 32000,
    reasoning: true, thinkingLevelMap: { high: 'high' }, input: ['text', 'image'], cost: { input: 20 } }], streamSimple: () => 'native-stream', stream: () => 'native-stream' };
  const config = { vaultId: randomUUID(), capability: 'a'.repeat(64), socketPath: '/tmp/fixture.sock' };
  const provider = chatGPTProvider(config, { provider: base, request: async (_path, message) => { resolved = message; return { ok: true, access: 'fixture-access' }; } });
  assert.equal(provider.streamSimple, base.streamSimple); assert.equal(provider.stream, base.stream);
  const model = provider.getModels()[0]; assert.equal(model.contextWindow, 128000); assert.equal(model.maxTokens, 32000);
  assert.deepEqual(model.thinkingLevelMap, { high: 'high' }); assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.cost.input, 0, 'API list prices are not a subscription bill');
  assert.equal((await provider.auth.apiKey.resolve({})).auth.apiKey, 'fixture-access');
  assert.equal(resolved.op, 'access'); assert.equal(resolved.key, undefined);
  assert.doesNotMatch(JSON.stringify(provider.getModels()), /capability|fixture-access/);
  const usage = usageOf([{ role: 'assistant', usage: { output: 500, reasoning: 400, input: 1200, cacheRead: 800 },
    __timing: { source: 'agent', complete: true, requestStart: 0, start: 4000, end: 5000 } }]);
  assert.equal(usage.tps, 100); assert.equal(usage.output, 500); assert.equal(usage.prompt, 2000);
  const catalog = [{ provider: 'api', id: 'regular' }, { ...chatGPTModels(base)[0], environments: ['ssh:fixture'] }];
  assert.equal(modelsForEnvironment(catalog, 'local').length, 1);
  assert.equal(modelsForEnvironment(catalog, 'ssh:fixture').length, 2);
  assert.deepEqual(modelForEnvironment(catalog, 'local', { provider: CHATGPT_PROVIDER, id: 'fixture' }), { provider: 'api', id: 'regular' });
});
