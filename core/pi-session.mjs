// One Pi RPC process = one desktop session, wherever it runs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attachJsonlReader, serializeJsonLine } from './jsonl.mjs';

export class PiSession extends EventEmitter {
  #child = null;
  #pending = new Map();
  #nextId = 0;
  #stderr = '';
  #exit = null;
  #closed = null;
  #stopping = null;

  // `relay`: { sinceSeq, spawn } when the transport reaches a pidesk relay instead of a bare Pi process.
  // Then the first stdin line is the relay's attach handshake, every Pi line carries a sequence number
  // (lastSeq), and closing this connection only detaches — Pi keeps running on the host.
  constructor({ id, transport, boot, relay }) {
    super();
    this.id = id;
    this.transport = transport;
    this.boot = boot;
    this.relay = relay ?? null;
    this.lastSeq = relay?.sinceSeq ?? null;
    this.attachInfo = null;
    this.piExit = null;
    this.nonce = randomBytes(3).toString('hex'); // keeps request ids unique across reconnects
  }

  get stderr() { return this.#stderr; }
  get pid() { return this.#child?.pid; }

  async start({ readyTimeout = 30000 } = {}) {
    if (this.#child) throw new Error('Session already started');
    const bootLine = serializeJsonLine(this.relay
      ? { op: 'attach', sessionId: this.id, sinceSeq: this.relay.sinceSeq ?? null, spawn: this.relay.spawn, boot: this.boot ?? {} }
      : this.boot ?? {});
    if (bootLine.indexOf('\n') !== bootLine.length - 1) throw new Error('Boot record must be a single line');
    const { command, args, spawnOptions } = this.transport;
    const child = spawn(command, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', data => { const text = data.toString(); this.#stderr = (this.#stderr + text).slice(-8000); this.emit('stderr', text); });
    child.on('error', error => this.#fail(new Error(`${this.id}: failed to start ${command}: ${error.message}`)));
    // 'exit' can precede the last stdout records. Only classify the exit once the relay's
    // final status and diagnostics have drained, otherwise a real Pi exit looks like a drop.
    child.on('close', (code, signal) => {
      const what = this.relay ? (this.piExit ? 'Pi exited' : 'connection closed') : 'Pi exited';
      const status = this.piExit ?? { code, signal };
      const detail = this.piExit?.stderr || this.#stderr.slice(-2000);
      this.#fail(new Error(`${this.id}: ${what} (code=${status.code} signal=${status.signal})${detail ? '\n' + detail : ''}`));
      this.emit('exit', { ...status, piExited: !this.relay || !!this.piExit });
    });
    child.stdin.on('error', error => this.#fail(new Error(`${this.id}: stdin error: ${error.message}`)));
    attachJsonlReader(child.stdout, line => this.#handleLine(line));
    // The first stdin line is consumed by the bootstrap (or the relay), never by Pi.
    child.stdin.write(bootLine);
    try {
      this.initialState = await this.request('get_state', {}, { timeout: readyTimeout }); // also proves Pi is ready
      return this;
    } catch (error) {
      await this.stop(); // a failed/timed-out attach must not leak its transport
      throw error;
    } finally { this.boot = null; }
  }

  request(type, payload = {}, { timeout = 30000 } = {}) {
    if (this.#exit) return Promise.reject(this.#exit);
    if (!this.#child) return Promise.reject(new Error('Session not started'));
    const id = `${this.id}-${this.nonce}-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${this.id}: timeout waiting for ${type}`)); }, timeout);
      this.#pending.set(id, {
        resolve: response => {
          clearTimeout(timer);
          if (response.success) resolve(response.data);
          else reject(new Error(`${this.id}: ${type} failed: ${response.error}`));
        },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.#child.stdin.write(serializeJsonLine({ ...payload, type, id }));
    });
  }

  respondUi(id, payload) {
    this.#child?.stdin.write(serializeJsonLine({ type: 'extension_ui_response', id, ...payload }));
  }

  prompt(message, options = {}) { return this.request('prompt', { message, ...options }); }
  setModel(provider, modelId) { return this.request('set_model', { provider, modelId }); }
  availableModels() { return this.request('get_available_models').then(data => data.models); }
  messages() { return this.request('get_messages').then(data => data.messages); }
  state() { return this.request('get_state'); }
  abort() { return this.request('abort'); }
  abortBash() { return this.request('abort_bash'); }
  clearQueue() { return this.request('clear_queue'); }

  // Resolves on the next agent_settled event (subscribe before prompting).
  nextSettled(timeout = 60000, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', listener); signal?.removeEventListener('abort', aborted); };
      const listener = event => { if (event.type === 'agent_settled') { cleanup(); resolve(); } };
      const aborted = () => { cleanup(); reject(new Error(`${this.id}: waiting for agent_settled cancelled`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${this.id}: timeout waiting for agent_settled`)); }, timeout);
      this.on('event', listener);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  stop(timeout = 3000) {
    if (this.#stopping) return this.#stopping;
    const child = this.#child;
    if (!child) return Promise.resolve();
    this.#stopping = (async () => {
      child.stdin.end(); // orderly shutdown (detach for a relay transport)
      const term = setTimeout(() => child.kill('SIGTERM'), timeout);
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy();
      }, timeout + 1000);
      try { await this.#closed; }
      finally { clearTimeout(term); clearTimeout(kill); }
    })();
    return this.#stopping;
  }

  #handleLine(line) {
    let record;
    try { record = JSON.parse(line); } catch { this.emit('protocol-error', line); return; }
    if (record.relay) { this.#handleRelay(record); return; }
    if (typeof record._seq === 'number') { if (this.lastSeq === null || record._seq > this.lastSeq) this.lastSeq = record._seq; delete record._seq; }
    if (record.type === 'response') {
      const pending = record.id && this.#pending.get(record.id);
      if (pending) { this.#pending.delete(record.id); pending.resolve(record); }
      return; // replayed responses to an earlier connection's requests are not events
    }
    if (record.type === 'extension_ui_request') { this.emit('ui', record); return; }
    this.emit('event', record);
  }

  #handleRelay(record) {
    switch (record.relay) {
      case 'attached':
        this.attachInfo = record;
        if (record.created || this.lastSeq === null) this.lastSeq = record.lastSeq;
        this.emit('attached', record);
        break;
      case 'pending':
        for (const line of record.lines ?? []) this.#handleLine(line);
        break;
      case 'gap': this.emit('gap', record); break;
      case 'exit': this.piExit = record; this.emit('pi-exit', record); break;
      case 'error': this.#fail(new Error(`${this.id}: relay: ${record.error}`)); break;
    }
  }

  #fail(error) {
    if (this.#exit) return;
    this.#exit = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
