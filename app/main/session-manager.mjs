// Owns every Pi process the desktop runs, local or remote, and the records needed to resume them.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { PiSession } from '../../core/pi-session.mjs';
import { egressEnv, localTransport, relaySpawnSpec, sshRelayTransport } from '../../core/transports.mjs';
import { startEgressProxy, hostPortOf } from '../../core/egress-proxy.mjs';
import { listRelaySessions, prepareRemote, stopRelaySession } from './remote-setup.mjs';

const titleFrom = text => { const line = text.trim().split('\n')[0].replace(/\s+/g, ' '); return line.length > 60 ? line.slice(0, 57) + '…' : line || 'New session'; };
const remoteBase = path => path.split('/').filter(Boolean).pop() ?? path;

export class SessionManager extends EventEmitter {
  runtimes = new Map();   // session id -> { session, status, streaming, questions: Map, starting, lastSeq }
  prepared = new Map();   // environment id -> Promise<remote facts>
  catalogCache = null;
  providersVersion = 0;   // bumped whenever providers/keys change in Settings
  egress = null;

  constructor({ store, environments, local, piVersion, piPackageDir, bridgePath, relayPath, cacheDir }) {
    super();
    this.store = store;
    this.environments = environments; // () => [environment]
    this.local = local;               // { node, piCli, agentDir, extraEnv }
    this.piVersion = piVersion;
    this.bridgePath = bridgePath;
    this.relayPath = relayPath;
    this.cacheDir = cacheDir;
    this.piPackageDir = piPackageDir;
  }

  env(id) {
    const env = this.environments().find(e => e.id === id);
    if (!env) throw new Error(`Unknown environment ${id}`);
    return env;
  }

  // ---------------------------------------------------------------- providers and models
  bootProviders() {
    return this.store.settings.providers.flatMap(provider => {
      const apiKey = this.store.getKey(provider.id);
      if (!apiKey && provider.kind === 'builtin') return [];
      const entry = { id: provider.id, apiKey: apiKey ?? undefined };
      if (provider.kind === 'custom') Object.assign(entry, { name: provider.name, api: provider.api, baseUrl: provider.baseUrl, models: provider.models, headers: provider.headers });
      // A built-in provider with a chosen model list replaces its catalog with exactly those models.
      else if (provider.models?.length) entry.models = provider.models;
      return [entry];
    });
  }

  invalidateCatalog() { this.catalogCache = null; }

  // Keys and model lists changed: running Pi processes (including ones kept alive by a host's relay)
  // still hold what they started with, so send them the current providers.
  providersChanged() {
    this.providersVersion += 1;
    for (const key of [...this.spares.keys()]) this.#dropSpare(key);
    for (const runtime of this.runtimes.values()) if (runtime.status === 'connected') this.#syncProviders(runtime).catch(() => {});
  }
  async #syncProviders(runtime) {
    if (!runtime.session || runtime.providersVersion === this.providersVersion) return;
    const version = this.providersVersion;
    const payload = Buffer.from(JSON.stringify(this.bootProviders())).toString('base64');
    await runtime.session.prompt(`/pidesk-providers ${payload}`);
    runtime.providersVersion = version;
  }

  // Models Pi can use with the configured providers, from a short-lived local Pi process.
  async catalog() {
    if (this.catalogCache) return this.catalogCache;
    this.catalogCache = (async () => {
      const configured = new Set(this.store.settings.providers.map(p => p.id));
      if (!configured.size) return [];
      const session = new PiSession({ id: 'catalog', boot: { providers: this.bootProviders() }, transport: this.#localTransport({ cwd: this.local.agentDir }) });
      try {
        await session.start();
        const models = await session.request('get_available_models').then(d => d.models);
        // Built-in providers can be narrowed to the models the user picked in Settings.
        const enabled = Object.fromEntries(this.store.settings.providers.filter(p => p.enabledModels?.length).map(p => [p.id, new Set(p.enabledModels)]));
        return models.filter(m => configured.has(m.provider) && (!enabled[m.provider] || enabled[m.provider].has(m.id)))
          .map(m => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, thinkingLevelMap: m.thinkingLevelMap, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl, input: m.input }));
      } finally { await session.stop(); }
    })();
    this.catalogCache.catch(() => { this.catalogCache = null; });
    return this.catalogCache;
  }

  // Every model Pi knows for one built-in provider (used by Settings to pick models).
  async builtinModels(providerId, apiKey) {
    const session = new PiSession({ id: 'models-' + providerId, boot: { providers: [{ id: providerId, apiKey }] }, transport: this.#localTransport({ cwd: this.local.agentDir }) });
    try {
      await session.start();
      const models = await session.request('get_available_models').then(d => d.models);
      return models.filter(m => m.provider === providerId).map(({ provider, type, ...m }) => m); // full definitions: edits keep compat, cost, …
    } finally { await session.stop(); }
  }

  async providerHosts() {
    const models = await this.catalog().catch(() => []);
    return [...new Set(models.filter(m => m.baseUrl?.startsWith('https://')).map(m => hostPortOf(m.baseUrl)))];
  }

  // ---------------------------------------------------------------- environments
  prepare(envId, { force = false } = {}) {
    const env = this.env(envId);
    if (env.kind === 'local') return Promise.resolve({ ready: true });
    if (!force && this.prepared.has(envId)) return this.prepared.get(envId);
    const promise = (async () => {
      const providerHosts = await this.providerHosts();
      const saved = this.store.settings.environments[envId] ?? {};
      const facts = await prepareRemote(env, {
        piVersion: this.piVersion, piPackageDir: this.piPackageDir, bridgePath: this.bridgePath, relayPath: this.relayPath, providerHosts,
        root: saved.root, cacheDir: this.cacheDir,
        onProgress: message => this.emit('environment', { id: envId, status: 'preparing', message }),
      });
      // Remember where Pi lives on this host so sessions always find the same install.
      if (saved.root !== facts.root || !saved.added) { this.store.settings.environments[envId] = { ...saved, added: true, root: facts.root }; this.store.saveSettings(); this.emit('environments-changed'); }
      return facts;
    })();
    this.prepared.set(envId, promise);
    promise.then(facts => this.emit('environment', { id: envId, status: 'ready', facts }),
      error => { this.prepared.delete(envId); this.emit('environment', { id: envId, status: 'error', message: error.message }); });
    return promise;
  }

  async #egressFor(hosts) {
    if (!hosts.length) return null;
    if (!this.egress) this.egress = await startEgressProxy({ allow: [] });
    this.egress.allow(hosts);
    return this.egress;
  }

  // Environment for every Pi this app starts: long (1-hour) prompt caching where the provider supports it.
  piEnv() { return this.store.settings.context?.longCache === false ? {} : { PI_CACHE_RETENTION: 'long' }; }

  #localTransport(target) {
    mkdirSync(this.local.agentDir, { recursive: true });
    return localTransport({ node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, extensions: [this.bridgePath], extraEnv: { ...this.local.extraEnv, ...this.piEnv() }, ...target });
  }

  // ---------------------------------------------------------------- sessions
  list() {
    return this.store.sessions.filter(s => !s.archived).map(record => this.#view(record));
  }
  #view(record) {
    const runtime = this.runtimes.get(record.id);
    return { ...record, status: runtime?.status ?? 'idle', streaming: !!runtime?.streaming, pendingQuestions: runtime ? [...runtime.questions.values()] : [] };
  }
  record(id) {
    const record = this.store.sessions.find(s => s.id === id);
    if (!record) throw new Error(`Unknown session ${id}`);
    return record;
  }
  #save(record, patch) { Object.assign(record, patch, { updatedAt: Date.now() }); if (record.spare) return; this.store.saveSessions(); this.emit('sessions'); }

  // ---------------------------------------------------------------- pre-warming
  // While the user is on the new-session screen with an environment and folder chosen, start a Pi there
  // in advance; the first message then adopts it instead of waiting for SSH + Pi start-up.
  spares = new Map(); // `${environmentId}\n${cwd}` -> { id, record, timer }
  prewarm({ environmentId, cwd, model, thinkingLevel }) {
    if (!environmentId || !cwd) return false;
    const key = `${environmentId}\n${cwd}`;
    for (const [k] of this.spares) if (k !== key) this.#dropSpare(k);
    const existing = this.spares.get(key);
    if (existing) { this.#armSpare(key, existing); return true; }
    const env = this.environments().find(e => e.id === environmentId);
    if (!env || (env.kind === 'ssh' && !env.enabled)) return false;
    const record = { id: randomUUID(), title: 'New session', environmentId, environmentLabel: env.label, cwd, model, thinkingLevel: thinkingLevel ?? 'medium', spare: true };
    const spare = { id: record.id, record };
    this.spares.set(key, spare);
    this.#armSpare(key, spare);
    this.ensureStarted(record.id, record).catch(() => this.#dropSpare(key));
    return true;
  }
  #armSpare(key, spare) {
    clearTimeout(spare.timer);
    spare.timer = setTimeout(() => this.#dropSpare(key), 10 * 60 * 1000);
    spare.timer.unref?.();
  }
  #dropSpare(key) {
    const spare = this.spares.get(key);
    if (!spare) return;
    this.spares.delete(key);
    clearTimeout(spare.timer);
    const runtime = this.runtimes.get(spare.id);
    this.close(spare.id).catch(() => {});
    const env = this.environments().find(e => e.id === spare.record.environmentId);
    if (env?.kind === 'ssh' && runtime) this.prepare(env.id).then(facts => stopRelaySession(env, facts, spare.id)).catch(() => {});
  }

  async create({ environmentId, cwd, model, thinkingLevel }) {
    const env = this.env(environmentId);
    const spareKey = `${environmentId}\n${cwd}`;
    const spare = this.spares.get(spareKey);
    if (spare) {
      // Adopt the warm Pi: same id, so its relay session and runtime carry over.
      this.spares.delete(spareKey);
      clearTimeout(spare.timer);
      const record = Object.assign(spare.record, { spare: undefined, environmentLabel: env.label, project: env.kind === 'local' ? basename(cwd) : remoteBase(cwd), createdAt: Date.now(), updatedAt: Date.now() });
      delete record.spare;
      this.store.sessions.unshift(record);
      this.store.touchRecent(environmentId, cwd);
      this.store.saveSessions();
      this.emit('sessions');
      try {
        const session = await this.ensureStarted(record.id, record);
        await Promise.all([
          model && (record.model?.provider !== model.provider || record.model?.id !== model.id) ? session.setModel(model.provider, model.id).catch(error => this.emit('notice', { id: record.id, level: 'warning', message: error.message })) : null,
          thinkingLevel && thinkingLevel !== record.thinkingLevel ? session.request('set_thinking_level', { level: thinkingLevel }).catch(() => {}) : null,
        ]);
        this.#save(record, { model, thinkingLevel: thinkingLevel ?? record.thinkingLevel });
        return this.#view(record);
      } catch { /* the warm Pi failed: fall through to a fresh start with this record */ }
      await this.ensureStarted(record.id);
      return this.#view(record);
    }
    const record = {
      id: randomUUID(), title: 'New session', environmentId, environmentLabel: env.label, cwd,
      project: env.kind === 'local' ? basename(cwd) : remoteBase(cwd),
      model, thinkingLevel: thinkingLevel ?? 'medium',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.store.sessions.unshift(record);
    this.store.touchRecent(environmentId, cwd);
    this.store.saveSessions();
    this.emit('sessions');
    await this.ensureStarted(record.id);
    return this.#view(record);
  }

  // Connect (or reconnect) a session. SSH sessions live in the host's relay, so a dropped connection is
  // retried with backoff and resumes from the last event seen; Pi keeps working in the meantime.
  ensureStarted(id, recordOverride) {
    let runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') return Promise.resolve(runtime.session);
    if (runtime?.starting) return runtime.starting;
    const record = recordOverride ?? [...this.spares.values()].find(sp => sp.id === id)?.record ?? this.record(id);
    if (!runtime) {
      runtime = { session: null, status: 'idle', streaming: false, questions: new Map(), starting: null, lastSeq: null, retry: 0, retryTimer: null, closing: false, autoReconnect: false };
      this.runtimes.set(id, runtime);
    }
    clearTimeout(runtime.retryTimer);
    runtime.closing = false;
    runtime.status = runtime.autoReconnect ? 'reconnecting' : 'connecting';
    this.emit('status', { id, status: runtime.status });
    runtime.starting = this.#start(record, runtime).then(session => {
      runtime.status = 'connected'; runtime.starting = null; runtime.retry = 0;
      this.emit('status', { id, status: 'connected', streaming: runtime.streaming });
      return session;
    }, error => {
      runtime.starting = null;
      if (runtime.autoReconnect && !runtime.closing) this.#scheduleReconnect(record, runtime, error.message);
      else { runtime.status = 'error'; runtime.error = error.message; this.emit('status', { id, status: 'error', message: error.message }); }
      throw error;
    });
    return runtime.starting;
  }

  #scheduleReconnect(record, runtime, reason) {
    if (runtime.closing || this.runtimes.get(record.id) !== runtime) return;
    const delay = Math.min(30000, 1000 * 2 ** runtime.retry);
    runtime.retry += 1;
    runtime.status = 'reconnecting';
    this.emit('status', { id: record.id, status: 'reconnecting', message: reason, retryIn: delay });
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => this.ensureStarted(record.id).catch(() => {}), delay);
  }

  async #start(record, runtime) {
    const env = this.env(record.environmentId);
    const boot = { providers: this.bootProviders() };
    const piArgs = record.piSessionFile ? ['--session', record.piSessionFile] : [];
    let session;
    if (env.kind === 'local') {
      session = new PiSession({ id: record.id, boot, transport: this.#localTransport({ cwd: record.cwd, piArgs }) });
    } else {
      const facts = await this.prepare(env.id);
      const egressProxy = await this.#egressFor(facts.unreachable ?? []);
      // The remote port is fixed per session: the relay's Pi keeps HTTPS_PROXY across reconnects.
      if (egressProxy && !record.egressPort) this.#save(record, { egressPort: 30000 + Math.floor(Math.random() * 30000) });
      const egress = egressProxy && { localPort: egressProxy.port, remotePort: record.egressPort };
      const spawn = relaySpawnSpec({ cwd: record.cwd, node: facts.node, piCli: facts.piCli, agentDir: facts.agentDir, extensions: [facts.bridge], piArgs, extraEnv: { TMPDIR: facts.tmpDir, ...this.piEnv(), ...(egress ? egressEnv(egress.remotePort) : {}) } });
      const sharedOnHost = [...this.runtimes.values()].filter(r => r !== runtime && r.shared && r.envId === env.id && r.session && !r.closing).length;
      runtime.envId = env.id; runtime.shared = sharedOnHost < 6;
      const transport = sshRelayTransport({ host: env.host, sshOptions: env.sshArgs ?? [], node: facts.node, relayPath: facts.relay, runDir: facts.runDir, egress, shared: runtime.shared });
      session = new PiSession({ id: record.id, boot, transport, relay: { sinceSeq: runtime.lastSeq, spawn } });
    }
    runtime.session = session;
    runtime.questions.clear();
    session.on('event', event => { runtime.lastSeq = session.lastSeq; this.#onEvent(record, runtime, event); });
    session.on('ui', request => this.#onUi(record, runtime, request));
    session.on('gap', () => this.emit('resync', { id: record.id }));
    session.on('exit', ({ piExited }) => {
      if (this.runtimes.get(record.id) !== runtime || runtime.session !== session || runtime.closing) return;
      runtime.lastSeq = session.lastSeq;
      runtime.streaming = false;
      if (runtime.questions.size) { runtime.questions.clear(); this.emit('questions-cleared', { id: record.id }); }
      const message = session.stderr.trim().split('\n').slice(-2).join(' ');
      if (env.kind === 'ssh' && !piExited && runtime.status === 'connected') { this.#scheduleReconnect(record, runtime, message || 'Connection lost'); return; }
      if (runtime.starting) return; // the start promise reports this failure
      runtime.status = 'disconnected';
      if (piExited) runtime.lastSeq = null; // a new Pi process numbers its events from scratch
      this.emit('status', { id: record.id, status: 'disconnected', message: piExited ? 'Pi stopped' + (message ? `: ${message}` : '') : message });
    });
    await session.start({ readyTimeout: 90000 });
    runtime.lastSeq = session.lastSeq;
    const created = env.kind === 'local' || session.attachInfo?.created;
    if (env.kind === 'ssh') runtime.autoReconnect = true;
    const state = session.initialState ?? await session.state();
    runtime.streaming = !!state.isStreaming;
    runtime.providersVersion = created ? this.providersVersion : -1;
    if (!created) await this.#syncProviders(runtime).catch(() => {});
    if (created) {
      // Pipelined: both requests travel together, one network round trip instead of two.
      await Promise.all([
        record.model && (state.model?.provider !== record.model.provider || state.model?.id !== record.model.id)
          ? session.setModel(record.model.provider, record.model.id).catch(error => this.emit('notice', { id: record.id, level: 'warning', message: error.message })) : null,
        record.thinkingLevel ? session.request('set_thinking_level', { level: record.thinkingLevel }).catch(() => {}) : null,
      ]);
    }
    this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    return session;
  }

  // After the app starts, re-attach to SSH sessions that kept running in their host's relay.
  async resumeRemote() {
    // Set up every added host in the background now, so the first message there doesn't pay for it.
    for (const env of this.environments().filter(e => e.kind === 'ssh' && e.added && e.enabled)) this.prepare(env.id).catch(() => {});
    const byEnv = new Map();
    for (const record of this.store.sessions.filter(s => !s.archived && s.environmentId !== 'local')) {
      if (!byEnv.has(record.environmentId)) byEnv.set(record.environmentId, []);
      byEnv.get(record.environmentId).push(record);
    }
    await Promise.all([...byEnv].map(async ([envId, records]) => {
      try {
        const env = this.env(envId);
        const facts = await this.prepare(envId);
        const alive = new Set((await listRelaySessions(env, facts)).filter(s => s.alive).map(s => s.id));
        await Promise.all(records.filter(r => alive.has(r.id)).map(r => this.ensureStarted(r.id).catch(() => {})));
      } catch { /* host unreachable: sessions stay idle until opened */ }
    }));
  }

  #onEvent(record, runtime, event) {
    if (event.type === 'agent_start') { runtime.streaming = true; this.emit('status', { id: record.id, status: runtime.status, streaming: true }); }
    if (event.type === 'agent_settled') { runtime.streaming = false; this.#save(record, { lastActiveAt: Date.now() }); this.emit('status', { id: record.id, status: runtime.status, streaming: false }); }
    this.emit('event', { id: record.id, event });
  }

  // Extension dialogs are questions for the person at the desktop (e.g. from the ask_user tool).
  #onUi(record, runtime, request) {
    if (['select', 'input', 'confirm', 'editor'].includes(request.method)) {
      if (runtime.questions.has(request.id)) return; // re-delivered by the relay after a reconnect
      const question = { requestId: request.id, method: request.method, title: request.title, message: request.message, options: request.options, placeholder: request.placeholder, prefill: request.prefill };
      runtime.questions.set(request.id, question);
      this.emit('question', { id: record.id, question });
      return;
    }
    if (request.method === 'notify') this.emit('notice', { id: record.id, level: request.notifyType ?? 'info', message: request.message });
  }


  async prompt(id, text) {
    const record = this.record(id);
    const session = await this.ensureStarted(id);
    await this.#syncProviders(this.runtimes.get(id)).catch(() => {});
    if (record.title === 'New session') {
      const title = titleFrom(text);
      this.#save(record, { title });
      session.request('set_session_name', { name: title }).catch(() => {});
    }
    const runtime = this.runtimes.get(id);
    return session.prompt(text, runtime.streaming ? { streamingBehavior: 'followUp' } : {});
  }

  // payload: { value } for select/input/editor, { confirmed } for confirm, or { cancelled: true }.
  answer(id, requestId, payload) {
    const runtime = this.runtimes.get(id);
    if (!runtime?.questions.has(requestId)) return false;
    runtime.questions.delete(requestId);
    runtime.session.respondUi(requestId, payload);
    this.emit('question-resolved', { id, requestId });
    return true;
  }

  async abort(id) { const runtime = this.runtimes.get(id); if (runtime?.session) await runtime.session.abort(); }

  async setModel(id, provider, modelId) {
    const record = this.record(id);
    let runtime = this.runtimes.get(id);
    // A host that can't reach this model's endpoint needs its traffic relayed through this Mac, which is
    // wired up when Pi starts. A session started without it is restarted (same session file, history kept).
    const env = this.env(record.environmentId);
    if (env.kind === 'ssh' && runtime?.session && !record.egressPort) {
      const baseUrl = (await this.catalog().catch(() => [])).find(m => m.provider === provider && m.id === modelId)?.baseUrl;
      const facts = baseUrl?.startsWith('https://') ? await this.prepare(env.id) : null;
      if (facts?.unreachable?.includes(hostPortOf(baseUrl))) {
        if (runtime.streaming) throw new Error('Wait for the current reply to finish, then switch models.');
        this.#save(record, { model: { provider, id: modelId } });
        await this.close(id);
        await stopRelaySession(env, facts, id).catch(() => {});
        for (let i = 0; i < 50; i++) {
          const entry = (await listRelaySessions(env, facts).catch(() => [])).find(s => s.id === id);
          if (!entry?.alive) break;
          await new Promise(r => setTimeout(r, 200));
        }
        await this.ensureStarted(id); // fresh Pi with the relay; picks record.model
        return;
      }
    }
    if (runtime?.status === 'connected') {
      await this.#syncProviders(runtime).catch(() => {});
      await runtime.session.setModel(provider, modelId);
    }
    this.#save(record, { model: { provider, id: modelId } });
  }

  async setThinking(id, level) {
    const record = this.record(id);
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await runtime.session.request('set_thinking_level', { level });
    this.#save(record, { thinkingLevel: level });
  }



  async compact(id) { const session = await this.ensureStarted(id); return session.request('compact', {}, { timeout: 300000 }); }


  // Full visible history: the active branch of the session tree, including messages from before any
  // compaction (Pi's get_messages returns only what the model still sees), with compactions as markers.
  async messages(id) {
    const session = await this.ensureStarted(id);
    try {
      const { entries, leafId } = await session.request('get_entries', {}, { timeout: 60000 });
      const byId = new Map(entries.map(e => [e.id, e]));
      const path = [];
      for (let e = byId.get(leafId); e; e = byId.get(e.parentId)) path.push(e);
      path.reverse();
      const out = [];
      for (const e of path) {
        if (e.type === 'message' && e.message) out.push(e.message);
        else if (e.type === 'compaction') out.push({ role: 'compactionSummary', summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.parse(e.timestamp) || 0 });
      }
      return out;
    } catch {
      return session.messages();
    }
  }
  async stats(id) { const runtime = this.runtimes.get(id); if (runtime?.status !== 'connected') return null; return runtime.session.request('get_session_stats'); }

  rename(id, title) {
    const record = this.record(id);
    this.#save(record, { title });
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') runtime.session.request('set_session_name', { name: title }).catch(() => {});
  }

  async archive(id) {
    const record = this.record(id);
    await this.close(id);
    const env = this.environments().find(e => e.id === record.environmentId);
    if (env?.kind === 'ssh') {
      // Archiving ends the remote Pi process too; a detach alone would leave it running.
      this.prepare(env.id).then(facts => stopRelaySession(env, facts, id)).catch(() => {});
    }
    this.#save(record, { archived: true });
  }

  // Disconnect from a session. Local Pi processes stop; SSH sessions only detach and keep running remotely.
  async close(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.closing = true;
    clearTimeout(runtime.retryTimer);
    this.runtimes.delete(id);
    await runtime.session?.stop().catch(() => {});
  }

  async shutdown() {
    for (const key of [...this.spares.keys()]) this.#dropSpare(key);
    await Promise.all([...this.runtimes.keys()].map(id => this.close(id)));
    await this.egress?.close();
  }
}
