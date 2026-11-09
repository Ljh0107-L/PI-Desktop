import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerSaveBlocker, safeStorage, shell } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEnvironments } from './environments.mjs';
import { listRemoteDir, runSsh } from './remote-setup.mjs';
import { decodeRemoteFilePreview, filePreview, remoteFilePreviewScript } from './file-preview.mjs';
import { downloadLocal, downloadRemote } from './file-download.mjs';
import { execFile } from 'node:child_process';
import { shellQuote } from '../../core/transports.mjs';
import { SessionManager } from './session-manager.mjs';
import { Terminals } from './terminals.mjs';
import { Updater } from './updater.mjs';
import { Store } from './store.mjs';
import { UsageLedger } from './usage.mjs';
import { stageExtensions } from './extensions.mjs';
import { listCustomModels, resolveProviderBaseUrl } from './custom-providers.mjs';
import { isRetiredProvider, RETIRED_PROVIDER_MESSAGE } from '../../core/retired-providers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const piPackage = join(root, 'node_modules/@earendil-works/pi-coding-agent');
const piVersion = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).version;

// Pi and the relay run on this app's Electron binary acting as Node. On macOS they use the helper app's
// copy: Pi sets its process title, which makes libuv check the process in with LaunchServices, and the
// main executable would then appear in the Dock as a generic "exec" icon. The helper is a UI element
// (LSUIElement), so it never shows in the Dock.
function nodeBinary() {
  if (process.platform !== 'darwin') return process.execPath;
  const name = basename(process.execPath); // "Pi Desktop", or "Electron" in development
  const helper = join(dirname(process.execPath), '../Frameworks', `${name} Helper.app/Contents/MacOS/${name} Helper`);
  return existsSync(helper) ? helper : process.execPath;
}

if (process.env.PIDESK_USER_DATA) app.setPath('userData', process.env.PIDESK_USER_DATA);
app.setName('Pi Desktop');

let store, manager, window, usage;
// Hosts set up before Connections existed count as added.
const migrateConnections = () => { for (const v of Object.values(store?.settings.environments ?? {})) if (v.root && v.added === undefined) v.added = true; };
const environments = () => (migrateConnections(), listEnvironments({ sshConfig: process.env.PIDESK_SSH_CONFIG, customHosts: store?.settings.customHosts ?? [], state: store?.settings.environments ?? {} }));

// Resolve and inspect paths on the session's own machine, including remote ~/ paths.
async function sessionFilePreview(id, operation, rel = '') {
  const record = manager.record(id);
  const env = manager.env(record.environmentId);
  if (env.kind === 'local') return filePreview(operation, record.cwd, rel);
  // Sessions already prepare Node on the host; reuse that runtime instead of parsing
  // ls output or relying on platform-specific shell utilities for binary-safe reads.
  const { node } = await manager.prepare(record.environmentId);
  const output = await runSsh(env, remoteFilePreviewScript(node, operation, record.cwd, rel), { timeout: operation === 'read' ? 60000 : 30000 });
  return decodeRemoteFilePreview(output);
}

// Save a file from the session's machine to this Mac, through a save dialog that starts in Downloads.
async function downloadSessionFile(id, rel) {
  const record = manager.record(id);
  const env = manager.env(record.environmentId);
  const name = String(rel).split('/').filter(Boolean).pop() || 'download';
  let target;
  if (process.env.PIDESK_TEST_SAVE_DIR) target = join(process.env.PIDESK_TEST_SAVE_DIR, name);
  else {
    const choice = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath('downloads'), name) });
    if (choice.canceled || !choice.filePath) return null;
    target = choice.filePath;
  }
  if (env.kind === 'local') return downloadLocal(record.cwd, rel, target);
  const { node } = await manager.prepare(record.environmentId);
  return downloadRemote(env, node, record.cwd, rel, target);
}

const BUILTIN_PROVIDERS = {
  anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', google: 'Google Gemini', openrouter: 'OpenRouter',
  xai: 'xAI', groq: 'Groq', mistral: 'Mistral', moonshotai: 'Moonshot (Kimi)', zai: 'Z.ai (GLM)', fireworks: 'Fireworks', together: 'Together',
};

// Pi's compaction trigger is contextTokens > contextWindow - reserveTokens. Equalising
// the reserve with each model's max output makes it exactly "compact when the remaining
// context is smaller than the largest possible reply", instead of the 16K default that
// lets a 1M-context model overflow before compaction.
function syncCompactionReserves() {
  const agentDir = join(app.getPath('userData'), 'agent');
  const path = join(agentDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const overrides = { ...(settings.compaction?.modelOverrides ?? {}) };
  for (const provider of store.settings.providers.filter(p => !isRetiredProvider(p.id))) {
    for (const model of provider.models ?? []) {
      const maxTokens = Number(model.maxTokens);
      if (!provider.id || !model.id || !Number.isFinite(maxTokens) || maxTokens <= 0) continue;
      const key = `${provider.id}/${model.id}`;
      overrides[key] = { ...(overrides[key] ?? {}), reserveTokens: Math.floor(maxTokens) };
    }
  }
  settings.compaction = { ...(settings.compaction ?? {}), modelOverrides: overrides };
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    chmodSync(path, 0o600);
  } catch { /* settings are best effort; Pi keeps its defaults if this cannot be written */ }
}

function publicSettings() {
  const { chatgpt: _retired, ...s } = store.settings;
  const providers = s.providers.filter(p => !isRetiredProvider(p.id)).map(p => ({ ...p, hasKey: store.hasKey(p.id) }));
  return { ...s, providers, builtinProviders: BUILTIN_PROVIDERS };
}

const send = (channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send('pidesk:event', { channel, payload }); };
const terminals = new Terminals({ send });
let updater = null;

const api = {
  async bootstrap() {
    return { settings: publicSettings(), environments: environments(), sessions: manager.list(), piVersion, platform: process.platform, home: app.getPath('home') };
  },
  environments: () => environments(),
  // SSH connections the user works with (Settings → Connections).
  addConnections(ids) {
    for (const id of ids) store.settings.environments[id] = { ...store.settings.environments[id], added: true, enabled: true };
    store.saveSettings();
    for (const id of ids) manager.prepare(id).catch(() => {});
    return environments();
  },
  addManualConnection({ label, host, port, identityFile }) {
    const clean = String(host ?? '').trim();
    if (!/^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(clean)) throw new Error('Enter a host like user@example.com');
    const id = 'manual-' + (label || clean).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
    store.settings.customHosts = [...(store.settings.customHosts ?? []), { id, label: (label || clean).trim(), host: clean, port: port ? Number(port) : undefined, identityFile: identityFile?.trim() || undefined }];
    return api.addConnections([`ssh:${id}`]);
  },
  removeConnection(id) {
    const { root, ...rest } = store.settings.environments[id] ?? {};
    store.settings.environments[id] = { ...rest, root, added: false };
    store.settings.customHosts = (store.settings.customHosts ?? []).filter(h => `ssh:${h.id}` !== id);
    store.saveSettings();
    return environments();
  },
  setConnectionEnabled(id, enabled) {
    store.settings.environments[id] = { ...store.settings.environments[id], enabled: !!enabled };
    store.saveSettings();
    return environments();
  },
  prepareEnvironment: (id, force) => manager.prepare(id, { force }).then(facts => ({ ok: true, facts }), error => ({ ok: false, error: error.message })),
  async listDir(environmentId, path) {
    const env = manager.env(environmentId);
    if (env.kind === 'ssh') return listRemoteDir(env, path);
    const { readdirSync } = await import('node:fs');
    const dir = path || app.getPath('home');
    return { path: dir, entries: readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort((a, b) => a.localeCompare(b)) };
  },
  async pickLocalFolder() {
    if (process.env.PIDESK_TEST_PICK_FOLDER) return process.env.PIDESK_TEST_PICK_FOLDER;
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  catalog: () => manager.catalog(),
  // Models a provider offers: Pi's catalog for built-in providers, GET /models for custom endpoints.
  async listProviderModels(draft, key) {
    const apiKey = key || store.getKey(draft.id);
    if (!apiKey) throw new Error('Enter the API key first.');
    if (draft.kind === 'builtin') return manager.builtinModels(draft.id, apiKey);
    return listCustomModels(draft, apiKey);
  },
  async saveProvider(provider, key) {
    if (isRetiredProvider(provider.id)) throw new Error(RETIRED_PROVIDER_MESSAGE);
    // With or without the version: an OpenAI-compatible URL is kept as entered unless only the other form
    // serves the API, and a Google one without a version gets /v1beta.
    const baseUrl = provider.kind === 'custom' ? await resolveProviderBaseUrl(provider, key || store.getKey(provider.id)) : provider.baseUrl;
    const providers = store.settings.providers;
    const index = providers.findIndex(p => p.id === provider.id);
    const clean = { id: provider.id, name: provider.name, kind: provider.kind, api: provider.api, baseUrl, models: provider.models, headers: provider.headers, enabledModels: provider.enabledModels?.length ? provider.enabledModels : undefined };
    if (index >= 0) providers[index] = clean; else providers.push(clean);
    if (key) store.setKey(provider.id, key);
    store.saveSettings();
    syncCompactionReserves();
    manager.invalidateCatalog();
    manager.providersChanged();
    // Provider reachability may differ: redo host setup now, in the background, not at the next message.
    manager.prepared.clear();
    for (const env of environments().filter(e => e.kind === 'ssh' && e.added && e.enabled)) manager.prepare(env.id).catch(() => {});
    return publicSettings();
  },
  deleteProvider(id) {
    store.settings.providers = store.settings.providers.filter(p => p.id !== id);
    store.setKey(id, null);
    store.saveSettings();
    syncCompactionReserves();
    manager.invalidateCatalog();
    manager.providersChanged();
    return publicSettings();
  },
  updateDefaults(patch) {
    Object.assign(store.settings.defaults, patch); store.saveSettings();
    if (Object.hasOwn(patch ?? {}, 'subagents')) manager.configChanged(); // running Pis apply it before their next prompt
    return publicSettings();
  },
  listSessions: () => manager.list(),
  resumeRemote: () => manager.resumeRemote(),
  prewarm: draft => manager.prewarm(draft),
  warmSessions: () => [...manager.spares.values()].filter(sp => manager.runtimes.get(sp.id)?.status === 'connected').length,
  createSession: options => manager.create(options),
  openSession: id => manager.ensureStarted(id).then(() => true),
  warmSession: id => manager.warm(id),
  focusSession: id => { manager.focus(id); return true; },
  warmFolder: id => manager.warmFolder(id),
  prompt: (id, text, attachments, options) => manager.prompt(id, text, attachments ?? [], options ?? {}),
  editMessage: (id, ordinal, originalText, text, attachments) => manager.editMessage(id, ordinal, originalText, text, attachments ?? []),
  fork: id => manager.fork(id),
  deleteSession: id => manager.delete(id),
  commands: id => manager.commands(id),
  goal: id => manager.goal(id),
  ultra: id => manager.ultra(id),
  setUltra: (id, on) => manager.setUltra(id, on),
  agents: id => manager.agents(id),
  stopAgent: (id, agentId) => manager.stopAgent(id, agentId),
  stopBackgroundJob: (id, jobId) => manager.stopBackgroundJob(id, jobId),
  messageAgent: (id, agentId, text) => manager.messageAgent(id, agentId, text),
  // Updates
  updateStatus: () => updater?.status ?? { state: 'idle' },
  // test builds only: show an update state without a real release
  testUpdateStatus: status => { if (process.env.PIDESK_INSECURE_TEST_STORAGE === '1') send('update', status); },
  checkForUpdates: () => updater?.check({ manual: true }),
  installUpdate: () => updater?.install(),
  appVersion: () => app.getVersion(),
  usageSummary: () => usage.summary(),
  // Terminal panel
  termOpen(id, cols, rows) { const record = manager.record(id); return terminals.open({ env: manager.env(record.environmentId), cwd: record.cwd, cols, rows }); },
  termWrite: (termId, data) => terminals.write(termId, data),
  termResize: (termId, cols, rows) => terminals.resize(termId, cols, rows),
  termClose: termId => terminals.close(termId),
  async pickFiles() {
    if (process.env.PIDESK_TEST_PICK_FILES) return process.env.PIDESK_TEST_PICK_FILES.split(':');
    const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  },
  answer: (id, requestId, payload) => manager.answer(id, requestId, payload),
  abort: id => manager.abort(id),
  setModel: (id, provider, modelId) => manager.setModel(id, provider, modelId),
  setThinking: (id, level) => manager.setThinking(id, level),
  setSpeed: (id, speed) => manager.setSpeed(id, speed),
  messages: id => manager.messages(id),
  historyPage: (id, options) => manager.historyPage(id, options ?? {}),
  clearSubagentHistory: (id, ids) => manager.clearSubagentHistory(id, ids),
  stats: id => manager.stats(id),
  rename: (id, title) => manager.rename(id, title),
  archive: id => manager.archive(id),
  reconnect: id => manager.close(id).then(() => manager.ensureStarted(id)).then(() => true),
  async gitBranch(id) {
    const record = manager.record(id);
    const env = manager.env(record.environmentId);
    if (env.kind === 'ssh') return runSsh(env, `git -C ${shellQuote(record.cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null || true`, { timeout: 15000 }).then(s => s.trim()).catch(() => '');
    return new Promise(resolve => execFile('git', ['-C', record.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], (error, stdout) => resolve(error ? '' : stdout.trim())));
  },
  compact: id => manager.compact(id),
  openExternal: url => /^https?:\/\//.test(url) ? shell.openExternal(url) : false,
  openPath: path => shell.openPath(path),
  // File preview (Claude-style): browse and read files in a session's folder, local or over SSH.
  listFiles: (id, rel = '') => sessionFilePreview(id, 'list', rel),
  readFile: (id, rel) => sessionFilePreview(id, 'read', rel),
  downloadFile: (id, rel) => downloadSessionFile(id, rel),
  showInFolder: path => shell.showItemInFolder(path),
};

ipcMain.handle('pidesk:invoke', async (_event, method, ...args) => {
  const fn = api[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...args);
});

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640,
    title: 'Pi Desktop',
    backgroundColor: '#181818',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }, // vertically centred in the 50px title row
    icon: join(root, 'build/icon.png'),
    webPreferences: { preload: join(root, 'app/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { api.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) { event.preventDefault(); api.openExternal(url); } });
  if (process.env.PIDESK_DEV_URL) window.loadURL(process.env.PIDESK_DEV_URL);
  else window.loadFile(join(root, 'dist/renderer/index.html'));
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'; // the UI is dark; keep native vibrancy and menus dark too
  updater = new Updater({ app, net, cacheDir: join(app.getPath('userData'), 'updates'), send });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => updater.check({ manual: true }).then(st => { if (st.state === 'current') dialog.showMessageBox(window, { message: `Pi Desktop ${app.getVersion()} is up to date.` }); else if (st.state === 'error') dialog.showMessageBox(window, { type: 'warning', message: 'Couldn’t check for updates', detail: st.message }); }) },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings', {}) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload', visible: !app.isPackaged }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(root, 'build/icon.png')));
  store = new Store(app.getPath('userData'), safeStorage, { insecureTestStorage: process.env.PIDESK_INSECURE_TEST_STORAGE === '1' });
  // Cursor CLI was removed: delete the runtime and download cache it installed here (~800 MB), in the
  // background. Old Cursor conversations stay readable from agent/cursor-sessions.
  for (const dir of ['cursor-sdk', join('downloads', 'cursor-sdk')]) rm(join(app.getPath('userData'), dir), { recursive: true, force: true }).catch(() => {});
  syncCompactionReserves();
  // Pi loads the bridge in milliseconds from outside this ES module package (extensions.mjs).
  let bridgePath = join(root, 'agent/pidesk-bridge.js');
  try { bridgePath = stageExtensions(join(root, 'agent'), join(app.getPath('userData'), 'ext')); }
  catch (error) { console.error('Pi Desktop: could not stage the bridge, loading it in place:', error.message); }
  manager = new SessionManager({
    store, environments, piVersion,
    bridgePath,
    relayPath: join(root, 'agent/pidesk-relay.mjs'),
    piPackageDir: join(root, 'node_modules/@earendil-works/pi-coding-agent'),
    cacheDir: join(app.getPath('userData'), 'downloads'),
    local: {
      node: nodeBinary(), piCli: join(piPackage, 'dist/bundle/cli.js'),
      agentDir: join(app.getPath('userData'), 'agent'),
      runDir: join(app.getPath('userData'), 'run'),
      uploadDir: join(app.getPath('userData'), 'uploads'),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    },
  });
  usage = new UsageLedger({ path: join(app.getPath('userData'), 'usage.jsonl'), sessionsDir: join(app.getPath('userData'), 'agent', 'sessions') });
  manager.on('event', ({ event }) => { if (event.type === 'message_end') usage.record(event.message); });
  manager.on('environments-changed', () => send('environments', environments()));
  for (const channel of ['event', 'status', 'question', 'question-resolved', 'questions-cleared', 'resync', 'rewound', 'notice', 'environment', 'goal', 'agents', 'jobs', 'ultra']) manager.on(channel, payload => send(channel, payload));
  manager.on('ultra', ultraChanged);
  manager.on('status', ultraPiStatus);
  manager.on('sessions', () => send('sessions', manager.list()));
  createWindow();
  updater.start();
  if (process.env.PIDESK_SMOKE_TEST) smokeTest();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Ultra on this Mac: keep it awake while a task runs here (the screen may still turn off), say when a
// task ends, and ask before quitting stops one. Tasks on SSH hosts run there whatever this Mac does.
const ultraLocal = new Map(); // session id -> running here
let awake = null;
function keepAwake() {
  if (ultraLocal.size && awake == null) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!ultraLocal.size && awake != null) { powerSaveBlocker.stop(awake); awake = null; }
}
// A Pi that stopped (archived, deleted, crashed) sends no more status: it no longer keeps the Mac awake.
function ultraPiStatus({ id, status }) { if (!['connected', 'connecting', 'reconnecting'].includes(status) && ultraLocal.delete(id)) keepAwake(); }
function ultraChanged({ id, ultra, ended, title, local }) {
  if (local && ultra?.task?.status === 'active') ultraLocal.set(id, true); else ultraLocal.delete(id);
  keepAwake();
  if (ended && ['complete', 'stalled'].includes(ended) && Notification.isSupported()) {
    const note = new Notification({ title: ended === 'complete' ? 'Ultra finished' : 'Ultra stopped: no progress', body: title || 'Conversation' });
    note.on('click', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); send('open-session', { id }); } });
    note.show();
  }
}

let quitting = false;
app.on('before-quit', event => {
  if (quitting || !manager) return;
  if (ultraLocal.size && window && !window.isDestroyed()) {
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Ultra is working in ${ultraLocal.size === 1 ? 'a conversation' : `${ultraLocal.size} conversations`} on this Mac`,
      detail: 'Quitting stops it. It carries on when you open the conversation again.' });
    if (choice !== 0) { event.preventDefault(); return; }
  }
  event.preventDefault();
  quitting = true;
  terminals.closeAll();
  manager.shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || process.env.PIDESK_QUIT_ON_CLOSE) app.quit(); });

// Packaged-build check used by the release workflow: the UI loads, the native pty module loads, and
// Pi starts with this app's Electron binary acting as Node (no Node install on the Mac).
async function smokeTest() {
  const fail = error => { console.error('PIDESK SMOKE FAILED:', error?.stack ?? error); app.exit(1); };
  try {
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`renderer: ${desc}`))); setTimeout(() => reject(new Error('renderer load timeout')), 30000); });
    let mounted = false;
    for (let i = 0; i < 60 && !mounted; i++) {
      mounted = await window.webContents.executeJavaScript('!!document.querySelector(".sidebar, .composer")');
      if (!mounted) await new Promise(r => setTimeout(r, 250));
    }
    if (!mounted) throw new Error('renderer did not mount: ' + (await window.webContents.executeJavaScript('document.body.innerHTML.slice(0, 400)')));
    const t = terminals.open({ env: { kind: 'local' }, cwd: app.getPath('home'), cols: 80, rows: 24 });
    terminals.close(t);
    const piState = await manager.piSelfTest();
    console.log('PIDESK SMOKE OK', JSON.stringify({ version: app.getVersion(), pi: piState }));
    app.exit(0);
  } catch (error) { fail(error); }
}
