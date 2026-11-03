// Official Cursor ACP (JSON-RPC over stdio). No private HTTP protocol or API shim.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

export function cursorCommand(value = '~/.local/bin/cursor-agent', home = homedir()) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error('Enter a Cursor CLI executable path');
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
}
export async function validateCursorCommand(command, { path = process.env.PATH ?? '', cwd = process.cwd() } = {}) {
  const candidates = command.includes('/') ? [isAbsolute(command) ? command : resolve(cwd, command)] : path.split(':').filter(Boolean).slice(0, 100).map(dir => resolve(cwd, dir, command));
  let resolved;
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); resolved = await realpath(candidate); break; } catch { /* next PATH entry */ }
  }
  if (!resolved) throw new Error('Cursor CLI was not found. Use automatic Cursor SDK setup in Settings. No API key was passed to a program.');
  try {
    const dir = dirname(resolved);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (!['cursor-agent', 'cursor-agent-sea'].includes(basename(resolved)) || pkg.name !== '@anysphere/agent-cli-runtime') throw new Error('wrong program');
    for (const name of ['node', 'index.js']) if (!(await stat(join(dir, name))).isFile()) throw new Error('incomplete runtime');
    return resolved;
  } catch {
    throw new Error(`Not a verified Cursor CLI: ${command} resolves to ${resolved}. No API key was passed to this program. Use automatic Cursor SDK setup instead of a generic agent/Grok command.`);
  }
}

// A host that reaches the internet only through a proxy (typical on company networks) needs its proxy
// and CA settings, as any program run there would; without them Cursor hangs connecting.
const NETWORK_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
export function cursorEnvironment(source = process.env, apiKey) {
  // In particular never forward Pi provider keys, PIDESK_BOOT or ELECTRON_RUN_AS_NODE.
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', ...NETWORK_ENV];
  const env = Object.fromEntries(keep.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  env.NO_OPEN_BROWSER = '1';
  if (['memory', 'file'].includes(source.AGENT_CLI_CREDENTIAL_STORE)) env.AGENT_CLI_CREDENTIAL_STORE = source.AGENT_CLI_CREDENTIAL_STORE;
  if (apiKey) { env.CURSOR_API_KEY = apiKey; delete env.CURSOR_AUTH_TOKEN; }
  // Cursor otherwise probes the macOS login keychain even over SSH. Supplied
  // credentials are already encrypted by the desktop: keep CLI auth ephemeral.
  if (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  return env;
}
export const cursorConfigOptions = result => (result?.configOptions ?? []).filter(option => option && typeof option.id === 'string' && (option.type === 'select' || option.type === 'boolean'));
export const cursorSelectValues = option => (option?.options ?? []).flatMap(value => value.options ?? [value]);
export const cursorModelConfig = result => cursorConfigOptions(result).find(option => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
export const cursorCurrentModel = result => cursorModelConfig(result)?.currentValue ?? result?.models?.currentModelId;
// Desktop conversations always run in Cursor's Agent mode; Ask/Plan are not offered.
export const cursorModeOption = options => (options ?? []).find(option => option.category === 'mode' || option.id === 'mode');
// Cursor can split reasoning into a thinking switch and a level (Claude: thinking on/off plus
// reasoning_effort). The desktop offers one Pi-style effort instead: Off (when there is a switch),
// then the levels. Its id is the desktop's own; the adapter maps a choice to Cursor's options.
export const CURSOR_EFFORT_ID = 'pidesk-effort';
const isSwitch = option => option.type === 'boolean' || cursorSelectValues(option).map(value => value.value).sort().join() === 'false,true';
const switchedOn = option => String(option.currentValue) === 'true';
function effortParts(options) {
  const thoughts = (options ?? []).filter(option => option.category === 'thought_level' && (option.type === 'select' || option.type === 'boolean'));
  return { toggle: thoughts.find(isSwitch) ?? null, level: thoughts.find(option => option.type === 'select' && !isSwitch(option)) ?? null };
}
export function cursorThoughtOption(options) {
  const { toggle, level } = effortParts(options);
  if (!toggle && !level) return null;
  const levels = level ? cursorSelectValues(level).map(value => ({ value: value.value, name: value.name || value.value })) : [{ value: 'on', name: 'On' }];
  return {
    id: CURSOR_EFFORT_ID, name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: toggle && !switchedOn(toggle) ? 'off' : level ? level.currentValue : 'on',
    options: [...(toggle ? [{ value: 'off', name: 'Off' }] : []), ...levels],
  };
}
// The next Cursor option change towards effort `value` ([] when it is selected, null when the model
// lacks it). Applied one at a time: turning thinking on can reveal the level option.
export function cursorEffortChange(options, value) {
  const effort = cursorThoughtOption(options);
  if (!effort?.options.some(option => option.value === value)) return null;
  const { toggle, level } = effortParts(options);
  const turn = on => [toggle.id, toggle.type === 'boolean' ? on : String(on)];
  if (value === 'off') return switchedOn(toggle) ? turn(false) : [];
  if (toggle && !switchedOn(toggle)) return turn(true);
  return level && value !== 'on' && level.currentValue !== value ? [level.id, value] : [];
}
// The per-model settings the desktop shows: one reasoning effort and Cursor's other model parameters.
export const cursorModelSettings = options => {
  const effort = cursorThoughtOption(options);
  return [...(options ?? []).filter(option => option.category !== 'mode' && option.id !== 'mode' && option.category !== 'model' && option.id !== 'model' && option.category !== 'thought_level'), ...(effort ? [effort] : [])];
};
// `listed`: Cursor's cursor/list_available_models result, which carries each model's own parameters
// and defaults, so a new conversation can offer the right efforts before its session exists.
export function cursorModels(result, capabilities = {}, listed = null) {
  const config = cursorModelConfig(result);
  const options = config ? cursorSelectValues(config).map(option => ({ modelId: option.value, name: option.name })) : result?.models?.availableModels ?? [];
  const current = cursorCurrentModel(result);
  const perModel = new Map((Array.isArray(listed?.models) ? listed.models : []).filter(model => typeof model?.value === 'string').map(model => [model.value, cursorModelSettings(cursorConfigOptions(model))]));
  return options.map(m => {
    const settings = perModel.get(m.modelId) ?? (m.modelId === current ? cursorModelSettings(cursorConfigOptions(result)) : null);
    return { provider: 'cursor', id: m.modelId, name: m.name || m.modelId, reasoning: !!cursorThoughtOption(settings), ...(settings ? { configOptions: settings } : {}), input: capabilities.promptCapabilities?.image ? ['text', 'image'] : ['text'] };
  }).filter(m => typeof m.id === 'string' && m.id);
}
// cursor/list_available_models alone (a pre-started CLI has no session yet): each model's settings.
export const cursorListedModels = listed => (Array.isArray(listed?.models) ? listed.models : [])
  .filter(model => typeof model?.value === 'string' && model.value)
  .map(model => ({ id: model.value, name: model.name || model.value, configOptions: cursorModelSettings(cursorConfigOptions(model)) }));
// Cursor's ACP reports no context usage: no usage_update, nothing in the prompt result. A rough
// figure for what the conversation itself contributes: ~4 characters per token for ASCII text and
// ~1 token per CJK character.
export function estimateTokens(text) {
  let ascii = 0, wide = 0, other = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code < 0x80) ascii++;
    else if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) wide++;
    else other++;
  }
  return Math.ceil(ascii / 4 + wide + other / 2);
}

export class CursorAcp extends EventEmitter {
  constructor({ command, cwd, spawnProcess = spawn, env = process.env, apiKey }) {
    super();
    this.command = cursorCommand(command);
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.env = cursorEnvironment(env, apiKey);
    const secrets = [this.env.CURSOR_API_KEY, this.env.CURSOR_AUTH_TOKEN].filter(Boolean);
    this.redact = text => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), String(text));
    this.pending = new Map();
    this.nextId = 0;
    this._stderr = '';
    this.closed = false;
  }
  get stderr() { return this._stderr.slice(-4000); }
  async start() {
    // Identity checks are filesystem-only and happen before ANY key-bearing spawn.
    this.command = await validateCursorCommand(this.command, { path: this.env.PATH, cwd: this.cwd });
    // Official YOLO mode: allow tools without repeated approval, while preserving
    // explicit Cursor deny rules. Applies equally to local and SSH ACP sessions.
    const child = this.child = this.spawnProcess(this.command, ['--disable-auto-update', '--force', 'acp'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 << 20) { this.fail(new Error('Cursor ACP message exceeds 16 MB')); this.close(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error('Invalid JSON from Cursor CLI')); this.close(); return; }
      }
    });
    child.stderr.on('data', chunk => { this._stderr = this.redact(this._stderr + chunk).slice(-32768); });
    child.stdin.on('error', error => this.fail(error));
    child.once('error', error => this.fail(new Error(`Could not start Cursor CLI (${this.command}): ${error.message}. Install Cursor CLI, then enter a Cursor API Key in Settings → Cursor SDK (or use agent login).`)));
    this.exit = new Promise(resolve => child.once('close', (code, signal) => {
      const error = new Error(`Cursor CLI closed (${signal ?? code})${this.stderr ? ': ' + this.stderr : ''}`);
      this.fail(error);
      this.closed = true;
      this.emit('closed', error);
      resolve();
    }));
    // Ask for the official parameterized model picker. Without this meta hint the
    // CLI collapses variants into one long list and needs extra model lookups.
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } }, fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'pi-desktop', version: '0.1' } });
    if (init.protocolVersion !== 1) throw new Error(`Unsupported Cursor ACP protocol: ${init.protocolVersion}`);
    this.capabilities = init.agentCapabilities ?? {};
    // The official CLI marks env API keys/auth tokens and an existing CLI login
    // authenticated at startup. ACP authenticate(cursor_login) instead checks
    // browser-login credentials and can launch a browser even with an API key.
    // Never silently enter that interactive flow from a desktop SDK connection.
    return init;
  }
  send(message) {
    if (this.failure || this.closed) throw this.failure ?? new Error('Cursor CLI is closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  request(method, params, { timeout = 60000 } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cursor CLI timed out during ${method}`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ method, params }); }
  respond(id, result) { if (!this.failure && !this.closed) this.send({ id, result }); }
  reject(id, message = 'Unsupported client request') { if (!this.failure && !this.closed) this.send({ id, error: { code: -32601, message } }); }
  receive(message) {
    if (message.jsonrpc !== '2.0') throw new Error('Invalid RPC envelope');
    if (message.method) {
      if (message.id !== undefined) this.emit('request', message);
      else this.emit('notification', message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(this.rpcError(pending.method, message.error));
      else pending.resolve(message.result);
    }
  }
  rpcError(method, error) {
    const labels = { initialize: 'initialization', authenticate: 'authentication', 'session/new': 'session creation', 'session/load': 'session restore', 'session/set_model': 'model selection', 'session/set_config_option': 'model selection', 'session/prompt': 'prompt', 'cursor/list_available_models': 'model discovery' };
    const summary = error?.message || 'Cursor request failed';
    const detail = typeof error?.data?.message === 'string' ? error.data.message : '';
    const code = Number.isFinite(error?.code) ? error.code : undefined;
    const message = this.redact(`Cursor ${labels[method] ?? method} (${method}${code === undefined ? '' : `, RPC ${code}`}): ${summary}${detail && detail !== summary ? ` — ${detail}` : ''}`);
    return Object.assign(new Error(message.slice(0, 2400)), { method, code });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.rpcError(pending.method, error)); }
    this.pending.clear();
  }
  // `cwd` defaults to the CLI's own directory; a pre-started CLI opens its conversation elsewhere.
  async openSession(sessionId, cwd = this.cwd) {
    if (sessionId && !this.capabilities?.loadSession) throw new Error('This Cursor CLI cannot resume sessions. Update Cursor CLI; the existing history has not been replaced.');
    const result = await this.request(sessionId ? 'session/load' : 'session/new', { ...(sessionId ? { sessionId } : {}), cwd, mcpServers: [] });
    this.sessionId = sessionId || result.sessionId;
    if (!this.sessionId) throw new Error('Cursor CLI did not return a session ID');
    return result;
  }
  async close() {
    if (!this.child || this.closed) return;
    this.fail(new Error('Cursor connection closed'));
    this.child.stdin.end();
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') this.child.kill(signal); }
    };
    // The separate process group also contains tools spawned by an unresponsive CLI.
    kill('SIGTERM');
    const timer = setTimeout(() => {
      kill('SIGKILL');
      // A detached helper or SSH control master may retain inherited pipe handles
      // after the direct child exits. Do not wait forever for those pipes to drain.
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 2000);
    try { await this.exit; } finally { clearTimeout(timer); }
  }
}
