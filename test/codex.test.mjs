// CI only: native Codex protocol, encrypted refresh and route isolation, never real account requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { chatGPTProvider } from '../agent/pidesk-chatgpt.mjs';
import { ChatGPTLogin } from '../app/main/chatgpt.mjs';
import { ChatGPTAuthHost } from '../agent/pidesk-chatgpt-auth.mjs';
import { ChatGPTCredentials, chatGPTCapability, chatGPTVaultPath, sealChatGPT } from '../agent/pidesk-chatgpt-vault.mjs';
import { createSpeed } from '../agent/pidesk-speed.mjs';
import { egressEnv } from '../core/transports.mjs';
import { pathToFileURL } from 'node:url';

test('Codex bypasses the Mac egress forward without changing API-key gateway routing', async () => {
  const { resolveHttpProxyUrlForTarget } = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-ai/dist/utils/node-http-proxy.js')));
  const env = egressEnv(32123);
  assert.equal(resolveHttpProxyUrlForTarget('https://chatgpt.com/backend-api/codex/responses', env), undefined);
  assert.equal(resolveHttpProxyUrlForTarget('https://auth.openai.com/oauth/token', env), undefined);
  assert.equal(resolveHttpProxyUrlForTarget('https://api.openai.com/v1/responses', env).port, '32123');
});

const jwt = n => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' }, generation: n })).toString('base64')}.fixture`;
const credential = n => ({ type: 'oauth', access: jwt(n), refresh: `fixture-refresh-${n}`, expires: 0, accountId: 'fixture-account' });

for (const tier of ['standard', 'fast', 'ultrafast']) test(`Codex ${tier}: real wire headers, tier, tool replay and unchanged signatures`, async t => {
  const requests = [], expectedTier = tier === 'fast' ? 'priority' : tier === 'standard' ? 'default' : tier;
  const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'bash', arguments: '{"command":"pwd"}', status: 'completed' };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), body = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: `resp_${requests.length}`, status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } });
    send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output: [item], service_tier: expectedTier,
      usage: { input_tokens: 100, output_tokens: 20 } } });
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const native = openaiCodexProvider(), base = native.getModels().find(m => m.id === 'gpt-6-astra');
  const provider = chatGPTProvider({ authProvider: 'openai-codex', vaultId: randomUUID(), socketPath: '/tmp/no-owner.sock', capability: 'a'.repeat(64) }, {
    provider: { ...native, getModels: () => [{ ...base, baseUrl: `http://127.0.0.1:${server.address().port}/backend-api` }] },
    request: async (_path, request) => { assert.equal(request.authProvider, 'openai-codex'); return { access: jwt(0) }; },
  });
  const models = createModels(); models.setProvider(provider);
  const model = models.getModel('pidesk-chatgpt', base.id), speed = createSpeed({ speed: tier });
  const messages = [{ role: 'user', content: 'Inspect the working directory', timestamp: Date.now() }];
  let attempt;
  const run = async () => {
    const stream = models.streamSimple(model, { messages }, {
      reasoning: 'high', sessionId: `fixture-${tier}`,
      onPayload: (body, current) => { assert.equal(current.provider, model.provider); attempt = speed.request(model, body); return attempt?.payload; },
      onProviderStreamEvent: (event, current) => { assert.equal(current.provider, model.provider); attempt?.event(event); },
    });
    for await (const event of stream) if (event.partial) assert.equal(event.partial.provider, model.provider);
    const result = await stream.result();
    assert.equal(result.stopReason, 'toolUse', result.errorMessage);
    assert.equal(result.provider, model.provider); assert.equal(result.api, 'openai-codex-responses');
    if (attempt) assert.equal(attempt.finish(result).__speed.used, tier);
    return result;
  };
  const first = await run();
  assert.equal(first.content[0].id, 'call_fixture|fc_fixture');
  const signature = JSON.stringify({ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-fixture-signature', summary: [] });
  first.content.unshift({ type: 'thinking', thinking: '', thinkingSignature: signature });
  messages.push(first, { role: 'toolResult', toolCallId: 'call_fixture|fc_fixture', toolName: 'bash', content: [{ type: 'text', text: '/fixture' }], isError: false, timestamp: Date.now() });
  const original = JSON.stringify(messages);
  await run(); assert.equal(JSON.stringify(messages), original, 'normalization must not mutate model history');
  for (const { url, headers, body } of requests) {
    assert.equal(url, '/backend-api/codex/responses'); assert.equal(headers['chatgpt-account-id'], 'fixture-account');
    assert.equal(headers.authorization, `Bearer ${jwt(0)}`); assert.equal(headers.originator, 'pi');
    assert.equal(body.service_tier, expectedTier); assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, undefined); assert.equal(body.reasoning.effort, 'high');
  }
  const replay = requests[1].body.input;
  assert.equal(replay.find(i => i.type === 'function_call').call_id, 'call_fixture');
  assert.equal(replay.find(i => i.type === 'function_call').id, 'fc_fixture');
  assert.equal(replay.find(i => i.type === 'function_call_output').call_id, 'call_fixture');
  assert.equal(replay.find(i => i.type === 'reasoning').encrypted_content, 'opaque-fixture-signature');
});

test('native Codex browser OAuth validates PKCE and installs only a Codex grant', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-codex-login-')), keys = new Map();
  const store = { settings: {}, saveSettings() {}, getKey: id => keys.get(id), setKey: (id, value) => keys.set(id, value) };
  const host = new ChatGPTAuthHost(), originalFetch = globalThis.fetch;
  let authUrl, exchanges = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://auth.openai.com/oauth/token');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'fixture-authorization-code');
    assert.equal(body.get('client_id'), authUrl.searchParams.get('client_id'));
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
    exchanges++;
    return new Response(JSON.stringify({ access_token: jwt(0), refresh_token: 'fixture-refresh-0', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  };
  const login = new ChatGPTLogin({ store, target: async () => ({ env: { kind: 'local' }, agentDir: root, runDir: root,
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js') }),
    openExternal: async url => { authUrl = new URL(url); }, probe: async () => {}, run: (_target, message) => host.handle(message) });
  t.after(async () => { await login.close(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
  await login.start('local');
  for (let i = 0; i < 200 && !login.status().login?.manual; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(login.status().login?.manual, true);
  assert.equal(authUrl.origin, 'https://auth.openai.com');
  assert.equal(authUrl.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(authUrl.searchParams.get('resource'), null);
  login.submit(`fixture-authorization-code#${authUrl.searchParams.get('state')}`);
  for (let i = 0; i < 200 && login.status().login; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(exchanges, 1); assert.equal(login.status().accounts.local.connected, true);
  assert.equal(login.config('local').authProvider, 'openai-codex');
  await login.logout('local');
});

test('native Codex refresh is serialized and cannot reuse or relabel a subscription-sharing vault', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-codex-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32).toString('hex'), vaultId = randomUUID(), originalFetch = globalThis.fetch;
  let refreshes = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://auth.openai.com/oauth/token', 'no non-fixture network request');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), 'fixture-refresh-0');
    refreshes++;
    return new Response(JSON.stringify({ access_token: jwt(1), refresh_token: 'fixture-refresh-1', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const host = new ChatGPTAuthHost();
  const config = { op: 'configure', vaultId, key, authProvider: 'openai-codex', agentDir: root,
    piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), encoded: sealChatGPT({ 'openai-codex': credential(0) }, key) };
  assert.equal((await host.handle(config)).connected, true);
  const request = { op: 'access', vaultId, capability: chatGPTCapability(key), authProvider: 'openai-codex' };
  const results = await Promise.all(Array.from({ length: 8 }, () => host.handle(request)));
  assert.equal(refreshes, 1); assert.ok(results.every(r => r.access === jwt(1)));
  const stored = new ChatGPTCredentials(chatGPTVaultPath(root, vaultId), key);
  assert.equal((await stored.read('openai-codex')).refresh, 'fixture-refresh-1');
  assert.equal(await stored.read('openai'), undefined);
  await assert.rejects(host.handle({ ...config, authProvider: 'openai' }));
  await assert.rejects(host.handle({ ...request, authProvider: 'openai' }));
  await host.handle({ op: 'logout', vaultId, key });
  await assert.rejects(host.handle(request));
});
