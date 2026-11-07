// Custom endpoint base URLs work with or without their version (and as a pasted endpoint URL).
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
    { id: 'gemini', kind: 'custom', name: 'Gemini relay', api: 'google-generative-ai', baseUrl: 'https://gemini.example.com/v1beta/', models: [{ id: 'm' }] },
    { id: 'bare', kind: 'custom', name: 'Gemini without a version', api: 'google-generative-ai', baseUrl: 'https://bare.example.com/gemini', models: [{ id: 'm' }] },
  ] }, getKey: () => 'key' };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  assert.deepEqual(manager.bootProviders().map(p => p.baseUrl), ['https://relay.example.com', 'https://gw.example.com/v1', 'https://gemini.example.com/v1beta', 'https://bare.example.com/gemini']);
  assert.equal(manager.bootProviders()[2].api, 'google-generative-ai');
});

// A local endpoint speaking Google's protocol: GET <prefix>/models in two pages (the second with a
// model that only embeds), the key in x-goog-api-key; every other path 404s.
async function gemini(t, prefix) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    requests.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'], authorization: req.headers.authorization });
    if (req.method !== 'GET' || url.pathname !== `${prefix}/models`) return res.writeHead(404).end('{"error":{"code":404,"status":"NOT_FOUND"}}');
    if (req.headers['x-goog-api-key'] !== 'AIza-key') return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
    const second = url.searchParams.get('pageToken') === 'next page';
    const models = second
      ? [{ name: 'models/gemini-a', displayName: 'Gemini A', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
        { name: 'models/text-embedding', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }]
      : [{ name: 'models/gemini-b', inputTokenLimit: 32768, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'], thinking: false }];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models, ...(second ? {} : { nextPageToken: 'next page' }) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const google = baseUrl => ({ api: 'google-generative-ai', baseUrl });

test('a Google URL loses a pasted request path and its query, which can hold the key', () => {
  for (const url of ['https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com/v1beta/', 'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyExample', ' https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse '])
    assert.equal(providerBaseUrl('google-generative-ai', url), 'https://generativelanguage.googleapis.com/v1beta', url);
  assert.equal(providerBaseUrl('google-generative-ai', 'https://gw.example.com/v1alpha/models/x:countTokens'), 'https://gw.example.com/v1alpha');
  assert.equal(providerBaseUrl('google-generative-ai', 'https://gw.example.com/models-api/v1'), 'https://gw.example.com/models-api/v1');
});

test('a Google URL without a version gets /v1beta, unless only the URL as entered serves the API', async t => {
  const standard = await gemini(t, '/v1beta');
  assert.equal(await resolveProviderBaseUrl(google(standard.url), 'AIza-key'), `${standard.url}/v1beta`);
  assert.equal(await resolveProviderBaseUrl(google(`${standard.url}/v1beta/models/gemini-a:streamGenerateContent?alt=sse`), 'AIza-key'), `${standard.url}/v1beta`, 'a pasted request URL');
  const v1 = await gemini(t, '/v1');
  assert.equal(await resolveProviderBaseUrl(google(`${v1.url}/v1`), 'AIza-key'), `${v1.url}/v1`);
  assert.equal(v1.requests.length, 0, 'a URL that names its version needs no check');
  const bare = await gemini(t, '');
  assert.equal(await resolveProviderBaseUrl(google(bare.url), 'AIza-key'), bare.url, 'a gateway without a version');
  assert.ok([...standard.requests, ...bare.requests].every(r => r.method === 'GET' && r.key === 'AIza-key' && !r.authorization), 'only model lists, with the key in its header');
  const port = await new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  assert.equal(await resolveProviderBaseUrl(google(`http://127.0.0.1:${port}`), 'AIza-key', { timeout: 2000 }), `http://127.0.0.1:${port}/v1beta`, 'unreachable from this Mac: Google\'s default version');
});

test('Gemini models are listed from every page, only the ones that generate, with their limits', async t => {
  const standard = await gemini(t, '/v1beta');
  const expected = [
    { id: 'gemini-a', name: 'Gemini A', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
    { id: 'gemini-b', name: undefined, contextWindow: 32768, maxTokens: 8192, reasoning: false },
  ];
  for (const baseUrl of [standard.url, `${standard.url}/v1beta`]) assert.deepEqual(await listCustomModels(google(baseUrl), 'AIza-key'), expected, baseUrl);
  assert.ok(standard.requests.some(r => r.url.includes('pageToken=next%20page')), 'the next page is asked for');
  assert.ok(standard.requests.every(r => r.key === 'AIza-key' && !r.authorization && !r.url.includes('AIza')), 'the key never goes in the URL');
  const bare = await gemini(t, '');
  assert.deepEqual((await listCustomModels(google(bare.url), 'AIza-key')).map(m => m.id), ['gemini-a', 'gemini-b'], 'a gateway without a version');
  await assert.rejects(listCustomModels(google((await gemini(t, '/elsewhere')).url), 'AIza-key'), /Couldn't list models: 404/);
  // Measured on generativelanguage.googleapis.com: a wrong key gets 400 at /v1beta/models and 404 at /models.
  await assert.rejects(listCustomModels(google(standard.url), 'AIza-wrong'), /Couldn't list models: 400 Bad Request from \S+\/v1beta\/models: API key not valid/, 'the refused key, not the missing route');
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
