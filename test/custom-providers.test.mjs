// Custom endpoint base URLs work with or without /v1 (and as a pasted endpoint URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { listCustomModels, providerBaseUrl, resolveProviderBaseUrl } from '../app/main/custom-providers.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';

// A local endpoint serving only `routes`: API calls answer 400 (as to an empty request), GETs a model
// list, and every other path 404s.
async function endpoint(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (!routes.includes(req.url)) return res.writeHead(404).end('{"error":"not found"}');
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"model is required"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const openai = baseUrl => ({ api: 'openai-completions', baseUrl });

test('an Anthropic base URL works with or without /v1: its SDK appends /v1/messages itself', async t => {
  for (const url of ['https://relay.example.com', 'https://relay.example.com/', 'https://relay.example.com/v1', 'https://relay.example.com/v1/', 'https://relay.example.com/v1/messages'])
    assert.equal(providerBaseUrl('anthropic-messages', url), 'https://relay.example.com', url);
  assert.equal(providerBaseUrl('anthropic-messages', 'https://gw.example.com/api/anthropic/v1'), 'https://gw.example.com/api/anthropic');
  const gateway = await endpoint(t, ['/v1/messages', '/v1/models']);
  assert.equal(await resolveProviderBaseUrl({ api: 'anthropic-messages', baseUrl: `${gateway.url}/v1` }, 'key'), gateway.url);
  assert.equal(gateway.requests.length, 0, 'no check is needed: the form is fixed');
  for (const baseUrl of [gateway.url, `${gateway.url}/v1`])
    assert.deepEqual((await listCustomModels({ api: 'anthropic-messages', baseUrl }, 'key')).map(m => m.id), ['model-a', 'model-b'], baseUrl);
  assert.ok(gateway.requests.every(r => r.url === '/v1/models'), 'never /v1/v1/models');
});

test('Pi gets the base URL its SDK expects, also for providers saved before', () => {
  const store = { settings: { providers: [
    { id: 'relay', kind: 'custom', name: 'Relay', api: 'anthropic-messages', baseUrl: 'https://relay.example.com/v1', models: [{ id: 'm' }] },
    { id: 'gateway', kind: 'custom', name: 'Gateway', api: 'openai-completions', baseUrl: 'https://gw.example.com/v1/chat/completions', models: [{ id: 'm' }] },
  ] }, getKey: () => 'key' };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  assert.deepEqual(manager.bootProviders().map(p => p.baseUrl), ['https://relay.example.com', 'https://gw.example.com/v1']);
});

test('an OpenAI-compatible server that serves only /v1 gets /v1 added', async t => {
  const server = await endpoint(t, ['/v1/chat/completions', '/v1/models']);
  assert.equal(await resolveProviderBaseUrl(openai(server.url), 'key'), `${server.url}/v1`);
  assert.equal(await resolveProviderBaseUrl(openai(`${server.url}/v1`), 'key'), `${server.url}/v1`);
  assert.equal(await resolveProviderBaseUrl(openai(`${server.url}/v1/chat/completions`), 'key'), `${server.url}/v1`, 'a pasted endpoint URL');
  assert.ok(server.requests.filter(r => r.method === 'POST').every(r => r.authorization === 'Bearer key'));
  assert.deepEqual((await listCustomModels(openai(server.url), 'key')).map(m => m.id), ['model-a', 'model-b']);
});

test('an OpenAI-compatible server that serves only the root gets /v1 removed', async t => {
  const server = await endpoint(t, ['/chat/completions', '/models']);
  assert.equal(await resolveProviderBaseUrl(openai(`${server.url}/v1`), 'key'), server.url);
  assert.equal(await resolveProviderBaseUrl(openai(server.url), 'key'), server.url);
  assert.deepEqual((await listCustomModels(openai(`${server.url}/v1`), 'key')).map(m => m.id), ['model-a', 'model-b']);
});

test('a server that serves both, or a version other than /v1, keeps the URL as entered', async t => {
  const both = await endpoint(t, ['/chat/completions', '/v1/chat/completions']);
  assert.equal(await resolveProviderBaseUrl(openai(both.url), 'key'), both.url);
  assert.equal(await resolveProviderBaseUrl(openai(`${both.url}/v1`), 'key'), `${both.url}/v1`);
  const v3 = await endpoint(t, ['/api/v3/chat/completions']);
  assert.equal(await resolveProviderBaseUrl(openai(`${v3.url}/api/v3`), 'key'), `${v3.url}/api/v3`);
});

test('the Responses API is checked at /responses', async t => {
  const server = await endpoint(t, ['/v1/responses']);
  assert.equal(await resolveProviderBaseUrl({ api: 'openai-responses', baseUrl: server.url }, 'key'), `${server.url}/v1`);
  assert.equal(await resolveProviderBaseUrl({ api: 'openai-responses', baseUrl: `${server.url}/v1/responses` }, 'key'), `${server.url}/v1`);
});

test('a server this Mac cannot reach keeps the URL as entered', async () => {
  const port = await new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const url = `http://127.0.0.1:${port}`; // closed: the connection is refused
  assert.equal(await resolveProviderBaseUrl(openai(url), 'key', { timeout: 2000 }), url);
});

test('when neither form serves the API, the URL is kept as entered', async t => {
  const none = await endpoint(t, []);
  assert.equal(await resolveProviderBaseUrl(openai(none.url), 'key'), none.url);
});
