// Cursor CLI runs as a distinct agent behind Pi Desktop's existing durable relay.
// Only the desktop event envelope is adapted. Cursor owns context, tools and auth.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CursorAcp, cursorCurrentModel, cursorModelConfig, cursorModels } from './cursor-acp.mjs';

const textOf = content => (content ?? []).map(c => c.type === 'text' ? c.text : c.type === 'resource_link' ? c.uri : JSON.stringify(c)).join('\n');
export class CursorDesktopSession {
  constructor({ client, file, cwd, send, credentialVersion = 0 }) {
    this.cursorCredentialVersion = credentialVersion;
    this.client = client; this.file = file; this.cwd = cwd; this.send = send;
    this.entries = []; this.dialogs = new Map(); this.streaming = false;
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try { this.entries.push(JSON.parse(lines[i])); }
        catch { throw new Error('Cursor desktop history is damaged; refusing to overwrite it'); }
      }
    } else {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      this.append({ type: 'session', version: 3, cwd, timestamp: new Date().toISOString(), id: randomUUID() });
    }
    this.cursorState = [...this.entries].reverse().find(e => e.type === 'cursor_state');
    this.sessionId = this.cursorState?.sessionId;
    this.model = this.cursorState?.model;
    client.on('notification', message => this.notification(message));
    client.on('request', message => { this.clientRequest(message).catch(() => client.reject(message.id)); });
  }
  append(entry) {
    const value = entry.id ? entry : { ...entry, id: randomUUID(), parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() };
    appendFileSync(this.file, JSON.stringify(value) + '\n', { mode: 0o600 });
    this.entries.push(value);
  }
  saveState() { this.append({ type: 'cursor_state', sessionId: this.sessionId, model: this.model }); }
  async start(modelId) {
    await this.client.start();
    const session = await this.client.openSession(this.sessionId);
    this.sessionId = this.client.sessionId;
    this.applyModelState(session);
    this.model ??= { provider: 'cursor', id: modelId ?? 'default' };
    this.saveState();
    if (modelId && modelId !== this.model.id) await this.setModel(modelId);
  }
  applyModelState(state) {
    this.modelConfig = cursorModelConfig(state);
    this.models = cursorModels(state);
    const id = cursorCurrentModel(state) ?? this.model?.id;
    if (id) this.model = { provider: 'cursor', id, name: this.models.find(model => model.id === id)?.name ?? id };
  }
  async setModel(modelId) {
    if (this.streaming) throw new Error('Wait for Cursor to finish before switching models');
    if (!this.models.some(model => model.id === modelId)) throw new Error('This model is not available from Cursor CLI');
    if (this.modelConfig) {
      const result = await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modelConfig.id, value: modelId });
      this.applyModelState(result);
      if (this.model?.id !== modelId) throw new Error('Cursor did not apply the requested model');
    } else {
      await this.client.request('session/set_model', { sessionId: this.sessionId, modelId });
      this.model = { provider: 'cursor', id: modelId, name: this.models.find(model => model.id === modelId)?.name ?? modelId };
    }
    this.saveState();
  }
  state() { return { sessionId: this.sessionId, sessionFile: this.file, cursorCredentialVersion: this.cursorCredentialVersion, isStreaming: this.streaming, model: this.model, thinkingLevel: 'off' }; }
  messages() { return this.entries.filter(e => e.type === 'message').map(e => e.message); }
  endMessage(message) { this.append({ type: 'message', message }); this.send({ type: 'message_end', message }); }
  notification({ method, params }) {
    if (method !== 'session/update' || params?.sessionId !== this.sessionId) return;
    const u = params.update;
    if (!u) return;
    if (u.sessionUpdate === 'config_option_update') {
      this.applyModelState(u); this.saveState();
      this.send({ type: 'cursor_model_changed', model: this.model });
      return;
    }
    if (!this.streaming) return;
    if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
      if (u.content?.type !== 'text') return;
      const thinking = u.sessionUpdate === 'agent_thought_chunk';
      const type = thinking ? 'thinking' : 'text', field = thinking ? 'thinking' : 'text';
      let index = this.assistant.content.length - 1;
      if (this.assistant.content[index]?.type !== type) {
        index = this.assistant.content.length;
        this.assistant.content.push({ type, [field]: '' });
        this.send({ type: 'message_update', assistantMessageEvent: { type: `${type}_start`, contentIndex: index } });
      }
      this.assistant.content[index][field] += u.content.text;
      this.send({ type: 'message_update', assistantMessageEvent: { type: `${type}_delta`, contentIndex: index, delta: u.content.text } });
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const id = u.toolCallId;
      if (!id) return;
      let tool = this.tools.get(id);
      if (!tool) {
        const name = u.kind === 'read' ? 'read' : u.kind === 'execute' ? 'bash' : `cursor_${u.kind || 'tool'}`;
        const args = { ...(u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}), description: u.title || 'Cursor tool' };
        if (!args.path && u.locations?.[0]?.path) args.path = u.locations[0].path;
        const call = { type: 'toolCall', id, name, arguments: args };
        const index = this.assistant.content.length;
        this.assistant.content.push(call);
        tool = { call, index, started: Date.now(), content: [] }; this.tools.set(id, tool);
        this.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: index, toolCall: call } });
        this.send({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
      }
      if (u.rawInput || u.locations || u.title) {
        Object.assign(tool.call.arguments, u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {});
        if (u.locations?.[0]?.path && !tool.call.arguments.path) tool.call.arguments.path = u.locations[0].path;
        if (u.title) tool.call.arguments.description = u.title;
        this.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: tool.index, toolCall: tool.call } });
      }
      if (u.content) tool.content = u.content.map(item => ({ type: 'text', text: item.type === 'content' ? textOf([item.content]) : item.type === 'diff' ? `${item.path}\n${item.newText ?? ''}` : JSON.stringify(item) }));
      if (u.rawOutput !== undefined && !tool.content.length) tool.content = [{ type: 'text', text: typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput) }];
      if (u.status === 'completed' || u.status === 'failed') {
        tool.done = true; tool.error = u.status === 'failed';
        this.send({ type: 'tool_execution_end', toolCallId: id, result: { content: tool.content }, isError: tool.error, durationMs: Date.now() - tool.started });
      } else if (!tool.done) this.send({ type: 'tool_execution_update', toolCallId: id, partialResult: { content: tool.content } });
    }
  }
  dialog(method, title, extra = {}) {
    const id = randomUUID();
    return new Promise(resolve => {
      this.dialogs.set(id, resolve);
      this.send({ type: 'extension_ui_request', id, method, title, ...extra });
    });
  }
  answer(id, payload) { const resolve = this.dialogs.get(id); this.dialogs.delete(id); resolve?.(payload); }
  async clientRequest({ id, method, params }) {
    if (!this.streaming) { this.client.reject(id, 'No active Cursor turn'); return; }
    if (method === 'session/request_permission') {
      const options = params.options ?? [];
      const labels = options.map((option, i) => `${i + 1}. ${option.name || option.optionId}`);
      const answer = await this.dialog('select', params.toolCall?.title || 'Cursor requests permission', { options: labels });
      const option = options[labels.indexOf(answer.value)];
      this.client.respond(id, { outcome: option && !answer.cancelled ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
    } else if (method === 'cursor/ask_question') {
      const answers = [];
      for (const question of params.questions ?? []) {
        // A single-choice UI must not silently narrow a multi-select question.
        const options = question.options ?? [];
        const labels = options.map((option, i) => `${i + 1}. ${option.label}`);
        const answer = await this.dialog(question.allowMultiple ? 'input' : 'select', question.prompt, question.allowMultiple ? { placeholder: 'Option numbers separated by commas', message: labels.join('\n') } : { options: labels });
        if (answer.cancelled) { this.client.respond(id, { outcome: { outcome: 'cancelled' } }); return; }
        const selected = question.allowMultiple ? String(answer.value ?? '').split(',').map(s => options[Number(s.trim()) - 1]?.id).filter(Boolean) : [options[labels.indexOf(answer.value)]?.id].filter(Boolean);
        if (!selected.length) { this.client.respond(id, { outcome: { outcome: 'skipped', reason: 'No listed option selected' } }); return; }
        answers.push({ questionId: question.id, selectedOptionIds: [...new Set(selected)] });
      }
      this.client.respond(id, { outcome: { outcome: 'answered', answers } });
    } else if (method === 'cursor/create_plan') {
      const answer = await this.dialog('confirm', params.name || 'Approve Cursor plan?', { message: params.plan || params.overview || '' });
      this.client.respond(id, { outcome: { outcome: answer.cancelled ? 'cancelled' : answer.confirmed ? 'accepted' : 'rejected' } });
    } else this.client.reject(id);
  }
  clearDialogs() {
    const hadDialogs = this.dialogs.size > 0;
    for (const resolve of this.dialogs.values()) resolve({ cancelled: true });
    this.dialogs.clear();
    if (hadDialogs) this.send({ type: 'cursor_questions_cleared' });
  }
  prompt(message, images = []) {
    if (this.streaming) throw new Error('Cursor is still working; stop the current turn first');
    if (/^\/(goal|compact|fork)(\s|$)/.test(message)) throw new Error('This Pi command is not available in Cursor sessions');
    this.streaming = true; this.tools = new Map();
    this.endMessage({ role: 'user', content: [{ type: 'text', text: message }, ...images], timestamp: Date.now() });
    this.assistant = { role: 'assistant', provider: 'cursor', model: this.model?.id, content: [], timestamp: Date.now() };
    this.send({ type: 'agent_start' }); this.send({ type: 'message_start', message: this.assistant });
    const started = Date.now();
    const prompt = [{ type: 'text', text: message }, ...images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))];
    this.turn = this.client.request('session/prompt', { sessionId: this.sessionId, prompt }, { timeout: 0 }).then(result => {
      if (!result?.stopReason) throw new Error('Cursor ended without a stop reason');
      this.assistant.stopReason = result.stopReason === 'cancelled' ? 'aborted' : ['max_tokens', 'max_turn_requests'].includes(result.stopReason) ? 'length' : result.stopReason === 'end_turn' ? 'stop' : 'error';
      if (this.assistant.stopReason === 'error') this.assistant.errorMessage = `Cursor stopped: ${result.stopReason}`;
    }).catch(error => { this.assistant.stopReason = this.cancelling ? 'aborted' : 'error'; this.assistant.errorMessage = error.message; }).finally(() => {
      this.clearDialogs();
      this.assistant.durationMs = Date.now() - started;
      this.endMessage(this.assistant);
      for (const [id, tool] of this.tools) {
        if (!tool.done) {
          tool.error = true; tool.content = [{ type: 'text', text: 'Cursor tool interrupted before completion' }];
          this.send({ type: 'tool_execution_end', toolCallId: id, result: { content: tool.content }, isError: true });
        }
        this.endMessage({ role: 'toolResult', toolCallId: id, toolName: tool.call.name, content: tool.content, isError: !!tool.error, timestamp: Date.now() });
      }
      this.streaming = false; this.cancelling = false;
      this.send({ type: 'agent_end', messages: [] }); this.send({ type: 'agent_settled' });
    });
    return { disposition: 'started' };
  }
  async abort() {
    if (!this.streaming) return;
    this.cancelling = true; this.clearDialogs();
    try { this.client.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* process has already exited */ }
    // SessionManager owns the four-second fallback: it stops the relay process and
    // starts a fresh adapter before accepting another prompt. Do not announce an
    // early settled event from a CLI that is still being forcibly terminated.
    await this.turn;
  }
  async request(type, p = {}) {
    switch (type) {
      case 'get_state': return this.state();
      case 'get_available_models': return { models: this.models };
      case 'get_messages': return { messages: this.messages() };
      case 'get_entries': return { entries: this.entries, leafId: this.entries.at(-1)?.id };
      case 'get_session_stats': return { contextUsage: null };
      case 'get_commands': return { commands: [] };
      case 'set_session_name': return {};
      case 'set_model': if (p.provider !== 'cursor') throw new Error('Use a Cursor model for this session'); await this.setModel(p.modelId); return { model: this.model };
      case 'prompt': return this.prompt(p.message, p.images);
      case 'abort': await this.abort(); return {};
      case 'abort_bash': case 'clear_queue': return {};
      default: throw new Error(`${type} is not available in Cursor sessions`);
    }
  }
}

async function main() {
  let bootText = process.env.PIDESK_BOOT || '{}';
  delete process.env.PIDESK_BOOT;
  const args = process.argv.slice(2);
  if (args.includes('--boot-stdin')) {
    bootText = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      bootText += chunk;
      if (Buffer.byteLength(bootText) > 65536) throw new Error('Cursor startup configuration is too large');
    }
  }
  let boot;
  try { boot = JSON.parse(bootText); } catch { throw new Error('Invalid Cursor startup configuration'); }
  if (!boot || (boot.cursorApiKey !== undefined && typeof boot.cursorApiKey !== 'string')) throw new Error('Invalid Cursor credentials');
  bootText = '';
  const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const cwd = value('--cwd') || process.cwd();
  const client = new CursorAcp({ command: value('--command'), cwd, apiKey: boot.cursorApiKey });
  const credentialVersion = boot.cursorCredentialVersion ?? 0;
  delete boot.cursorApiKey;
  if (args.includes('--catalog')) {
    // Discovery is also cancellable when its parent process enforces a deadline.
    // Cursor has its own process group, so killing only this adapter would leak it.
    const stop = () => { void client.close().finally(() => process.exit(0)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    // Opening an empty ACP session advertises account models; it sends no model prompt.
    client.on('request', message => client.reject(message.id, 'Model discovery is non-interactive. Enter a Cursor API Key in Settings or use agent login.'));
    try { await client.start(); const session = await client.openSession(); process.stdout.write(JSON.stringify({ models: cursorModels(session), currentModelId: cursorCurrentModel(session) }) + '\n'); }
    finally { await client.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop); }
    return;
  }
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const file = value('--session-file');
  if (!file) throw new Error('Missing Cursor desktop history path');
  const desktop = new CursorDesktopSession({ client, file, cwd, send, credentialVersion });
  const ready = desktop.start(value('--model'));
  ready.catch(error => { console.error(error.message); });
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let p;
      try { p = JSON.parse(line); } catch { continue; }
      if (p.type === 'extension_ui_response') { desktop.answer(p.id, p); continue; }
      void ready.then(() => desktop.request(p.type, p)).then(data => send({ type: 'response', id: p.id, command: p.type, success: true, data }), error => send({ type: 'response', id: p.id, command: p.type, success: false, error: error.message }));
    }
  });
  const shutdown = async () => { desktop.clearDialogs(); await client.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
  client.on('closed', () => { if (!desktop.streaming) process.exit(1); else desktop.turn?.finally(() => process.exit(1)); });
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
