// Deterministic Anthropic Messages API server (SSE streaming) for offline Claude Code engine tests.
// Requests are logged (model, x-api-key, authorization, custom headers) so tests can prove which
// credentials and which model reached the endpoint.
//
// Behaviour, driven by the conversation:
//   last user turn holds a tool_result            -> stream "Tool result: <first line>"
//   last user text contains [[bash:COMMAND]]      -> a Bash tool_use with COMMAND
//   last user text contains [[edit:PATH|OLD|NEW]] -> an Edit tool_use on PATH
//   last user text contains [[think]]             -> a thinking block before the answer
//   otherwise                                     -> stream "[<model>] echo: <text>" in chunks
import http from 'node:http';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('') : '';

export function startMockAnthropic({ port = 0, chunkDelay = 10, prefix = '' } = {}) {
  const requests = [];
  let counter = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.slice(prefix.length);
    if (req.method === 'GET' && /\/v1\/models$/.test(path)) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-claude', display_name: 'Mock Claude' }] }));
    }
    if (req.method !== 'POST' || !/\/v1\/messages(\/count_tokens)?$/.test(path)) return res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* logged below */ }
    if (path.endsWith('/count_tokens')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 42 }));
    const messages = payload.messages ?? [];
    const last = messages.at(-1);
    const lastText = textOf(last?.content);
    const system = Array.isArray(payload.system) ? payload.system.map(s => s.text ?? '').join('\n') : String(payload.system ?? '');
    const toolResult = Array.isArray(last?.content) ? last.content.find(part => part?.type === 'tool_result') : null;
    requests.push({
      model: payload.model, apiKey: req.headers['x-api-key'] ?? '', authorization: req.headers.authorization ?? '',
      custom: req.headers['x-pidesk-test'] ?? '', url: req.url, stream: !!payload.stream, thinking: payload.thinking ?? null,
      tools: (payload.tools ?? []).map(t => t.name), messageCount: messages.length, system, lastText, maxTokens: payload.max_tokens, at: Date.now(),
    });
    const id = `msg_mock_${++counter}`;
    const usage = { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 1 };
    const blocks = [];
    const userText = [...messages].reverse().map(m => m.role === 'user' ? textOf(m.content) : '').find(Boolean) ?? '';
    const bash = /\[\[bash:([\s\S]+?)\]\]/.exec(lastText);
    const edit = /\[\[edit:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]\]/.exec(lastText);
    if (toolResult) {
      const out = typeof toolResult.content === 'string' ? toolResult.content : textOf(toolResult.content);
      blocks.push({ type: 'text', text: `Tool result: ${String(out).split('\n')[0]}` });
    } else if (bash) blocks.push({ type: 'tool_use', id: `toolu_${counter}`, name: 'Bash', input: { command: bash[1], description: 'Run the requested command' } });
    else if (edit) blocks.push({ type: 'tool_use', id: `toolu_${counter}`, name: 'Edit', input: { file_path: edit[1], old_string: edit[2], new_string: edit[3] } });
    else {
      if (/\[\[think\]\]/.test(lastText)) blocks.push({ type: 'thinking', thinking: 'Considering the request carefully.' });
      // Background calls (titles, summaries) get a short JSON-ish answer so they never look like a reply.
      blocks.push({ type: 'text', text: payload.stream ? `[${payload.model}] echo: ${userText}` : '{"title":"Mock title"}' });
    }
    const outputTokens = blocks.reduce((n, b) => n + Math.ceil(JSON.stringify(b).length / 4), 0);
    const delay = /\[\[slow\]\]/.test(userText) ? Math.max(chunkDelay, 150) : chunkDelay;
    if (!payload.stream) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        id, type: 'message', role: 'assistant', model: payload.model, content: blocks.map(b => b.type === 'thinking' ? { ...b, signature: 'sig' } : b),
        stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { ...usage, output_tokens: outputTokens },
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'request-id': `req_${counter}` });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { id, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (let i = 0; i < block.text.length; i += 8) { await sleep(delay); if (res.destroyed) return; send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text.slice(i, i + 8) } }); }
      } else if (block.type === 'thinking') {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock-signature' } });
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        const json = JSON.stringify(block.input);
        for (let i = 0; i < json.length; i += 16) { await sleep(delay); if (res.destroyed) return; send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 16) } }); }
      }
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
    send('message_stop', {});
    res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    requests,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockAnthropic({ port: Number(process.env.PORT ?? 0) });
  process.stdout.write(`mock-anthropic listening on ${mock.url}\n`);
  setInterval(() => { while (mock.requests.length) process.stdout.write(JSON.stringify(mock.requests.shift()) + '\n'); }, 200);
}
