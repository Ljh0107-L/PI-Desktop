// Antigravity engine: Pi RPC ⇄ the official CLI's ACP v1 stdio server.
// The CLI owns sign-in, credentials, tools and model access. This adapter has no API fallback.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINE = 'antigravity';
const AUTH_METHOD = 'oauth-personal';
const BINDING = 'pidesk-antigravity-session';
const CONTROL_MS = 12000;
const LOGIN_MS = 120000;
const ABORT_MS = 6000;
const PERMISSION_MS = 90000;
const MAX_LINE = 8 * 1024 * 1024;
const has = (obj, key) => Object.hasOwn(obj, key);
const text = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcId = value => typeof value === 'string' || Number.isSafeInteger(value);
const output = (stream, value) => stream.write(JSON.stringify(value) + '\n');
const within = async (promise, ms, fallback) => {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })]); }
  finally { clearTimeout(timer); }
};

function readLines(stream, onLine, onOverflow) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let start = 0, end;
    while ((end = buffer.indexOf('\n', start)) !== -1) {
      if (end - start > MAX_LINE) { buffer = ''; onOverflow(); return; }
      if (end > start) onLine(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_LINE) { buffer = ''; onOverflow(); }
  });
}

const CLI_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'LC_ALL', 'LC_ADDRESS', 'LC_COLLATE', 'LC_CTYPE', 'LC_IDENTIFICATION', 'LC_MEASUREMENT', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NAME', 'LC_NUMERIC', 'LC_PAPER', 'LC_TELEPHONE', 'LC_TIME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'];
function cliEnv(env) {
  return Object.fromEntries(CLI_ENV.filter(key => has(env, key)).map(key => [key, env[key]]));
}

// A binding is append-only. An interrupted session/new may have reached the CLI, so never
// issue another one for that file unless the CLI confirmed it had rejected the first for auth.
class Transcript {
  constructor({ cwd, sessionsDir, sessionFile, recordId }) {
    this.entries = [];
    this.leafId = null;
    this.binding = null;
    const id = randomUUID(), timestamp = new Date().toISOString();
    const dir = join(sessionsDir, 'antigravity');
    this.file = sessionFile ?? join(dir, `${recordId ?? id}.jsonl`);
    let existing = !!sessionFile;
    try {
      const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      if (!existing) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { this.fd = openSync(this.file, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
        catch (error) {
          // The adapter may have saved an ACP ID before Desktop observed get_state.
          // With the same record ID, open that file instead of calling session/new again.
          if (error.code !== 'EEXIST' || !recordId) throw error;
          existing = true;
        }
      }
      if (existing) this.fd = openSync(this.file, flags);
      const stat = fstatSync(this.fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Not a private session file');
      if (!existing) {
        this.header = { type: 'session', version: 3, id, timestamp, cwd, engine: ENGINE };
        this.#write([this.header]);
      } else {
        const records = readFileSync(this.fd, 'utf8');
        if (!records.endsWith('\n')) throw new Error('Incomplete session file');
        const lines = records.split('\n');
        this.header = JSON.parse(lines.shift());
        if (this.header?.type !== 'session' || this.header.engine !== ENGINE || !text(this.header.id) || this.header.cwd !== cwd) throw new Error('Invalid session header');
        const ids = new Set();
        for (const line of lines) {
          if (!line) continue;
          const entry = JSON.parse(line);
          if (!text(entry?.id) || ids.has(entry.id) || entry.parentId !== this.leafId || entry.type === 'session') throw new Error('Invalid session entry');
          if (entry.type === 'custom' && entry.customType === BINDING) {
            const binding = entry.data;
            if (this.binding?.sessionId || !object(binding) || !(text(binding.sessionId) || typeof binding.creating === 'boolean')) throw new Error('Invalid session binding');
            this.binding = binding;
          }
          ids.add(entry.id); this.entries.push(entry); this.leafId = entry.id;
        }
        if (!this.binding?.sessionId && this.entries.some(e => e.type === 'message')) throw new Error('Missing ACP session ID');
      }
    } catch {
      this.close();
      throw new Error(existing ? 'Cannot read the original Antigravity transcript. No replacement was started.' : 'Cannot create a private Antigravity transcript.');
    }
  }

  #write(entries) {
    try {
      if (this.writeFailed) throw new Error('A previous write failed');
      appendFileSync(this.fd, entries.map(e => JSON.stringify(e) + '\n').join(''));
      fsyncSync(this.fd);
    } catch {
      // An append could have partly succeeded. Do not link a new entry across that uncertainty.
      this.writeFailed = true;
      throw new Error('Cannot save the Antigravity transcript.');
    }
  }

  append(entries) {
    let parentId = this.leafId;
    const full = entries.map(entry => {
      const next = { id: randomUUID().replace(/-/g, '').slice(0, 12), parentId, timestamp: new Date().toISOString(), ...entry };
      parentId = next.id;
      return next;
    });
    this.#write(full);
    this.entries.push(...full); this.leafId = parentId;
  }

  bind(data) {
    this.append([{ type: 'custom', customType: BINDING, data }]);
    this.binding = data;
  }

  messages() { return this.entries.filter(e => e.type === 'message').map(e => e.message); }
  publicEntries() { return this.entries.map(e => e.type === 'custom' && e.customType === BINDING ? { ...e, data: undefined } : e); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

class AcpError extends Error {
  constructor(error, method) {
    const code = Number.isInteger(error?.code) ? error.code : null;
    const what = {
      initialize: 'initialize', authenticate: 'complete sign-in', 'session/new': 'start a session',
      'session/load': 'load the original session', 'session/resume': 'resume the original session',
      'session/set_config_option': 'change session settings', 'session/prompt': 'complete the prompt',
    }[method];
    super(`Antigravity could not ${what}${code == null ? '' : ` (ACP error ${code})`}.`);
    this.code = code;
    // -32000 is also used as a generic server error by JSON-RPC implementations.
    this.authRequired = code === -32000 && typeof error?.message === 'string' &&
      /^\s*(?:authentication (?:is )?required\b|auth_required\b)/i.test(error.message);
  }
}

class AcpPeer {
  constructor(config, env, onRecord, onDisconnect) {
    try { this.child = spawn(config.bin, ['acp'], { cwd: config.cwd, env: cliEnv(env), stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { throw new Error('Could not start the configured Antigravity CLI.'); }
    this.pending = new Map();
    this.nextId = 0;
    this.seq = 0;
    this.closed = false;
    this.onDisconnect = onDisconnect;
    const broken = () => this.close(new Error('The Antigravity CLI connection closed.'));
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => {
        resolve(true);
        // Normally stdout closes right after the final records. A descendant could hold it open.
        if (!this.closed) this.drainTimer = setTimeout(broken, 250);
      });
      this.child.on('error', () => {
        if (!this.child.pid) resolve(true);
        this.close(new Error('Could not start or communicate with the configured Antigravity CLI.'));
      });
    });
    this.child.once('close', broken);
    this.child.stdout.once('end', broken);
    this.child.stdout.on('error', broken);
    this.child.stdin.on('error', broken);
    readLines(this.child.stdout, line => {
      if (this.closed) return;
      try {
        const record = JSON.parse(line);
        if (record?.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC record');
        const seq = ++this.seq;
        if (typeof record.method === 'string') onRecord(this, record, seq);
        else if (this.pending.has(record.id)) {
          const p = this.pending.get(record.id);
          this.pending.delete(record.id); clearTimeout(p.timer);
          if (has(record, 'error')) p.reject(new AcpError(record.error, p.method));
          else if (has(record, 'result')) p.resolve({ result: record.result, seq });
          else p.reject(new Error('Invalid response from the Antigravity CLI.'));
        }
      } catch { this.close(new Error('The Antigravity CLI sent an invalid ACP record.')); }
    }, () => this.close(new Error('An Antigravity CLI ACP record exceeded the size limit.')));
  }

  send(fields) {
    if (this.closed) return;
    output(this.child.stdin, { jsonrpc: '2.0', ...fields });
  }

  request(method, params, timeout = CONTROL_MS) {
    if (this.closed) return Promise.reject(new Error('The Antigravity CLI connection closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => this.close(new Error(`Antigravity timed out waiting for ${method}.`)), timeout) : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(error) {
    if (this.closed) return this.stopped;
    this.closed = true;
    clearTimeout(this.drainTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.child.stdin.end();
    const signal = name => { try { this.child.kill(name); } catch { /* relay owns escalation */ } };
    this.stopped = (async () => {
      if (await within(this.exited, 250, false)) return true;
      signal('SIGTERM');
      if (await within(this.exited, 500, false)) return true;
      signal('SIGKILL');
      return within(this.exited, 750, false);
    })().finally(() => this.child.stdout.destroy());
    this.onDisconnect(this);
    return this.stopped;
  }
}

function selectConfig(options) {
  const seen = new Set();
  return (Array.isArray(options) ? options : []).flatMap(o => {
    if (!text(o?.id) || seen.has(o.id) || o.type !== 'select' || !text(o.name) || typeof o.currentValue !== 'string') return [];
    // Only model and reasoning controls belong in the desktop MVP, not CLI permission modes.
    const category = o.category ?? (o.id === 'model' ? 'model' : ['effort', 'thinking', 'thinking_level', 'thought_level'].includes(o.id) ? 'thought_level' : null);
    if (category !== 'model' && category !== 'thought_level') return [];
    seen.add(o.id);
    const values = new Set();
    const choices = (Array.isArray(o.options) ? o.options : []).flatMap(choice =>
      text(choice?.group) && Array.isArray(choice.options) ? choice.options : [choice]);
    return [{ id: o.id, name: o.name, category, currentValue: o.currentValue,
      options: choices.flatMap(choice => {
        if (typeof choice?.value !== 'string' || values.has(choice.value) || !text(choice.name)) return [];
        values.add(choice.value);
        return [{ value: choice.value, name: choice.name }];
      }) }];
  });
}

const STOP = new Map([['end_turn', 'stop'], ['max_tokens', 'length'], ['max_turn_requests', 'length'], ['refusal', 'stop'], ['cancelled', 'aborted']]);
const PERMISSIONS = new Map([['allow_once', 'Allow once'], ['allow_always', 'Allow and remember'], ['reject_once', 'Reject once'], ['reject_always', 'Reject and remember']]);
const cancelled = { outcome: { outcome: 'cancelled' } };
const shownContent = content => (Array.isArray(content) ? content : []).flatMap(block =>
  block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string' ? [{ type: 'text', text: block.content.text }] : []);
const shownPaths = locations => (Array.isArray(locations) ? locations : []).flatMap(location => text(location?.path) ? [location.path] : []);

class AntigravityAdapter {
  constructor({ boot, write, env = process.env }) {
    const { bin, cwd, sessionsDir, sessionFile, recordId, remote, clientVersion } = boot?.antigravity ?? {};
    this.config = { bin, cwd, sessionsDir, sessionFile, recordId, remote: remote === true, clientVersion };
    this.write = write;
    this.env = env;
    this.controls = Promise.resolve();
    this.permissions = new Map();
    this.cancelEpoch = 0;
    this.authRequired = false;
    this.canSignIn = false;
    this.options = [];
    this.configSeq = 0;
    this.closed = false;
  }

  async handle(r) {
    if (this.closed || typeof r?.type !== 'string') return;
    if (r.type === 'extension_ui_response') { this.#answer(r); return; }
    if (!rpcId(r.id)) return;
    try { this.write({ type: 'response', id: r.id, command: r.type, success: true, data: await this.#command(r) }); }
    catch (error) { this.write({ type: 'response', id: r.id, command: r.type, success: false, error: error.message }); }
  }

  #serial(fn) {
    const run = this.controls.then(() => {
      if (this.closed) throw new Error('The Antigravity adapter stopped.');
      return fn();
    });
    this.controls = run.catch(() => {});
    return run;
  }

  #command(r) {
    switch (r.type) {
      case 'get_state': {
        const ready = () => {
          this.write({ type: 'antigravity_permissions', ids: [...this.permissions.keys()] });
          return this.#state();
        };
        if (this.peer && !this.peer.closed && (this.sessionId || this.authRequired)) return ready();
        return this.#serial(async () => { await this.#ensureReady(); return ready(); });
      }
      case 'antigravity_login': {
        if (!this.login) this.login = this.#serial(() => this.#signIn()).finally(() => { this.login = null; });
        return this.login;
      }
      case 'antigravity_set_config': return this.#serial(() => this.#setConfig(r.configId, r.value));
      case 'prompt': {
        if (r.images != null && (!Array.isArray(r.images) || r.images.length)) throw new Error('Antigravity only supports text prompts in Pi Desktop.');
        if (!text(r.message) || !r.message.trim()) throw new Error('Enter a text prompt for Antigravity.');
        const epoch = this.cancelEpoch;
        return this.#serial(() => this.#prompt(r.message, epoch));
      }
      case 'abort': return this.#abort();
      case 'abort_bash': case 'clear_queue': case 'set_session_name': return {};
      case 'get_messages': return { messages: this.#transcript(false)?.messages() ?? [] };
      case 'get_entries': {
        const tr = this.#transcript(false);
        return { entries: tr?.publicEntries() ?? [], leafId: tr?.leafId ?? null };
      }
      case 'get_session_stats': return null;
      case 'get_commands': return { commands: [] };
      default: throw new Error('This command is not supported by the Antigravity adapter.');
    }
  }

  #transcript(create = true) {
    if (!this.transcript && (create || this.config.sessionFile != null)) {
      const { cwd, sessionsDir, sessionFile, recordId } = this.config;
      if (recordId != null && (typeof recordId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(recordId))) {
        throw new Error('Invalid Antigravity conversation ID.');
      }
      if (![cwd, sessionsDir, ...(sessionFile == null ? [] : [sessionFile])].every(v => text(v) && isAbsolute(v))) {
        throw new Error('Antigravity requires absolute local working directory and transcript paths.');
      }
      this.transcript = new Transcript(this.config);
    }
    return this.transcript;
  }

  #antigravityState() { return { authRequired: this.authRequired, canSignIn: this.canSignIn, options: this.options }; }
  #model() {
    const id = this.options.find(o => o.category === 'model')?.currentValue;
    return id ? { provider: ENGINE, id } : null;
  }
  #state() {
    const model = this.#model();
    return { engine: ENGINE, sessionId: this.transcript?.header.id ?? null, sessionFile: this.transcript?.file ?? null,
      isStreaming: !!this.turn, isCompacting: false, pendingMessageCount: 0, antigravity: this.#antigravityState(), ...(model ? { model } : {}) };
  }
  #updateState() { this.write({ type: 'antigravity_state', antigravity: this.#antigravityState() }); }
  #authNeeded() {
    this.sessionId = null;
    this.authRequired = true;
    this.options = [];
    this.#updateState();
  }
  #replaceOptions(options, seq) {
    if (!Array.isArray(options) || seq < this.configSeq) return;
    this.configSeq = seq;
    this.options = selectConfig(options);
    this.#updateState();
  }

  async #initialize() {
    if (this.peer && !this.peer.closed) return this.capabilities;
    if (this.peer && !await this.peer.stopped) throw new Error('The previous Antigravity CLI process did not stop.');
    if (this.closed) throw new Error('The Antigravity adapter stopped.');
    if (!text(this.config.bin) || !isAbsolute(this.config.bin)) throw new Error('An explicit path to the official Antigravity CLI is required.');
    const peer = new AcpPeer(this.config, this.env, (p, r, seq) => this.#onRecord(p, r, seq), p => this.#disconnected(p));
    this.peer = peer;
    this.capabilities = {};
    this.configSeq = 0;
    let init;
    try {
      ({ result: init } = await peer.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pi-desktop', title: 'Pi Desktop', version: this.config.clientVersion ?? '0.0.0' },
      }));
    } catch (error) {
      if (!error.authRequired) peer.close(error);
      throw error;
    }
    if (init?.protocolVersion !== 1 || peer.closed) {
      const error = new Error('The Antigravity CLI did not negotiate ACP version 1.');
      peer.close(error); throw error;
    }
    this.capabilities = init.agentCapabilities ?? {};
    this.canSignIn = !this.config.remote && Array.isArray(init.authMethods) && init.authMethods.some(m => m?.id === AUTH_METHOD && (m.type == null || m.type === 'agent'));
    return this.capabilities;
  }

  async #ensureReady() {
    const tr = this.#transcript();
    if (this.peer && !this.peer.closed && (this.sessionId || this.authRequired)) return;
    if (tr.binding?.creating) throw new Error('The original Antigravity session ID was not saved. No replacement was started.');
    try { await this.#initialize(); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return; } throw error; }
    await this.#open();
  }

  async #open() {
    const tr = this.transcript, saved = tr.binding?.sessionId;
    const peer = this.peer;
    if (this.closed || peer.closed) throw new Error('The Antigravity CLI connection closed.');
    const method = !saved ? 'session/new' : object(this.capabilities.sessionCapabilities?.resume) ? 'session/resume' :
      this.capabilities.loadSession === true ? 'session/load' : null;
    if (!method) throw new Error('The Antigravity CLI cannot resume this session. No replacement was started.');
    const opening = { saved, latest: null };
    this.opening = opening;
    try {
      if (!saved) tr.bind({ creating: true });
      const { result, seq } = await peer.request(method, { cwd: this.config.cwd, mcpServers: [], ...(saved ? { sessionId: saved } : {}) });
      const sessionId = saved ?? result?.sessionId;
      if (!text(sessionId) || (saved && result?.sessionId != null && result.sessionId !== saved)) throw new Error('Antigravity did not return the expected session ID.');
      // Record a successful new session even if the pipe closes immediately after the reply.
      if (!saved) tr.bind({ sessionId });
      if (this.closed || peer.closed) throw new Error('The Antigravity CLI connection closed.');
      this.sessionId = sessionId;
      this.authRequired = false;
      this.options = [];
      const early = opening.latest?.id === sessionId ? opening.latest : null;
      if (early && (early.seq > seq || !Array.isArray(result?.configOptions))) this.#replaceOptions(early.options, early.seq);
      else if (Array.isArray(result?.configOptions)) this.#replaceOptions(result.configOptions, seq);
      else this.#updateState();
    } catch (error) {
      if (error.authRequired) {
        if (!saved) tr.bind({ creating: false });
        this.#authNeeded();
        return;
      }
      if (saved && error instanceof AcpError && error.code === -32002) throw new Error('The original Antigravity session was not found. No replacement was started.');
      throw error;
    } finally { this.opening = null; }
  }

  async #signIn() {
    await this.#ensureReady();
    if (this.sessionId) return this.#state();
    if (!this.authRequired || !this.canSignIn) throw new Error(this.config.remote
      ? 'Run agy acp --login on the SSH host, then reconnect.' : 'Sign in using the official Antigravity CLI, then reconnect.');
    try { await this.peer.request('authenticate', { methodId: AUTH_METHOD }, LOGIN_MS); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return this.#state(); } throw error; }
    await this.#open();
    return this.#state();
  }

  async #setConfig(configId, value) {
    if (this.turn) throw new Error('Wait for the current Antigravity turn to finish.');
    await this.#ensureReady();
    if (!this.sessionId) throw new Error('Sign in to Antigravity before changing session settings.');
    if (!this.options.find(o => o.id === configId)?.options.some(choice => choice.value === value)) throw new Error('That Antigravity setting is not an advertised option.');
    const peer = this.peer;
    try {
      const { result, seq } = await peer.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
      if (peer.closed) throw new Error('The Antigravity CLI connection closed.');
      this.#replaceOptions(result?.configOptions, seq);
    } catch (error) { if (error.authRequired) this.#authNeeded(); else throw error; }
    return this.#state();
  }

  async #prompt(message, epoch) {
    if (this.turn) throw new Error('Antigravity is already responding; stop this turn before sending another prompt.');
    if (this.cancelEpoch !== epoch) throw new Error('The Antigravity prompt was cancelled before it started.');
    await this.#ensureReady();
    if (this.closed || this.cancelEpoch !== epoch) throw new Error('The Antigravity prompt was cancelled before it started.');
    if (!this.sessionId) throw new Error('Sign in to Antigravity before sending a prompt.');
    const user = { role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() };
    this.transcript.append([{ type: 'message', message: user }]);
    const turn = { sessionId: this.sessionId, startedAt: Math.max(Date.now(), user.timestamp + 1), tools: new Map(), content: [], model: this.#model()?.id };
    this.turn = turn;
    this.write({ type: 'agent_start' });
    this.#message(user);
    this.write({ type: 'message_start', message: this.#assistant(turn, []) });
    turn.done = this.peer.request('session/prompt', { sessionId: turn.sessionId, prompt: user.content }, null).then(
      ({ result }) => {
        const reason = STOP.get(result?.stopReason);
        this.#finishTurn(turn, reason ?? 'error', reason ? null : 'Antigravity returned an unrecognized stop reason.');
        return !!reason;
      }, error => {
        const aborted = turn.cancelled || error.code === -32800;
        this.#finishTurn(turn, aborted ? 'aborted' : 'error', aborted ? null : error.authRequired ? 'Sign in to Antigravity to continue.' : error.message);
        if (!this.closed && error.authRequired) this.#authNeeded();
        return error instanceof AcpError;
      });
    return { disposition: 'started' };
  }

  #assistant(turn, content) {
    return { role: 'assistant', content, provider: ENGINE, api: 'antigravity-acp', ...(turn.model ? { model: turn.model } : {}), timestamp: turn.startedAt };
  }
  #message(message) { this.write({ type: 'message_start', message }); this.write({ type: 'message_end', message }); }
  #delta(fields) { this.write({ type: 'message_update', assistantMessageEvent: fields }); }
  #endBlock(turn) {
    if (turn.blockIndex == null) return;
    const index = turn.blockIndex, block = turn.content[index];
    this.#delta({ type: `${block.type}_end`, contentIndex: index, content: block[block.type] });
    turn.blockIndex = null;
  }
  #chunk(turn, type, content) {
    if (content?.type !== 'text' || !text(content.text)) return;
    if (turn.blockIndex == null || turn.content[turn.blockIndex].type !== type) {
      this.#endBlock(turn);
      turn.blockIndex = turn.content.push({ type, [type]: '' }) - 1;
      this.#delta({ type: `${type}_start`, contentIndex: turn.blockIndex });
    }
    turn.content[turn.blockIndex][type] += content.text;
    this.#delta({ type: `${type}_delta`, contentIndex: turn.blockIndex, delta: content.text });
  }

  #tool(turn, update) {
    if (!text(update.toolCallId)) return;
    let tool = turn.tools.get(update.toolCallId);
    if (!tool) {
      this.#endBlock(turn);
      tool = { id: randomUUID(), index: turn.content.length, start: Date.now(), paths: [], result: [] };
      turn.tools.set(update.toolCallId, tool);
    }
    if (text(update.kind)) tool.kind = update.kind;
    if (text(update.title)) tool.title = update.title;
    if (Array.isArray(update.locations)) tool.paths = shownPaths(update.locations);
    if (Array.isArray(update.content)) tool.result = shownContent(update.content);
    const call = { type: 'toolCall', id: tool.id, name: tool.title ?? tool.kind ?? 'Antigravity tool',
      arguments: tool.paths.length ? { path: tool.paths[0], ...(tool.paths.length > 1 ? { paths: tool.paths } : {}) } : {} };
    turn.content[tool.index] = call;
    if (!tool.call) this.#delta({ type: 'toolcall_start', contentIndex: tool.index, id: call.id, toolName: call.name });
    this.#delta({ type: 'toolcall_end', contentIndex: tool.index, toolCall: call });
    if (!tool.call) this.write({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
    tool.call = call;
    if (update.status === 'completed' || update.status === 'failed') {
      tool.finished = true;
      this.#toolEnd(tool, update.status === 'failed', update.status === 'failed' ? 'Tool failed.' : 'Tool completed.');
    } else if (!tool.finished && !turn.cancelled && tool.result.length) {
      this.write({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args: call.arguments,
        partialResult: { content: tool.result, details: { engine: ENGINE } } });
    } else if (turn.cancelled && !tool.finished && !tool.interrupted) {
      tool.interrupted = true;
      this.#toolEnd(tool, true, 'Interrupted.');
    }
  }
  #toolEnd(tool, isError, fallback) {
    const content = tool.result.length ? tool.result : [{ type: 'text', text: fallback }];
    const details = { engine: ENGINE };
    const durationMs = Date.now() - tool.start;
    tool.message = { role: 'toolResult', toolCallId: tool.id, toolName: tool.call.name, content, details, isError, timestamp: Date.now() };
    this.write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.call.name, result: { content, details }, isError, durationMs });
  }

  #finishTurn(turn, stopReason, errorMessage) {
    if (this.turn !== turn) return;
    this.#cancelPermissions();
    this.#endBlock(turn);
    for (const tool of turn.tools.values()) if (!tool.message) this.#toolEnd(tool, true, stopReason === 'aborted' ? 'Interrupted.' : 'Antigravity did not report tool completion.');
    let message = { ...this.#assistant(turn, turn.content), stopReason, ...(errorMessage ? { errorMessage } : {}) };
    const results = [...turn.tools.values()].map(t => t.message);
    try { this.transcript.append([message, ...results].map(message => ({ type: 'message', message }))); }
    catch { message = { ...message, stopReason: 'error', errorMessage: 'Could not save this turn to the Antigravity transcript.' }; }
    this.turn = null;
    this.write({ type: 'message_end', message });
    for (const result of results) this.#message(result);
    this.write({ type: 'agent_end' });
    this.write({ type: 'agent_settled' });
  }

  #cancelTurn(turn) {
    if (turn.cancelled) return;
    turn.cancelled = true;
    this.peer.send({ method: 'session/cancel', params: { sessionId: turn.sessionId } });
    this.#cancelPermissions();
    for (const tool of turn.tools.values()) if (!tool.finished && !tool.interrupted) {
      tool.interrupted = true;
      this.#toolEnd(tool, true, 'Interrupted.');
    }
  }
  async #abort() {
    ++this.cancelEpoch;
    const turn = this.turn;
    if (turn) {
      this.#cancelTurn(turn);
      // Never claim a successful Stop until the original prompt really settled.
      if (!await within(turn.done, ABORT_MS, false)) throw new Error('Antigravity did not confirm the cancellation.');
    }
    return {};
  }

  #onRecord(peer, record, seq) {
    if (peer !== this.peer || this.closed) return;
    const { id, method, params } = record;
    if (has(record, 'id')) {
      if (!rpcId(id)) return;
      if (method === 'session/request_permission') this.#permission(peer, id, params);
      else peer.send({ id, error: { code: -32601, message: 'Method not supported by Pi Desktop' } });
    } else if (method === 'session/update') {
      const update = params?.update;
      if (!text(params?.sessionId) || !object(update)) return;
      if (update.sessionUpdate === 'config_option_update') {
        if (!Array.isArray(update.configOptions)) return;
        if (this.opening && (!this.opening.saved || this.opening.saved === params.sessionId)) this.opening.latest = { id: params.sessionId, options: update.configOptions, seq };
        else if (params.sessionId === this.sessionId) this.#replaceOptions(update.configOptions, seq);
      }
      // session/load replays history as session/update. The local Pi file is authoritative
      // for the UI, so only an active prompt can append/emit messages and tools.
      const turn = this.turn;
      if (!turn || params.sessionId !== turn.sessionId) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': this.#chunk(turn, 'text', update.content); break;
        case 'agent_thought_chunk': this.#chunk(turn, 'thinking', update.content); break;
        case 'tool_call': case 'tool_call_update': this.#tool(turn, update); break;
      }
    }
  }

  #permission(peer, id, params) {
    const turn = this.turn;
    const reject = () => peer.send({ id, result: cancelled });
    if (!turn || turn.cancelled || params?.sessionId !== turn.sessionId || !Array.isArray(params.options) || this.permissions.size >= 8) { reject(); return; }
    const call = params.toolCall;
    if (!text(call?.toolCallId) || !params.options.length || params.options.length > 32) { reject(); return; }
    const options = new Map(), details = [], ids = new Set();
    for (const option of params.options) {
      if (!text(option?.optionId) || !text(option.name) || ids.has(option.optionId) || !PERMISSIONS.has(option.kind)) { reject(); return; }
      let label = option.name;
      for (let suffix = 2; options.has(label); suffix++) label = `${option.name} (${suffix})`;
      options.set(label, option.optionId); ids.add(option.optionId);
      details.push({ label, description: PERMISSIONS.get(option.kind) });
    }
    const uiId = randomUUID();
    const timer = setTimeout(() => this.#answer({ id: uiId, cancelled: true }), PERMISSION_MS);
    this.permissions.set(uiId, { peer, id, options, timer });
    const tool = turn.tools.get(call.toolCallId);
    const kind = text(call.kind) ? call.kind : tool?.kind;
    const paths = Array.isArray(call.locations) ? shownPaths(call.locations) : tool?.paths ?? [];
    this.write({ type: 'extension_ui_request', id: uiId, method: 'select', header: 'Antigravity tool permission',
      title: (text(call.title) ? call.title : tool?.title) ?? 'Approve this Antigravity tool call?',
      message: [kind, ...paths, ...shownContent(call.content).map(block => block.text)].filter(Boolean).join('\n'),
      options: [...options.keys()], optionDetails: details });
  }
  #answer(r) {
    const entry = this.permissions.get(r.id);
    if (!entry) return;
    this.permissions.delete(r.id); clearTimeout(entry.timer);
    const optionId = !r.cancelled && entry.options.get(r.value);
    entry.peer.send({ id: entry.id, result: optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled });
    this.write({ type: 'extension_ui_dismiss', id: r.id });
  }
  #cancelPermissions() { for (const id of this.permissions.keys()) this.#answer({ id, cancelled: true }); }
  #disconnected(peer) {
    if (peer !== this.peer) return;
    this.sessionId = null;
    this.#cancelPermissions();
    if (!this.closed) {
      this.authRequired = false; this.canSignIn = false; this.options = [];
      this.#updateState();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn) this.#cancelTurn(turn);
    this.#cancelPermissions();
    const stopping = this.peer?.close(new Error('The Antigravity adapter stopped.'));
    await turn?.done;
    await this.controls;
    this.transcript?.close();
    await stopping;
  }
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain) {
  let boot;
  try { boot = JSON.parse(process.env.PIDESK_BOOT ?? '{}'); } catch { boot = {}; }
  delete process.env.PIDESK_BOOT;
  const adapter = new AntigravityAdapter({ boot, write: value => { if (!process.stdout.destroyed) output(process.stdout, value); } });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.destroy();
    adapter.close().then(() => process.stdout.end(), () => { process.exitCode = 1; process.stdout.end(); });
  };
  readLines(process.stdin, line => {
    try { void adapter.handle(JSON.parse(line)); } catch { /* malformed parent input */ }
  }, shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('error', shutdown);
  process.stdout.on('error', shutdown);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
}
