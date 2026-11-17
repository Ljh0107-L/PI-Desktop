// Real Pi RPC + local OpenAI-compatible endpoints. No API keys or external services.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport } from '../core/transports.mjs';
import pideskBridge from '../agent/pidesk-bridge.js';

const SUMMARY = '## Goal\nKeep the project requirements.\n## Next Steps\nContinue the work.';

test('OpenAI guards preserve catalog defaults and explicit model APIs', t => {
  const saved = process.env.PIDESK_BOOT, boot = Symbol.for('pidesk.boot'), savedBoot = globalThis[boot];
  t.after(() => {
    if (saved === undefined) delete process.env.PIDESK_BOOT; else process.env.PIDESK_BOOT = saved;
    if (savedBoot === undefined) delete globalThis[boot]; else globalThis[boot] = savedBoot;
  });
  const providers = [
    { id: 'openai', apiKey: 'test-only' },
    { id: 'implicit', models: [{ id: 'test' }] },
    { id: 'mixed', models: [{ id: 'a', api: 'openai-responses' }, { id: 'b', api: 'anthropic-messages' }] },
    { id: 'chat', api: 'openai-completions', models: [{ id: 'test' }] },
  ];
  process.env.PIDESK_BOOT = JSON.stringify({ providers });
  const registered = new Map();
  pideskBridge({ on() {}, registerTool() {}, registerCommand() {}, registerProvider(id, config) { registered.set(id, config); } });
  assert.equal(registered.get('openai').models, undefined);
  assert.equal(typeof registered.get('openai').streamSimple, 'function');
  assert.equal(registered.get('implicit').api, undefined);
  assert.equal(registered.get('mixed').api, undefined);
  assert.deepEqual(registered.get('mixed').models.map(m => m.api), ['openai-responses', 'anthropic-messages']);
  assert.equal(registered.get('chat').api, 'openai-completions');
  assert.equal(typeof registered.get('chat').streamSimple, 'function');
});

async function fixture(t, api, { empty = false, reasoningOnly = false, automatic = false, whitespace = false, truncated = false, provider = 'mock', modelApiOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-compact-'));
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: automatic, keepRecentTokens: 0 }, retry: { enabled: false } }));
  const requests = [], events = [];
  let summarizing = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const requestText = JSON.stringify(payload);
    const isSummary = summarizing || requestText.includes('<conversation>') || requestText.includes('Create a concise checkpoint');
    const text = isSummary ? (empty || reasoningOnly ? '' : whitespace ? '  \n  ' : SUMMARY) : 'Ready to continue.';
    const inputTokens = automatic && !isSummary ? 790000 : 200;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (api === 'openai-responses') {
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const id = `resp_${requests.length}`;
      send({ type: 'response.created', response: { id, status: 'in_progress' } });
      const output = [];
      if (isSummary && reasoningOnly) {
        const item = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'I should summarize the task.' }] };
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, summary: [] } });
        send({ type: 'response.output_item.done', output_index: 0, item }); output.push(item);
      }
      if (text) {
        const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
        send({ type: 'response.output_item.added', output_index: output.length, item: { ...item, content: [] } });
        send({ type: 'response.output_text.delta', output_index: output.length, content_index: 0, delta: text });
        send({ type: 'response.output_item.done', output_index: output.length, item }); output.push(item);
      }
      send({ type: truncated && isSummary ? 'response.incomplete' : 'response.completed', response: {
        id, status: truncated && isSummary ? 'incomplete' : 'completed', output,
        ...(truncated && isSummary ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        usage: { input_tokens: inputTokens, output_tokens: 30, total_tokens: inputTokens + 30 },
      } });
    } else {
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chat_${requests.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: inputTokens, completion_tokens: 30, total_tokens: inputTokens + 30 } } : {}) })}\n\n`);
      send({ role: 'assistant', content: text, ...(isSummary && reasoningOnly ? { reasoning_content: 'I should summarize the task.' } : {}) });
      send({}, truncated && isSummary ? 'length' : 'stop'); res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const session = new PiSession({ id: 'compact', boot: { providers: [{ id: provider, ...(modelApiOnly ? {} : { api }), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', models: [{ id: 'test', api }] }] },
    transport: localTransport({ node: process.execPath, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), cwd: dir, agentDir, extensions: [resolve('agent/pidesk-bridge.js')] }) });
  t.after(async () => { await session.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  session.on('event', event => events.push(event));
  await session.start(); await session.setModel(provider, 'test');
  const settled = session.nextSettled(15000);
  await session.prompt('Remember the project requirements and continue later.'); await settled;
  summarizing = true;
  return { session, requests, events, resume: () => { summarizing = false; }, repair: () => { empty = reasoningOnly = whitespace = truncated = false; }, entries: async () => (await session.request('get_entries')).entries,
    disk: async () => readFileSync((await session.state()).sessionFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const api of ['openai-responses', 'openai-completions']) {
  test(`${api}: manual compact persists a summary and the next request retains tools`, { timeout: 20000 }, async t => {
    const f = await fixture(t, api);
    const result = await f.session.request('compact');
    assert.match(result.summary, /Keep the project requirements/);
    for (const entries of [await f.entries(), await f.disk()]) assert.equal(entries.filter(e => e.type === 'compaction').length, 1);
    assert.equal(f.events.findLast(e => e.type === 'compaction_end').aborted, false);
    f.resume();
    const settled = f.session.nextSettled(15000); await f.session.prompt('Continue.'); await settled;
    assert.match(JSON.stringify(f.requests.at(-1)), /Keep the project requirements/);
    assert.ok(f.requests.at(-1).tools.some(tool => (tool.function?.name ?? tool.name) === 'read'));
  });

  for (const kind of ['empty', 'reasoningOnly', 'whitespace', 'truncated']) test(`${api}: ${kind} summary fails without replacing context`, { timeout: 20000 }, async t => {
    const f = await fixture(t, api, { [kind]: true });
    await assert.rejects(f.session.request('compact'), kind === 'truncated' ? /token cap|incomplete/i : /empty|no.*text/i);
    for (const entries of [await f.entries(), await f.disk()]) assert.equal(entries.filter(e => e.type === 'compaction').length, 0);
    const end = f.events.findLast(e => e.type === 'compaction_end');
    assert.ok(end.errorMessage); assert.equal(end.aborted, false);
    const messages = await f.session.messages();
    assert.ok(messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Remember the project requirements')));
    f.repair();
    const result = await f.session.request('compact');
    assert.match(result.summary, /Keep the project requirements/, 'a failed compaction must not block a later retry');
  });

  test(`${api}: automatic compaction also preserves context on an empty summary`, { timeout: 20000 }, async t => {
    const f = await fixture(t, api, { automatic: true, empty: true });
    const end = f.events.findLast(e => e.type === 'compaction_end');
    assert.equal(end?.reason, 'threshold');
    assert.match(end.errorMessage, /empty|no.*text/i);
    assert.equal((await f.entries()).filter(e => e.type === 'compaction').length, 0);
    assert.ok((await f.session.messages()).some(m => m.role === 'user' && JSON.stringify(m.content).includes('Remember the project requirements')));
  });
}

for (const [provider, api] of [['openai', 'openai-responses'], ['deepseek', 'openai-completions']]) {
  test(`${provider}: model-level API registrations also guard empty summaries`, { timeout: 20000 }, async t => {
    const f = await fixture(t, api, { provider, modelApiOnly: true, empty: true });
    await assert.rejects(f.session.request('compact'), /empty|no.*text/i);
    assert.equal((await f.entries()).filter(e => e.type === 'compaction').length, 0);
  });
}
