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

export function cursorEnvironment(source = process.env, apiKey) {
  // In particular never forward Pi provider keys, PIDESK_BOOT or ELECTRON_RUN_AS_NODE.
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'];
  const env = Object.fromEntries(keep.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  env.NO_OPEN_BROWSER = '1';
  if (['memory', 'file'].includes(source.AGENT_CLI_CREDENTIAL_STORE)) env.AGENT_CLI_CREDENTIAL_STORE = source.AGENT_CLI_CREDENTIAL_STORE;
  if (apiKey) { env.CURSOR_API_KEY = apiKey; delete env.CURSOR_AUTH_TOKEN; }
  // Cursor otherwise probes the macOS login keychain even over SSH. Supplied
  // credentials are already encrypted by the desktop: keep CLI auth ephemeral.
  if (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) env.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  return env;
}
export const cursorModelConfig = result => result?.configOptions?.find(option => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
export const cursorCurrentModel = result => cursorModelConfig(result)?.currentValue ?? result?.models?.currentModelId;
export function cursorModels(result) {
  const config = cursorModelConfig(result);
  const options = config ? (config.options ?? []).flatMap(option => option.options ?? [option]).map(option => ({ modelId: option.value, name: option.name })) : result?.models?.availableModels ?? [];
  return options.map(m => ({ provider: 'cursor', id: m.modelId, name: m.name || m.modelId, reasoning: false, input: ['text', 'image'] })).filter(m => typeof m.id === 'string' && m.id);
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
  async start({ authenticate = true } = {}) {
    // Identity checks are filesystem-only and happen before ANY key-bearing spawn.
    this.command = await validateCursorCommand(this.command, { path: this.env.PATH, cwd: this.cwd });
    const child = this.child = this.spawnProcess(this.command, ['--disable-auto-update', 'acp'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
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
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'pi-desktop', version: '0.1' } });
    if (init.protocolVersion !== 1) throw new Error(`Unsupported Cursor ACP protocol: ${init.protocolVersion}`);
    this.capabilities = init.agentCapabilities ?? {};
    if (authenticate && init.authMethods?.some(method => method.id === 'cursor_login')) await this.request('authenticate', { methodId: 'cursor_login' });
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
      this.pending.set(id, { resolve, reject, timer });
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
      if (message.error) pending.reject(new Error(this.redact(message.error.message || 'Cursor request failed')));
      else pending.resolve(message.result);
    }
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async openSession(sessionId) {
    if (sessionId && !this.capabilities?.loadSession) throw new Error('This Cursor CLI cannot resume sessions. Update Cursor CLI; the existing history has not been replaced.');
    const result = await this.request(sessionId ? 'session/load' : 'session/new', { ...(sessionId ? { sessionId } : {}), cwd: this.cwd, mcpServers: [] });
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
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    try { await this.exit; } finally { clearTimeout(timer); }
  }
}
