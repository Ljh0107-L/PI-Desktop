import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, shell } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEnvironments } from './environments.mjs';
import { listRemoteDir, runSsh } from './remote-setup.mjs';
import { execFile } from 'node:child_process';
import { shellQuote } from '../../core/transports.mjs';
import { SessionManager } from './session-manager.mjs';
import { Terminals } from './terminals.mjs';
import { Updater } from './updater.mjs';
import { Store } from './store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const piPackage = join(root, 'node_modules/@earendil-works/pi-coding-agent');
const piVersion = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).version;

if (process.env.PIDESK_USER_DATA) app.setPath('userData', process.env.PIDESK_USER_DATA);
app.setName('Pi Desktop');

let store, manager, window;
// Hosts set up before Connections existed count as added.
const migrateConnections = () => { for (const v of Object.values(store?.settings.environments ?? {})) if (v.root && v.added === undefined) v.added = true; };
const environments = () => (migrateConnections(), listEnvironments({ sshConfig: process.env.PIDESK_SSH_CONFIG, customHosts: store?.settings.customHosts ?? [], state: store?.settings.environments ?? {} }));

async function fetchRemoteModels({ api: format, baseUrl }, apiKey) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Enter the base URL first.');
  const anthropic = format === 'anthropic-messages';
  const urls = anthropic ? [`${base}/v1/models`, `${base}/models`] : [`${base}/models`];
  const headers = anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', authorization: `Bearer ${apiKey}` } : { authorization: `Bearer ${apiKey}` };
  let lastError;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { lastError = new Error(`${res.status} ${res.statusText} from ${url}`); continue; }
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.data ?? body.models ?? [];
      return list.map(m => typeof m === 'string' ? { id: m } : {
        id: m.id ?? m.name?.replace(/^models\//, ''),
        name: m.display_name ?? m.displayName ?? undefined,
        contextWindow: m.context_length ?? m.context_window ?? m.inputTokenLimit ?? undefined,
        maxTokens: m.max_output_tokens ?? m.outputTokenLimit ?? m.top_provider?.max_completion_tokens ?? undefined,
      }).filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) { lastError = error; }
  }
  throw new Error(`Couldn't list models: ${lastError?.message ?? 'no response'}`);
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
// A path inside (or relative to) a session's folder, on the session's machine.
function sessionPath(id, rel) {
  const record = manager.record(id);
  const env = manager.env(record.environmentId);
  const base = record.cwd;
  const join_ = env.kind === 'local' ? join : posix.join;
  const path = !rel ? base : rel.startsWith('/') ? rel : rel.startsWith('~/') && env.kind === 'local' ? join(homedir(), rel.slice(2)) : join_(base, rel);
  return { env, path };
}

const BUILTIN_PROVIDERS = {
  anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', google: 'Google Gemini', openrouter: 'OpenRouter',
  xai: 'xAI', groq: 'Groq', mistral: 'Mistral', moonshotai: 'Moonshot (Kimi)', zai: 'Z.ai (GLM)', fireworks: 'Fireworks', together: 'Together',
};

function publicSettings() {
  const s = store.settings;
  return { ...s, providers: s.providers.map(p => ({ ...p, hasKey: store.hasKey(p.id) })), builtinProviders: BUILTIN_PROVIDERS };
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
    return fetchRemoteModels(draft, apiKey);
  },
  saveProvider(provider, key) {
    const providers = store.settings.providers;
    const index = providers.findIndex(p => p.id === provider.id);
    const clean = { id: provider.id, name: provider.name, kind: provider.kind, api: provider.api, baseUrl: provider.baseUrl, models: provider.models, headers: provider.headers, enabledModels: provider.enabledModels?.length ? provider.enabledModels : undefined };
    if (index >= 0) providers[index] = clean; else providers.push(clean);
    if (key) store.setKey(provider.id, key);
    store.saveSettings();
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
    manager.invalidateCatalog();
    manager.providersChanged();
    return publicSettings();
  },
  updateDefaults(patch) { Object.assign(store.settings.defaults, patch); store.saveSettings(); return publicSettings(); },
  listSessions: () => manager.list(),
  resumeRemote: () => manager.resumeRemote(),
  prewarm: draft => manager.prewarm(draft),
  warmSessions: () => [...manager.spares.values()].filter(sp => manager.runtimes.get(sp.id)?.status === 'connected').length,
  createSession: options => manager.create(options),
  openSession: id => manager.ensureStarted(id).then(() => true),
  prompt: (id, text, attachments) => manager.prompt(id, text, attachments ?? []),
  editMessage: (id, ordinal, originalText, text, attachments) => manager.editMessage(id, ordinal, originalText, text, attachments ?? []),
  fork: id => manager.fork(id),
  deleteSession: id => manager.delete(id),
  commands: id => manager.commands(id),
  goal: id => manager.goal(id),
  // Updates
  updateStatus: () => updater?.status ?? { state: 'idle' },
  checkForUpdates: () => updater?.check({ manual: true }),
  installUpdate: () => updater?.install(),
  appVersion: () => app.getVersion(),
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
  messages: id => manager.messages(id),
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
  async listFiles(id, rel = '') {
    const { env, path } = sessionPath(id, rel);
    let entries;
    if (env.kind === 'local') {
      entries = (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDir(join(path, e.name))) }));
    } else {
      const out = await runSsh(env, `cd ${shellQuote(path)} && ls -1pA | head -2000`, { timeout: 30000 });
      entries = out.split('\n').filter(Boolean).map(name => ({ name: name.replace(/\/$/, ''), dir: name.endsWith('/') }));
    }
    entries = entries.filter(e => e.name !== '.DS_Store').sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path, entries };
  },
  async readFile(id, rel) {
    const { env, path } = sessionPath(id, rel);
    const image = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
    const limit = image ? 8 << 20 : 1 << 20;
    let size, data;
    if (env.kind === 'local') {
      size = (await stat(path)).size;
      const handle = await open(path, 'r');
      try { data = Buffer.alloc(Math.min(size, limit)); await handle.read(data, 0, data.length, 0); } finally { await handle.close(); }
    } else {
      const out = await runSsh(env, `f=${shellQuote(path)}; [ -f "$f" ] || { echo missing; exit 0; }; wc -c < "$f"; head -c ${limit} "$f" | base64`, { timeout: 60000 });
      const nl = out.indexOf('\n');
      if (out.startsWith('missing')) throw new Error(`${path} is not a file`);
      size = Number(out.slice(0, nl).trim());
      data = Buffer.from(out.slice(nl + 1), 'base64');
    }
    if (image) return { path, size, kind: 'image', truncated: size > limit, dataUrl: size > limit ? null : `data:${image};base64,${data.toString('base64')}` };
    const binary = data.subarray(0, 8000).includes(0);
    return { path, size, kind: binary ? 'binary' : 'text', truncated: size > limit, content: binary ? null : data.toString('utf8') };
  },
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
    webPreferences: { preload: join(root, 'app/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { api.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) { event.preventDefault(); api.openExternal(url); } });
  if (process.env.PIDESK_DEV_URL) window.loadURL(process.env.PIDESK_DEV_URL);
  else window.loadFile(join(root, 'dist/renderer/index.html'));
}

app.whenReady().then(() => {
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
  manager = new SessionManager({
    store, environments, piVersion,
    bridgePath: join(root, 'agent/pidesk-bridge.js'),
    relayPath: join(root, 'agent/pidesk-relay.mjs'),
    piPackageDir: join(root, 'node_modules/@earendil-works/pi-coding-agent'),
    cacheDir: join(app.getPath('userData'), 'downloads'),
    local: {
      node: process.execPath, piCli: join(piPackage, 'dist/bundle/cli.js'),
      agentDir: join(app.getPath('userData'), 'agent'),
      runDir: join(app.getPath('userData'), 'run'),
      uploadDir: join(app.getPath('userData'), 'uploads'),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    },
  });
  manager.on('environments-changed', () => send('environments', environments()));
  for (const channel of ['event', 'status', 'question', 'question-resolved', 'questions-cleared', 'resync', 'rewound', 'notice', 'environment', 'goal']) manager.on(channel, payload => send(channel, payload));
  manager.on('sessions', () => send('sessions', manager.list()));
  createWindow();
  updater.start();
  if (process.env.PIDESK_SMOKE_TEST) smokeTest();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', event => {
  if (quitting || !manager) return;
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
