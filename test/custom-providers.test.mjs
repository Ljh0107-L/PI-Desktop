// Custom endpoint base URLs work with or without their version (and as a pasted endpoint URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { listCustomModels, providerBaseUrl, resolveProviderBaseUrl } from '../app/main/custom-providers.mjs';
import { BUILTIN_PROVIDERS, listBuiltinModels } from '../app/main/builtin-providers.mjs';
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

test('a Google URL gains /v1beta only when that path returns a model list', async t => {
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
  assert.equal(await resolveProviderBaseUrl(google(`http://127.0.0.1:${port}`), 'AIza-key', { timeout: 2000 }), `http://127.0.0.1:${port}`, 'unreachable from this Mac: preserve the custom URL');
});

// Some gateways return HTTP 200 with no body for an unknown route, including /v1beta.
// Others implement generation but not /models at all. Neither is evidence for rewriting a URL.
async function googleProbeEndpoint(t, responses) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    const reply = responses[path] ?? { status: 404, body: '{}' };
    res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'application/json' });
    res.end(reply.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Google endpoint probing preserves a custom path when model discovery is inconclusive', async t => {
  for (const reply of [
    { body: '' }, { body: '<html>Sign in</html>', type: 'text/html' }, { body: '{}' },
    { body: '{"models":{}}' }, { status: 401, body: '{"error":{"message":"unauthorized"}}' },
  ]) {
    const base = await googleProbeEndpoint(t, { '/proxy/google/v1beta/models': reply });
    const entered = `${base}/proxy/google`;
    assert.equal(await resolveProviderBaseUrl(google(entered), 'test-key'), entered, JSON.stringify(reply));
  }
});

test('Google probing prefers the entered URL when both paths return valid model lists', async t => {
  const reply = { body: '{"models":[]}' };
  const base = await googleProbeEndpoint(t, { '/models': reply, '/v1beta/models': reply });
  assert.equal(await resolveProviderBaseUrl(google(base), 'test-key'), base);
});

test('Google probing accepts an empty model list, not an empty HTTP response', async t => {
  const base = await googleProbeEndpoint(t, { '/v1beta/models': { body: '{"models":[]}' } });
  assert.equal(await resolveProviderBaseUrl(google(base), 'test-key'), `${base}/v1beta`);
  const empty = await googleProbeEndpoint(t, { '/v1beta/models': { body: '{}' } });
  await assert.rejects(listCustomModels(google(empty), 'test-key'), /Expected a Google model list/);
});

test('the official Google host keeps its default version when discovery is unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal(await resolveProviderBaseUrl(google('https://generativelanguage.googleapis.com'), 'test-key'), 'https://generativelanguage.googleapis.com/v1beta');
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

test('built-in discovery requests each provider endpoint and keeps only live IDs', async t => {
  const urls = {
    anthropic: 'https://api.anthropic.com/v1/models', openai: 'https://api.openai.com/v1/models',
    deepseek: 'https://api.deepseek.com/models', google: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    openrouter: 'https://openrouter.ai/api/v1/models/user', xai: 'https://api.x.ai/v1/language-models',
    groq: 'https://api.groq.com/openai/v1/models', mistral: 'https://api.mistral.ai/v1/models',
    moonshotai: 'https://api.moonshot.ai/v1/models', zai: 'https://api.z.ai/api/coding/paas/v4/models',
    fireworks: 'https://api.fireworks.ai/inference/v1/models', together: 'https://api.together.ai/v1/models',
  };
  assert.deepEqual(Object.keys(BUILTIN_PROVIDERS).sort(), Object.keys(urls).sort());
  const known = { id: 'gpt-6.1-sol', contextWindow: 272000, compat: { supportsStrictMode: true } };
  const catalog = async () => [known, { id: 'bundled-only' }];
  for (const [provider, endpoint] of Object.entries(urls)) {
    const mock = t.mock.method(globalThis, 'fetch', async (url, { headers, redirect }) => {
      assert.equal(url, endpoint);
      assert.equal(redirect, 'error');
      if (provider === 'google') assert.equal(headers['x-goog-api-key'], 'example');
      else if (provider === 'anthropic') assert.deepEqual(headers, { 'x-api-key': 'example', 'anthropic-version': '2023-06-01' });
      else assert.equal(headers.authorization, 'Bearer example');
      return Response.json({ data: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.1-sol' }, { id: 'whisper-1', type: 'audio' }, null] });
    });
    const models = await listBuiltinModels(provider, 'example', catalog);
    assert.deepEqual(models.map(m => m.id), ['gpt-6.1-sol', 'gpt-6.2-sol']);
    assert.equal(models[0], known);
    assert.match(models[1].baseUrl, /^https:\/\//);
    if (provider === 'openai') {
      assert.equal(models[1].api, 'openai-responses');
      assert.equal(models[1].contextWindow, 1050000);
      assert.equal(models[1].maxTokens, 128000);
      assert.equal(models[1].thinkingLevelMap.off, null);
    }
    mock.mock.restore();
  }
});

test('built-in lists follow Anthropic cursors and surface authentication errors without falling back to the bundled list', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async url => new URL(url).searchParams.has('after_id')
    ? Response.json({ data: [{ id: 'claude-second', max_input_tokens: 123456, max_tokens: 7890 }] })
    : Response.json({ data: [{ id: 'claude-first' }], has_more: true, last_id: 'claude-first' }));
  const catalog = async () => [{ id: 'bundled-only' }];
  const models = await listBuiltinModels('anthropic', 'example', catalog);
  assert.deepEqual(models.map(m => m.id), ['claude-first', 'claude-second']);
  assert.equal(models[1].contextWindow, 123456);
  assert.equal(models[1].maxTokens, 7890);
  assert.equal(mock.mock.calls.length, 2);
  mock.mock.mockImplementation(async () => new Response(null, { status: 401, statusText: 'Unauthorized' }));
  await assert.rejects(listBuiltinModels('anthropic', 'example', catalog), /Couldn't list Anthropic models: 401 Unauthorized/);
  mock.mock.mockImplementation(async () => Response.json({ data: [] }));
  assert.deepEqual(await listBuiltinModels('anthropic', 'example', catalog), []);
});

test('a custom OpenAI gateway can fall through an unrelated HTTP 200 to a valid list', async t => {
  const base = await googleProbeEndpoint(t, { '/models': { body: '{}' }, '/v1/models': { body: '{"data":[{"id":"gpt-6.2-sol"}]}' } });
  assert.deepEqual((await listCustomModels(openai(base), 'test-key')).map(m => m.id), ['gpt-6.2-sol']);
});
