// Deterministic OpenAI-compatible chat-completions server (and a Gemini API one) for offline M0 verification.
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

// Google's protocol (Gemini API) under /<provider>/v1beta: the model list in two pages (the second
// with a model that only embeds), and streamGenerateContent with the key in x-goog-api-key. Same
// behaviour as above for echoes, [[bash:…]] and tool results.
async function geminiReply(req, res, [, provider, model, query = ''], { requests, chunkDelay }) {
  if (!model) {
    if (req.method !== 'GET') return res.writeHead(404).end();
    const second = new URLSearchParams(query).get('pageToken') === 'page-2';
    const models = second
      ? [{ name: 'models/gemini-embed-mock', displayName: 'Gemini Embed Mock', supportedGenerationMethods: ['embedContent'] }]
      : [{ name: 'models/gemini-mock-1', displayName: 'Gemini Mock 1', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true }];
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models, ...(second ? {} : { nextPageToken: 'page-2' }) }));
  }
  if (req.method !== 'POST') return res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || '{}');
  const contents = payload.contents ?? [];
  const textOfParts = parts => (parts ?? []).map(part => part.text ?? '').join('');
  const system = textOfParts((payload.systemInstruction ?? payload.system_instruction)?.parts);
  const tools = (payload.tools ?? []).flatMap(tool => tool.functionDeclarations ?? []).map(f => ({ name: f.name, description: f.description ?? '' }));
  const thinking = payload.generationConfig?.thinkingConfig;
  const functionResponseIds = contents.flatMap(c => c.parts ?? []).filter(part => part.functionResponse).map(part => part.functionResponse.id);
  requests.push({ provider, model, api: 'google', apiKey: req.headers['x-goog-api-key'] ?? '', authorization: req.headers.authorization ?? '', url: req.url,
    messageCount: contents.length, system, tools, thinking, functionResponseIds, subagent: system.includes('You are a Pi Desktop subagent, not the coordinating assistant.'), at: Date.now() });
  // An endpoint id (ep-…) stands for Gemini 4 behind Volcengine Ark, which refuses thinkingBudget.
  if (/^ep-/.test(model) && thinking?.thinkingBudget !== undefined)
    return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'InvalidParameter', message: '400: Thinking budget is not supported for this model.' } }));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (parts, finishReason) => res.write('data: ' + JSON.stringify({
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
    ...(finishReason ? { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } } : {}), modelVersion: model,
  }) + '\n\n');
  const userText = textOfParts([...contents].reverse().find(c => c.role === 'user' && c.parts?.some(part => typeof part.text === 'string'))?.parts);
  const result = (contents.at(-1)?.parts ?? []).find(part => part.functionResponse)?.functionResponse;
  const bash = /\[\[bash:([\s\S]+?)\]\]/.exec(userText);
  if (/^You name conversations/.test(system)) send([{ text: `"${userText.split('\n')[0].slice(0, 50).trim()} (named)"` }], 'STOP');
  else if (result) send([{ text: `Tool result: ${String(result.response?.output ?? result.response?.error ?? '').split('\n')[0]}` }], 'STOP');
  else if (bash) send([{ functionCall: { name: 'bash', args: { command: bash[1] } } }], 'STOP');
  else {
    const reply = `[${provider}/${model}] echo: ${userText}`;
    for (let i = 0; i < reply.length; i += 8) { await sleep(chunkDelay); send([{ text: reply.slice(i, i + 8) }]); }
    send([], 'STOP');
  }
  res.end();
}

export function startMockLlm({ port = 0, chunkDelay = 15 } = {}) {
  const requests = [];
  const dropped = new Set();
  const server = http.createServer(async (req, res) => {
    const gemini = /^\/([\w-]+)\/v1beta\/models(?:\/([^/:?]+):streamGenerateContent)?(?:\?(.*))?$/.exec(req.url ?? '');
    if (gemini) return geminiReply(req, res, gemini, { requests, chunkDelay });
    const match = /^\/([\w-]+)\/v1\/chat\/completions$/.exec(req.url ?? '');
    if (req.method === 'GET' && /\/v1\/models$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'alpha-1', object: 'model' }, { id: 'beta-1', object: 'model', context_length: 200000 }, { id: 'gamma-embed', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !match) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    // Like a real server, an empty request (Pi Desktop checking the route) is a 400, not a reply.
    if (!Array.isArray(payload.messages)) { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"messages is required"}}'); return; }
    const provider = match[1];
    const auth = req.headers.authorization ?? '';
    const system = (payload.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('')).join('\n');
    const subagent = system.includes('You are a Pi Desktop subagent, not the coordinating assistant.');
    const tools = (payload.tools ?? []).map(t => ({ name: t.function?.name ?? t.name, description: t.function?.description ?? t.description ?? '' }));
    requests.push({ provider, model: payload.model, authorization: auth, messageCount: payload.messages?.length ?? 0, system, tools, subagent, at: Date.now() });

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
    if (userText.includes('[[hold-for-stop]]')) {
      send({ role: 'assistant', content: 'Waiting for stop fixture' });
      await new Promise(resolve => {
        // A real in-flight stream, not an echo that may finish while Playwright is scheduling.
        const timer = setTimeout(() => { send({ content: ' Unexpected completion after stop' }); finish('stop'); resolve(); }, 30000);
        res.once('close', () => { clearTimeout(timer); resolve(); });
      });
      return;
    }
    // Ultra feedback uses actual registered tools; the checkpoint must be visible without prose duplication.
    if (!subagent && userText.includes('[[ultra-progress]]')) {
      const reported = messages.some(m => m.tool_calls?.some(c => c.function?.name === 'report_progress'));
      send({ role: 'assistant', content: '' });
      if (reported) { send({ content: 'Ultra mode: continue the task (fixture has no further actions).' }); finish('stop'); return; }
      if (last.role !== 'tool') send({ content: '我先检查当前输出，再验证异常路径。' });
      const name = last.role === 'tool' ? 'report_progress' : 'bash';
      const args = name === 'bash' ? { command: 'printf fixture-check-ok', description: '检查当前输出' }
        : { done: '检查完成：fixture-check-ok。', next: '接下来验证异常路径。', assumptions: '保留现有输入格式。' };
      send({ tool_calls: [{ index: 0, id: `call_ultra_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      finish('tool_calls'); return;
    }
    const askMatch = /\[\[ask:([^|\]]+)(?:\|([^\]]*))?\]\]/.exec(userText);
    // Functional-test fixtures: real SSE finish_reason/usage goes through the actual SDK.
    const childLength = subagent && messages.some(m => m.role === 'user' && /\[\[child-length(?:-repeat|-tools)?\]\]/.test(textOf(m.content)));
    if (childLength) {
      const repeated = messages.some(m => textOf(m.content).includes('[[child-length-repeat]]'));
      const clippedTools = messages.some(m => textOf(m.content).includes('[[child-length-tools]]'));
      const recovery = messages.some(m => m.role === 'user' && textOf(m.content).includes('This is the only automatic output-limit recovery.'));
      send({ role: 'assistant', content: '' });
      if (!recovery || repeated) {
        send({ reasoning_content: 'PRIVATE_REASONING_FIXTURE_NOT_FOR_TRACE' });
        if (clippedTools) send({ tool_calls: [{ index: 0, id: 'call_clipped_write', type: 'function', function: {
          name: 'write', arguments: '{"path":"must-not-be-written.txt","content":"incomplete response"}',
        } }] });
        send({}, 'length', { usage: { prompt_tokens: 100, completion_tokens: 32768, total_tokens: 32868, completion_tokens_details: { reasoning_tokens: 32768 } } });
        res.end('data: [DONE]\n\n');
      } else { send({ content: 'Recovered with smaller complete operations.' }); finish('stop'); }
      return;
    }
    const special = /\[\[subagents-(runtime|length|length-repeat|length-tools)\]\]/.exec(userText);
    if (!subagent && special && last.role !== 'tool') {
      const runtimeCommand = `node -p "'runtime=' + Boolean(process.versions.electron)"; "$PI_NODE" -p "'pi-node=' + Boolean(process.versions.electron)"`;
      const task = special[1] === 'runtime' ? `[[bash:${runtimeCommand}]]` : `[[child-${special[1]}]]`;
      send({ role: 'assistant', content: '' });
      send({ tool_calls: [{ index: 0, id: 'call_sub' + requests.length, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
        tasks: [{ name: special[1] === 'runtime' ? 'Runtime check' : 'Output budget check', task }],
        context: 'Offline CI fixture only. Preserve task constraints. Do not launch GUI or install packages.', background: false,
      }) } }] });
      finish('tool_calls'); return;
    }
    // Background agents (the default): the call returns at once and each report arrives as a message.
    if (!subagent && /\[\[agents-(?:background|slow)\]\]/.test(userText) && last.role !== 'tool') {
      const slow = userText.includes('[[agents-slow]]');
      send({ role: 'assistant', content: '' });
      send({ tool_calls: [{ index: 0, id: 'call_bg' + requests.length, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
        tasks: [slow ? { name: 'Slow check', task: '[[bash:sleep 30 && echo never]]' } : { name: 'Background check', type: 'explore', task: '[[bash:sleep 1 && echo bg-done]]' }],
        context: 'Offline CI fixture. Read-only; do not install packages.',
      }) } }] });
      finish('tool_calls');
      return;
    }
    if (!subagent && /\[\[subagents(?:-slow|-background)?\]\]/.test(userText) && last.role !== 'tool') {
      send({ role: 'assistant', content: '' });
      const slow = userText.includes('[[subagents-slow]]'), background = userText.includes('[[subagents-background]]');
      const tasks = slow || background
        ? [1, 2].map(i => ({ name: `Delayed task ${i}`, task: `[[bash:sleep ${background ? 6 : 3} && echo done > ${slow ? 'cancelled' : 'background'}-subagent-${i}.txt]]` }))
        : [{ name: 'Inspect cwd', task: '[[bash:pwd]]' }, { name: 'Write delegated file', task: '[[write:subagent-result.txt|created by subagent]]' }];
      send({ tool_calls: [{ index: 0, id: 'call_sub' + requests.length, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ tasks, context: 'Only inspect cwd and write the assigned file. Do not run tests or open GUI applications.', background: false }) } }] });
      finish('tool_calls');
      return;
    }
    // [[present:a.txt,b.png]]: hand the user files with present_files.
    const presentMatch = /\[\[present:([^\]]+)\]\]/.exec(userText);
    if (presentMatch && last.role !== 'tool') {
      const paths = presentMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      send({ role: 'assistant', content: '' });
      send({ tool_calls: [{ index: 0, id: 'call_files' + requests.length, type: 'function', function: { name: 'present_files', arguments: JSON.stringify({ paths, caption: 'Files for you' }) } }] });
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
    resolve({ port: actual, baseUrl: provider => `http://127.0.0.1:${actual}/${provider}/v1`, geminiRoot: provider => `http://127.0.0.1:${actual}/${provider}`,
      requests, close: () => new Promise(r => server.close(r)) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockLlm({ port: Number(process.env.PORT ?? 0) });
  console.log(`mock LLM listening on ${mock.baseUrl('<provider>')}`);
}
