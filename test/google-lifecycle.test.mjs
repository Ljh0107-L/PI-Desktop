// Exercise the actual staged extension and Pi tool loop, not just the adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport } from '../core/transports.mjs';
import { stageExtensions } from '../app/main/extensions.mjs';

test('staged Google provider retries a broken call without executing it, then executes the complete call once', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pidesk-google-loop-'));
  const cwd = join(root, 'cwd'); mkdirSync(cwd);
  const bridge = stageExtensions(resolve('agent'), join(root, 'ext'));
  const requests = [];
  let requestsWithTool = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (parts, finishReason) => res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finishReason && { finishReason }) }] })}\n\n`);
    if (payload.contents.some(c => c.parts.some(p => p.functionResponse))) {
      send([{ text: 'Done.' }], 'STOP'); res.end(); return;
    }
    requestsWithTool++;
    const command = 'printf "once\\n" >> marker.txt';
    send([{ functionCall: { id: 'call-write', name: 'bash', willContinue: true } }]);
    send([{ functionCall: { partialArgs: [{ jsonPath: '$.command', stringValue: command }], willContinue: true } }]);
    if (requestsWithTool === 1) {
      // A complete-looking command is still not an executable call until the terminal frame.
      await sleep(30); res.end(); return;
    }
    send([{ functionCall: { willContinue: false } }]);
    send([], 'STOP'); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const session = new PiSession({ id: 'google-native-loop', boot: { providers: [{ id: 'google-loop', api: 'google-generative-ai',
    apiKey: 'test-key', baseUrl: `http://127.0.0.1:${server.address().port}/proxy/google`,
    models: [{ id: 'ep-native-test', name: 'Gemini 4 Argon', reasoning: true, contextWindow: 1048576, maxTokens: 64000 }],
  }] }, transport: localTransport({ node: process.execPath, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    cwd, agentDir: join(root, 'agent'), extensions: [bridge] }) });
  t.after(async () => { await session.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); });
  const events = []; session.on('event', e => events.push(e));
  await session.start(); await session.setModel('google-loop', 'ep-native-test');
  const settled = session.nextSettled(15000);
  await session.prompt('Write marker.txt once using bash.'); await settled;
  assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), 'once\n');
  assert.equal(requestsWithTool, 2);
  assert.equal(requests.length, 3);
  assert.equal(events.filter(e => e.type === 'tool_execution_start').length, 1);
  assert.equal(events.filter(e => e.type === 'auto_retry_start').length, 1);
  for (const payload of requests) assert.equal(payload.toolConfig.functionCallingConfig.streamFunctionCallArguments, true);
  assert.equal(events.findLast(e => e.type === 'message_end' && e.message.role === 'assistant').message.stopReason, 'stop');
});
