// Owns every Pi process the desktop runs, local or remote, and the records needed to resume them.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PiSession } from '../../core/pi-session.mjs';
import { closeSshMux, egressEnv, localRelayTransport, localTransport, relaySpawnSpec, shellQuote, sshRelayTransport } from '../../core/transports.mjs';
import { startEgressProxy, hostPortOf } from '../../core/egress-proxy.mjs';
import { listRelaySessions, prepareRemote, readInstallHint, runSsh, stopRelayCommand, stopRelaySession } from './remote-setup.mjs';
import { providerBaseUrl } from './custom-providers.mjs';
import { builtinModelRoute, listBuiltinModels } from './builtin-providers.mjs';
import { isRetiredProvider, RETIRED_PROVIDER_MESSAGE } from '../../core/retired-providers.mjs';
import { SPEEDS, speedOptions } from '../../agent/pidesk-speed.mjs';
import { readHistory } from '../../agent/pidesk-history.mjs';
import { historyEvent } from '../../core/history-view.mjs';
import { CLAUDE_CODE_VERSION, CLAUDE_EFFORTS, clampClaudeEffort, claudeBuiltinBaseUrl, claudeEffort, ensureLocalClaude, isClaudeCodeModel, prepareRemoteClaude, resolveClaudeEffort } from './claude-code.mjs';
import { ANTIGRAVITY_ENGINE, ANTIGRAVITY_REMOTE_LOGIN, antigravityAccount, antigravityBoot, antigravityInstallMessage, findAntigravityCli, findRemoteAntigravityCli } from './antigravity.mjs';
import { installAntigravityCli } from './antigravity-install.mjs';

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function clampPiThinkingLevel(model, level) {
  if (!model || !level) return level;
  if (model.reasoning === false) return 'off';
  const map = model.thinkingLevelMap ?? {};
  const supported = PI_THINKING_LEVELS.filter(l => map[l] === null ? false : (l === 'xhigh' || l === 'max') ? map[l] !== undefined : true);
  if (supported.includes(level)) return level;
  const idx = PI_THINKING_LEVELS.indexOf(level);
  if (idx === -1) return supported[0] ?? 'off';
  for (let i = idx; i < PI_THINKING_LEVELS.length; i++) if (supported.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
  for (let i = idx - 1; i >= 0; i--) if (supported.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
  return supported[0] ?? 'off';
}

// Conversation engines: Pi by default, or a separate Claude Code / Antigravity CLI adapter.
export const CLAUDE_ENGINE = 'claude-code';
const isClaude = record => record?.engine === CLAUDE_ENGINE;
const isAntigravity = record => record?.engine === ANTIGRAVITY_ENGINE;
const CLAUDE_NO_ULTRA = 'Claude Code conversations use Claude Code’s own Ultracode instead of Ultra.';
const CLAUDE_MODEL_ONLY = 'Claude Code works only with Anthropic Messages models. Choose one in Settings → Models.';

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
const isCompacting = runtime => !!(runtime?.compacting || runtime?.compactRequests);
const sameModel = (a, b) => a?.provider === b?.provider && a?.id === b?.id;

// Process lifecycle: a Pi is kept running while it may be needed soon, and stopped when it is not.
const IDLE_STOP_MS = 20 * 60 * 1000; // an idle Pi nobody has looked at for this long is stopped
const MAX_IDLE_PER_ENV = 6;          // and at most this many idle Pis stay up per machine (least recently used go first)
const SWEEP_MS = 60 * 1000;

export class SessionManager extends EventEmitter {
  runtimes = new Map();   // session id -> { session, status, streaming, questions: Map, starting, lastSeq }
  prepared = new Map();   // environment id -> Promise<remote facts>
  preparing = new Map();  // in-flight setup; force/provider changes must not race deployments
  antigravityPrepared = new Map();
  antigravityBins = new Map();
  antigravityInstalls = new Map();
  antigravityAccounts = new Map();
  #antigravityCreations = new WeakMap(); // correlate foreground startup with the new-session placeholder
  stopping = new Map();   // do not reattach while a hard stop of this session is pending
  updateRestartFailed = new Set(); // don't silently reattach to a process the update couldn't replace
  catalogCache = null;
  providersVersion = 0;   // bumped whenever providers/keys change in Settings
  egress = null;

  constructor({ store, environments, local, piVersion, piPackageDir, bridgePath, relayPath, cacheDir, remoteSetup = prepareRemote, claudeAdapterPath, claudeLocal = ensureLocalClaude, claudeRemote = prepareRemoteClaude, claudeEnv = {}, antigravityCli = findAntigravityCli, antigravityRemoteCli = findRemoteAntigravityCli }) {
    super();
    this.focused = null; // the session on screen: never stopped by the sweep
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), SWEEP_MS);
    this.sweeper.unref?.();
    this.store = store;
    this.environments = environments; // () => [environment]
    this.local = local;               // { node, piCli, agentDir, extraEnv, runDir, uploadDir, claudeRoot }
    this.piVersion = piVersion;
    this.bridgePath = bridgePath;
    this.relayPath = relayPath;
    this.cacheDir = cacheDir;
    this.piPackageDir = piPackageDir;
    this.remoteSetup = remoteSetup;
    // Claude Code engine: the adapter beside the bridge (staged, and uploaded to hosts with it), and the installers.
    this.claudeAdapterPath = claudeAdapterPath ?? (bridgePath ? join(dirname(bridgePath), 'pidesk-claude.mjs') : null);
    this.claudeLocal = claudeLocal;
    this.claudeRemote = claudeRemote;
    this.claudeInstalls = new Map(); // environment id -> Promise<{ bin, configDir }>
    this.claudeEnv = claudeEnv;      // extra non-secret variables for Claude Code (tests)
    this.antigravityCli = antigravityCli;
    this.antigravityRemoteCli = antigravityRemoteCli;
  }

  env(id) {
    const env = this.environments().find(e => e.id === id);
    if (!env) throw new Error(`Unknown environment ${id}`);
    return env;
  }

  // Start a throwaway Pi through this machine's relay and read its state (used by the packaged-build smoke test).
  async piSelfTest() {
    const id = 'selftest-' + randomUUID().slice(0, 8);
    const spawn = relaySpawnSpec({ cwd: this.local.agentDir, node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, retryPath: this.local.retryPath, extensions: [this.bridgePath], piArgs: ['--no-session'], extraEnv: this.local.extraEnv });
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
  async relaySessions(env, engine) {
    if (env.kind === 'local') return JSON.parse((await this.#localRelay(['list'])).trim().split('\n').pop()).sessions ?? [];
    if (engine === undefined) {
      const records = this.store.sessions.filter(s => s.environmentId === env.id && !s.archived);
      if (records.length && records.every(isAntigravity)) engine = ANTIGRAVITY_ENGINE;
    }
    return listRelaySessions(env, await this.prepare(env.id, { engine }));
  }
  async stopRelay(env, id, options) {
    if (env.kind === 'local') return this.#localRelay([stopRelayCommand(options), id]);
    const engine = this.#recordOf(id)?.engine ?? options?.engine;
    return stopRelaySession(env, await this.prepare(env.id, { engine }), id, options);
  }

  // ---------------------------------------------------------------- providers and models
  bootProviders() {
    return this.store.settings.providers.filter(provider => !isRetiredProvider(provider.id)).flatMap(provider => {
      const apiKey = this.store.getKey(provider.id);
      if (!apiKey && provider.kind === 'builtin') return [];
      const entry = { id: provider.id, apiKey: apiKey ?? undefined };
      // The base its SDK needs (e.g. an Anthropic base saved with /v1), for providers saved before too.
      if (provider.kind === 'custom') Object.assign(entry, { name: provider.name, api: provider.api, baseUrl: providerBaseUrl(provider.api, provider.baseUrl), models: provider.models, headers: provider.headers });
      // A built-in provider with a chosen model list replaces its catalog with exactly those models.
      else if (provider.models?.length) entry.models = provider.models.map(model => builtinModelRoute(provider.id, model));
      return [entry];
    });
  }

  invalidateCatalog() { this.catalogCache = null; }

  // Keys and model lists changed: running Pi processes (including ones kept alive by a host's relay)
  // still hold what they started with, so send them the current providers.
  providersChanged() {
    this.providersVersion += 1;
    this.invalidateCatalog();
    this.prepared.clear();
    if (this.egress) this.providerHosts().then(hosts => this.egress?.allow(hosts)).catch(() => {});
    for (const [key, spare] of this.spares) if (!isAntigravity(spare.record)) this.#dropSpare(key);
    for (const [id, runtime] of this.runtimes) {
      if (runtime.status !== 'connected') continue;
      // A Claude Code conversation gets its endpoint and key again (a new key restarts Claude Code, resumed).
      if (runtime.engine === CLAUDE_ENGINE) { const record = this.#recordOf(id); if (record) this.#applyModel(record, runtime).catch(error => this.emit('notice', { id, level: 'warning', message: error.message })); }
      else this.#syncProviders(runtime).catch(() => {});
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
    if (isClaude(runtime) || isAntigravity(runtime)) return; // Pi Desktop's Subagents/Ultra/Speed settings are Pi's
    const key = JSON.stringify(this.bootConfig(record));
    if (!session || runtime.configKey === key) return;
    await session.prompt(`/pidesk-config ${Buffer.from(key).toString('base64')}`);
    if (runtime.session === session) runtime.configKey = key;
  }
  async #modelInfo(want) {
    if (!want?.provider || !want?.id) return null;
    const fromSettings = this.store.settings?.providers?.find(p => p.id === want.provider)?.models?.find(m => m.id === want.id);
    if (fromSettings) return fromSettings;
    if (this.catalogCache || this.catalog !== SessionManager.prototype.catalog || (this.local?.piCli && existsSync(this.local.piCli))) {
      const list = await this.catalog().catch(() => []);
      return list.find(m => m.provider === want.provider && m.id === want.id) ?? null;
    }
    return null;
  }

  // The model and effort chosen for this conversation, made true in its Pi: when it attaches (one that
  // kept running may have missed a change), after each change and before each prompt. One change at a
  // time and the effort after the model, because Pi resets the effort when the model changes. What the
  // Pi has is tracked in runtime.applied, so a prompt with nothing to change costs no request.
  #applyModel(record, runtime, afterApply) {
    const session = runtime?.session;
    if (!session) return Promise.resolve();
    const run = async () => {
      if (runtime.session !== session) return;
      if (isAntigravity(record)) return; // model and thinking options belong to the ACP session
      if (isClaude(record)) return this.#applyClaude(record, runtime, session);
      const want = record.model;
      if (isRetiredProvider(want?.provider)) throw new Error(RETIRED_PROVIDER_MESSAGE);
      let applied = runtime.applied ?? {};
      if (want?.provider && want.id && !sameModel(applied.model, want)) {
        await this.#syncProviders(runtime);
        try { await session.setModel(want.provider, want.id); }
        catch (error) {
          // A failed RPC may have changed the model before its acknowledgement was lost.
          if (runtime.session === session) runtime.applied = {};
          throw error;
        }
        applied = { model: { provider: want.provider, id: want.id } };
        if (runtime.session === session) runtime.applied = applied;
      }
      const info = await this.#modelInfo(want);
      const effectiveLevel = info && record.thinkingLevel ? clampPiThinkingLevel(info, record.thinkingLevel) : record.thinkingLevel;
      if (effectiveLevel && effectiveLevel !== record.thinkingLevel) this.#save(record, { thinkingLevel: effectiveLevel });
      if (effectiveLevel && applied.thinkingLevel !== effectiveLevel) {
        await session.request('set_thinking_level', { level: effectiveLevel });
        applied = { ...applied, thinkingLevel: effectiveLevel };
      }
      if (runtime.session === session) runtime.applied = applied;
    };
    let queued = (runtime.applying ?? Promise.resolve()).catch(() => {}).then(run);
    if (afterApply) queued = queued.then(afterApply);
    runtime.applying = queued;
    return queued;
  }
  // A Claude Code conversation's endpoint, key, model, effort and Ultracode, made true in its adapter.
  async #applyClaude(record, runtime, session) {
    const config = await this.claudeConfig(record);
    const key = JSON.stringify(config);
    if (runtime.claudeKey === key) return;
    const result = await session.request('claude_configure', config, { timeout: 60000 });
    if (runtime.session !== session) return;
    runtime.claudeKey = key;
    runtime.applied = { model: { provider: config.model.provider, id: config.model.id }, thinkingLevel: config.effort };
    // Ultracode needs a model and endpoint that offer it: the adapter turned it off and said why.
    if (config.ultracode && result?.ultracode === false) {
      delete record.ultracode;
      this.#save(record, {});
      runtime.claudeKey = JSON.stringify({ ...config, ultracode: false });
    }
  }
  async #syncProviders(runtime) {
    const session = runtime?.session;
    if (!session || isClaude(runtime) || isAntigravity(runtime)) return;
    while (runtime.session === session && runtime.providersVersion !== this.providersVersion) {
      // Settings updates and the first prompt can arrive together. Send one update at a time,
      // then re-check the version so an older acknowledgement cannot mark newer keys as synced.
      if (runtime.providerSync?.session === session) { await runtime.providerSync.promise; continue; }
      const version = this.providersVersion;
      const payload = Buffer.from(JSON.stringify(this.bootProviders())).toString('base64');
      const sync = { session };
      sync.promise = session.prompt(`/pidesk-providers ${payload}`).then(() => {
        if (runtime.session === session) runtime.providersVersion = version;
      }).finally(() => { if (runtime.providerSync === sync) runtime.providerSync = null; });
      runtime.providerSync = sync;
      await sync.promise;
    }
  }

  // Models Pi can use with the configured providers, from a short-lived local Pi process.
  async catalog() {
    if (this.catalogCache) return this.catalogCache;
    this.catalogCache = (async () => {
      const configured = new Set(this.store.settings.providers.filter(p => !isRetiredProvider(p.id)).map(p => p.id));
      if (!configured.size) return [];
      const session = new PiSession({ id: 'catalog', boot: { providers: this.bootProviders() }, transport: this.#localTransport({ cwd: this.local.agentDir }) });
      try {
        await session.start();
        const models = await session.request('get_available_models').then(d => d.models);
        // Built-in providers can be narrowed to the models the user picked in Settings.
        const providerById = new Map(this.store.settings.providers.map(p => [p.id, p]));
        const enabled = Object.fromEntries(this.store.settings.providers.filter(p => p.enabledModels?.length).map(p => [p.id, new Set(p.enabledModels)]));
        return models.filter(m => configured.has(m.provider) && (!enabled[m.provider] || enabled[m.provider].has(m.id)))
          .map(m => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, api: m.api, reasoning: !!m.reasoning, thinkingLevelMap: m.thinkingLevelMap, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl, input: m.input, cost: m.cost, speeds: speedOptions(m), engines: isClaudeCodeModel(m, providerById.get(m.provider)) ? ['pi', CLAUDE_ENGINE] : ['pi'], ...(m.environments ? { environments: m.environments } : {}) }));
      } finally { await session.stop(); }
    })();
    const cached = this.catalogCache;
    cached.catch(() => { if (this.catalogCache === cached) this.catalogCache = null; });
    return cached;
  }

  builtinModels(providerId, apiKey) {
    return listBuiltinModels(providerId, apiKey, () => this.#builtinCatalog(providerId, apiKey));
  }

  // Pi's full definitions supply parameters and protocol settings for models returned by the API.
  async #builtinCatalog(providerId, apiKey) {
    const session = new PiSession({ id: 'models-' + providerId, boot: { providers: [{ id: providerId, apiKey }] }, transport: this.#localTransport({ cwd: this.local.agentDir }) });
    try {
      await session.start();
      const models = await session.request('get_available_models').then(d => d.models);
      return models.filter(m => m.provider === providerId).map(({ provider, type, ...m }) => m);
    } finally { await session.stop(); }
  }

  async providerHosts() {
    const models = await this.catalog().catch(() => []);
    return [...new Set(models.filter(m => /^https?:\/\//i.test(m.baseUrl ?? '')).map(m => hostPortOf(m.baseUrl)))];
  }

  // ---------------------------------------------------------------- Claude Code engine
  async #claudeModel(want) {
    if (!want?.provider || !want.id) throw new Error(CLAUDE_MODEL_ONLY);
    if (isRetiredProvider(want.provider)) throw new Error(RETIRED_PROVIDER_MESSAGE);
    const model = (await this.catalog()).find(m => m.provider === want.provider && m.id === want.id);
    const saved = this.store.settings.providers.find(p => p.id === want.provider);
    if (!model || !isClaudeCodeModel(model, saved)) throw new Error(CLAUDE_MODEL_ONLY);
    return model;
  }
  // The endpoint, key, model and Claude Code settings a conversation runs with (Settings → Models only:
  // built-in Anthropic, built-in providers with Anthropic Messages endpoints, or custom Anthropic endpoints).
  async claudeConfig(record) {
    const model = await this.#claudeModel(record.model);
    const saved = this.store.settings.providers.find(p => p.id === model.provider);
    const apiKey = this.store.getKey(model.provider);
    if (!apiKey) throw new Error(`Add an API key for ${saved?.name ?? model.provider} in Settings → Models to use it with Claude Code.`);
    // Anthropic's own API is Claude Code's default endpoint; any other one uses its Anthropic Messages base URL.
    const rawBaseUrl = saved?.kind === 'custom' ? saved.baseUrl : claudeBuiltinBaseUrl(model.provider, model.baseUrl);
    const baseUrl = rawBaseUrl ? providerBaseUrl('anthropic-messages', rawBaseUrl) : undefined;
    const headers = saved?.headers && typeof saved.headers === 'object' && Object.keys(saved.headers).length ? saved.headers : undefined;
    return {
      provider: { id: model.provider, kind: saved?.kind ?? 'builtin', api: 'anthropic-messages', apiKey, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) },
      model: { provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost },
      effort: resolveClaudeEffort(model, record.effort),
      ultracode: !!record.ultracode,
      fast: record.speed === 'fast',
    };
  }
  // Install (once per machine) the pinned Claude Code where `environmentId` runs conversations: this Mac
  // downloads it into its own data folder; an SSH host downloads it itself, or gets it uploaded from here.
  prepareClaude(environmentId, onProgress = () => {}) {
    const env = this.env(environmentId);
    const cached = this.claudeInstalls.get(env.id);
    if (cached) {
      if (!cached.done) {
        cached.listeners.add(onProgress);
        if (cached.lastMessage) onProgress(cached.lastMessage);
      }
      return cached.promise;
    }
    const listeners = new Set([onProgress]);
    const entry = { promise: null, listeners, lastMessage: null, done: false };
    const progress = message => {
      entry.lastMessage = message;
      for (const listener of listeners) listener(message);
      this.emit('claude-code', { id: env.id, status: 'preparing', message, version: CLAUDE_CODE_VERSION });
    };
    const promise = (async () => {
      if (env.kind === 'local') return this.claudeLocal({ root: this.local.claudeRoot ?? dirname(this.local.agentDir), cacheDir: this.cacheDir, onProgress: progress });
      const facts = await this.prepare(env.id);
      return this.claudeRemote(env, facts, { runSsh, cacheDir: this.cacheDir, onProgress: progress });
    })();
    entry.promise = promise;
    this.claudeInstalls.set(env.id, entry);
    promise.then(() => {
      entry.done = true;
      entry.lastMessage = null;
      listeners.clear();
      this.emit('claude-code', { id: env.id, status: 'ready', version: CLAUDE_CODE_VERSION });
    }, error => {
      entry.done = true;
      listeners.clear();
      if (this.claudeInstalls.get(env.id) === entry) this.claudeInstalls.delete(env.id);
      this.emit('claude-code', { id: env.id, status: 'error', message: error.message, version: CLAUDE_CODE_VERSION });
    }).catch(() => {});
    return promise;
  }
  claudeCodeInfo() {
    return { version: CLAUDE_CODE_VERSION, efforts: CLAUDE_EFFORTS, environments: Object.fromEntries([...this.claudeInstalls.keys()].map(id => [id, 'installed-or-installing'])) };
  }

  // ---------------------------------------------------------------- environments
  prepare(envId, { force = false, engine } = {}) {
    const env = this.env(envId);
    if (env.kind === 'local') return Promise.resolve({ ready: true });
    if (engine === ANTIGRAVITY_ENGINE) return this.#prepareAntigravityRemote(env, force);
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

  #prepareAntigravityRemote(env, force) {
    const cached = this.antigravityPrepared.get(env.id);
    if (cached && (!force || !cached.ready)) return cached.promise;
    const saved = this.store.settings.environments[env.id] ?? {};
    const progress = (status, fields) => this.emit('environment', { id: env.id, engine: ANTIGRAVITY_ENGINE, status, ...fields });
    const entry = { ready: false, promise: null };
    entry.promise = this.remoteSetup(env, {
      engine: ANTIGRAVITY_ENGINE, root: saved.root, cacheDir: this.cacheDir, bridgePath: this.bridgePath, relayPath: this.relayPath,
      onProgress: message => progress('preparing', { message }),
    }).then(facts => {
      const current = this.store.settings.environments[env.id];
      if (current?.added && !current.root) {
        this.store.settings.environments[env.id] = { ...current, root: facts.root };
        this.store.saveSettings();
        this.emit('environments-changed');
      }
      entry.ready = true;
      progress('ready', { facts });
      return facts;
    }).catch(error => {
      this.antigravityPrepared.delete(env.id);
      progress('error', { message: error.message });
      throw error;
    });
    this.antigravityPrepared.set(env.id, entry);
    return entry.promise;
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
    return localTransport({ node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, retryPath: this.local.retryPath, extensions: [this.bridgePath], extraEnv: { ...this.local.extraEnv, ...this.piEnv() }, ...target });
  }

  // ---------------------------------------------------------------- sessions
  async antigravityInfo(environmentId = 'local') {
    const env = this.env(environmentId);
    return { installed: !!await this.#findAntigravity(env) };
  }

  antigravityInstall(environmentId) {
    const env = this.env(environmentId);
    if (this.antigravityInstalls.has(env.id)) return this.antigravityInstalls.get(env.id);
    const progress = state => this.emit('antigravity-install', { id: env.id, ...state });
    const install = (async () => {
      progress({ stage: 'preparing' });
      this.antigravityBins.delete(env.id);
      if (!await this.#findAntigravity(env)) await installAntigravityCli(env, { cacheDir: this.cacheDir, onProgress: progress });
      this.antigravityBins.delete(env.id);
      if (!await this.#findAntigravity(env)) throw new Error(antigravityInstallMessage(env));
      progress({ stage: 'done' });
      return { installed: true };
    })().catch(error => {
      progress({ stage: 'error', message: error.message });
      throw error;
    }).finally(() => this.antigravityInstalls.delete(env.id));
    this.antigravityInstalls.set(env.id, install);
    return install;
  }

  async antigravityReadiness(environmentId) {
    const env = this.env(environmentId);
    try { if (!await this.#findAntigravity(env)) return 'missing'; }
    catch { return env.kind === 'ssh' ? 'unreachable' : 'unknown'; }
    try {
      const { installed, signedIn } = await this.#readAntigravityAccount(env);
      return !installed ? 'missing' : signedIn === true ? 'ready' : signedIn === false ? 'signedOut' : 'unknown';
    } catch { return 'unknown'; } // A CLI without account reporting can still start a conversation.
  }

  async antigravityAccount(environmentId, { login = false } = {}) {
    const env = this.env(environmentId);
    const result = await this.#readAntigravityAccount(env, login);
    if (result.signedIn) {
      // Only an explicit account action should invalidate standby/reconnect an open chat.
      for (const [key, spare] of this.spares) {
        if (isAntigravity(spare.record) && spare.record.environmentId === env.id) this.#dropSpare(key);
      }
      const record = this.#recordOf(this.focused);
      const runtime = this.runtimes.get(this.focused);
      if (isAntigravity(record) && record.environmentId === env.id && runtime?.antigravity?.authRequired) this.reconnect(record.id).catch(() => {});
    }
    return result;
  }

  async #readAntigravityAccount(env, login = false) {
    if (login && env.kind !== 'local') throw new Error(ANTIGRAVITY_REMOTE_LOGIN);
    const active = this.antigravityAccounts.get(env.id);
    if (active) {
      if (!login || active.login) return active.promise;
      await active.promise.catch(() => {});
      return this.#readAntigravityAccount(env, login);
    }
    const promise = (async () => {
      const bin = await this.#findAntigravity(env);
      if (!bin) return { installed: false };
      const facts = env.kind === 'ssh' ? await this.prepare(env.id, { engine: ANTIGRAVITY_ENGINE }) : null;
      return antigravityAccount(env, { bin, local: this.local, facts, login });
    })().finally(() => this.antigravityAccounts.delete(env.id));
    this.antigravityAccounts.set(env.id, { login, promise });
    return promise;
  }

  async antigravityTerminal(environmentId, action) {
    if (!['login', 'usage'].includes(action)) throw new Error('Unknown Antigravity terminal action.');
    const env = this.env(environmentId);
    return { env, bin: await this.#antigravityBinary(env), args: action === 'login' ? ['acp', '--login'] : [] };
  }

  antigravityPermissionMode() { return this.store.settings.defaults?.antigravityBypassPermissions === false ? 'confirm' : 'bypassPermissions'; }

  async antigravityLogin(id) {
    if (isAntigravity(this.record(id)) && this.env(this.record(id).environmentId).kind !== 'local') throw new Error(ANTIGRAVITY_REMOTE_LOGIN);
    return this.#antigravityAction(id, 'antigravity_login', {}, 240000);
  }
  antigravitySetConfig(id, configId, value) { return this.#antigravityAction(id, 'antigravity_set_config', { configId, value }, 30000); }

  async reconnect(id) {
    const record = this.record(id);
    const runtime = this.runtimes.get(id);
    if (isAntigravity(record) && runtime?.session && (runtime.antigravity?.authRequired || runtime.antigravity?.permissionMode !== this.antigravityPermissionMode())) {
      // A fresh ACP process reads updated credentials and the chosen permission mode.
      if (runtime.antigravityRequest || runtime.streaming) throw new Error('Wait for the current Antigravity operation to finish.');
      await this.#hardStop(record, runtime, runtime.session);
    } else await this.close(id);
    await this.ensureStarted(id);
    return true;
  }

  async #antigravityAction(id, command, payload, timeout) {
    const record = this.record(id);
    if (!isAntigravity(record)) throw new Error('This is not an Antigravity CLI conversation.');
    const session = await this.ensureStarted(id);
    const runtime = this.runtimes.get(id);
    this.#assertCurrent(record, runtime);
    if (runtime.session !== session || this.stopping.has(id) || runtime.antigravityRequest || runtime.streaming) throw new Error('Wait for the current Antigravity operation to finish.');
    runtime.antigravityRequest = true;
    try {
      const state = await session.request(command, payload, { timeout });
      this.#assertCurrent(record, runtime);
      runtime.antigravity = state.antigravity;
      this.emit('sessions');
      return runtime.antigravity;
    } finally { runtime.antigravityRequest = false; }
  }

  #findAntigravity(env) {
    if (env.kind === 'local') return this.antigravityCli();
    const cached = this.antigravityBins.get(env.id);
    if (cached?.expires > Date.now()) return cached.promise;
    const entry = { expires: Infinity, promise: null };
    entry.promise = Promise.resolve().then(() => this.antigravityRemoteCli(env)).then(bin => {
      entry.expires = Date.now() + (bin ? 60000 : 3000);
      return bin;
    }, error => {
      if (this.antigravityBins.get(env.id) === entry) this.antigravityBins.delete(env.id);
      throw error;
    });
    this.antigravityBins.set(env.id, entry);
    return entry.promise;
  }
  async #antigravityBinary(env) {
    const bin = await this.#findAntigravity(env);
    if (!bin) throw new Error(antigravityInstallMessage(env));
    return bin;
  }

  list() {
    return this.store.sessions.filter(s => !s.archived).map(record => this.#view(record));
  }
  #view(record) {
    const runtime = this.runtimes.get(record.id);
    const engine = ['cursor', CLAUDE_ENGINE, ANTIGRAVITY_ENGINE].includes(record.engine) ? record.engine : 'pi';
    return { ...record, engine, ...(isAntigravity(record) ? { antigravity: runtime?.antigravity,
      ...(runtime?.status === 'error' && runtime.error ? { statusMessage: runtime.error } : {}) } : {}),
      status: runtime?.status ?? 'idle', phase: runtime?.phase ?? null, streaming: !!runtime?.streaming, compacting: isCompacting(runtime), pendingQuestions: runtime ? [...runtime.questions.values()] : [] };
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
  spares = new Map(); // per engine/environment/workspace -> { id, record, timer }
  warmSequence = 0;
  #spareKey(environmentId, cwd, engine) {
    const target = cwd ? `${environmentId}\n${cwd}` : projectlessSpareKey(environmentId);
    return engine === ANTIGRAVITY_ENGINE ? `antigravity\n${target}` : target;
  }
  async prewarm({ environmentId, cwd: chosen, model, thinkingLevel, speed, noFolder, engine }) {
    const seq = ++this.warmSequence;
    if (!environmentId) return false;
    const env = this.environments().find(e => e.id === environmentId);
    if (!env || (env.kind === 'ssh' && !env.enabled)) return false;
    const antigravity = engine === ANTIGRAVITY_ENGINE;
    if (!antigravity && isRetiredProvider(model?.provider)) return false;
    // Claude Code: install the binary there in advance (the first message would otherwise wait for it).
    if (engine === CLAUDE_ENGINE) { this.prepareClaude(environmentId).catch(() => {}); return true; }
    const bin = antigravity ? await this.#findAntigravity(env) : null;
    if (antigravity && (!bin || seq !== this.warmSequence)) return false;
    const cwd = chosen || await this.projectlessRoot(environmentId).catch(() => null);
    if (!cwd || seq !== this.warmSequence) return false;
    const key = this.#spareKey(environmentId, chosen, engine);
    for (const [k] of this.spares) if (k !== key) this.#dropSpare(k);
    const existing = this.spares.get(key);
    if (existing) { this.#armSpare(key, existing); return true; }
    const options = antigravity ? { engine } : { model, thinkingLevel: thinkingLevel ?? 'medium', ...speedField(speed) };
    const record = { id: randomUUID(), title: 'New session', environmentId, environmentLabel: env.label, cwd, noFolder: (!chosen || noFolder) || undefined, ...options, spare: true };
    const spare = { id: record.id, record, bin };
    this.spares.set(key, spare);
    this.#armSpare(key, spare);
    this.ensureStarted(record.id, record, bin).catch(() => {
      // A cancelled start may finish after another spare has taken the same key.
      if (this.spares.get(key) === spare) this.#dropSpare(key);
    });
    return true;
  }
  #armSpare(key, spare) {
    const antigravity = isAntigravity(spare.record);
    if (antigravity && spare.timer) return; // the adapter also has a fixed lifetime while in standby
    clearTimeout(spare.timer);
    spare.timer = setTimeout(() => this.#dropSpare(key), antigravity ? 90000 : 10 * 60 * 1000);
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
    // Wait for any in-flight attach to finish before stopping the relay process.
    await this.close(spare.id);
    const env = this.environments().find(e => e.id === spare.record.environmentId);
    if (env) await this.stopRelay(env, spare.id, { engine: spare.record.engine }).catch(() => {});
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

  async create({ environmentId, cwd: chosen, model, thinkingLevel, speed, ultra, prompt, engine, effort, ultracode, creationId }) {
    const antigravity = engine === ANTIGRAVITY_ENGINE;
    creationId = antigravity && typeof creationId === 'string' && /^pending:\d{1,15}$/.test(creationId) ? creationId : null;
    if (!antigravity && isRetiredProvider(model?.provider)) throw new Error(RETIRED_PROVIDER_MESSAGE);
    const claude = engine === CLAUDE_ENGINE;
    let claudeModel = null;
    if (claude) {
      if (ultra) throw new Error(CLAUDE_NO_ULTRA);
      claudeModel = await this.#claudeModel(model);
    }
    const env = this.env(environmentId);
    const antigravityBin = antigravity ? await this.#antigravityBinary(env) : null; // verify before creating a folder or record
    const noFolder = !chosen;
    const cwd = noFolder ? await this.#projectlessDir(env, prompt) : chosen;
    const fields = {
      title: 'New session', environmentId, environmentLabel: env.label, cwd, noFolder: noFolder || undefined,
      project: noFolder ? 'No folder' : env.kind === 'local' ? basename(cwd) : remoteBase(cwd),
    };
    const spareKey = this.#spareKey(environmentId, chosen, engine);
    const spare = claude ? null : this.spares.get(spareKey);
    if (spare) {
      this.spares.delete(spareKey);
      clearTimeout(spare.timer);
      if (antigravity) {
        const adopted = await this.#adoptAntigravity(spare, fields, antigravityBin, creationId);
        if (adopted) return adopted;
      } else {
        try { return await this.#adopt(spare.record, fields, { model, thinkingLevel, speed, ultra }); }
        catch { await this.#stopSpare(spare); } // the warm Pi failed or could not move: start a fresh one below
      }
    }
    const clampedEffort = claude && effort ? clampClaudeEffort(claudeModel, effort) : null;
    const piModel = !claude && !antigravity ? await this.#modelInfo(model) : null;
    const effectiveThinking = piModel && thinkingLevel ? clampPiThinkingLevel(piModel, thinkingLevel) : (thinkingLevel ?? 'medium');
    const engineFields = claude
      ? { engine: CLAUDE_ENGINE, ...(clampedEffort ? { effort: clampedEffort } : {}), ...(ultracode ? { ultracode: true } : {}) }
      : (ultra ? { ultra: true } : {});
    // An account-backed session must not inherit the selected Pi provider or API settings.
    const options = antigravity ? { engine: ANTIGRAVITY_ENGINE } : { model, thinkingLevel: effectiveThinking, ...speedField(speed), ...engineFields };
    const record = { id: randomUUID(), ...fields, ...options, createdAt: Date.now(), updatedAt: Date.now() };
    this.#add(record);
    return this.#finishCreate(record, creationId, () => this.ensureStarted(record.id, undefined, antigravityBin));
  }
  async #finishCreate(record, creationId, start) {
    if (creationId) this.#antigravityCreations.set(record, creationId);
    try { await start(); }
    catch (error) {
      // The renderer can retry this saved conversation rather than create another one.
      if (!creationId || this.#recordOf(record.id) !== record || this.runtimes.get(record.id)?.status !== 'error') throw error;
    } finally { this.#antigravityCreations.delete(record); }
    return this.#view(record);
  }
  #add(record) {
    this.store.sessions.unshift(record);
    if (!record.noFolder) this.store.touchRecent(record.environmentId, record.cwd);
    this.store.saveSessions();
    this.emit('sessions');
  }
  async #adoptAntigravity(spare, fields, bin, creationId) {
    // Use the already initialized CLI on the same relay connection. Before
    // activation, a failed or stale spare is safe to discard without a binding.
    const { id, record } = spare;
    const runtime = this.runtimes.get(id);
    const session = bin !== spare.bin ? null : runtime?.status === 'connected' ? runtime.session
      : await runtime?.starting?.catch(() => null);
    if (!session || !this.#current(record, runtime) || runtime.session !== session || runtime.status !== 'connected' ||
      !runtime.antigravity?.standby || runtime.antigravity.permissionMode !== this.antigravityPermissionMode()) {
      await this.#stopSpare(spare);
      return null;
    }
    Object.assign(record, fields, { createdAt: Date.now(), updatedAt: Date.now() });
    delete record.spare;
    // Persist the ID before dispatching session/new. If activation is interrupted,
    // reconnect the same record instead of creating a replacement CLI conversation.
    try { this.#add(record); }
    catch (error) { await this.#stopSpare(spare); throw error; }
    return this.#finishCreate(record, creationId, () => this.#startRuntime(record, runtime, async () => {
      try { return this.#configureAntigravity(record, runtime, session, await this.#activateAntigravity(record, session)); }
      catch (error) {
        await session.stop().catch(() => {});
        if (runtime.session === session) runtime.session = null;
        throw error;
      }
    }, 'opening'));
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
  #current(record, runtime) { return !!runtime && !runtime.closing && this.runtimes.get(record.id) === runtime; }
  #assertCurrent(record, runtime) {
    if (!this.#current(record, runtime)) throw Object.assign(new Error('Session start cancelled'), { code: 'SESSION_CANCELLED' });
  }
  #status(record, runtime, patch) {
    if (Object.hasOwn(patch, 'phase')) runtime.phase = patch.phase;
    // Pre-warming is an implementation detail, not a visible conversation. In particular,
    // changing folders deliberately stops its connection and must not show an error toast.
    if (!record.spare && this.#current(record, runtime)) {
      const creationId = this.#antigravityCreations.get(record);
      this.emit('status', { id: record.id, ...patch, ...(creationId ? { creationId } : {}) });
    }
  }

  // Connect (or reconnect) a session. SSH sessions live in the host's relay, so a dropped connection is
  // retried with backoff and resumes from the last event seen; Pi keeps working in the meantime.
  ensureStarted(id, recordOverride, antigravityBin) {
    if (this.updateRestartFailed.has(id)) return Promise.reject(new Error('This conversation was not restarted. See Update issues to retry.'));
    const stopping = this.stopping.get(id);
    if (stopping) return stopping.then(() => this.ensureStarted(id, recordOverride, antigravityBin));
    if (isRetiredProvider((recordOverride ?? this.#recordOf(id))?.model?.provider)) return Promise.reject(new Error(RETIRED_PROVIDER_MESSAGE));
    let runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') return Promise.resolve(runtime.session);
    if (runtime?.starting) return runtime.starting;
    const record = recordOverride ?? [...this.spares.values()].find(sp => sp.id === id)?.record ?? this.record(id);
    if (record.engine === 'cursor') return Promise.reject(new Error(CURSOR_REMOVED));
    if (!runtime) {
      runtime = { session: null, status: 'idle', streaming: false, questions: new Map(), starting: null, lastSeq: null, retry: 0, retryTimer: null, closing: false, autoReconnect: false };
      this.runtimes.set(id, runtime);
    }
    return this.#startRuntime(record, runtime, () => this.#start(record, runtime, antigravityBin));
  }

  #startRuntime(record, runtime, start, phase = 'connecting') {
    clearTimeout(runtime.retryTimer);
    runtime.closing = false;
    runtime.status = runtime.autoReconnect ? 'reconnecting' : 'connecting';
    runtime.starting = Promise.resolve().then(() => {
      this.#assertCurrent(record, runtime);
      return start();
    }).then(session => {
      this.#assertCurrent(record, runtime);
      runtime.status = 'connected'; runtime.starting = null; runtime.retry = 0; runtime.lastUsed = Date.now();
      this.#status(record, runtime, { status: 'connected', phase: null, streaming: runtime.streaming, compacting: isCompacting(runtime) });
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
    this.#status(record, runtime, { status: runtime.status, phase });
    return runtime.starting;
  }

  #scheduleReconnect(record, runtime, reason) {
    if (runtime.closing || this.runtimes.get(record.id) !== runtime) return;
    const delay = Math.min(30000, 1000 * 2 ** runtime.retry);
    runtime.retry += 1;
    runtime.status = 'reconnecting';
    this.#status(record, runtime, { status: 'reconnecting', phase: 'connecting', message: reason, retryIn: delay, streaming: false, compacting: false });
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => this.ensureStarted(record.id).catch(() => {}), delay);
  }

  async #start(record, runtime, antigravityBin) {
    const env = this.env(record.environmentId);
    const bootVersion = this.providersVersion;
    const claude = isClaude(record), antigravity = isAntigravity(record);
    runtime.engine = antigravity ? ANTIGRAVITY_ENGINE : claude ? CLAUDE_ENGINE : 'pi';
    const agy = antigravity ? antigravityBin ?? await this.#antigravityBinary(env) : null;
    const bypass = antigravity && this.antigravityPermissionMode() === 'bypassPermissions';
    this.#assertCurrent(record, runtime);
    // Claude Code: its endpoint and key first (a clear error before any setup), then its binary there.
    const claudeConfig = claude ? await this.claudeConfig(record) : null;
    const claudeProgress = message => this.#status(record, runtime, { status: runtime.status, phase: 'preparing', message });
    let boot = claude || antigravity ? null : { providers: this.bootProviders(), config: this.bootConfig(record) };
    const piArgs = record.piSessionFile ? ['--session', record.piSessionFile] : [];
    let session;
    if (env.kind === 'local') {
      mkdirSync(this.local.agentDir, { recursive: true });
      let spawn;
      if (antigravity) {
        boot = antigravityBoot(agy, record, join(this.local.agentDir, 'sessions'), false, bypass);
        const adapter = fileURLToPath(new URL('../../agent/pidesk-antigravity.mjs', import.meta.url));
        spawn = { cwd: record.cwd, env: { ...this.local.extraEnv }, argv: [this.local.node, adapter] };
      } else if (claude) {
        const layout = await this.prepareClaude(env.id, claudeProgress);
        this.#assertCurrent(record, runtime);
        boot = { claudeCode: { ...claudeConfig, bin: layout.bin, configDir: layout.configDir, sessionsDir: join(this.local.agentDir, 'sessions'), sessionFile: record.piSessionFile ?? null, cwd: record.cwd, env: this.claudeEnv } };
        spawn = { cwd: record.cwd, env: { ...this.local.extraEnv }, argv: [this.local.node, this.claudeAdapterPath] };
      } else spawn = relaySpawnSpec({ cwd: record.cwd, node: this.local.node, piCli: this.local.piCli, agentDir: this.local.agentDir, retryPath: this.local.retryPath, extensions: [this.bridgePath], piArgs, extraEnv: { ...this.local.extraEnv, ...this.piEnv(record) } });
      const transport = localRelayTransport({ node: this.local.node, relayPath: this.relayPath, runDir: this.local.runDir, extraEnv: this.local.extraEnv });
      session = new PiSession({ id: record.id, boot, transport, relay: { sinceSeq: runtime.lastSeq, spawn } });
    } else {
      this.#status(record, runtime, { status: runtime.status, phase: 'preparing', ...(antigravity ? { message: 'Preparing the Antigravity SSH bridge…' } : {}) });
      const facts = await this.prepare(env.id, { engine: record.engine });
      const layout = claude ? await this.prepareClaude(env.id, claudeProgress) : null;
      // A running relay Pi retains its proxy environment. Even if a fresh probe now says the
      // endpoint is reachable, reconnect the old fixed forward rather than strand that Pi.
      const hosts = antigravity ? [] : record.egressPort ? [...new Set([...(facts.unreachable ?? []), ...await this.providerHosts()])] : facts.unreachable ?? [];
      const egressProxy = antigravity ? null : await this.#egressFor(hosts, { required: !!record.egressPort });
      this.#assertCurrent(record, runtime);
      // The remote port is fixed per session: the relay's Pi keeps HTTPS_PROXY across reconnects.
      if (egressProxy && !record.egressPort) this.#save(record, { egressPort: 30000 + Math.floor(Math.random() * 30000) });
      const egress = egressProxy && { localPort: egressProxy.port, remotePort: record.egressPort };
      let spawn;
      if (antigravity) {
        // Only remote paths and the conversation identity cross SSH; agy uses the host's own login.
        boot = antigravityBoot(agy, record, `${facts.agentDir}/sessions`, true, bypass);
        spawn = { cwd: record.cwd, env: { TMPDIR: facts.tmpDir }, argv: [facts.node, facts.adapter ?? `${facts.root}/ext/pidesk-antigravity.mjs`] };
      } else if (claude) {
        boot = { claudeCode: { ...claudeConfig, bin: layout.bin, configDir: layout.configDir, sessionsDir: `${facts.agentDir}/sessions`, sessionFile: record.piSessionFile ?? null, cwd: record.cwd, env: this.claudeEnv } };
        spawn = { cwd: record.cwd, env: { TMPDIR: facts.tmpDir, ...(egress ? egressEnv(egress.remotePort) : {}) }, argv: [facts.node, `${facts.root}/ext/pidesk-claude.mjs`] };
      } else spawn = relaySpawnSpec({ cwd: record.cwd, node: facts.node, piCli: facts.piCli, agentDir: facts.agentDir, retryPath: facts.retryPath, extensions: [facts.bridge], piArgs, extraEnv: { TMPDIR: facts.tmpDir, ...this.piEnv(record), ...(egress ? egressEnv(egress.remotePort) : {}) } });
      const sharedOnHost = [...this.runtimes.values()].filter(r => r !== runtime && r.shared && r.envId === env.id && r.session && !r.closing).length;
      runtime.envId = env.id; runtime.shared = sharedOnHost < 6;
      const transport = sshRelayTransport({ host: env.host, sshOptions: env.sshArgs ?? [], node: facts.node, relayPath: facts.relay, runDir: facts.runDir, egress, shared: runtime.shared });
      session = new PiSession({ id: record.id, boot, transport, relay: { sinceSeq: runtime.lastSeq, spawn } });
    }
    if (claude) runtime.claudeBootKey = JSON.stringify(claudeConfig);
    runtime.session = session;
    runtime.compacting = false;
    runtime.compactRequests = 0;
    runtime.questions.clear();
    const current = () => this.#current(record, runtime) && runtime.session === session;
    session.on('attached', info => {
      if (!current()) return;
      const key = `${info.pid}:${info.startedAt}`;
      if (runtime.jobsProcess !== key) {
        runtime.jobsProcess = key;
        runtime.jobsSource = null;
        this.#publishJobs(record, runtime, []);
      }
      this.#status(record, runtime, { status: runtime.status, phase: info.created ? 'starting' : 'connecting' });
    });
    session.on('event', event => { if (current()) { runtime.lastSeq = session.lastSeq; this.#onEvent(record, runtime, event); } });
    session.on('ui', request => { if (current()) this.#onUi(record, runtime, request); });
    session.on('gap', () => { if (current() && !record.spare) this.emit('resync', { id: record.id }); });
    session.on('exit', ({ piExited }) => {
      if (this.runtimes.get(record.id) !== runtime || runtime.session !== session || runtime.closing) return;
      runtime.lastSeq = session.lastSeq;
      runtime.streaming = false;
      runtime.compacting = false;
      runtime.compactRequests = 0;
      if (runtime.questions.size) { runtime.questions.clear(); this.emit('questions-cleared', { id: record.id }); }
      if (this.stopping.has(record.id)) {
        runtime.status = 'disconnected';
        if (piExited) runtime.lastSeq = null;
        this.#status(record, runtime, { status: 'disconnected', phase: null, streaming: false, compacting: false });
        return;
      }
      const message = (session.piExit?.stderr || session.stderr).trim().split('\n').slice(-2).join(' ');
      if (!piExited && runtime.status === 'connected' && !record.spare) { this.#scheduleReconnect(record, runtime, message || 'Connection lost'); return; }
      if (runtime.starting) return; // the start promise reports this failure
      runtime.status = 'disconnected';
      if (piExited) runtime.lastSeq = null; // a new Pi process numbers its events from scratch
      const agent = antigravity ? 'Antigravity CLI' : 'Pi';
      this.#status(record, runtime, { status: 'disconnected', phase: null, streaming: false, compacting: false, message: piExited ? `${agent} stopped` + (message ? `: ${message}` : '') : message });
    });
    try {
      this.#status(record, runtime, { status: runtime.status, phase: 'connecting' });
      await session.start({ readyTimeout: 90000 });
      this.#assertCurrent(record, runtime);
      if (antigravity) {
        const state = !record.spare && session.initialState.antigravity?.standby
          ? await this.#activateAntigravity(record, session) // Desktop relaunched during handoff
          : session.initialState;
        return this.#configureAntigravity(record, runtime, session, state);
      }
      this.#status(record, runtime, { status: runtime.status, phase: 'configuring' });
      if (claude) return await this.#configureClaude(record, runtime, session);
      return await this.#configureSession(record, runtime, session, bootVersion, JSON.stringify(boot.config));
    } catch (error) {
      await session.stop().catch(() => {});
      if (runtime.session === session) runtime.session = null;
      if (session.attachInfo?.created) await this.stopRelay(env, record.id).catch(() => {});
      // If an ssh -R port forward failed before attach (port collision or stale dead sshd forward)
      // and no session process is alive on the relay, drop the pinned egressPort so the next try picks a fresh one.
      if (env.kind === 'ssh' && record.egressPort && !session.attachInfo && /remote port forwarding failed/i.test(`${error?.message ?? ''}\n${session.stderr ?? ''}`)) {
        const alive = await this.relaySessions(env).then(list => list.some(s => s.id === record.id && s.alive), () => true);
        if (!alive) { delete record.egressPort; this.#save(record, {}); }
      }
      // Re-check the CLI next time (it may have been removed from the machine).
      if (claude) this.claudeInstalls.delete(env.id);
      if (antigravity) this.antigravityBins.delete(env.id);
      throw error;
    }
  }

  #activateAntigravity(record, session) {
    return session.request('antigravity_activate', { cwd: record.cwd }, { timeout: 30000 });
  }

  #configureAntigravity(record, runtime, session, state) {
    this.#assertCurrent(record, runtime);
    if (!state.antigravity || !!state.antigravity.standby !== !!record.spare) throw new Error('Unexpected Antigravity startup state.');
    session.initialState = state;
    runtime.lastSeq = session.lastSeq;
    runtime.autoReconnect = !record.spare;
    runtime.streaming = !!state.isStreaming;
    runtime.antigravity = state.antigravity;
    if (!record.spare) this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    return session;
  }

  async #configureClaude(record, runtime, session) {
    runtime.lastSeq = session.lastSeq;
    runtime.autoReconnect = true;
    const created = !!session.attachInfo?.created;
    const state = session.initialState ?? await session.state();
    runtime.streaming = !!state.isStreaming;
    runtime.applied = { model: state.model ? { provider: state.model.provider, id: state.model.id } : null, thinkingLevel: state.thinkingLevel };
    // An adapter this desktop just started has the current settings; one that kept running may not.
    runtime.claudeKey = created ? runtime.claudeBootKey : null;
    await this.#applyModel(record, runtime).catch(error => { if (!record.spare && this.#current(record, runtime)) this.emit('notice', { id: record.id, level: 'warning', message: error.message }); });
    if (!created) await session.request('background_sync').catch(() => {});
    this.#assertCurrent(record, runtime);
    this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    return session;
  }

  async #configureSession(record, runtime, session, bootVersion, bootConfigKey) {
    runtime.lastSeq = session.lastSeq;
    const created = !!session.attachInfo?.created;
    runtime.autoReconnect = true;
    const state = session.initialState ?? await session.state();
    runtime.streaming = !!state.isStreaming;
    runtime.compacting = !!state.isCompacting;
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
    // This existing bridge command is safe even on older Pis: they resync subagents instead.
    // Explicitly resend jobs because an idle Pi may have finished while this desktop was away.
    if (!created) await session.prompt('/pidesk-agents background-sync').catch(() => {});
    this.#assertCurrent(record, runtime);
    this.#save(record, { piSessionFile: state.sessionFile, piSessionId: state.sessionId });
    return session;
  }

  // After the app starts, re-attach to sessions that kept running in a relay (this machine's or a host's).
  async resumeRemote({ skip = new Set() } = {}) {
    const byEnv = new Map();
    for (const record of this.store.sessions.filter(s => !s.archived && !skip.has(s.id))) {
      if (!byEnv.has(record.environmentId)) byEnv.set(record.environmentId, []);
      byEnv.get(record.environmentId).push(record);
    }
    await Promise.all([...byEnv].map(async ([envId, records]) => {
      try {
        const env = this.env(envId);
        const engine = records.every(isAntigravity) ? ANTIGRAVITY_ENGINE : undefined;
        const alive = new Set((await this.relaySessions(env, engine)).filter(s => s.alive).map(s => s.id));
        // A Cursor CLI still running from an older version is stopped, not re-attached.
        await Promise.all(records.filter(r => alive.has(r.id)).map(r => (r.engine === 'cursor' ? this.stopRelay(env, r.id) : this.ensureStarted(r.id)).catch(() => {})));
      } catch { /* host unreachable: sessions stay idle until opened */ }
    }));
  }

  #busyStatus(record, runtime) {
    this.#status(record, runtime, { status: runtime.status, streaming: !!runtime.streaming, compacting: isCompacting(runtime) });
  }

  #onEvent(record, runtime, event) {
    runtime.lastUsed = Date.now();
    if (event.type === 'extension_ui_dismiss') {
      if (runtime.questions.delete(event.id)) this.emit('question-resolved', { id: record.id, requestId: event.id });
      return;
    }
    if (isAntigravity(record) && event.type === 'antigravity_permissions') {
      // A running older relay may replay a permission even after its dismissal. Reconcile against
      // the adapter's ordered snapshot, without discarding requests that arrive after it.
      const active = new Set(event.ids);
      for (const id of runtime.questions.keys()) {
        if (active.has(id)) continue;
        runtime.questions.delete(id);
        this.emit('question-resolved', { id: record.id, requestId: id });
      }
      return;
    }
    if (isAntigravity(record) && event.type === 'antigravity_opening') {
      if (runtime.status === 'connecting' && !record.spare && runtime.phase !== 'opening') this.#status(record, runtime, { status: runtime.status, phase: 'opening' });
      return;
    }
    if (isAntigravity(record) && event.type === 'antigravity_state') {
      runtime.antigravity = event.antigravity;
      this.emit('sessions');
      return;
    }
    if (event.type === 'agent_start') { runtime.streaming = true; this.#busyStatus(record, runtime); }
    if (event.type === 'agent_settled') { runtime.streaming = false; this.#save(record, { lastActiveAt: Date.now() }); this.#busyStatus(record, runtime); }
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      runtime.compacting = event.type === 'compaction_start';
      this.#busyStatus(record, runtime);
    }
    const visible = historyEvent(event);
    if (visible) this.emit('event', { id: record.id, event: visible });
  }

  // Extension dialogs are questions for the person at the desktop (e.g. from the ask_user tool).
  #onUi(record, runtime, request) {
    if (record.spare && request.method === 'notify') return;
    if (['select', 'input', 'confirm', 'editor'].includes(request.method)) {
      if (runtime.questions.has(request.id)) return; // re-delivered by the relay after a reconnect
      const question = {
        requestId: request.id, method: request.method, title: request.title, message: request.message,
        options: request.options, placeholder: request.placeholder, prefill: request.prefill,
        ...(isAntigravity(record) ? { permission: true } : {}),
        ...(request.header ? { header: request.header } : {}),
        ...(request.multiSelect ? { multiSelect: true } : {}),
        ...(Array.isArray(request.optionDetails) ? { optionDetails: request.optionDetails } : {}),
      };
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
    // Live state of this Pi's background jobs (the card shows the newest full list; nothing to merge).
    if (request.method === 'setStatus' && request.statusKey === 'pidesk-background' && request.statusText) {
      let payload;
      try { payload = JSON.parse(request.statusText); } catch { return; }
      if (!Array.isArray(payload.jobs)) return;
      const known = runtime.jobsSource;
      if (known?.generation === payload.generation && known.revision >= payload.revision) return;
      runtime.jobsSource = { generation: payload.generation, revision: payload.revision };
      this.#publishJobs(record, runtime, payload.jobs);
    }
  }


  // Verify the selected model on the same connection that will send the request. A change or
  // rollback while we waited must not send a message (or history) to a different provider.
  async #withModel(record, runtime, session, selected, send) {
    const verify = () => {
      this.#assertCurrent(record, runtime);
      if (runtime.session !== session || this.stopping.has(record.id) || !sameModel(record.model, selected)) {
        throw new Error('The model or connection changed before the request was sent. Please try again.');
      }
    };
    verify();
    await this.#syncProviders(runtime);
    await this.#syncConfig(runtime, record).catch(() => {});
    verify();
    let sent;
    await this.#applyModel(record, runtime, () => {
      verify();
      if (selected?.provider && selected?.id && !sameModel(runtime.applied?.model, selected)) {
        throw new Error('The selected model was not applied. No request was sent.');
      }
      // Dispatch in the model queue, but don't block later model updates on the request itself.
      sent = send();
    });
    return sent;
  }

  // attachments: [{ kind: 'image', name, mimeType, data (base64) } | { kind: 'file', name, path?, data? }]
  // interrupt: a message sent while Pi works replaces the active run (as in Codex/ChatGPT), instead of
  // waiting for the current assistant turn and its tool calls to finish like a steering message does.
  async prompt(id, text, attachments = [], { interrupt = false } = {}) {
    const record = this.record(id);
    if (isAntigravity(record)) {
      let session = await this.ensureStarted(id);
      let runtime = this.runtimes.get(id);
      this.#assertCurrent(record, runtime);
      if (runtime.session !== session || this.stopping.has(id)) throw new Error('The Antigravity connection changed. No message was sent.');
      if (runtime.antigravity?.authRequired) throw new Error('Sign in with Google before sending a message to Antigravity.');
      if (runtime.streaming || runtime.antigravityRequest) throw new Error('Wait for the current Antigravity operation to finish.');
      // Existing SSH adapters keep their launch flags. Apply the new default on
      // the next turn without replaying old prompts or interrupting active tools.
      if ((runtime.antigravity?.permissionMode ?? 'confirm') !== this.antigravityPermissionMode()) {
        await this.reconnect(id);
        session = await this.ensureStarted(id);
        runtime = this.runtimes.get(id);
      }
      this.#assertCurrent(record, runtime);
      if (runtime.session !== session || runtime.antigravity?.authRequired ||
        (runtime.antigravity?.permissionMode ?? 'confirm') !== this.antigravityPermissionMode()) throw new Error('Antigravity settings changed. No message was sent; try again.');
      const images = attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
      if (images.length && runtime.antigravity?.image !== true) throw new Error('This Antigravity CLI does not accept image prompts.');
      const files = attachments.filter(a => a.kind === 'file');
      const paths = files.length ? await this.#placeFiles(record, files) : [];
      this.#assertCurrent(record, runtime);
      if (runtime.session !== session || this.stopping.has(id) || runtime.streaming || runtime.antigravityRequest) throw new Error('Antigravity is busy. No message was sent.');
      if (runtime.antigravity?.authRequired || (runtime.antigravity?.permissionMode ?? 'confirm') !== this.antigravityPermissionMode()) throw new Error('Antigravity settings changed. No message was sent; try again.');
      const message = paths.length ? `${text}${text ? '\n\n' : ''}Attached files:\n${paths.map(path => `- ${path}`).join('\n')}` : text;
      // Antigravity owns session options and permissions. No Pi setup prompts or automatic turn retry.
      const sent = await session.prompt(message, images.length ? { images } : {});
      if (record.title === 'New session' && (text.trim() || attachments.length) && this.#current(record, runtime) && runtime.session === session) {
        const title = titleFrom(text || attachments[0]?.name || 'Attachment');
        this.#save(record, { title });
      }
      return sent;
    }
    const selected = record.model;
    let session = await this.ensureStarted(id);
    let runtime = this.runtimes.get(id);
    let interrupted = false;
    // While an Ultra task runs, a message joins it (Pi steers it in before the next model call); an
    // interruption would read as Stop and pause the task.
    if (interrupt && (runtime?.streaming || isCompacting(runtime)) && runtime.ultra?.task?.status !== 'active') {
      ({ session, runtime } = await this.#interruptForPrompt(id, session, runtime));
      interrupted = true;
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
    let nameIt = null;
    const send = () => this.#withModel(record, runtime, session, selected, () => {
      // Name the conversation only once its first prompt is ready to send.
      if (record.title === 'New session' && text.trim()) {
        const title = titleFrom(text);
        this.#save(record, { title, autoTitle: title });
        session.request('set_session_name', { name: title }).catch(() => {});
        nameIt = text.trim().replace(/^\/goal\s+/, '');
      }
      return session.prompt(message, { ...(images.length ? { images } : {}), streamingBehavior: 'steer' });
    });
    let sent = await send();
    // The renderer can be a moment behind Pi. If the prompt was queued instead of starting a fresh
    // turn, abort the run that accepted it and send it again; otherwise a stale flag brings back the
    // old "new message waits for the current reply" behaviour.
    if (interrupt && !interrupted && runtime?.ultra?.task?.status !== 'active' && sent?.disposition === 'queued') {
      ({ session, runtime } = await this.#interruptForPrompt(id, session, runtime));
      interrupted = true;
      sent = await send();
    }
    if (nameIt && !nameIt.startsWith('/') && !isClaude(record)) session.prompt(`/pidesk-title ${Buffer.from(nameIt).toString('base64')}`).catch(() => {});
    return { ...(sent && typeof sent === 'object' ? sent : {}), interrupted };
  }

  // A successful Abort RPC waits for the engine to be idle. A rejection or deadline does not.
  async #abortRun(session) {
    session.abortBash().catch(() => {});
    session.clearQueue().catch(() => {});
    let timer;
    try {
      return await Promise.race([
        session.abort().then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 4000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async #hardStop(record, runtime, session) {
    if (!this.#current(record, runtime) || runtime.session !== session) return;
    const id = record.id;
    if (this.stopping.has(id)) return this.stopping.get(id);
    const stopping = (async () => {
      // Do not disconnect or claim success before the relay confirms the process is gone.
      await this.stopRelay(this.env(record.environmentId), id, { requireTree: true });
      if (this.runtimes.get(id) === runtime) await this.close(id);
      this.emit('status', { id, status: 'disconnected', streaming: false, compacting: false });
    })().finally(() => this.stopping.delete(id));
    this.stopping.set(id, stopping);
    return stopping;
  }

  // Stop the active run before sending a replacement; reconnect from history only after a hard stop.
  async #interruptForPrompt(id, session, runtime) {
    await this.abort(id);
    if (this.runtimes.get(id) === runtime && runtime.session === session && runtime.status !== 'disconnected') return { session, runtime };
    const fresh = await this.ensureStarted(id);
    return { session: fresh, runtime: this.runtimes.get(id) };
  }

  // Put attached files where the session's Pi can read them: as-is on this machine, uploaded to the host.
  async #placeFiles(record, files) {
    const env = this.env(record.environmentId);
    const safe = name => {
      const file = String(name ?? '').replace(/[^\w.@+-]+/g, '_').slice(-120);
      return !file || file === '.' || file === '..' ? 'file' : file;
    };
    // Separate both messages and attachments, including on case-insensitive filesystems.
    const batch = randomUUID();
    if (env.kind === 'local') {
      return files.map((f, i) => {
        if (f.path) return f.path;
        const dir = join(this.local.uploadDir, record.id, batch, String(i + 1));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, safe(f.name));
        writeFileSync(path, Buffer.from(f.data, 'base64'), { flag: 'wx' });
        return path;
      });
    }
    const facts = await this.prepare(env.id, { engine: record.engine });
    const paths = [];
    for (const [i, f] of files.entries()) {
      const dir = `${facts.root}/uploads/${record.id}/${batch}/${i + 1}`;
      const path = `${dir}/${safe(f.name)}`;
      const data = f.path ? readFileSync(f.path) : Buffer.from(f.data, 'base64');
      await runSsh(env, `mkdir -p ${shellQuote(dir)} && (set -C; cat > ${shellQuote(path)})`, { input: data, timeout: 600000 });
      paths.push(path);
    }
    return paths;
  }

  // payload: { value } for select/input/editor, { confirmed } for confirm, or { cancelled: true }.
  answer(id, requestId, payload) {
    const runtime = this.runtimes.get(id);
    const question = runtime?.questions.get(requestId);
    if (!question) return false;
    if (question.permission) {
      if (payload?.cancelled === true) payload = { cancelled: true };
      else if (typeof payload?.value === 'string' && question.options?.includes(payload.value)) payload = { value: payload.value };
      else throw new Error('Choose one of the Antigravity permission options.');
    }
    runtime.questions.delete(requestId);
    runtime.session.respondUi(requestId, payload);
    this.emit('question-resolved', { id, requestId });
    return true;
  }

  async abort(id) {
    if (this.stopping.has(id)) return this.stopping.get(id);
    const runtime = this.runtimes.get(id);
    if (!runtime?.session) return;
    const session = runtime.session;
    const record = this.record(id);
    runtime.compactEpoch = (runtime.compactEpoch ?? 0) + 1;
    if (!await this.#abortRun(session)) await this.#hardStop(record, runtime, session);
  }

  async setModel(id, provider, modelId) {
    if (isRetiredProvider(provider)) throw new Error(RETIRED_PROVIDER_MESSAGE);
    const record = this.record(id);
    if (isAntigravity(record)) throw new Error('Choose a model from Antigravity’s session options.');
    const claudeModel = isClaude(record) ? await this.#claudeModel({ provider, id: modelId }) : null;
    let runtime = this.runtimes.get(id);
    // A host that can't reach this model's endpoint needs its traffic relayed through this Mac, which is
    // wired up when Pi starts. A session started without it is restarted (same session file, history kept).
    const env = this.env(record.environmentId);
    if (env.kind === 'ssh' && runtime?.session && !record.egressPort) {
      const baseUrl = (await this.catalog().catch(() => [])).find(m => m.provider === provider && m.id === modelId)?.baseUrl;
      const facts = /^https?:\/\//i.test(baseUrl ?? '') ? await this.prepare(env.id) : null;
      if (facts?.unreachable?.includes(hostPortOf(baseUrl))) {
        if (runtime.streaming || isCompacting(runtime)) throw new Error('Wait for the current operation to finish, then switch models.');
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
    const previousEffort = record.effort;
    const previousThinking = record.thinkingLevel;
    const nextPatch = { model: { provider, id: modelId } };
    if (claudeModel) {
      const clampedEffort = record.effort ? clampClaudeEffort(claudeModel, record.effort) : null;
      if (!clampedEffort) delete record.effort;
      else nextPatch.effort = clampedEffort;
    } else {
      const info = await this.#modelInfo({ provider, id: modelId });
      if (info && record.thinkingLevel) nextPatch.thinkingLevel = clampPiThinkingLevel(info, record.thinkingLevel);
    }
    this.#save(record, nextPatch); // the composer shows it at once
    if (runtime?.status !== 'connected') return; // applied when its Pi attaches or before the next prompt
    try { await this.#applyModel(record, runtime); }
    catch (error) {
      if (record.model?.provider === provider && record.model?.id === modelId) {
        if (previousEffort === undefined) delete record.effort; else record.effort = previousEffort;
        this.#save(record, { model: previous, ...(previousThinking !== undefined ? { thinkingLevel: previousThinking } : {}) });
      }
      throw error;
    }
  }

  async setThinking(id, level) {
    const record = this.record(id);
    if (isAntigravity(record)) throw new Error('Choose a thinking level from Antigravity’s session options.');
    // Claude Code has effort levels instead of Pi's thinking levels: the nearest one.
    if (isClaude(record)) return this.setEffort(id, claudeEffort(level) ?? level);
    const info = await this.#modelInfo(record.model);
    const effective = info ? clampPiThinkingLevel(info, level) : level;
    this.#save(record, { thinkingLevel: effective });
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#applyModel(record, runtime);
  }
  // Claude Code's effort (low … max), applied to a running Claude Code at once.
  async setEffort(id, level) {
    const record = this.record(id);
    if (!isClaude(record)) throw new Error('Effort levels belong to Claude Code conversations.');
    if (level != null && !CLAUDE_EFFORTS.includes(level)) throw new Error(`Unknown effort level: ${level}`);
    const info = level == null ? null : await this.#modelInfo(record.model);
    const effective = level == null ? null : (info ? clampClaudeEffort(info, level) : level);
    if (effective == null) delete record.effort;
    this.#save(record, effective == null ? {} : { effort: effective });
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#applyModel(record, runtime);
    return { effort: record.effort ?? null };
  }
  // Claude Code's Ultracode (standing multi-agent workflows), for models and endpoints that offer it.
  async setUltracode(id, on) {
    const record = this.record(id);
    if (!isClaude(record)) throw new Error('Ultracode belongs to Claude Code conversations; Pi conversations have Ultra.');
    if (on) record.ultracode = true; else delete record.ultracode;
    this.#save(record, {});
    const runtime = this.runtimes.get(id);
    if (runtime?.status === 'connected') await this.#applyModel(record, runtime);
    return { ultracode: !!record.ultracode };
  }
  // Ultra mode (the composer's Ultra switch): Pi works on each request on its own until it is done.
  async setUltra(id, on) {
    const record = this.record(id);
    if (isClaude(record)) { if (on) throw new Error(CLAUDE_NO_ULTRA); return; }
    if (isAntigravity(record)) throw new Error('Pi Ultra is not available in Antigravity CLI conversations.');
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
    if (isAntigravity(record)) throw new Error('Pi speed tiers do not apply to Antigravity CLI conversations.');
    if (speed === 'standard') delete record.speed;
    this.#save(record, speedField(speed));
    const runtime = this.runtimes.get(id);
    // Claude Code: Fast is its fast mode, where the model offers it.
    if (runtime?.status === 'connected') await (isClaude(record) ? this.#applyModel(record, runtime) : this.#syncConfig(runtime, record));
  }



  async compact(id) {
    const record = this.record(id);
    if (isAntigravity(record)) throw new Error('Pi Compact is not available in Antigravity CLI conversations.');
    const selected = record.model;
    const session = await this.ensureStarted(id);
    const runtime = this.runtimes.get(id);
    this.#assertCurrent(record, runtime);
    // Cover the gap before compaction_start arrives. Once started, the event/state flag
    // continues to protect the operation even if the desktop RPC times out first.
    const epoch = runtime.compactEpoch;
    runtime.compactRequests = (runtime.compactRequests ?? 0) + 1;
    this.touch(id);
    this.#busyStatus(record, runtime);
    try {
      return await this.#withModel(record, runtime, session, selected, () => {
        if (runtime.compactEpoch !== epoch) return { aborted: true };
        return session.request('compact', {}, { timeout: 300000 });
      });
    } finally {
      if (this.#current(record, runtime) && runtime.session === session && runtime.compactRequests > 0) {
        runtime.compactRequests--;
        this.touch(id);
        this.#busyStatus(record, runtime);
      }
    }
  }


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
      const reader = facts.history ?? `${facts.root}/${isAntigravity(record) ? 'antigravity' : 'ext'}/pidesk-history.mjs`;
      return JSON.parse(await runSsh(env, `${shellQuote(facts.node)} ${shellQuote(reader)} ${shellQuote(record.piSessionFile)} ${shellQuote(encoded)}`, { timeout: 30000 }));
    };
    // A validated path hint lets history open while provider discovery/Pi startup runs in parallel.
    // Missing or stale installs fall back to the normal versioned deployment, never a full-file read.
    const hint = readInstallHint(env, this.store.settings.environments?.[env.id]?.root, this.cacheDir, record.engine);
    if (hint) { try { return await readRemote(hint); } catch { /* first upgrade or moved runtime */ } }
    return readRemote(await this.prepare(env.id, { engine: record.engine }));
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
    if (!this.store.sessions.some(s => s.id === id && (!isAntigravity(s) || !!s.piSessionFile))) return false;
    this.ensureStarted(id).then(() => this.touch(id), () => {});
    return true;
  }
  // A spare Pi in the open conversation's folder, so Fork (and a new session there) adopts a running Pi.
  async warmFolder(id) {
    const record = this.store.sessions.find(s => s.id === id);
    if (!record || record.archived || record.engine === 'cursor' || isAntigravity(record)) return false;
    return this.prewarm({ environmentId: record.environmentId, cwd: record.cwd, model: record.model, thinkingLevel: record.thinkingLevel, speed: record.speed, noFolder: record.noFolder, engine: record.engine });
  }
  #idle(runtime) {
    return runtime.status === 'connected' && !runtime.antigravityRequest && !runtime.streaming && !isCompacting(runtime) && !runtime.starting && !runtime.questions.size && runtime.goal?.status !== 'active' && runtime.ultra?.task?.status !== 'active'
      && ![...(runtime.agents?.values() ?? [])].some(agent => ACTIVE_AGENT.has(agent.status))
      && !(runtime.jobs?.jobs ?? []).some(job => job.status === 'running'); // background work keeps it busy
  }
  // Stop Pis that are idle and either unused for IDLE_STOP_MS or beyond MAX_IDLE_PER_ENV on their machine.
  // A stopped session restarts on its next use; its history stays readable from the session file.
  async sweep(now = Date.now()) {
    const spareIds = new Set([...this.spares.values()].map(sp => sp.id));
    const idle = [];
    for (const [id, runtime] of this.runtimes) {
      if (id === this.focused || spareIds.has(id) || this.stopping.has(id) || !this.#idle(runtime)) continue;
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
    // Stop alongside detaching, but do not remove history if the relay could not stop its writer.
    await Promise.all([this.close(id), env ? this.stopRelay(env, id) : null]);
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
    if (isAntigravity(source)) throw new Error('Forking is not available in Antigravity CLI conversations.');
    if (!source.piSessionFile) throw new Error('Send a message before forking this conversation.');
    const env = this.env(source.environmentId);
    const fields = {
      title: `${source.title} (fork)`, environmentId: source.environmentId, environmentLabel: env.label, cwd: source.cwd,
      project: source.project, noFolder: source.noFolder, model: source.model, thinkingLevel: source.thinkingLevel, ...speedField(source.speed),
      ...(isClaude(source) ? { engine: CLAUDE_ENGINE, ...(source.effort ? { effort: source.effort } : {}), ...(source.ultracode ? { ultracode: true } : {}) } : {}),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const key = `${source.environmentId}\n${source.cwd}`;
    const spare = isClaude(source) ? null : this.spares.get(key); // spares are Pi processes
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
    if (isAntigravity(record)) throw new Error('Editing old messages is not available in Antigravity CLI conversations.');
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
    // Claude Code's own commands and skills (including its /goal) are all the user's to run.
    if (runtime.engine === ANTIGRAVITY_ENGINE) return commands;
    if (runtime.engine === CLAUDE_ENGINE) return commands.filter(c => !c.name.startsWith('pidesk-')).map(c => ({ name: c.name, description: c.description ?? '', source: 'claude-code', ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }));
    return commands.filter(c => !c.name.startsWith('pidesk-') && c.name !== 'goal').map(c => ({ name: c.name, description: c.description ?? '', source: c.source }));
  }

  goal(id) { return this.runtimes.get(id)?.goal ?? null; }
  agents(id) { return [...(this.runtimes.get(id)?.agents?.values() ?? [])]; }
  #publishJobs(record, runtime, jobs) {
    this.jobVersion = (this.jobVersion ?? 0) + 1;
    runtime.jobs = { version: this.jobVersion, at: Date.now(), jobs };
    this.emit('jobs', { id: record.id, ...runtime.jobs });
  }
  jobs(id) { return this.runtimes.get(id)?.jobs ?? { version: 0, jobs: [] }; }
  // Stop only the exact execution shown in the card, never a reused id after a process restart.
  async stopBackgroundJob(id, jobId, startedAt) {
    const runtime = this.runtimes.get(id);
    const job = runtime?.jobs?.jobs.find(job => job.id === jobId && job.startedAt === startedAt);
    const claude = runtime?.engine === CLAUDE_ENGINE;
    const validId = claude ? /^[A-Za-z0-9_-]{1,64}$/.test(jobId) : /^bg-\d+$/.test(jobId);
    if (runtime?.status !== 'connected' || !job || job.status !== 'running' || !validId || !Number.isFinite(startedAt))
      throw new Error('This job is no longer running in this session.');
    if (claude) await runtime.session.request('stop_background_job', { taskId: jobId, startedAt });
    else await runtime.session.prompt(`/pidesk-agents background-stop ${jobId} ${startedAt}`);
  }
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
    this.warmSequence++; // an outstanding folder/binary probe must not start a new spare on quit
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
      const env = { kind: 'local' };
      const remaining = await this.relaySessions(env).catch(() => null);
      const results = remaining && await Promise.allSettled(remaining.filter(s => s.alive).map(s => this.stopRelay(env, s.id)));
      // Do not kill the supervisor if a session still needs its process-tree cleanup.
      const daemon = this.relayPath && `${this.relayPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} daemon`;
      if (daemon && results?.every(result => result.status === 'fulfilled')) await new Promise(resolve => execFile('pkill', ['-f', daemon], () => resolve()));
    }
    await closeSshMux();
  }
}
