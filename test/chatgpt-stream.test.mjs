// CI only: real Responses normalization through the subscription provider, served by loopback SSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { chatGPTProvider } from '../agent/pidesk-chatgpt.mjs';
import { CHATGPT_PROVIDER } from '../agent/pidesk-chatgpt-vault.mjs';
import { registerMetrics } from '../agent/pidesk-bridge.js';
import { usageOf } from '../app/renderer/src/transcript.js';

test('native subscription Responses stream preserves text, tools, usage and pre-header TPS timing', async t => {
  let authorization, payload;
  const items = [
    { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture answer', annotations: [] }] },
    { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'bash', arguments: '{"command":"pwd"}', status: 'completed' },
  ];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    authorization = request.headers.authorization; payload = JSON.parse(body);
    await new Promise(r => setTimeout(r, 80)); // request wait before the SDK emits message_start
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...items[0], content: [] } });
    send({ type: 'response.output_text.delta', output_index: 0, delta: 'Fixture answer' });
    send({ type: 'response.output_item.done', output_index: 0, item: items[0] });
    send({ type: 'response.output_item.added', output_index: 1, item: { ...items[1], arguments: '' } });
    send({ type: 'response.function_call_arguments.delta', output_index: 1, delta: items[1].arguments });
    send({ type: 'response.output_item.done', output_index: 1, item: items[1] });
    send({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items,
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 } } } });
    response.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const base = openaiProvider();
  const underlying = { ...base, getModels: () => [{ ...base.getModels()[0], id: 'fixture', api: 'openai-responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxTokens: 32000 }] };
  const provider = chatGPTProvider({ vaultId: randomUUID(), capability: 'a'.repeat(64), socketPath: '/tmp/unused.sock' },
    { provider: underlying, request: async () => ({ ok: true, access: 'fixture-access' }) });
  const models = createModels(); models.setProvider(provider); const model = models.getModel(CHATGPT_PROVIDER, 'fixture');
  const handlers = new Map(); registerMetrics({ on: (name, handler) => handlers.set(name, handler) });
  const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'Answer and inspect the working directory', timestamp: Date.now() }] }, {
    onPayload: body => handlers.get('before_provider_request')({ payload: body }, { model }),
    onProviderStreamEvent: event => handlers.get('provider_stream_event')({ provider: model.provider, model: model.id, api: model.api, data: event }),
  });
  for await (const event of stream) {
    if (event.type === 'start') handlers.get('message_start')({ message: event.partial });
    else if (event.partial) handlers.get('message_update')({ message: event.partial, assistantMessageEvent: event });
  }
  const final = await stream.result();
  assert.equal(final.stopReason, 'toolUse', final.errorMessage);
  const done = handlers.get('message_end')({ message: final }).message;
  assert.equal(authorization, 'Bearer fixture-access'); assert.equal(payload.model, 'fixture');
  assert.equal(done.provider, CHATGPT_PROVIDER);
  assert.equal(done.content.find(b => b.type === 'text').text, 'Fixture answer');
  assert.equal(done.content.find(b => b.type === 'toolCall').arguments.command, 'pwd');
  assert.ok(done.__timing.start - done.__timing.requestStart >= 50);
  const usage = usageOf([done]);
  assert.equal(usage.output, 500); assert.equal(usage.reasoning, 400); assert.equal(usage.prompt, 1200);
  assert.equal(usage.genOut, 500); assert.equal(usage.genMs, done.__timing.end - done.__timing.requestStart);
  assert.equal(model.contextWindow, 128000); assert.equal(model.maxTokens, 32000);
});
