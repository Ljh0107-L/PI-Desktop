// Deterministic OpenAI-compatible chat-completions server for offline M0 verification.
// Each provider gets its own path prefix: /<provider>/v1/chat/completions.
// Requests are logged (provider, model, bearer token) so tests can prove which key reached which provider.
//
// Behaviour, driven by the conversation:
//   last message is a tool result            -> stream "Tool result: <first line>"
//   last user text contains [[bash:COMMAND]] -> stream a bash tool call with COMMAND
//   otherwise                                -> stream "[<provider>/<model>] echo: <text>" in chunks
import http from 'node:http';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';

export function startMockLlm({ port = 0, chunkDelay = 15 } = {}) {
  const requests = [];
  const dropped = new Set();
  const server = http.createServer(async (req, res) => {
    const match = /^\/([\w-]+)\/v1\/chat\/completions$/.exec(req.url ?? '');
    if (req.method === 'GET' && /\/v1\/models$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'alpha-1', object: 'model' }, { id: 'beta-1', object: 'model', context_length: 200000 }, { id: 'gamma-embed', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !match) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const provider = match[1];
    const auth = req.headers.authorization ?? '';
    const system = (payload.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('')).join('\n');
    const subagent = system.includes('You are a Pi Desktop subagent, not the coordinating assistant.');
    requests.push({ provider, model: payload.model, authorization: auth, messageCount: payload.messages?.length ?? 0, system, subagent, at: Date.now() });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const id = 'chatcmpl-' + requests.length;
    // Token counting like a real tokenizer (and unlike the desktop's heuristic): CJK ≈ 0.7 token/char.
    let sentChars = 0;
    const countTokens = text => { const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length; return cjk * 0.7 + (text.length - cjk) / 4; };
    const send = (delta, finish = null, extra = {}) => (sentChars += countTokens(String(delta.content ?? '') + String(delta.tool_calls?.[0]?.function?.arguments ?? '')) * 4, res.write('data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
    }) + '\n\n'));
    const finish = reason => {
      send({}, reason);
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model: payload.model, choices: [], usage: (() => { const prompt = Math.max(10, Math.round(JSON.stringify(payload.messages ?? []).length / 4)); const completion = Math.max(1, Math.round(sentChars / 4)); const cached = (payload.messages?.length ?? 0) > 2 ? Math.floor(prompt * 0.8) : 0; const reasoning = titleRequest || !hiddenThink ? 0 : 400; return { prompt_tokens: prompt, completion_tokens: completion + reasoning, total_tokens: prompt + completion + reasoning, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning } }; })() }) + '\n\n');
      res.end('data: [DONE]\n\n');
    };

    const messages = payload.messages ?? [];
    // Naming a conversation (Pi Desktop's title request): answer with the start of the user's message.
    const titleRequest = /^You name conversations/.test(textOf(messages[0]?.content));
    if (titleRequest) {
      send({ role: 'assistant', content: '' });
      send({ content: '"' + textOf(messages.at(-1)?.content).split('\n')[0].slice(0, 50).trim() + ' (named)"' });
      finish('stop');
      return;
    }
    const last = messages[messages.length - 1] ?? {};
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const fullUserText = textOf(lastUser?.content);
    const userText = subagent ? fullUserText.split(/\n\nYour task \([^\n]*\):\n/).at(-1) : fullUserText;
    if (userText.includes('[[drop-once]]') && !dropped.has(userText)) {
      dropped.add(userText);
      send({ role: 'assistant', content: 'Partial before disconnect' });
      await sleep(100);
      res.destroy();
      return;
    }
    const writeMatch = /\[\[write:([^|\]]+)\|([\s\S]*?)\]\]/.exec(userText);
    const toolMatch = writeMatch ? null : /\[\[bash:([\s\S]+?)\]\]/.exec(userText);
    // [[hidden-think]]: reason silently for a while (billed as reasoning tokens) before answering.
    const hiddenThink = userText.includes('[[hidden-think]]') && last.role !== 'tool';
    if (hiddenThink) { send({ role: 'assistant', content: '' }); sentChars = 0; await new Promise(r => setTimeout(r, 1500)); }
    const askMatch = /\[\[ask:([^|\]]+)(?:\|([^\]]*))?\]\]/.exec(userText);
    if (!subagent && userText.includes('[[subagents]]') && last.role !== 'tool') {
      send({ role: 'assistant', content: '' });
      const tasks = [{ name: 'Inspect cwd', task: '[[bash:pwd]]' }, { name: 'Write delegated file', task: '[[write:subagent-result.txt|created by subagent]]' }];
      send({ tool_calls: [{ index: 0, id: 'call_sub' + requests.length, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ tasks, context: 'Only inspect cwd and write the assigned file. Do not run tests or open GUI applications.' }) } }] });
      finish('tool_calls');
      return;
    }
    if (askMatch && last.role !== 'tool') {
      const options = askMatch[2] ? askMatch[2].split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const args = JSON.stringify({ question: askMatch[1].trim(), ...(options ? { options } : {}) });
      send({ role: 'assistant', content: '' });
      send({ tool_calls: [{ index: 0, id: 'call_q' + requests.length, type: 'function', function: { name: 'ask_user', arguments: args } }] });
      finish('tool_calls');
      return;
    }
    if (writeMatch && last.role !== 'tool') {
      const args = JSON.stringify({ path: writeMatch[1].trim(), content: writeMatch[2] });
      send({ role: 'assistant', content: '' });
      send({ content: 'I will create that file.' });
      send({ tool_calls: [{ index: 0, id: 'call_w' + requests.length, type: 'function', function: { name: 'write', arguments: args } }] });
      finish('tool_calls');
      return;
    }

    send({ role: 'assistant', content: '' });
    if (last.role === 'tool') {
      const firstLine = textOf(last.content).trim().split('\n')[0] ?? '';
      for (const piece of ['Tool ', 'result: ', firstLine]) { await sleep(chunkDelay); send({ content: piece }); }
      finish('stop');
      return;
    }
    if (toolMatch) {
      const desc = /\[\[desc:([^\]]+)\]\]/.exec(userText)?.[1];
      const args = JSON.stringify({ command: toolMatch[1], ...(desc ? { description: desc } : {}) });
      send({ tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name: 'bash', arguments: '' } }] });
      for (let i = 0; i < args.length; i += 12) { await sleep(chunkDelay); send({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 12) } }] }); }
      finish('tool_calls');
      return;
    }
    // Goals (/goal): the objective may carry [[goal-turns:N]]; after N goal turns the model marks it complete.
    if (userText.includes('<objective>') && !userText.includes('<conversation>')) {
      const needed = Number(/\[\[goal-turns:(\d+)\]\]/.exec(userText)?.[1] ?? 1);
      const goalTurns = messages.filter(m => m.role === 'user' && textOf(m.content).includes('<objective>')).length;
      if (last.role === 'tool') { send({ content: 'Goal complete.' }); finish('stop'); return; }
      if (goalTurns >= needed) {
        send({ role: 'assistant', content: '' });
        send({ tool_calls: [{ index: 0, id: 'call_goal' + requests.length, type: 'function', function: { name: 'update_goal', arguments: '{"status":"complete"}' } }] });
        finish('tool_calls');
        return;
      }
      send({ content: `goal progress ${goalTurns}` });
      finish('stop');
      return;
    }
    // Summarization requests (compaction) quote the whole conversation: answer with a short summary.
    if (userText.includes('<conversation>')) {
      send({ content: `## Goal\nSummary of ${messages.length} messages (mock).` });
      finish('stop');
      return;
    }
    // Long inputs are echoed in bigger chunks so tests stay fast; short ones still stream visibly.
    const imageCount = Array.isArray(lastUser?.content) ? lastUser.content.filter(c => c.type === 'image_url').length : 0;
    const reply = `[${provider}/${payload.model}] ${imageCount ? `[images:${imageCount}] ` : ''}echo: ${userText}`;
    const step = reply.length > 600 ? 64 : 8;
    for (let i = 0; i < reply.length; i += step) { await sleep(chunkDelay); send({ content: reply.slice(i, i + step) }); }
    finish('stop');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const { port: actual } = server.address();
    resolve({ port: actual, baseUrl: provider => `http://127.0.0.1:${actual}/${provider}/v1`, requests, close: () => new Promise(r => server.close(r)) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockLlm({ port: Number(process.env.PORT ?? 0) });
  console.log(`mock LLM listening on ${mock.baseUrl('<provider>')}`);
}
