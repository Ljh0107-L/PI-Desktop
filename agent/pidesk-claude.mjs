#!/usr/bin/env node
// Pi Desktop's Claude Code engine adapter. Runs where the conversation runs (this Mac's relay or an SSH
// host's), started by the relay exactly like a Pi process, and speaks Pi's RPC protocol on stdin/stdout:
// the desktop, the relay (reconnects, replay, approvals) and the conversation view need no second protocol.
//
// Inside, it drives the pinned Claude Code binary in headless stream-json mode:
//   claude -p --input-format stream-json --output-format stream-json --include-partial-messages
//          --permission-prompt-tool stdio --replay-user-messages ...
// and translates both ways:
//   - Claude Code's raw Anthropic stream events become Pi message_start/message_update/message_end events,
//     tool results become tool_execution_* events and toolResult messages, with Pi's usage and request
//     timing (so Usage and Request TPS work unchanged);
//   - the conversation is also written as a Pi-format session file (JSONL tree), so history pages, Usage,
//     fork and edit work as for Pi conversations. Claude Code keeps its own transcript for --resume.
//   - permission prompts are answered automatically (Pi Desktop runs tools without approvals), except
//     AskUserQuestion and ExitPlanMode, which become question cards for the person at the desktop.
//
// Credentials arrive in the boot record (PIDESK_BOOT, removed from the environment at once) and reach
// Claude Code only as ANTHROPIC_* variables of its own process. CLAUDE_CONFIG_DIR is private to Pi Desktop,
// so a Claude subscription signed in on the machine is never used.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ helpers (exported for tests)
export const CC_TOOL_NAMES = { Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', Bash: 'bash', Grep: 'grep', Glob: 'find', LS: 'ls' };

// Claude Code's core tools under Pi's names and argument shapes, so the conversation view shows file
// links, diffs, Git changes and folded rows as for Pi. The original name and input stay on the block.
export function normalizeToolCall(id, name, input = {}) {
  const a = input && typeof input === 'object' ? input : {};
  const piName = CC_TOOL_NAMES[name] ?? name;
  let args = a;
  switch (name) {
    case 'Read': args = { path: a.file_path, ...(a.offset != null ? { offset: a.offset } : {}), ...(a.limit != null ? { limit: a.limit } : {}) }; break;
    case 'Write': args = { path: a.file_path, content: a.content }; break;
    case 'Edit': args = { path: a.file_path, edits: [{ oldText: a.old_string ?? '', newText: a.new_string ?? '' }], ...(a.replace_all ? { replaceAll: true } : {}) }; break;
    case 'MultiEdit': args = { path: a.file_path, edits: (a.edits ?? []).map(e => ({ oldText: e.old_string ?? '', newText: e.new_string ?? '' })) }; break;
    case 'Bash': args = { command: a.command, ...(a.description ? { description: a.description } : {}), ...(a.timeout ? { timeout: a.timeout } : {}), ...(a.run_in_background ? { run_in_background: true } : {}) }; break;
    case 'Grep': args = { ...a, pattern: a.pattern, ...(a.path ? { path: a.path } : {}) }; break;
    case 'Glob': args = { pattern: a.pattern, ...(a.path ? { path: a.path } : {}) }; break;
    case 'LS': args = { path: a.path }; break;
  }
  return { type: 'toolCall', id, name: piName, arguments: args, ...(piName !== name ? { ccName: name, ccInput: a } : {}) };
}

const blockText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : '';
// A tool result's content in Pi's shape: text and image blocks.
export function toolResultContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(b => b?.type === 'image' && b.source?.type === 'base64' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type }
    : b?.type === 'text' ? { type: 'text', text: b.text ?? '' } : null).filter(Boolean);
}

// Pi usage from Anthropic usage, priced with the model's rates ($ per million tokens).
export function piUsage(u = {}, cost) {
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
  const rate = k => Number.isFinite(cost?.[k]) ? cost[k] / 1e6 : 0;
  const c = { input: input * rate('input'), output: output * rate('output'), cacheRead: cacheRead * rate('cacheRead'), cacheWrite: cacheWrite * rate('cacheWrite') };
  c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
  const thinking = u.output_tokens_details?.thinking_tokens;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: c, ...(Number.isFinite(thinking) && thinking > 0 ? { reasoning: thinking } : {}) };
}
const STOP = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'toolUse', max_tokens: 'length', pause_turn: 'stop', refusal: 'stop' };

// Environment for the Claude Code process: only what it needs, never PIDESK_BOOT. `extra` holds
// non-secret variables the desktop chose for it (tests use it to point the fake binary at a log).
export function claudeEnv(base, { configDir, provider = {}, model = {}, extra = {} }) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
  const env = Object.fromEntries(keep.filter(k => base[k] !== undefined).map(k => [k, base[k]]));
  Object.assign(env, extra);
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_BUG_COMMAND: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENTRYPOINT: 'pi-desktop',
  });
  if (provider.apiKey) env.ANTHROPIC_API_KEY = provider.apiKey;
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
  const headers = Object.entries(provider.headers ?? {}).filter(([k, v]) => k && v != null).map(([k, v]) => `${k}: ${v}`);
  if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.join('\n');
  // Endpoints other than Anthropic's own serve the models they list, not Claude Code's default aliases:
  // background work (titles, summaries) and agents use the conversation's model there too.
  if (provider.id !== 'anthropic' && model.id) {
    for (const k of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) env[k] = model.id;
  }
  if (Number.isFinite(model.maxTokens) && model.maxTokens > 0 && provider.id !== 'anthropic') env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxTokens);
  return env;
}

// ------------------------------------------------------------------ Pi-format session file
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 8);
const sessionDirName = cwd => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

export class Transcript {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.byId = new Map();
    this.leafId = null;
    this.header = null;
    if (file && existsSync(file)) this.#load();
  }
  static create(sessionsDir, cwd, extra = {}) {
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const dir = join(sessionsDir, sessionDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
    const header = { type: 'session', version: 3, id, timestamp, cwd, engine: 'claude-code', ...extra };
    writeFileSync(file, JSON.stringify(header) + '\n', { flag: 'wx' });
    const t = new Transcript(null);
    t.file = file; t.header = header;
    return t;
  }
  #load() {
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'session') { this.header = entry; continue; }
      if (!entry.id) continue;
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      this.leafId = entry.id; // Pi resumes at the last entry written
    }
  }
  get id() { return this.header?.id; }
  branch(leafId = this.leafId) {
    const path = [];
    for (let e = this.byId.get(leafId); e; e = this.byId.get(e.parentId)) path.push(e);
    return path.reverse();
  }
  append(entry) {
    const full = { id: shortId(), parentId: this.leafId, timestamp: new Date().toISOString(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + '\n');
    this.entries.push(full);
    this.byId.set(full.id, full);
    this.leafId = full.id;
    return full;
  }
  // The Claude Code session (and the last message in it) the branch ending at `leafId` continues.
  claudePosition(leafId = this.leafId) {
    const path = this.branch(leafId);
    for (let i = path.length - 1; i >= 0; i--) if (path[i].cc?.sessionId) return { sessionId: path[i].cc.sessionId, uuid: path[i].cc.uuid ?? null };
    return this.header?.cc?.sessionId ? { sessionId: this.header.cc.sessionId, uuid: null } : null;
  }
  // A new file holding the branch ending at `leafId` (Pi's clone/fork).
  copyBranch(sessionsDir, leafId = this.leafId, extra = {}) {
    const copy = Transcript.create(sessionsDir, this.header?.cwd ?? process.cwd(), { parentSession: this.file, ...extra });
    for (const original of this.branch(leafId)) {
      const entry = structuredClone(original);
      appendFileSync(copy.file, JSON.stringify(entry) + '\n');
      copy.entries.push(entry); copy.byId.set(entry.id, entry); copy.leafId = entry.id;
    }
    return copy;
  }
  messages(leafId = this.leafId) {
    const out = [];
    for (const e of this.branch(leafId)) {
      if (e.type === 'message' && e.message) out.push(e.message);
      else if (e.type === 'compaction') out.push({ role: 'compactionSummary', summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.parse(e.timestamp) || 0 });
    }
    return out;
  }
}

// ------------------------------------------------------------------ the adapter
export class ClaudeAdapter {
  constructor({ boot, write, spawnImpl = spawn, env = process.env, now = Date.now }) {
    const cc = boot?.claudeCode ?? {};
    this.write = write;
    this.spawnImpl = spawnImpl;
    this.baseEnv = env;
    this.now = now;
    this.bin = cc.bin;
    this.configDir = cc.configDir;
    this.sessionsDir = cc.sessionsDir;
    this.cwd = cc.cwd ?? process.cwd();
    this.extraEnv = cc.env && typeof cc.env === 'object' ? cc.env : {};
    this.config = { provider: cc.provider ?? {}, model: cc.model ?? {}, effort: cc.effort ?? null, ultracode: !!cc.ultracode, fast: !!cc.fast, permissionMode: cc.permissionMode ?? null };
    this.transcript = cc.sessionFile && existsSync(cc.sessionFile) ? new Transcript(cc.sessionFile) : null;
    // Like Pi, a conversation has its session file from the start (fork and history need its path).
    if (!this.transcript && this.sessionsDir) { try { this.transcript = Transcript.create(this.sessionsDir, this.cwd); } catch { /* created at the first prompt */ } }
    this.child = null;
    this.childKey = null;      // configuration the running Claude Code was started with
    this.resume = null;        // { sessionId, uuid, fork } for the next start
    this.streaming = false;
    this.queued = 0;           // prompts sent and not yet taken up by Claude Code (replayed)
    this.live = null;          // the assistant message streaming now
    this.requestStart = null;
    this.pendingTools = new Map(); // tool_use id -> { name, startedAt, agent? }
    this.uuids = new Map();    // message id -> last Claude Code uuid seen for it
    this.recorded = new Map(); // message id -> entry written for it by the running Claude Code
    this.commandList = [];
    this.models = [];
    this.account = null;
    this.lastContext = null;
    this.controls = new Map(); // request id -> { resolve, reject }
    this.controlSeq = 0;
    this.ui = new Map();       // extension_ui_request id -> resolver
    this.claudeSessionId = null;
    this.turnError = null;
  }

  // ---------------------------------------------------------------- Pi RPC side
  emit(event) { this.write(event); }
  respond(id, type, data, error) { this.write(error ? { type: 'response', id, command: type, success: false, error: String(error?.message ?? error) } : { type: 'response', id, command: type, success: true, data: data ?? null }); }

  async handle(request) {
    if (request.type === 'extension_ui_response') { this.ui.get(request.id)?.(request); this.ui.delete(request.id); return; }
    const { id, type } = request;
    try { this.respond(id, type, await this.#command(request)); }
    catch (error) { this.respond(id, type, null, error); }
  }

  #state() {
    return {
      sessionId: this.transcript?.id ?? null, sessionFile: this.transcript?.file ?? null, engine: 'claude-code',
      model: this.config.model?.id ? { provider: this.config.model.provider ?? this.config.provider.id, id: this.config.model.id } : null,
      thinkingLevel: this.config.effort, isStreaming: this.streaming, claudeSessionId: this.claudeSessionId ?? this.transcript?.claudePosition()?.sessionId ?? null,
      claudeCode: { version: this.version ?? null, account: this.account, models: this.models, ultracode: this.config.ultracode, effort: this.config.effort },
    };
  }

  async #command(request) {
    switch (request.type) {
      case 'get_state': return this.#state();
      case 'prompt': return this.prompt(request.message ?? '', request.images ?? []);
      case 'abort': return this.abort();
      case 'abort_bash': case 'clear_queue': return {};
      case 'claude_configure': return this.configure(request);
      case 'set_model': return this.configure({ provider: request.providerConfig ?? this.config.provider, model: { ...(request.model ?? {}), provider: request.provider, id: request.modelId } });
      case 'set_thinking_level': return this.configure({ effort: request.level });
      case 'set_session_name': return {};
      case 'get_messages': return { messages: this.transcript?.messages() ?? [] };
      case 'get_entries': return { entries: this.transcript?.entries ?? [], leafId: this.transcript?.leafId ?? null };
      case 'get_session_stats': return this.stats();
      case 'get_commands': return { commands: this.commandList.map(c => ({ name: c.name, description: c.description ?? '', source: 'claude-code', ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })) };
      case 'compact': return this.compact();
      case 'clone': return this.clone();
      case 'switch_session': return this.switchSession(request.sessionPath);
      case 'get_fork_messages': return { messages: (this.transcript?.branch() ?? []).filter(e => e.type === 'message' && e.message?.role === 'user').map(e => ({ entryId: e.id, text: blockText(e.message.content) })) };
      case 'fork': return this.forkAt(request.entryId);
      default: throw new Error(`Claude Code conversations do not support ${request.type}`);
    }
  }

  #ensureTranscript() {
    if (!this.transcript) this.transcript = Transcript.create(this.sessionsDir, this.cwd);
    return this.transcript;
  }

  // Context in use: Claude Code's own figure when it is idle, else the last reply's prompt + output.
  async stats() {
    const window = this.config.model?.contextWindow ?? this.lastContext?.contextWindow ?? null;
    if (this.child && !this.streaming) {
      const usage = await this.control({ subtype: 'get_context_usage' }, { timeout: 3000 }).catch(() => null);
      if (Number.isFinite(usage?.totalTokens) && Number.isFinite(usage?.maxTokens) && usage.maxTokens > 0) {
        this.lastContext = { tokens: usage.totalTokens, contextWindow: usage.maxTokens };
        return { contextUsage: { tokens: usage.totalTokens, contextWindow: usage.maxTokens, percent: usage.totalTokens * 100 / usage.maxTokens } };
      }
    }
    const ctx = this.lastContext;
    if (!ctx) return { contextUsage: window ? { tokens: null, contextWindow: window, percent: null } : null };
    const max = ctx.contextWindow ?? window;
    return { contextUsage: { tokens: ctx.tokens, contextWindow: max, percent: max ? ctx.tokens * 100 / max : null } };
  }

  // Provider, model, effort and Ultracode for this conversation. Model, effort and Ultracode reach a
  // running Claude Code at once; another endpoint or key needs a new process (resumed, history kept).
  async configure(patch = {}) {
    const before = this.config;
    const next = { ...before };
    if (patch.provider) next.provider = patch.provider;
    if (patch.model) next.model = { ...patch.model };
    if (Object.hasOwn(patch, 'effort')) next.effort = patch.effort ?? null;
    if (Object.hasOwn(patch, 'ultracode')) next.ultracode = !!patch.ultracode;
    if (Object.hasOwn(patch, 'fast')) next.fast = !!patch.fast;
    if (Object.hasOwn(patch, 'permissionMode')) next.permissionMode = patch.permissionMode ?? null;
    this.config = next;
    const notices = [];
    if (this.child && this.#processKey(next) !== this.childKey) {
      if (!this.streaming) this.#stopChild();
      else this.restartWhenIdle = true;
      return { restarted: !this.streaming, notices };
    }
    if (this.child) {
      const settings = {};
      if (next.model?.id && next.model.id !== before.model?.id) settings.model = next.model.id;
      if (next.effort && next.effort !== before.effort) settings.effortLevel = next.effort;
      if (next.ultracode !== before.ultracode) settings.ultracode = next.ultracode;
      if (next.fast !== before.fast) settings.fastMode = next.fast;
      if (Object.keys(settings).length) {
        const result = await this.control({ subtype: 'apply_flag_settings', settings }).catch(error => ({ error: error.message }));
        if (result?.error) {
          notices.push(result.error);
          // Ultracode needs a model and endpoint that support it: say so, and keep the switch off.
          if (Object.hasOwn(settings, 'ultracode') && next.ultracode) this.config = { ...this.config, ultracode: false };
          this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', notifyType: 'warning', message: `Claude Code: ${result.error.replace(/^apply_flag_settings:\s*/, '')}` });
        }
      }
      if (next.permissionMode && next.permissionMode !== before.permissionMode) await this.control({ subtype: 'set_permission_mode', mode: next.permissionMode }).catch(() => {});
    }
    return { restarted: false, notices, ultracode: this.config.ultracode };
  }
  #processKey(config) { const p = config.provider ?? {}; return JSON.stringify([p.id, p.apiKey, p.baseUrl, p.headers ?? null, p.id !== 'anthropic' ? config.model?.id : null]); }

  // ---------------------------------------------------------------- Claude Code process
  #args() {
    const c = this.config;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--forward-subagent-text'];
    if (c.model?.id) args.push('--model', c.model.id);
    if (c.effort) args.push('--effort', c.effort);
    if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
    const settings = {};
    if (c.ultracode) settings.ultracode = true;
    if (c.fast) settings.fastMode = true;
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
    const resume = this.resume ?? (this.transcript ? this.transcript.claudePosition() : null);
    if (resume?.sessionId) {
      args.push('--resume', resume.sessionId);
      if (resume.fork) args.push('--fork-session');
      if (resume.at) args.push('--resume-session-at', resume.at);
    }
    return args;
  }

  async #startChild() {
    if (this.child) return this.childReady;
    if (!this.bin) throw new Error('Claude Code is not installed for this conversation.');
    if (!this.config.provider?.apiKey) throw new Error('Choose a model with an API key in Settings → Models for Claude Code.');
    const env = claudeEnv(this.baseEnv, { configDir: this.configDir, provider: this.config.provider, model: this.config.model, extra: this.extraEnv });
    mkdirSync(this.configDir, { recursive: true });
    const args = this.#args();
    const child = this.spawnImpl(this.bin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.childKey = this.#processKey(this.config);
    this.resume = null;
    this.uuids.clear();
    this.recorded.clear();
    let stderr = '';
    let buffer = '';
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        try { this.#onClaude(record); } catch (error) { process.stderr.write(`pidesk-claude: ${error.stack ?? error}\n`); }
      }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => {});
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.once('error', error => { stderr += `\n${error.message}`; });
    exited.then(({ code, signal }) => {
      if (this.child !== child) return;
      this.child = null;
      this.childReady = null;
      for (const pending of this.controls.values()) pending.reject(new Error('Claude Code exited'));
      this.controls.clear();
      if (this.streaming) {
        const detail = stderr.split('\n').filter(l => l.trim() && !/unrecognized_model/.test(l)).slice(-3).join(' ').trim();
        this.#failTurn(`Claude Code exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`);
      }
    });
    this.childReady = (async () => {
      const init = await this.control({ subtype: 'initialize', hooks: null }, { timeout: 120000 });
      this.commandList = (init?.commands ?? []).filter(c => c?.name && !c.name.startsWith('__'));
      this.models = init?.models ?? [];
      this.account = init?.account ?? null;
      this.version = init?.claude_code_version ?? null;
      // Pi Desktop must never run on the machine's Claude subscription: only the key from Settings.
      if (this.account && this.account.tokenSource && this.account.tokenSource !== 'none' && this.account.apiKeySource !== 'ANTHROPIC_API_KEY') {
        throw new Error('Claude Code did not use the API key from Settings → Models.');
      }
      return init;
    })();
    this.childReady.catch(() => { if (this.child === child) this.#stopChild(); });
    return this.childReady;
  }
  #stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.childReady = null;
    try { child.stdin.end(); } catch { /* already closed */ }
    const kill = setTimeout(() => child.kill('SIGTERM'), 3000);
    child.once('close', () => clearTimeout(kill));
  }
  #send(record) { this.child?.stdin.write(JSON.stringify(record) + '\n'); }
  control(request, { timeout = 30000 } = {}) {
    if (!this.child) return Promise.reject(new Error('Claude Code is not running'));
    const request_id = `pidesk-${++this.controlSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(request_id); reject(new Error(`Claude Code did not answer ${request.subtype}`)); }, timeout);
      this.controls.set(request_id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.#send({ type: 'control_request', request_id, request });
    });
  }

  // ---------------------------------------------------------------- prompts
  async prompt(message, images = []) {
    // Pi Desktop's own commands for Pi processes have no meaning here.
    if (/^\/(pidesk-|goal$)/.test(message.trim())) return { ignored: true };
    const transcript = this.#ensureTranscript();
    if (this.restartWhenIdle && !this.streaming) { this.restartWhenIdle = false; this.#stopChild(); }
    await this.#startChild();
    const content = [];
    for (const image of images) if (image?.data) content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType ?? 'image/png', data: image.data } });
    if (message) content.push({ type: 'text', text: message });
    const busy = this.streaming;
    const timestamp = this.now();
    const piMessage = { role: 'user', content: [...images.filter(i => i?.data).map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType ?? 'image/png' })), ...(message ? [{ type: 'text', text: message }] : [])], timestamp };
    transcript.append({ type: 'message', message: piMessage });
    if (!busy) { this.streaming = true; this.turnError = null; this.interrupting = false; this.emit({ type: 'agent_start' }); }
    // Output of Claude Code's own slash commands (/context, /cost …) is shown only when the user ran one.
    if (message.trim().startsWith('/')) this.slashCommand = true;
    this.emit({ type: 'message_start', message: piMessage });
    this.emit({ type: 'message_end', message: piMessage });
    this.queued += 1;
    this.#send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.claudeSessionId ?? 'default' });
    return { disposition: busy ? 'steered' : 'started' };
  }

  async abort() {
    if (!this.streaming || !this.child) return {};
    this.interrupting = true;
    await this.control({ subtype: 'interrupt' }, { timeout: 8000 }).catch(() => {});
    return {};
  }

  async compact() {
    if (this.streaming) throw new Error('Wait for the current reply to finish, then compact.');
    await this.#startChild();
    this.compacting = true;
    this.emit({ type: 'compaction_start', reason: 'manual' });
    const done = new Promise(resolve => { this.compactDone = resolve; });
    this.streaming = true;
    this.#send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] }, parent_tool_use_id: null, session_id: this.claudeSessionId ?? 'default' });
    return done;
  }

  clone() {
    const source = this.#ensureTranscript();
    const position = source.claudePosition();
    this.#stopChild();
    this.transcript = source.copyBranch(this.sessionsDir);
    this.claudeSessionId = null;
    if (position?.sessionId) this.resume = { sessionId: position.sessionId, fork: true };
    return { cancelled: false };
  }

  switchSession(path) {
    if (this.streaming) throw new Error('Wait for the current reply to finish.');
    this.#stopChild();
    this.transcript = new Transcript(path);
    this.claudeSessionId = null;
    return { cancelled: false };
  }

  // Edit an earlier message: a new session file with the branch before it, and a Claude Code fork that
  // resumes at the last message before it.
  forkAt(entryId) {
    const source = this.#ensureTranscript();
    const target = source.byId.get(entryId);
    if (!target) throw new Error('That message can no longer be edited.');
    this.#stopChild();
    const leaf = target.parentId;
    const position = leaf ? source.claudePosition(leaf) : null;
    this.transcript = leaf ? source.copyBranch(this.sessionsDir, leaf) : Transcript.create(this.sessionsDir, source.header?.cwd ?? this.cwd, { parentSession: source.file });
    this.resume = position?.sessionId ? { sessionId: position.sessionId, fork: true, ...(position.uuid ? { at: position.uuid } : {}) } : { sessionId: null };
    this.claudeSessionId = null;
    return { cancelled: false };
  }

  // ---------------------------------------------------------------- Claude Code → Pi
  #provider() { return this.config.model?.provider ?? this.config.provider?.id ?? 'anthropic'; }

  #onClaude(record) {
    switch (record.type) {
      case 'control_response': {
        const response = record.response ?? {};
        const pending = this.controls.get(response.request_id);
        if (!pending) return;
        this.controls.delete(response.request_id);
        if (response.subtype === 'error') pending.reject(new Error(response.error ?? 'Claude Code refused the request'));
        else pending.resolve(response.response ?? {});
        return;
      }
      case 'control_request': return this.#onControlRequest(record);
      case 'control_cancel_request': { this.ui.get(record.request_id)?.({ cancelled: true }); return; }
      case 'system': return this.#onSystem(record);
      case 'stream_event': if (!record.parent_tool_use_id) this.#onStream(record.event ?? {}); return;
      case 'assistant': return this.#onAssistant(record);
      case 'user': return this.#onUser(record);
      case 'result': return this.#onResult(record);
      default: return;
    }
  }

  #onSystem(record) {
    if (record.session_id) this.claudeSessionId = record.session_id;
    switch (record.subtype) {
      case 'init':
        if (Array.isArray(record.slash_commands) && !this.commandList.length) this.commandList = record.slash_commands.filter(n => !n.startsWith('__')).map(name => ({ name }));
        return;
      case 'status':
        if (record.status === 'requesting') { this.requestStart = this.now(); clearTimeout(this.continueTimer); }
        if (record.status === 'compacting' && !this.compacting) { this.compacting = true; this.emit({ type: 'compaction_start', reason: 'auto' }); }
        return;
      case 'compact_boundary':
        this.compactMeta = record.compact_metadata ?? {};
        return;
      case 'api_retry':
        this.emit({ type: 'auto_retry_start', attempt: record.attempt ?? 1, maxAttempts: record.max_retries ?? record.maxAttempts ?? 10, delayMs: record.retry_delay_ms ?? record.delayMs ?? 0, errorMessage: record.error ?? '' });
        return;
      case 'session_title_changed':
        if (record.title) this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'pidesk-title', statusText: record.title });
        return;
      default:
        // Claude Code's own state (background tasks, agents, hooks) for the desktop to show if it wants.
        this.emit({ type: 'claude_event', subtype: record.subtype, data: record });
    }
  }

  #onStream(event) {
    const now = this.now();
    switch (event.type) {
      case 'message_start': {
        if (this.live) this.#finishLive('aborted');
        const m = event.message ?? {};
        this.emit({ type: 'auto_retry_end' });
        this.live = { id: m.id, model: m.model, usage: { ...(m.usage ?? {}) }, blocks: [], start: now, requestStart: this.requestStart ?? now, first: null, stopReason: null };
        this.requestStart = null;
        this.emit({ type: 'message_start', message: { role: 'assistant', content: [], api: 'anthropic-messages', provider: this.#provider(), model: m.model ?? this.config.model?.id, timestamp: this.live.requestStart } });
        return;
      }
      case 'content_block_start': {
        const live = this.live; if (!live) return;
        const b = event.content_block ?? {};
        const i = event.index ?? live.blocks.length;
        if (b.type === 'text') { live.blocks[i] = { type: 'text', text: b.text ?? '' }; this.#update({ type: 'text_start', contentIndex: i }); }
        else if (b.type === 'thinking') { live.blocks[i] = { type: 'thinking', thinking: b.thinking ?? '', signature: '' }; this.#update({ type: 'thinking_start', contentIndex: i }); }
        else if (b.type === 'redacted_thinking') { live.blocks[i] = { type: 'thinking', thinking: '', redacted: true }; }
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          live.blocks[i] = { type: 'tool_use', id: b.id, name: b.name, json: '', server: b.type === 'server_tool_use' };
          this.#update({ type: 'toolcall_start', contentIndex: i, id: b.id, toolName: CC_TOOL_NAMES[b.name] ?? b.name });
        } else live.blocks[i] = { type: 'other', raw: b };
        return;
      }
      case 'content_block_delta': {
        const live = this.live; if (!live) return;
        const i = event.index; const b = live.blocks[i]; const d = event.delta ?? {};
        if (!b) return;
        live.first ??= now;
        if (d.type === 'text_delta' && b.type === 'text') { b.text += d.text ?? ''; this.#update({ type: 'text_delta', contentIndex: i, delta: d.text ?? '' }); }
        else if (d.type === 'thinking_delta' && b.type === 'thinking') { b.thinking += d.thinking ?? ''; this.#update({ type: 'thinking_delta', contentIndex: i, delta: d.thinking ?? '' }); }
        else if (d.type === 'signature_delta' && b.type === 'thinking') b.signature += d.signature ?? '';
        else if (d.type === 'input_json_delta' && b.type === 'tool_use') { b.json += d.partial_json ?? ''; this.#update({ type: 'toolcall_delta', contentIndex: i, delta: d.partial_json ?? '' }); }
        return;
      }
      case 'content_block_stop': {
        const live = this.live; if (!live) return;
        const i = event.index; const b = live.blocks[i];
        if (!b) return;
        if (b.type === 'text') this.#update({ type: 'text_end', contentIndex: i, content: b.text });
        else if (b.type === 'thinking' && !b.redacted) this.#update({ type: 'thinking_end', contentIndex: i, content: b.thinking });
        else if (b.type === 'tool_use') {
          let input = {};
          try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = {}; }
          b.input = input;
          this.#update({ type: 'toolcall_end', contentIndex: i, toolCall: normalizeToolCall(b.id, b.name, input) });
        }
        return;
      }
      case 'message_delta': {
        const live = this.live; if (!live) return;
        if (event.delta?.stop_reason) live.stopReason = event.delta.stop_reason;
        Object.assign(live.usage, Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, v]) => v != null)));
        return;
      }
      case 'message_stop': this.#finishLive(); return;
    }
  }
  #update(assistantMessageEvent) { this.emit({ type: 'message_update', assistantMessageEvent }); }

  #content(blocks) {
    const content = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') { if (b.text) content.push({ type: 'text', text: b.text }); }
      else if (b.type === 'thinking') content.push(b.redacted ? { type: 'thinking', thinking: '', redacted: true } : { type: 'thinking', thinking: b.thinking, ...(b.signature ? { thinkingSignature: b.signature } : {}) });
      else if (b.type === 'tool_use') content.push(normalizeToolCall(b.id, b.name, b.input ?? (() => { try { return JSON.parse(b.json || '{}'); } catch { return {}; } })()));
    }
    return content;
  }

  #finishLive(forcedStop) {
    const live = this.live;
    if (!live) return;
    this.live = null;
    const end = this.now();
    const synthetic = live.model === '<synthetic>';
    const usage = piUsage(synthetic ? {} : live.usage, this.config.model?.cost);
    const stopReason = forcedStop ?? STOP[live.stopReason] ?? (live.stopReason ? 'stop' : 'aborted');
    const message = {
      role: 'assistant', content: this.#content(live.blocks), api: 'anthropic-messages', provider: this.#provider(), model: synthetic ? this.config.model?.id : live.model ?? this.config.model?.id,
      responseId: live.id, usage, stopReason, timestamp: live.requestStart,
      ...(synthetic ? { __localCommand: true } : { __timing: { source: 'agent', complete: stopReason !== 'aborted', requestStart: live.requestStart, start: live.start, first: live.first, end } }),
    };
    this.lastContext = synthetic ? this.lastContext : { tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output };
    const entry = this.#record(message, { uuid: this.uuids.get(live.id) ?? null });
    if (live.id) this.recorded.set(live.id, entry);
    this.emit({ type: 'message_end', message });
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      // Server tools (web search run by the API) have no client-side result.
      if (live.blocks.find(b => b?.id === block.id)?.server) continue;
      this.pendingTools.set(block.id, { name: block.name, ccName: block.ccName ?? block.name, startedAt: end, steps: [], usage: null });
      this.emit({ type: 'tool_execution_start', toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
  }

  #record(message, cc = {}) {
    const transcript = this.#ensureTranscript();
    const entry = transcript.append({ type: 'message', message, cc: { sessionId: this.claudeSessionId, ...(cc.uuid ? { uuid: cc.uuid } : {}) } });
    return entry;
  }

  #onAssistant(record) {
    const m = record.message ?? {};
    if (record.parent_tool_use_id) return this.#agentStep(record.parent_tool_use_id, m);
    if (record.uuid && m.id) {
      this.uuids.set(m.id, record.uuid);
      // The uuid can arrive after the stream finished: keep the stored entry resumable at it.
      const entry = this.recorded.get(m.id);
      if (entry && entry.cc && entry.cc.uuid !== record.uuid) { entry.cc.uuid = record.uuid; this.transcript.append({ type: 'claude_position', cc: { sessionId: this.claudeSessionId, uuid: record.uuid } }); }
    }
    // API errors are reported as synthetic assistant messages without a stream.
    if (record.isApiErrorMessage || record.error) {
      const text = blockText(m.content) || String(record.error ?? 'Claude Code request failed');
      this.#errorMessage(text);
      return;
    }
    // Without partial messages (should not happen) the whole message arrives here.
    if (m.id && !this.live && !this.recorded.has(m.id) && Array.isArray(m.content) && m.content.length) {
      this.live = { id: m.id, model: m.model, usage: { ...(m.usage ?? {}) }, blocks: m.content.map(b => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking ?? '' } : b.type === 'text' ? { type: 'text', text: b.text ?? '' } : null), start: this.now(), requestStart: this.requestStart ?? this.now(), stopReason: m.stop_reason ?? 'end_turn' };
      this.emit({ type: 'message_start', message: { role: 'assistant', content: [], api: 'anthropic-messages', provider: this.#provider(), model: m.model, timestamp: this.live.requestStart } });
      this.#finishLive();
    }
  }

  #errorMessage(text) {
    const timestamp = this.now();
    const message = { role: 'assistant', content: [], api: 'anthropic-messages', provider: this.#provider(), model: this.config.model?.id, stopReason: 'error', errorMessage: text, timestamp, usage: piUsage({}) };
    this.turnError = text;
    this.#record(message);
    this.emit({ type: 'message_start', message: { ...message, stopReason: 'pending' } });
    this.emit({ type: 'message_end', message });
  }

  #onUser(record) {
    const m = record.message ?? {};
    if (record.parent_tool_use_id) {
      const parent = this.pendingTools.get(record.parent_tool_use_id);
      if (parent && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_result') parent.steps.push({ type: 'result', toolUseId: b.tool_use_id, isError: !!b.is_error });
      return;
    }
    if (Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result')) {
      for (const block of m.content) if (block?.type === 'tool_result') this.#toolResult(block, record);
      return;
    }
    const text = typeof m.content === 'string' ? m.content : blockText(m.content);
    // The summary a compaction leaves for the model.
    if (record.isCompactSummary || /^This session is being continued from a previous conversation/.test(text)) {
      this.compactSummary = text;
      return;
    }
    // Output of Claude Code's local slash commands (/context, /cost, /mcp …): shown as a reply when the
    // user ran one, never for the settings this adapter applies itself (model, effort).
    const local = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
    if (local) {
      const out = local[1].trim();
      if (out && this.slashCommand && !this.compacting && !/^Compacted\b/.test(out)) {
        const message = { role: 'assistant', content: [{ type: 'text', text: out }], api: 'anthropic-messages', provider: this.#provider(), model: this.config.model?.id, stopReason: 'stop', timestamp: this.now(), __localCommand: true };
        this.#record(message, { uuid: record.uuid });
        this.emit({ type: 'message_start', message: { ...message, content: [] } });
        this.emit({ type: 'message_end', message });
      }
      return;
    }
    // A prompt we sent, taken up by Claude Code.
    if (record.isReplay) { this.queued = Math.max(0, this.queued - 1); clearTimeout(this.continueTimer); }
  }

  #toolResult(block, record) {
    const pending = this.pendingTools.get(block.tool_use_id);
    this.pendingTools.delete(block.tool_use_id);
    const now = this.now();
    const toolName = pending?.name ?? 'tool';
    const content = toolResultContent(block.content);
    const structured = record.tool_use_result;
    const details = { engine: 'claude-code', ...(pending?.ccName ? { ccTool: pending.ccName } : {}), ...(structured && typeof structured === 'object' ? { claude: structured } : {}) };
    if (pending?.steps?.length || pending?.agentUsage) {
      details.kind = 'claude-code-agent';
      details.steps = pending.steps.slice(-200);
      if (pending.agentUsage) {
        const usage = piUsage(pending.agentUsage, this.config.model?.cost);
        details.agentRuns = [{ key: `claude-agent:${block.tool_use_id}`, at: pending.startedAt, provider: this.#provider(), model: this.config.model?.id, usage, turns: pending.agentTurns ?? 1 }];
      }
    }
    const isError = !!block.is_error;
    const message = { role: 'toolResult', toolCallId: block.tool_use_id, toolName, content, details, isError, timestamp: now };
    this.emit({ type: 'tool_execution_end', toolCallId: block.tool_use_id, toolName, result: { content, details }, isError, durationMs: pending ? now - pending.startedAt : undefined });
    this.#record(message, { uuid: record.uuid });
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
  }

  // Claude Code's own agents (Task): their steps fold into the Task call's live result.
  #agentStep(parentId, m) {
    const parent = this.pendingTools.get(parentId);
    if (!parent) return;
    if (m.usage) {
      parent.agentUsage ??= {};
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) parent.agentUsage[k] = (parent.agentUsage[k] ?? 0) + (m.usage[k] ?? 0);
      parent.agentTurns = (parent.agentTurns ?? 0) + 1;
    }
    for (const b of m.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) parent.steps.push({ type: 'text', text: b.text.slice(0, 2000) });
      else if (b?.type === 'tool_use') { const call = normalizeToolCall(b.id, b.name, b.input); parent.steps.push({ type: 'tool', id: b.id, name: call.name, arguments: call.arguments }); }
    }
    const last = parent.steps.at(-1);
    const summary = last?.type === 'tool' ? `${last.name} ${JSON.stringify(last.arguments ?? {}).slice(0, 200)}` : last?.text?.split('\n')[0] ?? '';
    this.emit({ type: 'tool_execution_update', toolCallId: parentId, toolName: parent.name, args: {}, partialResult: { content: [{ type: 'text', text: summary }], details: { kind: 'claude-code-agent', engine: 'claude-code', steps: parent.steps.slice(-50) } } });
  }

  #onResult(record) {
    if (record.session_id) this.claudeSessionId = record.session_id;
    if (this.live) this.#finishLive('aborted');
    const window = Object.values(record.modelUsage ?? {})[0]?.contextWindow;
    if (window && this.lastContext) this.lastContext.contextWindow = window;
    if (this.compacting) {
      this.compacting = false;
      const transcript = this.#ensureTranscript();
      const meta = this.compactMeta ?? {};
      transcript.append({ type: 'compaction', summary: this.compactSummary ?? 'Conversation compacted by Claude Code.', tokensBefore: meta.pre_tokens ?? null, cc: { sessionId: this.claudeSessionId } });
      this.compactSummary = null; this.compactMeta = null;
      this.lastContext = meta.post_tokens ? { tokens: meta.post_tokens } : null;
      this.emit({ type: 'compaction_end', reason: 'manual', aborted: false });
      this.compactDone?.({ compacted: true }); this.compactDone = null;
    }
    // A failed turn that produced no visible error (e.g. a refused key) still says why. A Stop is not a failure.
    if (record.is_error && !this.turnError && !this.interrupting && record.subtype !== 'error_during_execution') {
      const text = typeof record.result === 'string' && record.result.trim() ? record.result.trim() : (record.errors ?? []).join('\n') || `Claude Code stopped (${record.subtype ?? 'error'})`;
      this.#errorMessage(text);
    }
    for (const [id, pending] of this.pendingTools) {
      this.emit({ type: 'tool_execution_end', toolCallId: id, toolName: pending.name, result: { content: [{ type: 'text', text: 'Interrupted' }], details: { engine: 'claude-code' } }, isError: true });
    }
    this.pendingTools.clear();
    // Messages sent while it worked and not yet taken up start another turn of the same run. If none
    // starts shortly (a message Claude Code merged into the last turn), the run is over.
    if (this.queued > 0) {
      clearTimeout(this.continueTimer);
      this.continueTimer = setTimeout(() => { this.queued = 0; this.#settle(); }, 1500);
      this.continueTimer.unref?.();
      return;
    }
    this.#settle();
  }

  #failTurn(text) {
    if (this.live) this.#finishLive('aborted');
    this.#errorMessage(text);
    for (const [id, pending] of this.pendingTools) this.emit({ type: 'tool_execution_end', toolCallId: id, toolName: pending.name, result: { content: [{ type: 'text', text }] }, isError: true });
    this.pendingTools.clear();
    if (this.compacting) { this.compacting = false; this.emit({ type: 'compaction_end', reason: 'manual', aborted: true }); this.compactDone?.({ compacted: false }); this.compactDone = null; }
    this.queued = 0;
    this.#settle();
  }

  #settle() {
    clearTimeout(this.continueTimer);
    if (!this.streaming) return;
    this.streaming = false;
    this.slashCommand = false;
    this.interrupting = false;
    this.emit({ type: 'agent_end' });
    this.emit({ type: 'agent_settled' });
    if (this.restartWhenIdle) { this.restartWhenIdle = false; this.#stopChild(); }
  }

  // ---------------------------------------------------------------- permission prompts
  async #onControlRequest(record) {
    const req = record.request ?? {};
    const reply = response => this.#send({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response } });
    const fail = error => this.#send({ type: 'control_response', response: { subtype: 'error', request_id: record.request_id, error } });
    if (req.subtype !== 'can_use_tool') { fail(`Pi Desktop does not handle ${req.subtype}`); return; }
    const input = req.input ?? {};
    try {
      if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        const answers = {};
        for (const q of input.questions) {
          const options = (q.options ?? []).map(o => o.label);
          const answer = await this.#ask(record.request_id, options.length
            ? { method: 'select', title: q.question ?? q.header ?? 'Question', options: q.multiSelect ? options : [...options] }
            : { method: 'input', title: q.question ?? 'Question', placeholder: '' });
          if (answer.cancelled) { reply({ behavior: 'deny', message: 'The user dismissed the question.' }); return; }
          answers[q.question] = answer.value;
        }
        reply({ behavior: 'allow', updatedInput: { ...input, answers } });
        return;
      }
      if (req.tool_name === 'ExitPlanMode') {
        const answer = await this.#ask(record.request_id, { method: 'confirm', title: 'Approve the plan?', message: String(input.plan ?? '').slice(0, 20000) });
        if (answer.confirmed) reply({ behavior: 'allow', updatedInput: input });
        else reply({ behavior: 'deny', message: answer.cancelled ? 'The user dismissed the plan.' : 'The user did not approve the plan. Ask what to change.' });
        return;
      }
      // Pi Desktop runs tools without approval prompts.
      reply({ behavior: 'allow', updatedInput: input });
    } catch (error) { fail(error.message); }
  }
  #ask(requestId, dialog) {
    const id = `cc-${requestId}`;
    return new Promise(resolve => {
      this.ui.set(id, resolve);
      this.ui.set(requestId, resolve);
      this.emit({ type: 'extension_ui_request', id, ...dialog });
    });
  }
}

// ------------------------------------------------------------------ process entry
let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain) {
  let boot = {};
  try { boot = JSON.parse(process.env.PIDESK_BOOT ?? '{}'); } catch { boot = {}; }
  delete process.env.PIDESK_BOOT;
  const write = record => { process.stdout.write(JSON.stringify(record) + '\n'); };
  const adapter = new ClaudeAdapter({ boot, write });
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      adapter.handle(request);
    }
  });
  process.stdin.on('end', () => {
    // The relay closes stdin to stop the conversation: end Claude Code too.
    adapter.child?.stdin.end();
    setTimeout(() => process.exit(0), 3000).unref();
    adapter.child?.once('close', () => process.exit(0));
    if (!adapter.child) process.exit(0);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { adapter.child?.kill('SIGTERM'); process.exit(0); });
}
