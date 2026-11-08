// Owns every Pi process the desktop runs, local or remote, and the records needed to resume them.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PiSession } from '../../core/pi-session.mjs';
import { closeSshMux, egressEnv, localRelayTransport, localTransport, relaySpawnSpec, shellQuote, sshRelayTransport } from '../../core/transports.mjs';
import { startEgressProxy, hostPortOf } from '../../core/egress-proxy.mjs';
import { listRelaySessions, prepareRemote, readInstallHint, runSsh, stopRelaySession } from './remote-setup.mjs';
import { providerBaseUrl } from './custom-providers.mjs';
import { CHATGPT_PROVIDER } from '../../agent/pidesk-chatgpt-vault.mjs';
import { SPEEDS, speedOptions } from '../../agent/pidesk-speed.mjs';
import { readHistory } from '../../agent/pidesk-history.mjs';
import { historyEvent } from '../../core/history-view.mjs';

// A conversation record keeps a speed only when it isn't standard.
const speedField = speed => SPEEDS.includes(speed) && speed !== 'standard' ? { speed } : {};

const titleFrom = text => { const line = text.trim().replace(/^\/goal\s+/, '').split('\n')[0].replace(/\s+/g, ' '); return line.length > 60 ? line.slice(0, 57) + '…' : line || 'New session'; };

// ---- No folder, as Codex's projectless chats ----
// A conversation started without a folder gets its own directory under a shared root (~/Pi here, ~/pi on
// a host): <root>/<YYYY-MM-DD>/<slug of the first prompt>[-N]/, with work/ for scratch files and outputs/
// for deliverables. Naming follows Codex: up to six [a-z0-9] words of the prompt, else "new-chat".
export const projectlessSlug = prompt => {
  const words = String(prompt ?? '').replace(/^\/goal\s+/, '').toLowerCase().match(/[a-z0-9]+/g);
  return words?.length ? words.slice(0, 6).join('-').slice(0, 80) : 'new-chat';
};
const projectlessDay = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
function makeProjectlessDir(root, prompt) {
  const day = join(root, projectlessDay());
  mkdirSync(day, { recursive: true });
  const base = projectlessSlug(prompt);
  const names = [...Array.from({ length: 100 }, (_, i) => (i ? `${base}-${i + 1}` : base)), `${base}-${randomUUID().slice(0, 8)}`];
  for (const name of names) {
    const dir = join(day, name);
    try { mkdirSync(dir); } catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
    for (const sub of ['work', 'outputs']) try { mkdirSync(join(dir, sub)); } catch { /* the directory itself still works */ }
    return dir;
  }
  throw new Error(`No free directory name under ${day}`);
}
// The spare Pi kept warm for a new No-folder conversation (it runs in the root until the first message).
const projectlessSpareKey = environmentId => `${environmentId}\n*no folder*`;
// A fresh session file for a directory, in Pi's documented layout (docs/session-format.md): a running Pi
// that switch_session-es to it continues in that directory with a new, empty conversation.
const sessionDirName = cwd => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
function sessionHeader(cwd) {
  const timestamp = new Date().toISOString();
  const id = randomUUID();
  return { name: `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`, line: JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd }) + '\n' };
}
const remoteBase = path => path.split('/').filter(Boolean).pop() ?? path;
// The visible history: the branch ending at `leafId`, with compactions as markers (shared by the live
// get_entries path and the session-file path).
export function branchMessages(entries, leafId) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const path = [];
  for (let e = byId.get(leafId); e; e = byId.get(e.parentId)) path.push(e);
  path.reverse();
  // Pi keeps failed attempts in raw history, then context_edit(null) omits them for
  // recovery. Preserve that fact for the UI instead of reviving a recovered red error.
  const omitted = new Map();
  for (const e of path) if (e.type === 'context_edit') omitted.set(e.targetId, e.replacement === null);
  const out = [];
  for (const e of path) {
    if (e.type === 'message' && e.message) out.push(e.message.stopReason === 'error' && omitted.get(e.id) ? { ...e.message, __retryOmitted: true } : e.message);
    // Extension messages (agent reports, goal prompts), as Pi gives them to the model.
    else if (e.type === 'custom_message') out.push({ role: 'custom', customType: e.customType, content: e.content, display: e.display, details: e.details, timestamp: Date.parse(e.timestamp) || 0 });
    else if (e.type === 'compaction') out.push({ role: 'compactionSummary', summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.parse(e.timestamp) || 0 });
  }
  return out;
}

// Conversations from the removed Cursor CLI engine remain readable from their history file, and deletable.
const CURSOR_REMOVED = 'Cursor CLI was removed from Pi Desktop; this conversation is read-only.';
const ACTIVE_AGENT = new Set(['queued', 'running', 'retrying']);

// Process lifecycle: a Pi is kept running while it may be needed soon, and stopped when it is not.
const IDLE_STOP_MS = 20 * 60 * 1000; // an idle Pi nobody has looked at for this long is stopped
const MAX_IDLE_PER_ENV = 6;          // and at most this many idle Pis stay up per machine (least recently used go first)
const SWEEP_MS = 60 * 1000;

export class SessionManager extends EventEmitter {
  runtimes = new Map();   // session id -> { session, status, streaming, questions: Map, starting, lastSeq }
  prepared = new Map();   // environment id -> Promise<remote facts>
  preparing = new Map();  // in-flight setup; force/provider changes must not race deployments
  catalogCache = null;
  providersVersion = 0;   // bumped whenever providers/keys change in Settings
  egress = null;

  constructor({ store, environments, local, piVersion, piPackageDir, bridgePath, relayPath, cacheDir, remoteSetup = prepareRemote }) {
    super();
    this.focused = null; // the session on screen: never stopped by the sweep
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), SWEEP_MS);
    this.sweeper.unref?.();
    this.store = store;
    this.environments = environments; // () => [environment]
    this.local = local;               // { node, piCli, agentDir, extraEnv, runDir, uploadDir }
    this.piVersion = piVersion;
    this.bridgePath = bridgePath;
    this.relayPath = relayPath;
    this.cacheDir = cacheDir;
    this.piPackageDir = piPackageDir;
    this.remoteSetup = remoteSetup;
  }

  env(id) {
    const env = this.environments().find(e => e.id === id);
    if (!env) throw new Error(`Unknown environment ${id}`);
    return env;
  }

  // Start a throwaway Pi through this machine's relay and read its state (used by the packaged-build smoke test).
  async piSelfTest() {
    const id = 'selftest-' + randomUUID().slice(0, 8);
    const spawn = relaySpawnSpec({ cwd: this.local.agentDir, node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, extensions: [this.bridgePath], piArgs: ['--no-session'], extraEnv: this.local.extraEnv });
    mkdirSync(this.local.agentDir, { recursive: true });
    const session = new PiSession({ id, boot: { providers: [] }, transport: localRelayTransport({ node: this.local.node, relayPath: this.relayPath, runDir: this.local.runDir, extraEnv: this.local.extraEnv }), relay: { spawn } });
    await session.start({ readyTimeout: 60000 });
    const state = session.initialState;
    await session.stop();
    await this.#localRelay(['stop', id]).catch(() => {});
    return { sessionId: state?.sessionId ?? null };
  }

  // ---------------------------------------------------------------- relays
  // Local and SSH sessions both live in a relay daemon (this machine's, or the host's). A host's keeps
  // its sessions running when the connection drops or the app quits; this machine's lasts only until
  // the app quits (shutdown).
  #localRelay(args) {
    return new Promise((resolve, reject) => execFile(this.local.node, [this.relayPath, ...args], { env: { ...process.env, ...this.local.extraEnv, PIDESK_RUN_DIR: this.local.runDir }, timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  }
  async relaySessions(env) {
    if (env.kind === 'local') return JSON.parse((await this.#localRelay(['list'])).trim().split('\n').pop()).sessions ?? [];
    return listRelaySessions(env, await this.prepare(env.id));
  }
  async stopRelay(env, id) {
    if (env.kind === 'local') return this.#localRelay(['stop', id]);
    return stopRelaySession(env, await this.prepare(env.id), id);
  }

  async chatGPTTarget(environmentId) {
    const env = this.env(environmentId);
    if (env.kind === 'local') return { ...this.local, env, authPath: join(dirname(this.bridgePath), 'pidesk-chatgpt-auth.mjs') };
    if (!env.enabled) throw new Error('Enable this SSH connection before signing in.');
    const facts = await this.prepare(environmentId);
    return { env, node: facts.node, piCli: facts.piCli, agentDir: facts.agentDir, runDir: facts.runDir,
      authPath: join(dirname(facts.bridge), 'pidesk-chatgpt-auth.mjs') };
  }

  // ---------------------------------------------------------------- providers and models
  bootProviders(environmentId = 'local') {
    const providers = this.store.settings.providers.flatMap(provider => {
      const apiKey = this.store.getKey(provider.id);
      if (!apiKey && provider.kind === 'builtin') return [];
      const entry = { id: provider.id, apiKey: apiKey ?? undefined };
      // The base its SDK needs (e.g. an Anthropic base saved with /v1), for providers saved before too.
      if (provider.kind === 'custom') Object.assign(entry, { name: provider.name, api: provider.api, baseUrl: providerBaseUrl(provider.api, provider.baseUrl), models: provider.models, headers: provider.headers });
      // A built-in provider with a chosen model list replaces its catalog with exactly those models.
      else if (provider.models?.length) entry.models = provider.models;
      return [entry];
    });
    const subscription = this.chatgpt?.config(environmentId);
    return subscription ? [...providers, subscription] : providers;
  }

  invalidateCatalog() { this.catalogCache = null; }

  // Keys and model lists changed: running Pi processes (including ones kept alive by a host's relay)
  // still hold what they started with, so send them the current providers.
  providersChanged() {
    this.providersVersion += 1;
    this.invalidateCatalog();
    this.prepared.clear();
    for (const key of [...this.spares.keys()]) this.#dropSpare(key);
    for (const runtime of this.runtimes.values()) if (runtime.status === 'connected') {
      this.#syncProviders(runtime).then(() => {
        const record = this.#recordOf(runtime.session?.id);
        if (record?.model?.provider === CHATGPT_PROVIDER) return this.#applyModel(record, runtime)
          .then(() => this.emit('model-settings', { id: record.id }));
      }).catch(() => {});
    }
  }
  // Desktop settings a Pi applies itself (Settings → Subagents, the conversation's speed): in its boot
  // record, then by command whenever they changed or the Pi started without them.
  bootConfig(record) { return { subagents: this.store.settings.defaults?.subagents ?? 'limited', speed: record?.speed ?? 'standard', ultra: !!record?.ultra }; }
  configChanged() {
    for (const [id, runtime] of this.runtimes) if (runtime.status === 'connected') this.#syncConfig(runtime, this.#recordOf(id)).catch(() => {});
  }
  #recordOf(id) { return this.store.sessions.find(s => s.id === id) ?? [...this.spares.values()].find(sp => sp.id === id)?.record; }
  async #syncConfig(runtime, record) {
    const session = runtime?.session;
    const key = JSON.stringify(this.bootConfig(record));
    if (!session || runtime.configKey === key) return;
    await session.prompt(`/pidesk-config ${Buffer.from(key).toString('base64')}`);
    if (runtime.session === session) runtime.configKey = key;
  }
  // The model and effort chosen for this conversation, made true in its Pi: when it attaches (one that
  // kept running may have missed a change), after each change and before each prompt. One change at a
  // time and the effort after the model, because Pi resets the effort when the model changes. What the
  // Pi has is tracked in runtime.applied, so a prompt with nothing to change costs no request.
  #applyModel(record, runtime) {
    const session = runtime?.session;
    if (!session) return Promise.resolve();
    const run = async () => {
      if (runtime.session !== session) return;
      const want = record.model;
      if (want?.provider === CHATGPT_PROVIDER) await this.#syncProviders(runtime);
      let applied = runtime.applied ?? {};
      if (want?.provider === CHATGPT_PROVIDER) {
        if (!this.chatgpt?.catalog().some(m => m.id === want.id && m.environments.includes(record.environmentId))) throw new Error('Choose an enabled ChatGPT model for this environment in Settings.');
        await this.chatgpt.ensure(record.environmentId);
        if (runtime.chatgptSettingsReady === undefined) {
          const available = await session.request('get_available_models');
          runtime.chatgptSettingsReady = available.models?.some(m => m.provider === CHATGPT_PROVIDER && m.pideskChatGPTSettings === 1) ?? false;
        }
      }
      if (want?.provider && want.id && (applied.model?.provider !== want.provider || applied.model?.id !== want.id)) {
        await this.#syncProviders(runtime);
        await session.setModel(want.provider, want.id);
        applied = { model: { provider: want.provider, id: want.id } };
        if (runtime.session === session) runtime.applied = applied;
      }
      if (record.thinkingLevel && applied.thinkingLevel !== record.thinkingLevel) {
        await session.request('set_thinking_level', { level: record.thinkingLevel });
        applied = { ...applied, thinkingLevel: record.thinkingLevel };
      }
      if (runtime.session === session) runtime.applied = applied;
    };
    const queued = (runtime.applying ?? Promise.resolve()).catch(() => {}).then(run);
    runtime.applying = queued;
    return queued;
  }
  async #syncProviders(runtime) {
    const session = runtime?.session;
    if (!session) return;
    while (runtime.session === session && runtime.providersVersion !== this.providersVersion) {
      // Settings updates and the first prompt can arrive together. Send one update at a time,
      // then re-check the version so an older acknowledgement cannot mark newer keys as synced.
      if (runtime.providerSync?.session === session) { await runtime.providerSync.promise; continue; }
      const version = this.providersVersion;
      const payload = Buffer.from(JSON.stringify(this.bootProviders(this.#recordOf(session.id)?.environmentId ?? 'local'))).toString('base64');
      const sync = { session };
      sync.promise = session.prompt(`/pidesk-providers ${payload}`).then(() => {
        if (runtime.session === session) {
          runtime.providersVersion = version;
          if (this.#recordOf(session.id)?.model?.provider === CHATGPT_PROVIDER) runtime.applied = null;
        }
      }).finally(() => { if (runtime.providerSync === sync) runtime.providerSync = null; });
      runtime.providerSync = sync;
      await sync.promise;
    }
  }

  // Models Pi can use with the configured providers, from a short-lived local Pi process.
  async catalog() {
    if (this.catalogCache) return this.catalogCache;
    this.catalogCache = (async () => {
      const configured = new Set(this.store.settings.providers.map(p => p.id));
      const subscription = this.chatgpt?.catalog() ?? [];
      if (!configured.size) return subscription.map(m => ({ ...m, speeds: speedOptions(m) }));
      const session = new PiSession({ id: 'catalog', boot: { providers: this.bootProviders() }, transport: this.#localTransport({ cwd: this.local.agentDir }) });
      try {
        await session.start();
        const models = await session.request('get_available_models').then(d => d.models);
        // Built-in providers can be narrowed to the models the user picked in Settings.
        const enabled = Object.fromEntries(this.store.settings.providers.filter(p => p.enabledModels?.length).map(p => [p.id, new Set(p.enabledModels)]));
        return [...models.filter(m => configured.has(m.provider) && (!enabled[m.provider] || enabled[m.provider].has(m.id))), ...subscription]
          .map(m => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, thinkingLevelMap: m.thinkingLevelMap, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl, input: m.input, speeds: speedOptions(m), ...(m.environments ? { environments: m.environments } : {}) }));
      } finally { await session.stop(); }
    })();
    const cached = this.catalogCache;
    cached.catch(() => { if (this.catalogCache === cached) this.catalogCache = null; });
    return cached;
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
    // All callers, including forced refreshes, share one deployment. Its loop refreshes
    // reachability after provider edits before *any* waiter can use stale setup facts.
    const active = this.preparing.get(envId);
    if (active) return active.promise;
    if (!force && this.prepared.has(envId)) return this.prepared.get(envId);
    const promise = (async () => {
      while (true) {
        const version = this.providersVersion;
        const providerHosts = Promise.resolve(this.providerHosts());
        // Setup may fail before it awaits catalog discovery. Observe both branches immediately,
        // but don't release the deployment lock until remote setup itself has settled.
        providerHosts.catch(() => {});
        const saved = this.store.settings.environments[envId] ?? {};
        const facts = await this.remoteSetup(env, {
          piVersion: this.piVersion, piPackageDir: this.piPackageDir, bridgePath: this.bridgePath, relayPath: this.relayPath, providerHosts,
          root: saved.root, cacheDir: this.cacheDir,
          onProgress: message => this.emit('environment', { id: envId, status: 'preparing', message }),
        });
        await providerHosts;
        // Merge the latest settings, not a snapshot from before a potentially long setup.
        const current = this.store.settings.environments[envId] ?? {};
        if (current.root !== facts.root || !current.added) { this.store.settings.environments[envId] = { ...current, added: true, root: facts.root }; this.store.saveSettings(); this.emit('environments-changed'); }
        if (version === this.providersVersion) { this.prepared.set(envId, promise); return facts; }
      }
    })();
    this.prepared.set(envId, promise);
    const activeSetup = { promise };
    this.preparing.set(envId, activeSetup);
    promise.then(facts => {
      if (this.preparing.get(envId) === activeSetup) this.preparing.delete(envId);
      this.emit('environment', { id: envId, status: 'ready', facts });
    }, error => {
      if (this.preparing.get(envId) === activeSetup) this.preparing.delete(envId);
      if (this.prepared.get(envId) === promise) this.prepared.delete(envId);
      this.emit('environment', { id: envId, status: 'error', message: error.message });
    }).catch(() => {}); // an event listener must not create an unobserved derived rejection
    return promise;
  }

  async #egressFor(hosts, { required = false } = {}) {
    if (!hosts.length && !required) return null;
    if (!this.egress) {
      this.egressStarting ??= startEgressProxy({ allow: [] }).finally(() => { this.egressStarting = null; });
      this.egress = await this.egressStarting;
    }
    this.egress.allow(hosts);
    return this.egress;
  }

  // Environment for every Pi this app starts: 1-hour prompt caching wherever the provider supports it.
  // No-folder conversations also get PIDESK_PROJECTLESS, for the bridge's projectless prompt section.
  piEnv(record) { return { PI_CACHE_RETENTION: 'long', ...(record?.noFolder ? { PIDESK_PROJECTLESS: '1' } : {}) }; }

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
    return { ...record, engine: record.engine === 'cursor' ? 'cursor' : 'pi', status: runtime?.status ?? 'idle', phase: runtime?.phase ?? null, streaming: !!runtime?.streaming, pendingQuestions: runtime ? [...runtime.questions.values()] : [] };
  }
  record(id) {
    const record = this.store.sessions.find(s => s.id === id);
    if (!record) throw new Error(`Unknown session ${id}`);
    return record;
  }
  #save(record, patch) { Object.assign(record, patch, { updatedAt: Date.now() }); if (record.spare) return; this.store.saveSessions(); this.emit('sessions'); }

  // Presentation-only tombstones: never start Pi, inspect JSONL, or change a running task.
  // Bound each IPC request, but retain all earlier IDs (no history can silently reappear).
  clearSubagentHistory(id, historyIds) {
    if (typeof id !== 'string' || !id.trim() || id.length > 1024) throw new Error('Invalid session identifier');
    if (!Array.isArray(historyIds) || historyIds.length > 10000) throw new Error('Subagent history identifiers must be an array of at most 10000 entries');
    for (const historyId of historyIds) {
      if (typeof historyId !== 'string' || !historyId.trim() || historyId.length > 1024) throw new Error('Subagent history identifiers must be nonempty strings of at most 1024 characters');
    }
    const record = this.record(id);
    const previous = record.clearedSubagentIds;
    if (previous !== undefined && (!Array.isArray(previous) || previous.some(value => typeof value !== 'string' || !value.trim()))) {
      throw new Error('Invalid saved subagent history metadata');
    }
    const merged = new Set(previous ?? []);
    const previousSize = merged.size;
    for (const historyId of historyIds) merged.add(historyId);
    const clearedSubagentIds = [...merged];
    if (merged.size === previousSize) return { clearedSubagentIds };
    const hadMetadata = Object.hasOwn(record, 'clearedSubagentIds');
    record.clearedSubagentIds = clearedSubagentIds;
    try {
      // Store.saveSessions writes synchronously via a temporary file + atomic rename.
      this.store.saveSessions();
    } catch (error) {
      if (hadMetadata) record.clearedSubagentIds = previous;
      else delete record.clearedSubagentIds;
      throw error;
    }
    this.emit('sessions');
    return { clearedSubagentIds: [...clearedSubagentIds] };
  }

  // ---------------------------------------------------------------- pre-warming
  // While the user is on the new-session screen, start a Pi in advance where the next conversation will
  // run; the first message then adopts it instead of waiting for SSH + Pi start-up. With No folder the
  // spare runs in the root and moves into the conversation's own directory when the first message names it.
  spares = new Map(); // `${environmentId}\n${cwd}` (or projectlessSpareKey) -> { id, record, timer }
  async prewarm({ environmentId, cwd: chosen, model, thinkingLevel, speed, noFolder }) {
    if (!environmentId) return false;
    const env = this.environments().find(e => e.id === environmentId);
    if (!env || (env.kind === 'ssh' && !env.enabled)) return false;
    const cwd = chosen || await this.projectlessRoot(environmentId).catch(() => null);
    if (!cwd) return false;
    const key = chosen ? `${environmentId}\n${cwd}` : projectlessSpareKey(environmentId);
    for (const [k] of this.spares) if (k !== key) this.#dropSpare(k);
    const existing = this.spares.get(key);
    if (existing) { this.#armSpare(key, existing); return true; }
    const record = { id: randomUUID(), title: 'New session', environmentId, environmentLabel: env.label, cwd, noFolder: (!chosen || noFolder) || undefined, model, thinkingLevel: thinkingLevel ?? 'medium', ...speedField(speed), spare: true };
    const spare = { id: record.id, record };
    this.spares.set(key, spare);
    this.#armSpare(key, spare);
    this.ensureStarted(record.id, record).catch(() => {
      // A cancelled start may finish after another spare has taken the same key.
      if (this.spares.get(key) === spare) this.#dropSpare(key);
    });
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
    this.#stopSpare(spare).catch(() => {});
  }
  async #stopSpare(spare) {
    clearTimeout(spare.timer);
    // Wait for any in-flight attach to finish before stopping the relay's Pi.
    await this.close(spare.id);
    const env = this.environments().find(e => e.id === spare.record.environmentId);
    if (env) await this.stopRelay(env, spare.id).catch(() => {});
  }
  // ---------------------------------------------------------------- No folder
  // The shared root of No-folder conversations: ~/Pi on this Mac, ~/pi on a host.
  async projectlessRoot(environmentId) {
    const env = this.env(environmentId);
    if (env.kind === 'local') {
      const root = process.env.PIDESK_DEFAULT_WORKSPACE ?? join(homedir(), 'Pi');
      mkdirSync(root, { recursive: true });
      return root;
    }
    this.defaultDirs ??= new Map();
    if (!this.defaultDirs.has(env.id)) {
      const out = await runSsh(env, 'mkdir -p "$HOME/pi" && cd "$HOME/pi" && pwd', { timeout: 30000 });
      this.defaultDirs.set(env.id, out.trim().split('\n').pop());
    }
    return this.defaultDirs.get(env.id);
  }
  // A new conversation's own directory, named from its first prompt.
  async #projectlessDir(env, prompt) {
    const root = await this.projectlessRoot(env.id);
    if (env.kind === 'local') return makeProjectlessDir(root, prompt);
    const script = [
      'set -e',
      `root=${shellQuote(root)}; day=${projectlessDay()}; base=${shellQuote(projectlessSlug(prompt))}`,
      'mkdir -p "$root/$day"',
      'i=1',
      'while [ "$i" -le 100 ]; do',
      '  name=$base; if [ "$i" -gt 1 ]; then name="$base-$i"; fi',
      `  if mkdir "$root/$day/$name" 2>/dev/null; then mkdir -p "$root/$day/$name/work" "$root/$day/$name/outputs" || true; printf '%s\\n' "$root/$day/$name"; exit 0; fi`,
      '  i=$((i + 1))',
      'done',
      'echo "no free directory name under $root/$day" >&2; exit 1',
    ].join('\n');
    return (await runSsh(env, script, { timeout: 30000 })).trim().split('\n').pop();
  }
  // Move a running Pi into `cwd`: a fresh session file for that directory, then switch_session to it.
  async #moveInto(environmentId, session, cwd) {
    const env = this.env(environmentId);
    const { name, line } = sessionHeader(cwd);
    let file;
    if (env.kind === 'local') {
      const dir = join(this.local.agentDir, 'sessions', sessionDirName(cwd));
      mkdirSync(dir, { recursive: true });
      file = join(dir, name);
      writeFileSync(file, line, { flag: 'wx' });
    } else {
      const facts = await this.prepare(env.id);
      const dir = `${facts.agentDir}/sessions/${sessionDirName(cwd)}`;
      file = `${dir}/${name}`;
      await runSsh(env, `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(file)}`, { input: line, timeout: 30000 });
    }
    const result = await session.request('switch_session', { sessionPath: file }, { timeout: 60000 });
    if (result?.cancelled) throw new Error('Moving the pre-warmed Pi was cancelled.');
  }

  async create({ environmentId, cwd: chosen, model, thinkingLevel, speed, ultra, prompt }) {
    const env = this.env(environmentId);
    const noFolder = !chosen;
    const cwd = noFolder ? await this.#projectlessDir(env, prompt) : chosen;
    const fields = {
      title: 'New session', environmentId, environmentLabel: env.label, cwd, noFolder: noFolder || undefined,
      project: noFolder ? 'No folder' : env.kind === 'local' ? basename(cwd) : remoteBase(cwd),
    };
    const spareKey = noFolder ? projectlessSpareKey(environmentId) : `${environmentId}\n${cwd}`;
    const spare = this.spares.get(spareKey);
    if (spare) {
      this.spares.delete(spareKey);
      clearTimeout(spare.timer);
      try { return await this.#adopt(spare.record, fields, { model, thinkingLevel, speed, ultra }); }
      catch { await this.#stopSpare(spare); } // the warm Pi failed or could not move: start a fresh one below
    }
    const record = { id: randomUUID(), ...fields, model, thinkingLevel: thinkingLevel ?? 'medium', ...speedField(speed), ...(ultra ? { ultra: true } : {}), createdAt: Date.now(), updatedAt: Date.now() };
    this.#add(record);
    await this.ensureStarted(record.id);
    return this.#view(record);
  }
  #add(record) {
    this.store.sessions.unshift(record);
    if (!record.noFolder) this.store.touchRecent(record.environmentId, record.cwd);
    this.store.saveSessions();
    this.emit('sessions');
  }
  // Take over a pre-warmed Pi. No folder: it runs in the root, so it first moves into the conversation's
  // directory; that starts a fresh session there, so the model and effort are compared against Pi's state.
  async #adopt(spareRecord, fields, { model, thinkingLevel, speed, ultra }) {
    const session = await this.ensureStarted(spareRecord.id, spareRecord);
    let current = {};
    if (fields.noFolder) {
      // A fresh session in the conversation's directory: what the Pi has now is its own state.
      await this.#moveInto(spareRecord.environmentId, session, fields.cwd);
      current = await session.state();
      const runtime = this.runtimes.get(spareRecord.id);
      if (runtime?.session === session) runtime.applied = { model: current.model ? { provider: current.model.provider, id: current.model.id } : null, thinkingLevel: current.thinkingLevel };
    }
    const record = Object.assign(spareRecord, fields, { createdAt: Date.now(), updatedAt: Date.now() });
    delete record.spare;
    if (fields.noFolder) Object.assign(record, { piSessionFile: current.sessionFile, piSessionId: current.sessionId });
    this.#add(record);
    // A speed other than the spare's reaches its Pi with the first prompt (#syncConfig).
    const wantSpeed = speedField(speed ?? record.speed);
    if (!wantSpeed.speed) delete record.speed;
    if (ultra) record.ultra = true; else delete record.ultra;
    this.#save(record, { model: model ?? record.model, thinkingLevel: thinkingLevel ?? record.thinkingLevel, ...wantSpeed });
    await this.#applyModel(record, this.runtimes.get(record.id)).catch(error => this.emit('notice', { id: record.id, level: 'warning', message: error.message }));
    return this.#view(record);
  }
  #current(record, runtime) { return !runtime.closing && this.runtimes.get(record.id) === runtime; }
  #assertCurrent(record, runtime) {
    if (!this.#current(record, runtime)) throw Object.assign(new Error('Session start cancelled'), { code: 'SESSION_CANCELLED' });
  }
  #status(record, runtime, patch) {
    if (Object.hasOwn(patch, 'phase')) runtime.phase = patch.phase;
    // Pre-warming is an implementation detail, not a visible conversation. In particular,
    // changing folders deliberately stops its connection and must not show an error toast.
    if (!record.spare && this.#current(record, runtime)) this.emit('status', { id: record.id, ...patch });
  }

  // Connect (or reconnect) a session. SSH sessions live in the host's relay, so a dropped connection is
  // retried with backoff and resumes from the last event seen; Pi keeps working in the meantime.
  ensureStarted(id, recordOverride) {
    let runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') return Promise.resolve(runtime.session);
    if (runtime?.starting) return runtime.starting;
    const record = recordOverride ?? [...this.spares.values()].find(sp => sp.id === id)?.record ?? this.record(id);
    if (record.engine === 'cursor') return Promise.reject(new Error(CURSOR_REMOVED));
    if (!runtime) {
      runtime = { session: null, status: 'idle', streaming: false, questions: new Map(), starting: null, lastSeq: null, retry: 0, retryTimer: null, closing: false, autoReconnect: false };
      this.runtimes.set(id, runtime);
    }
    clearTimeout(runtime.retryTimer);
    runtime.closing = false;
    runtime.status = runtime.autoReconnect ? 'reconnecting' : 'connecting';
    this.#status(record, runtime, { status: runtime.status, phase: 'connecting' });
    runtime.starting = this.#start(record, runtime).then(session => {
      this.#assertCurrent(record, runtime);
      runtime.status = 'connected'; runtime.starting = null; runtime.retry = 0; runtime.lastUsed = Date.now();
      this.#status(record, runtime, { status: 'connected', phase: null, streaming: runtime.streaming });
      // A Settings edit, or a model or effort chosen, can land after configuration's last await but
      // before this callback.
      this.#syncProviders(runtime).catch(() => {});
      this.#applyModel(record, runtime).catch(() => {});
      return session;
    }).catch(error => {
      runtime.starting = null;
      if (!this.#current(record, runtime)) throw error;
      if (runtime.autoReconnect && !record.spare) this.#scheduleReconnect(record, runtime, error.message);
      else { runtime.status = 'error'; runtime.error = error.message; this.#status(record, runtime, { status: 'error', phase: null, message: error.message }); }
      throw error;
    });
    return runtime.starting;
  }

  #scheduleReconnect(record, runtime, reason) {
    if (runtime.closing || this.runtimes.get(record.id) !== runtime) return;
    const delay = Math.min(30000, 1000 * 2 ** runtime.retry);
    runtime.retry += 1;
    runtime.status = 'reconnecting';
    this.#status(record, runtime, { status: 'reconnecting', phase: 'connecting', message: reason, retryIn: delay });
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => this.ensureStarted(record.id).catch(() => {}), delay);
  }

  async #start(record, runtime) {
    const env = this.env(record.environmentId);
    const bootVersion = this.providersVersion;
    const boot = { providers: this.bootProviders(record.environmentId), config: this.bootConfig(record) };
    const piArgs = record.piSessionFile ? ['--session', record.piSessionFile] : [];
    let session;
    if (env.kind === 'local') {
      mkdirSync(this.local.agentDir, { recursive: true });
      const spawn = relaySpawnSpec({ cwd: record.cwd, node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, extensions: [this.bridgePath], piArgs, extraEnv: { ...this.local.extraEnv, ...this.piEnv(record) } });
      const transport = localRelayTransport({ node: this.local.node, relayPath: this.relayPath, runDir: this.local.runDir, extraEnv: this.local.extraEnv });
      session = new PiSession({ id: record.id, boot, transport, relay: { sinceSeq: runtime.lastSeq, spawn } });
    } else {
      this.#status(record, runtime, { status: runtime.status, phase: 'preparing' });
      const facts = await this.prepare(env.id);
      // A running relay Pi retains its proxy environment. Even if a fresh probe now says the
      // endpoint is reachable, reconnect the old fixed forward rather than strand that Pi.
      const hosts = record.egressPort ? [...new Set([...(facts.unreachable ?? []), ...await this.providerHosts()])] : facts.unreachable ?? [];
      const egressProxy = await this.#egressFor(hosts, { required: !!record.egressPort });
      this.#assertCurrent(record, runtime);
      // The remote port is fixed per session: the relay's Pi keeps HTTPS_PROXY across reconnects.
      if (egressProxy && !record.egressPort) this.#save(record, { egressPort: 30000 + Math.floor(Math.random() * 30000) });
      const egress = egressProxy && { localPort: egressProxy.port, remotePort: record.egressPort };
      const spawn = relaySpawnSpec({ cwd: record.cwd, node: facts.node, piCli: facts.piCli, agentDir: facts.agentDir, extensions: [facts.bridge], piArgs, extraEnv: { TMPDIR: facts.tmpDir, ...this.piEnv(record), ...(egress ? egressEnv(egress.remotePort) : {}) } });
      const sharedOnHost = [...this.runtimes.values()].filter(r => r !== runtime && r.shared && r.envId === env.id && r.session && !r.closing).length;
      runtime.envId = env.id; runtime.shared = sharedOnHost < 6;
      const transport = sshRelayTransport({ host: env.host, sshOptions: env.sshArgs ?? [], node: facts.node, relayPath: facts.relay, runDir: facts.runDir, egress, shared: runtime.shared });
      session = new PiSession({ id: record.id, boot, transport, relay: { sinceSeq: runtime.lastSeq, spawn } });
    }
    runtime.session = session;
    runtime.questions.clear();
    const current = () => this.#current(record, runtime) && runtime.session === session;
    session.on('attached', info => {
      if (current()) this.#status(record, runtime, { status: runtime.status, phase: info.created ? 'starting' : 'connecting' });
    });
    session.on('event', event => { if (current()) { runtime.lastSeq = session.lastSeq; this.#onEvent(record, runtime, event); } });
    session.on('ui', request => { if (current()) this.#onUi(record, runtime, request); });
    session.on('gap', () => { if (current() && !record.spare) this.emit('resync', { id: record.id }); });
    session.on('exit', ({ piExited }) => {
      if (this.runtimes.get(record.id) !== runtime || runtime.session !== session || runtime.closing) return;
      runtime.lastSeq = session.lastSeq;
      runtime.streaming = false;
      if (runtime.questions.size) { runtime.questions.clear(); this.emit('questions-cleared', { id: record.id }); }
      const message = (session.piExit?.stderr || session.stderr).trim().split('\n').slice(-2).join(' ');
      if (!piExited && runtime.status === 'connected' && !record.spare) { this.#scheduleReconnect(record, runtime, message || 'Connection lost'); return; }
      if (runtime.starting) return; // the start promise reports this failure
      runtime.status = 'disconnected';
      if (piExited) runtime.lastSeq = null; // a new Pi process numbers its events from scratch
      this.#status(record, runtime, { status: 'disconnected', phase: null, message: piExited ? 'Pi stopped' + (message ? `: ${message}` : '') : message });
    });
    try {
      this.#status(record, runtime, { status: runtime.status, phase: 'connecting' });
      await session.start({ readyTimeout: 90000 });
      this.#assertCurrent(record, runtime);
      this.#status(record, runtime, { status: runtime.status, phase: 'configuring' });
      return await this.#configureSession(record, runtime, session, bootVersion, JSON.stringify(boot.config));
    } catch (error) {
      await session.stop().catch(() => {});
      if (runtime.session === session) runtime.session = null;
      if (session.attachInfo?.created) await this.stopRelay(env, record.id).catch(() => {});
      throw error;
    }
  }

  async #configureSession(record, runtime, session, bootVersion, bootConfigKey) {
    runtime.lastSeq = session.lastSeq;
    const created = !!session.attachInfo?.created;
    runtime.autoReconnect = true;
    const state = session.initialState ?? await session.state();
    runtime.streaming = !!state.isStreaming;
    runtime.applied = { model: state.model ? { provider: state.model.provider, id: state.model.id } : null, thinkingLevel: state.thinkingLevel };
    const info = session.attachInfo;
    const processKey = info?.pid && info?.startedAt ? `${info.pid}:${info.startedAt}` : null;
    const sameProcess = processKey && runtime.providerProcess === processKey;
    // A Pi this desktop just started has its boot settings, and the same process still has what we
    // sent it; another one that kept running may not.
    if (created) runtime.configKey = bootConfigKey;
    else if (!sameProcess) runtime.configKey = null;
    // Agents live inside a Pi process: another process means the known ones are gone.
    if (!sameProcess && runtime.agents?.size) { runtime.agents = new Map(); this.emit('agents', { id: record.id, agents: [] }); }
    // Only skip registration when this exact relay process already acknowledged these providers.
    // App restarts, missing/changed process identity, and changed keys still force a sync.
    // A previous transport may still have a provider command in flight on this same Pi.
    // Drain it before sending newer credentials; acknowledgements on an old transport
    // intentionally do not advance this runtime's version.
    if (sameProcess && runtime.providerSync) {
      await runtime.providerSync.promise.catch(() => {});
      runtime.providersVersion = -1;
    }
    if (created) runtime.providersVersion = bootVersion;
    else if (!sameProcess) runtime.providersVersion = -1;
    runtime.providerProcess = processKey;
    await this.#syncProviders(runtime);
    if (!created) {
      // A Pi that kept running without us may be mid-run with older settings (a speed changed meanwhile).
      await this.#syncConfig(runtime, record).catch(() => {});
      session.prompt('/goal').catch(() => {}); // re-publish the goal of a Pi that kept running without us
    }
    // Also a Pi that kept running while the model or effort was changed here: it still has the old ones.
    await this.#applyModel(record, runtime).catch(error => { if (!record.spare && this.#current(record, runtime)) this.emit('notice', { id: record.id, level: 'warning', message: error.message }); });
    this.#assertCurrent(record, runtime);
    this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    return session;
  }

  // After the app starts, re-attach to sessions that kept running in a relay (this machine's or a host's).
  async resumeRemote() {
    // Set up every added host in the background now, so the first message there doesn't pay for it.
    for (const env of this.environments().filter(e => e.kind === 'ssh' && e.added && e.enabled)) this.prepare(env.id).catch(() => {});
    const byEnv = new Map();
    for (const record of this.store.sessions.filter(s => !s.archived)) {
      if (!byEnv.has(record.environmentId)) byEnv.set(record.environmentId, []);
      byEnv.get(record.environmentId).push(record);
    }
    await Promise.all([...byEnv].map(async ([envId, records]) => {
      try {
        const env = this.env(envId);
        const alive = new Set((await this.relaySessions(env)).filter(s => s.alive).map(s => s.id));
        // A Cursor CLI still running from an older version is stopped, not re-attached.
        await Promise.all(records.filter(r => alive.has(r.id)).map(r => (r.engine === 'cursor' ? this.stopRelay(env, r.id) : this.ensureStarted(r.id)).catch(() => {})));
      } catch { /* host unreachable: sessions stay idle until opened */ }
    }));
  }

  #onEvent(record, runtime, event) {
    runtime.lastUsed = Date.now();
    if (event.type === 'agent_start') { runtime.streaming = true; this.emit('status', { id: record.id, status: runtime.status, streaming: true }); }
    if (event.type === 'agent_settled') { runtime.streaming = false; this.#save(record, { lastActiveAt: Date.now() }); this.emit('status', { id: record.id, status: runtime.status, streaming: false }); }
    const visible = historyEvent(event);
    if (visible) this.emit('event', { id: record.id, event: visible });
  }

  // Extension dialogs are questions for the person at the desktop (e.g. from the ask_user tool).
  #onUi(record, runtime, request) {
    if (record.spare && request.method === 'notify') return;
    if (['select', 'input', 'confirm', 'editor'].includes(request.method)) {
      if (runtime.questions.has(request.id)) return; // re-delivered by the relay after a reconnect
      const question = { requestId: request.id, method: request.method, title: request.title, message: request.message, options: request.options, placeholder: request.placeholder, prefill: request.prefill };
      runtime.questions.set(request.id, question);
      this.emit('question', { id: record.id, question });
      return;
    }
    if (request.method === 'notify') this.emit('notice', { id: record.id, level: request.notifyType ?? 'info', message: request.message });
    if (request.method === 'setStatus' && request.statusKey === 'pidesk-title' && request.statusText) {
      if (record.autoTitle && record.title === record.autoTitle && request.statusText !== record.title) {
        this.#save(record, { title: request.statusText, autoTitle: request.statusText });
        runtime.session?.request('set_session_name', { name: request.statusText }).catch(() => {});
      }
      return;
    }
    if (request.method === 'setStatus' && request.statusKey === 'pidesk-ultra') {
      const before = runtime.ultra?.task?.status;
      try { runtime.ultra = request.statusText ? JSON.parse(request.statusText) : null; } catch { runtime.ultra = null; }
      const after = runtime.ultra?.task?.status;
      this.emit('ultra', { id: record.id, ultra: runtime.ultra, ...(before === 'active' && after && after !== 'active' ? { ended: after, title: record.title } : {}), local: record.environmentId === 'local' });
      return;
    }
    if (request.method === 'setStatus' && request.statusKey === 'pidesk-goal') {
      try { runtime.goal = request.statusText ? JSON.parse(request.statusText) : null; } catch { runtime.goal = null; }
      this.emit('goal', { id: record.id, goal: runtime.goal });
    }
    // Live state of the agents running in this Pi (newest wins: the relay may replay older lines).
    if (request.method === 'setStatus' && request.statusKey === 'pidesk-agents' && request.statusText) {
      let agents = [];
      try { agents = JSON.parse(request.statusText).agents ?? []; } catch { return; }
      runtime.agents ??= new Map();
      for (const agent of agents) {
        if (!agent?.id) continue;
        const known = runtime.agents.get(agent.id);
        if (!known || (agent.updatedAt ?? 0) >= (known.updatedAt ?? 0)) runtime.agents.set(agent.id, agent);
      }
      this.emit('agents', { id: record.id, agents: [...runtime.agents.values()] });
    }
  }


  // attachments: [{ kind: 'image', name, mimeType, data (base64) } | { kind: 'file', name, path?, data? }]
  // interrupt: a message sent while Pi works replaces the active run (as in Codex/ChatGPT), instead of
  // waiting for the current assistant turn and its tool calls to finish like a steering message does.
  async prompt(id, text, attachments = [], { interrupt = false } = {}) {
    const record = this.record(id);
    let session = await this.ensureStarted(id);
    let runtime = this.runtimes.get(id);
    if (record.model?.provider === CHATGPT_PROVIDER && !runtime?.chatgptSettingsReady && !runtime?.streaming) {
      await this.setModel(id, record.model.provider, record.model.id);
      session = await this.ensureStarted(id); runtime = this.runtimes.get(id);
    }
    let interrupted = false;
    // While an Ultra task runs, a message joins it (Pi steers it in before the next model call); an
    // interruption would read as Stop and pause the task.
    if (interrupt && runtime?.streaming && runtime.ultra?.task?.status !== 'active') {
      ({ session, runtime } = await this.#interruptForPrompt(id, session, runtime));
      interrupted = true;
    }
    await this.#syncProviders(this.runtimes.get(id));
    await this.#syncConfig(this.runtimes.get(id), record).catch(() => {});
    await this.#applyModel(record, this.runtimes.get(id)).catch(error => {
      if (record.model?.provider === CHATGPT_PROVIDER) throw error;
      this.emit('notice', { id, level: 'warning', message: error.message });
    });
    // The first message names the conversation at once (its first line), and the model then suggests a
    // better title, as Claude does; a title the user set by hand is never replaced.
    let nameIt = null;
    if (record.title === 'New session' && text.trim()) {
      const title = titleFrom(text);
      this.#save(record, { title, autoTitle: title });
      session.request('set_session_name', { name: title }).catch(() => {});
      nameIt = text.trim().replace(/^\/goal\s+/, '');
    }
    const images = attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
    const files = attachments.filter(a => a.kind === 'file');
    let message = text;
    if (files.length) {
      const paths = await this.#placeFiles(record, files);
      message = `${text}${text ? '\n\n' : ''}Attached files:\n${paths.map(p => `- ${p}`).join('\n')}`;
    }
    // Always 'steer' (Pi ignores it when idle): a message sent while Pi works reaches the model before its
    // next call, as in Claude Code, instead of waiting for the whole run to finish ('followUp'). Not keyed on
    // runtime.streaming, which can lag a moment behind Pi and then made the prompt fail.
    const send = target => target.prompt(message, { ...(images.length ? { images } : {}), streamingBehavior: 'steer' });
    let sent = await send(session);
    // The renderer can be a moment behind Pi. If the prompt was queued instead of starting a fresh
    // turn, abort the run that accepted it and send it again; otherwise a stale flag brings back the
    // old "new message waits for the current reply" behaviour.
    if (interrupt && !interrupted && sent?.disposition === 'queued') {
      ({ session, runtime } = await this.#interruptForPrompt(id, session, runtime));
      interrupted = true;
      sent = await send(session);
    }
    if (nameIt && !nameIt.startsWith('/')) session.prompt(`/pidesk-title ${Buffer.from(nameIt).toString('base64')}`).catch(() => {});
    return { ...(sent && typeof sent === 'object' ? sent : {}), interrupted };
  }

  // Stop the active run before sending a replacement prompt. Wait for agent_settled so the next prompt
  // starts a fresh turn; if a tool ignores the abort, hard-stop this Pi and reconnect from its session file.
  async #interruptForPrompt(id, session, runtime) {
    session.abortBash().catch(() => {});
    session.clearQueue().catch(() => {});
    const controller = new AbortController();
    const settled = session.nextSettled(4000, { signal: controller.signal }).then(() => true, () => false);
    // A turn may have ended just before we subscribed: successful abort also proves
    // idle. Rejected aborts do not prove it and must still wait for the bounded fallback.
    const aborted = session.abort().then(() => true, () => settled);
    const finished = await Promise.race([settled, aborted]);
    controller.abort();
    if (finished) return { session, runtime: this.runtimes.get(id) ?? runtime };
    // A tool that ignores the abort signal must not make the new message wait for it.
    const record = this.record(id);
    const env = this.env(record.environmentId);
    await this.close(id).catch(() => {});
    if (env) await this.stopRelay(env, id).catch(() => {});
    this.emit('status', { id, status: 'disconnected', message: 'Stopped' });
    const fresh = await this.ensureStarted(id);
    return { session: fresh, runtime: this.runtimes.get(id) };
  }

  // Put attached files where the session's Pi can read them: as-is on this machine, uploaded to the host.
  async #placeFiles(record, files) {
    const env = this.env(record.environmentId);
    const safe = name => String(name || 'file').replace(/[^\w.@+-]+/g, '_').slice(-120);
    const stamp = Date.now().toString(36);
    if (env.kind === 'local') {
      const dir = join(this.local.uploadDir, record.id, stamp);
      return files.map(f => {
        if (f.path) return f.path;
        mkdirSync(dir, { recursive: true });
        const path = join(dir, safe(f.name));
        writeFileSync(path, Buffer.from(f.data, 'base64'));
        return path;
      });
    }
    const facts = await this.prepare(env.id);
    const dir = `${facts.root}/uploads/${record.id}/${stamp}`;
    const paths = [];
    for (const f of files) {
      const path = `${dir}/${safe(f.name)}`;
      const data = f.path ? readFileSync(f.path) : Buffer.from(f.data, 'base64');
      await runSsh(env, `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`, { input: data, timeout: 600000 });
      paths.push(path);
    }
    return paths;
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

  async abort(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime?.session) return;
    const session = runtime.session;
    // Codex-style interrupt: stop the running command and discard queued steering/follow-up
    // messages immediately, instead of letting the current tool finish and then consuming them.
    session.abortBash().catch(() => {});
    session.clearQueue().catch(() => {});
    const finished = await Promise.race([
      session.abort().then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), 4000)),
    ]);
    // A tool that ignores the abort signal must not leave the UI waiting forever.
    // Stop this Pi (the session file remains the source of truth; the next prompt
    // reconnects) so an interrupt is actually an interrupt.
    if (!finished && this.runtimes.get(id) === runtime && runtime.streaming) {
      const record = this.record(id);
      const env = this.env(record.environmentId);
      await this.close(id).catch(() => {});
      if (env) await this.stopRelay(env, id).catch(() => {});
      this.emit('status', { id, status: 'disconnected', message: 'Stopped' });
    }
  }

  async setModel(id, provider, modelId) {
    const record = this.record(id);
    let runtime = this.runtimes.get(id);
    // A host that can't reach this model's endpoint needs its traffic relayed through this Mac, which is
    // wired up when Pi starts. A session started without it is restarted (same session file, history kept).
    const env = this.env(record.environmentId);
    if (provider === CHATGPT_PROVIDER) {
      if (!this.chatgpt) throw new Error('Sign in to ChatGPT in Settings first.');
      if (!this.chatgpt.catalog().some(m => m.id === modelId && m.environments.includes(record.environmentId))) throw new Error('This ChatGPT model is not configured for this environment.');
      await this.chatgpt.ensure(record.environmentId);
      // An older relay Pi has cached the previous bridge factory. Restart only the chosen idle
      // session if it cannot register the new subscription provider; its JSONL remains untouched.
      if (runtime?.status === 'connected') {
        await this.#syncProviders(runtime);
        const available = await runtime.session.request('get_available_models');
        runtime.chatgptSettingsReady = available.models?.some(m => m.provider === provider && m.id === modelId && m.pideskChatGPTSettings === 1) ?? false;
        if (!runtime.chatgptSettingsReady) {
          if (runtime.streaming) throw new Error('Wait for the current reply to finish, then switch models.');
          this.#save(record, { model: { provider, id: modelId } });
          await this.close(id); await this.stopRelay(env, id); await this.ensureStarted(id); return;
        }
      }
    }
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
    const previous = record.model;
    this.#save(record, { model: { provider, id: modelId } }); // the composer shows it at once
    if (runtime?.status !== 'connected') return; // applied when its Pi attaches or before the next prompt
    try { await this.#applyModel(record, runtime); }
    catch (error) {
      if (record.model?.provider === provider && record.model?.id === modelId) this.#save(record, { model: previous });
      throw error;
    }
  }

  async setThinking(id, level) {
    const record = this.record(id);
    this.#save(record, { thinkingLevel: level });
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#applyModel(record, runtime);
  }
  // Ultra mode (the composer's Ultra switch): Pi works on each request on its own until it is done.
  async setUltra(id, on) {
    const record = this.record(id);
    if (on) record.ultra = true; else delete record.ultra;
    this.#save(record, {});
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#syncConfig(runtime, record);
  }
  ultra(id) { return this.runtimes.get(id)?.ultra ?? null; }
  // Fast or Ultrafast processing (the composer's Speed). A running Pi applies it from its next request.
  async setSpeed(id, speed) {
    if (!SPEEDS.includes(speed)) throw new Error(`Unknown speed: ${speed}`);
    const record = this.record(id);
    if (record.model?.provider === CHATGPT_PROVIDER && this.runtimes.get(id)?.status === 'connected' && !this.runtimes.get(id).chatgptSettingsReady) {
      await this.setModel(id, record.model.provider, record.model.id);
    }
    if (speed === 'standard') delete record.speed;
    this.#save(record, speedField(speed));
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#syncConfig(runtime, record);
  }



  async compact(id) { const session = await this.ensureStarted(id); return session.request('compact', {}, { timeout: 300000 }); }


  // UI pages are projected on the session's machine; never transport get_entries for opening a chat.
  async historyPage(id, options = {}) {
    if (!options.prefetch) this.focus(id);
    const record = this.record(id);
    const encoded = JSON.stringify(options);
    if (encoded.length > 65536) throw new Error('History cursor is too large. Reload the conversation.');
    if (!options.prefetch && record.engine !== 'cursor') this.ensureStarted(id).catch(() => {});
    if (!record.piSessionFile) {
      if (record.engine === 'cursor' || options.prefetch) return { messages: [], next: null };
      const session = await this.ensureStarted(id);
      const state = await session.state();
      if (!state.sessionFile) return { messages: [], next: null };
      record.piSessionFile = state.sessionFile;
    }
    const env = this.env(record.environmentId);
    if (env.kind === 'local') {
      try { return await readHistory(record.piSessionFile, options); }
      catch (error) { if (error.code === 'ENOENT' && !options.cursor && !options.ref) return { messages: [], next: null }; throw error; }
    }
    const readRemote = async facts => {
      const reader = `${facts.root}/ext/pidesk-history.mjs`;
      return JSON.parse(await runSsh(env, `${shellQuote(facts.node)} ${shellQuote(reader)} ${shellQuote(record.piSessionFile)} ${shellQuote(encoded)}`, { timeout: 30000 }));
    };
    // A validated path hint lets history open while provider discovery/Pi startup runs in parallel.
    // Missing or stale installs fall back to the normal versioned deployment, never a full-file read.
    const hint = readInstallHint(env, this.store.settings.environments?.[env.id]?.root, this.cacheDir);
    if (hint) { try { return await readRemote(hint); } catch { /* first upgrade or moved runtime */ } }
    return readRemote(await this.prepare(env.id));
  }

  // Full visible history: the active branch of the session tree, including messages from before any
  // compaction (Pi's get_messages returns only what the model still sees), with compactions as markers.
  // Visible history. A running Pi answers from memory; otherwise the session file is read directly (local
  // file, or one `cat` over the shared SSH connection) while Pi starts in the background, so opening a
  // conversation never waits for a cold Pi.
  async messages(id) {
    this.focus(id);
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') return this.#liveHistory(runtime.session);
    const record = this.record(id);
    if (record.engine === 'cursor') return this.#historyFromFile(record);
    let fromFile = false;
    const starting = this.ensureStarted(id);
    starting.then(session => {
      // Pi was mid-reply when we attached: the file may lack what finished meanwhile; reload from Pi.
      if (fromFile && session.initialState?.isStreaming) this.emit('resync', { id });
    }, () => {});
    if (record.piSessionFile) {
      try {
        const messages = await this.#historyFromFile(record);
        fromFile = true;
        return messages;
      } catch { /* unreadable: ask Pi */ }
    }
    return this.#liveHistory(await starting);
  }
  async #liveHistory(session) {
    try {
      const { entries, leafId } = await session.request('get_entries', {}, { timeout: 60000 });
      return branchMessages(entries, leafId);
    } catch {
      return session.messages();
    }
  }
  async #historyFromFile(record) {
    const env = this.env(record.environmentId);
    const text = env.kind === 'local'
      ? await readFile(record.piSessionFile, 'utf8')
      : await runSsh(env, `cat ${shellQuote(record.piSessionFile)}`, { timeout: 30000 });
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const entry = JSON.parse(line); if (entry?.id) entries.push(entry); } catch { /* torn last line */ }
    }
    if (!entries.length) throw new Error('empty session file');
    return branchMessages(entries, entries.at(-1).id); // Pi resumes at the last entry it wrote
  }

  // ---------------------------------------------------------------- warm-up and lifecycle
  focus(id) { this.focused = id; this.touch(id); }
  touch(id) { const runtime = this.runtimes.get(id); if (runtime) runtime.lastUsed = Date.now(); }
  // Likely to be opened soon (hovered in the sidebar): start its Pi now.
  warm(id) {
    if (!this.store.sessions.some(s => s.id === id)) return false;
    this.ensureStarted(id).then(() => this.touch(id), () => {});
    return true;
  }
  // A spare Pi in the open conversation's folder, so Fork (and a new session there) adopts a running Pi.
  async warmFolder(id) {
    const record = this.store.sessions.find(s => s.id === id);
    if (!record || record.archived || record.engine === 'cursor') return false;
    return this.prewarm({ environmentId: record.environmentId, cwd: record.cwd, model: record.model, thinkingLevel: record.thinkingLevel, speed: record.speed, noFolder: record.noFolder });
  }
  #idle(runtime) {
    return runtime.status === 'connected' && !runtime.streaming && !runtime.starting && !runtime.questions.size && runtime.goal?.status !== 'active' && runtime.ultra?.task?.status !== 'active'
      && ![...(runtime.agents?.values() ?? [])].some(agent => ACTIVE_AGENT.has(agent.status)); // background agents keep it busy
  }
  // Stop Pis that are idle and either unused for IDLE_STOP_MS or beyond MAX_IDLE_PER_ENV on their machine.
  // A stopped session restarts on its next use; its history stays readable from the session file.
  async sweep(now = Date.now()) {
    const spareIds = new Set([...this.spares.values()].map(sp => sp.id));
    const idle = [];
    for (const [id, runtime] of this.runtimes) {
      if (id === this.focused || spareIds.has(id) || !this.#idle(runtime)) continue;
      const record = this.store.sessions.find(s => s.id === id);
      if (record) idle.push({ id, record, used: runtime.lastUsed ?? 0 });
    }
    const stop = new Set(idle.filter(x => now - x.used > IDLE_STOP_MS).map(x => x.id));
    const byEnv = new Map();
    for (const x of idle) { if (!byEnv.has(x.record.environmentId)) byEnv.set(x.record.environmentId, []); byEnv.get(x.record.environmentId).push(x); }
    for (const list of byEnv.values()) list.sort((a, b) => b.used - a.used).slice(MAX_IDLE_PER_ENV).forEach(x => stop.add(x.id));
    await Promise.all([...stop].map(async id => {
      const record = this.store.sessions.find(s => s.id === id);
      const env = record && this.environments().find(e => e.id === record.environmentId);
      await this.close(id);
      if (env) await this.stopRelay(env, id).catch(() => {});
      this.emit('status', { id, status: 'idle' });
    }));
    return [...stop];
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
    // Archiving ends the Pi process too; a detach alone would leave it running in the relay.
    if (env) this.stopRelay(env, id).catch(() => {});
    this.#save(record, { archived: true });
  }

  // Remove a session for good: its Pi process, its session file, and the record.
  async delete(id) {
    const record = this.record(id);
    const env = this.environments().find(e => e.id === record.environmentId);
    // close() marks the runtime as closing synchronously. Stop the relay alongside detaching instead
    // of paying for two round trips in sequence; file removal still waits for both.
    await Promise.all([this.close(id), env ? this.stopRelay(env, id).catch(() => {}) : null]);
    if (env) {
      if (record.piSessionFile) {
        if (env.kind === 'local') rmSync(record.piSessionFile, { force: true });
        else await runSsh(env, `rm -f ${shellQuote(record.piSessionFile)}`).catch(() => {});
      }
    }
    this.store.sessions = this.store.sessions.filter(s => s.id !== id);
    this.store.saveSessions();
    this.emit('sessions');
  }

  // A new session that continues from a copy of this one's history. A spare Pi already running in the
  // same folder (kept warm while the conversation is open) takes it over: switch to the source file and
  // clone it, with no Pi to start. Without one, a fresh Pi does the same.
  async fork(id) {
    const source = this.record(id);
    if (source.engine === 'cursor') throw new Error(CURSOR_REMOVED);
    if (!source.piSessionFile) throw new Error('Send a message before forking this conversation.');
    const env = this.env(source.environmentId);
    const fields = {
      title: `${source.title} (fork)`, environmentId: source.environmentId, environmentLabel: env.label, cwd: source.cwd,
      project: source.project, noFolder: source.noFolder, model: source.model, thinkingLevel: source.thinkingLevel, ...speedField(source.speed),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const key = `${source.environmentId}\n${source.cwd}`;
    const spare = this.spares.get(key);
    let record, session;
    if (spare && this.runtimes.get(spare.id)?.status === 'connected') {
      this.spares.delete(key);
      clearTimeout(spare.timer);
      // Keep the runtime's record object, but do not publish a fork pointing at the source file.
      record = Object.assign(spare.record, fields, { piSessionFile: source.piSessionFile, spare: true });
      session = this.runtimes.get(record.id).session;
    } else {
      record = { id: randomUUID(), ...fields, piSessionFile: source.piSessionFile, spare: true };
    }
    try {
      if (session) {
        const switched = await session.request('switch_session', { sessionPath: source.piSessionFile }, { timeout: 60000 });
        if (switched?.cancelled) throw new Error('Forking was cancelled.');
      } else session = await this.ensureStarted(record.id, record);
      const cloned = await session.request('clone', {}, { timeout: 60000 });
      if (cloned?.cancelled) throw new Error('Forking was cancelled.');
      const state = await session.state();
      if (!state.sessionFile || state.sessionFile === source.piSessionFile) throw new Error('Fork did not create a separate session file.');
      session.request('set_session_name', { name: record.title }).catch(() => {});
      const runtime = this.runtimes.get(record.id);
      if (runtime?.session === session) runtime.applied = { model: state.model ? { provider: state.model.provider, id: state.model.id } : null, thinkingLevel: state.thinkingLevel };
      await this.#applyModel(record, runtime).catch(() => {});
      Object.assign(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
      delete record.spare;
      this.#add(record);
      return this.#view(record);
    } catch (error) {
      // Never use delete(): until clone succeeds piSessionFile still names the source.
      await this.close(record.id);
      await this.stopRelay(env, record.id).catch(() => {});
      throw error;
    }
  }

  // Edit an earlier user message: branch the conversation just before it and send the new text there.
  async editMessage(id, ordinal, originalText, text, attachments = []) {
    const record = this.record(id);
    if (record.engine === 'cursor') throw new Error(CURSOR_REMOVED);
    const session = await this.ensureStarted(id);
    const runtime = this.runtimes.get(id);
    if (runtime.streaming) {
      const settled = session.nextSettled(30000).catch(() => {});
      await session.abort().catch(() => {});
      await settled;
    }
    const { messages } = await session.request('get_fork_messages');
    // The desktop shows messages without Pi's notes about resized images; compare them the same way.
    const plain = text => String(text ?? '').replace(/\n*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/g, '').trim();
    const same = m => plain(m.text) === plain(originalText);
    let target;
    if (typeof ordinal === 'string') target = messages.find(m => m.entryId === ordinal);
    else {
      target = messages[ordinal];
      if (!target || (originalText && !same(target))) target = [...messages].reverse().find(same);
    }
    if (!target) throw new Error('That message can no longer be edited.');
    const result = await session.request('fork', { entryId: target.entryId });
    if (result?.cancelled) throw new Error('Editing was cancelled.');
    const state = await session.state();
    this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    this.emit('rewound', { id }); // the desktop already shows the rewound conversation
    return this.prompt(id, text, attachments);
  }

  async commands(id) {
    const runtime = this.runtimes.get(id);
    if (runtime?.status !== 'connected') return [];
    const { commands } = await runtime.session.request('get_commands').catch(() => ({ commands: [] }));
    return commands.filter(c => !c.name.startsWith('pidesk-') && c.name !== 'goal').map(c => ({ name: c.name, description: c.description ?? '', source: c.source }));
  }

  goal(id) { return this.runtimes.get(id)?.goal ?? null; }
  agents(id) { return [...(this.runtimes.get(id)?.agents?.values() ?? [])]; }
  // The inspector's controls, handled by the bridge's /pidesk-agents command (not recorded in history).
  async stopAgent(id, agentId) {
    const runtime = this.runtimes.get(id);
    if (runtime?.status !== 'connected' || !runtime.agents?.has(agentId)) throw new Error('This agent is not running in this session.');
    await runtime.session.prompt(`/pidesk-agents stop ${agentId}`);
  }
  async messageAgent(id, agentId, text) {
    const runtime = this.runtimes.get(id);
    if (runtime?.status !== 'connected' || !runtime.agents?.has(agentId)) throw new Error('This agent is no longer available in this session.');
    if (!String(text ?? '').trim()) return;
    await runtime.session.prompt(`/pidesk-agents message ${agentId} ${Buffer.from(String(text)).toString('base64')}`);
  }

  // Disconnect from a session. Both local and SSH relays keep Pi running unless explicitly stopped.
  async close(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.closing = true;
    clearTimeout(runtime.retryTimer);
    this.runtimes.delete(id);
    await runtime.session?.stop().catch(() => {});
    // prepare() may still be in flight. #assertCurrent prevents a late spawn, and waiting
    // here lets callers safely stop/delete the relay session after all attaches are done.
    await runtime.starting?.catch(() => {});
  }

  async shutdown() {
    clearInterval(this.sweeper);
    const spares = [...this.spares.values()];
    this.spares.clear();
    await Promise.all(spares.map(spare => this.#stopSpare(spare)));
    await Promise.all([...this.runtimes.keys()].map(id => this.close(id)));
    await this.egress?.close();
    // Nothing of this app keeps running on this Mac after it quits: its relay stops every local Pi (they
    // resume from their session files when opened again). Sessions on SSH hosts keep running there.
    const stopped = await this.#localRelay(['shutdown']).catch(() => '');
    if (!stopped.includes('"relay":"shutdown"')) {
      // A relay daemon from an older version has no shutdown: stop its Pis, then the daemon itself
      // (left alone it would idle for 15 minutes first).
      for (const session of await this.relaySessions({ kind: 'local' }).catch(() => [])) if (session.alive) await this.#localRelay(['stop', session.id]).catch(() => {});
      const daemon = this.relayPath && `${this.relayPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} daemon`;
      if (daemon) await new Promise(resolve => execFile('pkill', ['-f', daemon], () => resolve()));
    }
    await closeSshMux();
  }
}
