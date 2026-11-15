// Native Google wire protocol, using loopback HTTP only; never calls a model service.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { streamGoogle } from '../agent/pidesk-google.mjs';

const options = { apiKey: 'local-test-key', maxRetries: 0, timeoutMs: 3000 };
const signature = Buffer.from('native Google signature').toString('base64');
const checkpoint = Buffer.from([0, 255, 17, 33]).toString('base64');
const tool = { name: 'lookup', description: 'Look up structured data.', parameters: {
  type: 'object', properties: { key: { type: 'string' } }, additionalProperties: true,
} };
const context = () => ({ messages: [
  { role: 'system', content: 'Use lookup when needed.', toolsAdded: [tool], timestamp: 1 },
  { role: 'user', content: 'Look it up.', timestamp: 2 },
] });
const usage = (prompt, visible, thought = 0, cached = 0) => ({
  promptTokenCount: prompt, candidatesTokenCount: visible, thoughtsTokenCount: thought,
  cachedContentTokenCount: cached, totalTokenCount: prompt + visible + thought,
});
const chunk = (parts = [], finishReason, { continuationToken, ...extra } = {}) => ({
  candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason && { finishReason }), ...(continuationToken && { continuationToken }) }], ...extra,
});
const call = (functionCall, extra = {}) => ({ functionCall, ...extra });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const send = (res, value) => res.write(frame(value));
const begin = res => res.writeHead(200, { 'content-type': 'text/event-stream', 'x-local-response': 'google' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, handler, overrides = {}) {
  const requests = [], errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const request = { method: req.method, url: new URL(req.url, 'http://local'), headers: req.headers, body: JSON.parse(raw) };
      requests.push(request);
      await handler(request, res, requests.length);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, [], 'the local Google fixture did not fail');
  });
  return { requests, model: {
    id: 'gemini-4-argon', name: 'Gemini 4 Argon', api: 'google-generative-ai', provider: 'local-google',
    baseUrl: `http://127.0.0.1:${server.address().port}/proxy/google`, reasoning: true,
    input: ['text'], contextWindow: 1048576, maxTokens: 64000,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
  } };
}

async function collect(stream, onEvent = () => {}) {
  assert.ok(stream instanceof AssistantMessageEventStream, 'streamGoogle returns a Pi event stream directly');
  const events = [];
  for await (const event of stream) { events.push(event); onEvent(event, events); }
  return { events, result: await stream.result() };
}
const ofType = (events, type) => events.filter(event => event.type === type);
function assertError({ events, result }) {
  assert.equal(result.stopReason, 'error');
  assert.ok(result.errorMessage, 'failed streams explain the failure');
  assert.equal(ofType(events, 'error').length, 1);
  assert.equal(ofType(events, 'done').length, 0);
  assert.equal(ofType(events, 'toolcall_end').length, 0, 'unfinished calls must never become executable');
}

// The scalar string's willContinue is independent of the enclosing call's willContinue.
test('Google partialArgs stream one nested call, ending only at call willContinue:false', { timeout: 8000 }, async t => {
  const ready = deferred();
  let finalFrameSeen = false;
  const { model, requests } = await fixture(t, async (_request, res) => {
    begin(res);
    send(res, chunk([call({ name: 'lookup', id: 'call-1', willContinue: true }, { thoughtSignature: signature })]));
    send(res, chunk([call({ partialArgs: [
      { jsonPath: '$.key', stringValue: 'hel"\\', willContinue: true },
    ], willContinue: true })]));
    // Split inside a UTF-8 code point as well as across SSE records.
    const bytes = Buffer.from(frame(chunk([call({ partialArgs: [
      { jsonPath: '$.key', stringValue: 'lo🐦', willContinue: false },
      { jsonPath: '$.items[0].name', stringValue: 'first' },
      { jsonPath: '$.items[0].values[0]', numberValue: 7 },
      { jsonPath: '$.items[0].values[1]', nullValue: null },
      { jsonPath: '$.items[1].name', stringValue: 'second' },
      { jsonPath: '$.empty[]' }, { jsonPath: '$.meta{}' },
      { jsonPath: '$.recipient', nullValue: null },
      { jsonPath: '$.status', stringValue: 'ready' },
    ], willContinue: true })])));
    const split = bytes.indexOf(Buffer.from('🐦')) + 1;
    res.write(bytes.subarray(0, split));
    res.write(bytes.subarray(split));
    await ready.promise;
    send(res, chunk([call({ willContinue: false })]));
    send(res, chunk([], 'STOP', { usageMetadata: usage(20, 6) }));
    res.end();
  });
  const received = await collect(streamGoogle(model, context(), { ...options,
    onProviderStreamEvent(frame) {
      if (frame.candidates?.[0]?.content?.parts?.some(p => p.functionCall?.willContinue === false)) finalFrameSeen = true;
    },
  }), (event, events) => {
    if (event.type === 'toolcall_end') assert.equal(finalFrameSeen, true, 'only the final call frame permits tool execution');
    if (event.type === 'toolcall_delta' && event.delta.includes('ready')) {
      assert.equal(ofType(events, 'toolcall_end').length, 0, 'complete scalar values do not finish the call');
      ready.resolve();
    }
  });
  const expected = { key: 'hel"\\lo🐦', items: [{ name: 'first', values: [7, null] }, { name: 'second' }],
    empty: [], meta: {}, recipient: null, status: 'ready' };
  assert.equal(received.result.stopReason, 'toolUse');
  assert.equal(ofType(received.events, 'toolcall_start').length, 1);
  const ends = ofType(received.events, 'toolcall_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].toolCall.arguments, expected);
  assert.equal(ends[0].toolCall.id, 'call-1');
  assert.equal(ends[0].toolCall.thoughtSignature, signature);
  assert.deepEqual(JSON.parse(ofType(received.events, 'toolcall_delta').map(e => e.delta).join('')), expected);
  assert.equal(new Set(received.events.filter(e => e.type.startsWith('toolcall_')).map(e => e.contentIndex)).size, 1);
  assert.deepEqual(received.result.content, [ends[0].toolCall]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
});

test('Google rejects EOF and STOP while a streamed call is unfinished', { timeout: 8000 }, async t => {
  for (const ending of ['EOF', 'STOP']) await t.test(ending, async t => {
    const { model, requests } = await fixture(t, (_request, res) => {
      begin(res);
      send(res, chunk([call({ name: 'lookup', id: 'unfinished', partialArgs: [
        { jsonPath: '$.key', stringValue: 'partial', ...(ending === 'EOF' && { willContinue: true }) },
      ], willContinue: true })]));
      if (ending === 'STOP') send(res, chunk([], 'STOP'));
      res.end();
    });
    const received = await collect(streamGoogle(model, context(), options));
    assertError(received);
    assert.equal(ofType(received.events, 'toolcall_start').length, 1);
    assert.equal(requests.length, 1, 'maxRetries:0 does not replay an interrupted request');
  });
});

test('CONTINUATION resumes the same call and adds final wire usage once per hop', { timeout: 8000 }, async t => {
  const observed = [], responses = [];
  const { model, requests } = await fixture(t, (_request, res, hop) => {
    begin(res);
    if (hop === 1) {
      send(res, chunk([call({ name: 'lookup', id: 'continued', partialArgs: [
        { jsonPath: '$.key', stringValue: 'hel', willContinue: true },
      ], willContinue: true }, { thoughtSignature: signature })], undefined, { usageMetadata: usage(10, 1, 1, 1) }));
      send(res, chunk([], 'CONTINUATION', { continuationToken: checkpoint, usageMetadata: usage(10, 2, 3, 1) }));
    } else {
      send(res, chunk([call({ partialArgs: [{ jsonPath: '$.key', stringValue: 'lo' }], willContinue: false })]));
      send(res, chunk([], 'STOP', { usageMetadata: usage(15, 4, 5, 2) }));
    }
    res.end();
  });
  const received = await collect(streamGoogle(model, context(), { ...options,
    onProviderStreamEvent: event => { observed.push(event); }, onResponse: response => { responses.push(response); },
  }));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.continuationToken, undefined);
  assert.equal(requests[1].body.continuationToken, checkpoint);
  assert.deepEqual(requests[1].body.contents, requests[0].body.contents, 'continuation is not a fabricated tool result');
  assert.equal(ofType(received.events, 'start').length, 1);
  assert.equal(ofType(received.events, 'toolcall_start').length, 1);
  assert.equal(ofType(received.events, 'toolcall_end').length, 1);
  assert.equal(ofType(received.events, 'done').length, 1);
  assert.equal(ofType(received.events, 'error').length, 0);
  assert.equal(received.result.stopReason, 'toolUse');
  assert.deepEqual(received.result.content[0].arguments, { key: 'hello' });
  assert.equal(received.result.content[0].id, 'continued');
  assert.equal(received.result.content[0].thoughtSignature, signature);
  const { input, output, cacheRead, totalTokens } = received.result.usage;
  assert.deepEqual({ input, output, cacheRead, totalTokens }, { input: 22, output: 14, cacheRead: 3, totalTokens: 39 });
  assert.equal(observed.length, 4, 'hooks see each raw frame across both hops');
  assert.equal(responses.length, 2);
});

test('CONTINUATION without a token is an error, not an executable call or an endless retry', { timeout: 8000 }, async t => {
  const { model, requests } = await fixture(t, (_request, res) => {
    begin(res);
    send(res, chunk([call({ name: 'lookup', willContinue: true })]));
    send(res, chunk([], 'CONTINUATION'));
    res.end();
  });
  assertError(await collect(streamGoogle(model, context(), options)));
  assert.equal(requests.length, 1);
});

test('ordinary Gemini keeps STOP text and complete args calls without the Argon streaming flag', { timeout: 8000 }, async t => {
  const { model, requests } = await fixture(t, (_request, res, n) => {
    begin(res);
    // Comments and CRLF-delimited records are legal SSE.
    res.write(': keepalive\r\n\r\n');
    const value = n === 1 ? chunk([{ text: 'Hello ' }, { text: 'world' }], 'STOP', { usageMetadata: usage(4, 2) })
      : chunk([call({ name: 'lookup', id: 'ordinary', args: { key: 'x' } }, { thoughtSignature: signature })], 'STOP');
    res.end(frame(value).replaceAll('\n', '\r\n'));
  }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: false, thinkingLevelMap: undefined });
  const text = await collect(streamGoogle(model, context(), options));
  assert.equal(text.result.stopReason, 'stop');
  assert.equal(text.result.content.filter(b => b.type === 'text').map(b => b.text).join(''), 'Hello world');
  assert.equal(ofType(text.events, 'done').length, 1);
  const full = await collect(streamGoogle(model, context(), options));
  assert.equal(full.result.stopReason, 'toolUse');
  assert.equal(ofType(full.events, 'toolcall_end').length, 1);
  assert.deepEqual(full.result.content[0].arguments, { key: 'x' });
  assert.equal(full.result.content[0].thoughtSignature, signature);
  for (const request of requests) assert.equal(request.body.toolConfig?.functionCallingConfig?.streamFunctionCallArguments, undefined);
});

test('cancelling a live Google call yields aborted without finishing or retrying the tool', { timeout: 8000 }, async t => {
  const controller = new AbortController();
  const { model, requests } = await fixture(t, (_request, res) => {
    begin(res);
    send(res, chunk([call({ name: 'lookup', id: 'cancelled', partialArgs: [
      { jsonPath: '$.key', stringValue: 'not finished', willContinue: true },
    ], willContinue: true })]));
    // Deliberately leave the connection open until the client cancels it.
  });
  const received = await collect(streamGoogle(model, context(), { ...options, signal: controller.signal }), event => {
    if (event.type === 'toolcall_delta') controller.abort();
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(received.result.stopReason, 'aborted');
  assert.equal(ofType(received.events, 'error').length, 1);
  assert.equal(ofType(received.events, 'done').length, 0);
  assert.equal(ofType(received.events, 'toolcall_end').length, 0);
  assert.equal(requests.length, 1);
});

test('timeoutMs resets on incoming chunks instead of limiting total stream duration', { timeout: 8000 }, async t => {
  const timeoutMs = 400;
  const { model } = await fixture(t, async (_request, res) => {
    begin(res);
    for (let i = 0; i < 8; i++) {
      send(res, chunk([{ text: String(i) }]));
      await sleep(100);
      if (res.destroyed) return;
    }
    send(res, chunk([], 'STOP'));
    res.end();
  });
  const started = Date.now();
  const received = await collect(streamGoogle(model, context(), { ...options, timeoutMs }));
  assert.ok(Date.now() - started > timeoutMs, 'the successful stream outlives one timeout period');
  assert.equal(received.result.stopReason, 'stop');
  assert.equal(received.result.content.filter(b => b.type === 'text').map(b => b.text).join(''), '01234567');
  assert.equal(ofType(received.events, 'error').length, 0);
});

test('an idle Google body times out without exposing its unfinished call', { timeout: 8000 }, async t => {
  const { model, requests } = await fixture(t, (_request, res) => {
    begin(res);
    send(res, chunk([call({ name: 'lookup', id: 'stalled', willContinue: true })]));
  });
  const received = await collect(streamGoogle(model, context(), { ...options, timeoutMs: 150 }));
  assertError(received);
  assert.match(received.result.errorMessage, /timed?\s*out|timeout|idle/i);
  assert.equal(requests.length, 1);
});

test('models/ IDs retain native streaming, call IDs and separate signature-bearing parts on replay', { timeout: 8000 }, async t => {
  const { model, requests } = await fixture(t, (_request, res, n) => {
    begin(res);
    res.end(frame(chunk(n === 1 ? [{ text: 'before' }, { text: 'signed', thoughtSignature: signature }, { text: 'tail' }, { text: '', thoughtSignature: signature }] : [{ text: 'done' }], 'STOP')));
  }, { id: 'models/gemini-4-argon' });
  const first = await collect(streamGoogle(model, context(), options));
  assert.deepEqual(first.result.content.map(b => [b.text, b.textSignature]), [
    ['before', undefined], ['signed', signature], ['tail', undefined], ['', signature],
  ]);
  const input = context(); input.messages.push(first.result, { role: 'user', content: 'Continue.', timestamp: 10 });
  const second = await collect(streamGoogle(model, input, options));
  assert.equal(second.result.stopReason, 'stop');
  const replay = requests[1].body.contents.find(c => c.role === 'model').parts;
  assert.deepEqual(replay, [{ text: 'before' }, { text: 'signed', thoughtSignature: signature }, { text: 'tail' }, { text: '', thoughtSignature: signature }]);
  for (const request of requests) {
    assert.equal(request.url.pathname, '/proxy/google/models/gemini-4-argon:streamGenerateContent');
    assert.equal(request.body.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  }
});

test('refusals, exhausted budgets, malformed arguments and repeated checkpoints never execute tools', { timeout: 8000 }, async t => {
  for (const kind of ['refusal', 'budget', 'malformed', 'repeated']) await t.test(kind, async t => {
    const { model, requests } = await fixture(t, (_request, res) => {
      begin(res);
      if (kind === 'malformed') {
        send(res, chunk([call({ name: 'lookup', partialArgs: [{ jsonPath: '$.key', numberValue: 1, stringValue: 'x' }] })], 'STOP'));
      } else {
        if (kind !== 'repeated' || requests.length === 1) send(res, chunk([call({ name: 'lookup', args: { key: 'never execute' } })]));
        send(res, chunk([], kind === 'refusal' ? 'SAFETY' : kind === 'budget' ? 'MAX_TOKENS' : 'CONTINUATION', { continuationToken: checkpoint }));
      }
      res.end();
    });
    assertError(await collect(streamGoogle(model, context(), options)));
    assert.equal(requests.length, kind === 'repeated' ? 2 : 1);
  });
});

test('HTTP failures preserve safe classification, retry 429, and bound mismatched error bodies', { timeout: 8000 }, async t => {
  for (const status of [400, 401, 429]) await t.test(String(status), async t => {
    const { model, requests } = await fixture(t, (_request, res, attempt) => {
      if (status === 429 && attempt === 2) { begin(res); res.end(frame(chunk([{ text: 'recovered' }], 'STOP'))); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': '999999', 'retry-after': '0' });
      res.write(JSON.stringify({ error: { code: status === 400 ? 'InvalidParameter' : status, message: status === 400 ? 'maximum context length private-prompt' : 'private-token' } }));
      // Leave it open; the adapter must not wait for the advertised Content-Length.
    });
    const received = await collect(streamGoogle(model, context(), { ...options, maxRetries: 1 }));
    if (status === 429) { assert.equal(received.result.stopReason, 'stop'); assert.equal(requests.length, 2); }
    else { assertError(received); assert.equal(requests.length, 1); assert.ok(!received.result.errorMessage.includes('private-')); }
    if (status === 400) assert.match(received.result.errorMessage, /context_length_exceeded/);
  });
});

test('Google keeps SDK-shaped payload hooks, custom headers and signed transcript replay', { timeout: 8000 }, async t => {
  const order = [], raw = [], payloads = [];
  const { model, requests } = await fixture(t, (_request, res) => {
    begin(res);
    send(res, chunk([{ text: 'Think', thought: true, thoughtSignature: signature }]));
    send(res, chunk([{ text: 'ing', thought: true }]));
    send(res, chunk([{ text: 'Done', thoughtSignature: signature }]));
    send(res, chunk([{ text: '.' }], 'STOP', { usageMetadata: usage(10, 2, 2) }));
    res.end();
  }, { headers: { 'x-model-header': 'model', 'x-shared': 'model' } });
  const input = context();
  input.messages.push(
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      stopReason: 'toolUse', timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'toolCall', id: 'old-call', name: 'lookup', arguments: { key: 'old' }, thoughtSignature: signature }] },
    { role: 'toolResult', toolName: 'lookup', toolCallId: 'old-call', content: [{ type: 'text', text: 'Found.' }], isError: false, timestamp: 4 },
  );
  const before = structuredClone(input);
  const received = await collect(streamGoogle(model, input, { ...options, reasoning: 'high',
    headers: { 'x-option-header': 'option', 'x-shared': 'option' },
    async onPayload(payload, m) {
      assert.equal(m, model);
      assert.equal(payload.model, model.id);
      assert.ok(Array.isArray(payload.contents));
      assert.ok(payload.config, 'hooks retain SDK {model,contents,config}, not REST shape');
      payloads.push(payload);
      await Promise.resolve();
      return { ...payload, config: { ...payload.config, temperature: 0.25, maxOutputTokens: 77 } };
    },
    async onResponse(response, m) {
      assert.equal(m, model);
      assert.equal(response.status, 200);
      assert.equal(response.headers['x-local-response'], 'google');
      await Promise.resolve();
      order.push('response');
    },
    async onProviderStreamEvent(event, m) {
      assert.equal(m, model);
      assert.equal(order[0], 'response', 'response hook completes before the first provider frame');
      raw.push(event);
      await Promise.resolve();
      order.push('frame');
    },
  }));
  assert.equal(received.result.stopReason, 'stop');
  assert.equal(received.result.content.filter(b => b.type === 'thinking').map(b => b.thinking).join(''), 'Thinking');
  assert.equal(received.result.content.find(b => b.type === 'thinking').thinkingSignature, signature);
  assert.equal(received.result.content.filter(b => b.type === 'text').map(b => b.text).join(''), 'Done.');
  assert.equal(received.result.content.find(b => b.type === 'text').textSignature, signature);
  assert.deepEqual(input, before, 'wire conversion does not mutate the stored transcript');
  assert.equal(payloads.length, 1);
  assert.equal(raw.length, 4);
  assert.equal(raw[0].candidates[0].content.parts[0].thoughtSignature, signature);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url.pathname, '/proxy/google/models/gemini-4-argon:streamGenerateContent');
  assert.equal(request.url.searchParams.get('alt'), 'sse');
  assert.equal(request.headers['x-goog-api-key'], options.apiKey);
  assert.equal(request.headers['x-model-header'], 'model');
  assert.equal(request.headers['x-option-header'], 'option');
  assert.equal(request.headers['x-shared'], 'option');
  assert.equal(request.body.generationConfig.temperature, 0.25);
  assert.equal(request.body.generationConfig.maxOutputTokens, 77);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.equal(request.body.config, undefined, 'SDK config is flattened into the REST body');
  assert.equal(request.body.tools[0].functionDeclarations[0].name, 'lookup');
  const replay = request.body.contents.flatMap(c => c.parts);
  const previousCall = replay.find(p => p.functionCall);
  assert.equal(previousCall.functionCall.id, 'old-call');
  assert.deepEqual(previousCall.functionCall.args, { key: 'old' });
  assert.equal(previousCall.thoughtSignature, signature);
  assert.equal(replay.find(p => p.functionResponse).functionResponse.id, 'old-call');
});
