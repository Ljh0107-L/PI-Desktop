#!/usr/bin/env node
// Independent, host-local OAuth owner. It survives desktop disconnects without changing/restarting
// the session relay. Only ciphertext is persisted; vault keys stay in memory and the Mac's keychain.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChatGPTCredentials, chatGPTCapability, chatGPTSocketPath, chatGPTVaultPath, validVaultId } from './pidesk-chatgpt-vault.mjs';

const MAX_PACKET = 1024 * 1024;
const send = (socket, value) => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = message => Object.assign(new Error(message), { public: true });
const unavailable = () => failure('ChatGPT authentication is unavailable. Reconnect this environment in Settings → ChatGPT.');
const readPacket = stream => new Promise((resolve, reject) => {
  let buffer = '';
  const cleanup = () => { stream.off('data', data); stream.off('end', ended); stream.off('close', ended); stream.off('error', failed); };
  const failed = () => { cleanup(); reject(unavailable()); };
  const ended = () => { cleanup(); reject(unavailable()); };
  const data = chunk => {
    buffer += chunk;
    if (buffer.length > MAX_PACKET) { cleanup(); reject(unavailable()); return; }
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    cleanup(); stream.pause();
    try { resolve(JSON.parse(buffer.slice(0, end))); } catch { reject(unavailable()); }
  };
  stream.setEncoding('utf8'); stream.on('data', data); stream.once('end', ended); stream.once('close', ended); stream.once('error', failed);
});

export async function chatGPTRequest(socketPath, message, { signal, timeout = 60000 } = {}) {
  signal?.throwIfAborted();
  const socket = net.connect(socketPath);
  socket.on('error', () => {});
  const abort = () => socket.destroy(new Error('ChatGPT request cancelled'));
  const timer = setTimeout(abort, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const packet = readPacket(socket);
    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    const response = await packet;
    signal?.throwIfAborted();
    if (!response?.ok) throw unavailable();
    return response;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); }
}

export class ChatGPTAuthHost {
  #vaults = new Map();
  constructor({ loadModels = async (piCli, credentials) => {
    const paths = createRequire(piCli).resolve.paths('@earendil-works/pi-ai') ?? [];
    let root, manifest;
    for (const path of paths) {
      try {
        const candidate = join(path, '@earendil-works/pi-ai');
        const json = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
        if (json.name === '@earendil-works/pi-ai') { root = candidate; manifest = json; break; }
      } catch { /* continue through Node's bounded dependency lookup */ }
    }
    // This ESM-only package has no require export. Resolve its declared public import entries,
    // relative to the host's installed Pi, rather than relying on the extension's node_modules.
    if (!root) throw unavailable();
    const [{ createModels }, { openaiProvider }] = await Promise.all([
      import(pathToFileURL(join(root, manifest.exports['.'].import)).href),
      import(pathToFileURL(join(root, manifest.exports['./providers/*'].import.replace('*', 'openai'))).href),
    ]);
    const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    const provider = openaiProvider();
    models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
    return models;
  } } = {}) { this.loadModels = loadModels; }
  async handle(message) {
    if (!message || !validVaultId(message.vaultId)) throw unavailable();
    const id = message.vaultId;
    let vault = this.#vaults.get(id);
    if (message.op === 'configure') {
      if (typeof message.key !== 'string' || !/^[0-9a-f]{64}$/.test(message.key) ||
          !isAbsolute(message.agentDir ?? '') || !isAbsolute(message.piCli ?? '')) throw unavailable();
      if (vault && (!equalSecret(vault.key, message.key) || vault.agentDir !== message.agentDir)) throw unavailable();
      const created = !vault;
      if (!vault) {
        const credentials = new ChatGPTCredentials(chatGPTVaultPath(message.agentDir, id), message.key);
        vault = { key: message.key, capability: chatGPTCapability(message.key), credentials, agentDir: message.agentDir };
        // Publish before imports so simultaneous reconnects share one mutation queue.
        this.#vaults.set(id, vault);
        vault.models = this.loadModels(message.piCli, credentials);
        vault.models.catch(() => { if (this.#vaults.get(id) === vault) this.#vaults.delete(id); });
      }
      try {
        if (message.encoded !== undefined) await vault.credentials.install(message.encoded);
        await vault.models;
        return { ok: true, connected: !!await vault.credentials.read('openai') };
      } catch {
        if (created && this.#vaults.get(id) === vault) this.#vaults.delete(id);
        throw unavailable();
      }
    }
    if (!vault) throw unavailable();
    if (message.op === 'logout') {
      if (!equalSecret(message.key, vault.key)) throw unavailable();
      await vault.credentials.delete('openai');
      if (this.#vaults.get(id) === vault) this.#vaults.delete(id);
      return { ok: true };
    }
    if (message.op !== 'access' || !equalSecret(message.capability, vault.capability)) throw unavailable();
    if (!await vault.credentials.read('openai')) throw unavailable();
    const models = await vault.models;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await models.getAuth('openai', { signal: controller.signal, minOAuthValidityMs: 5 * 60 * 1000 });
      if (!result?.auth?.apiKey) throw unavailable();
      return { ok: true, access: result.auth.apiKey };
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
}

function privateRunDir(runDir) {
  if (!isAbsolute(runDir ?? '')) throw unavailable();
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(runDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw unavailable();
}
export function serveChatGPT(runDir, host = new ChatGPTAuthHost(), vaultId, adminHash) {
  privateRunDir(runDir);
  const path = vaultId ? chatGPTSocketPath(runDir, vaultId) : join(runDir, 'chatgpt.sock');
  let closing = false;
  const server = net.createServer(socket => {
    socket.on('error', () => {}); socket.setTimeout(65000, () => socket.destroy());
    readPacket(socket).then(async message => {
      if (closing || (vaultId && message?.vaultId !== vaultId)) throw unavailable();
      if (adminHash && ['configure', 'logout'].includes(message?.op) &&
          (typeof message.key !== 'string' || !equalSecret(createHash('sha256').update(message.key).digest('hex'), adminHash))) throw unavailable();
      const result = await host.handle(message);
      if (adminHash && message.op === 'logout') { closing = true; server.close(); }
      return result;
    }).then(result => send(socket, { ...result, pid: process.pid }), () => send(socket, { ok: false }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { chmodSync(path, 0o600); resolve(server); });
  });
}
const connects = path => new Promise(resolve => {
  const socket = net.connect(path); socket.on('error', () => resolve(false));
  socket.on('connect', () => { socket.destroy(); resolve(true); });
});
async function ensureDaemon(runDir, bootstrap) {
  privateRunDir(runDir);
  const path = chatGPTSocketPath(runDir, bootstrap.vaultId), lock = path + '.startup.lock';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await connects(path)) return path;
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw unavailable();
      try {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') unlinkSync(lock); } }
      } catch { /* the launcher just released the lock */ }
      await new Promise(r => setTimeout(r, 100)); continue;
    }
    try {
      writeFileSync(fd, String(process.pid)); closeSync(fd); fd = undefined;
      if (await connects(path)) return path;
      if (bootstrap.op !== 'configure') throw unavailable();
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
      const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'ELECTRON_RUN_AS_NODE'];
      const env = { ...Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), PI_TELEMETRY: '0' };
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', runDir], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], cwd: homedir(), env,
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(bootstrap) + '\n');
      let failed = false; child.on('error', () => { failed = true; }); child.unref();
      for (let i = 0; i < 50 && !failed; i++) {
        await new Promise(r => setTimeout(r, 100)); if (await connects(path)) return path;
      }
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(lock); } catch { /* already released */ }
    }
  }
  throw unavailable();
}
async function cli() {
  const [command, runDir] = process.argv.slice(2);
  if (command === 'daemon') {
    // The trusted launcher supplies the one vault over stdin before the socket is exposed. A
    // model with a request capability cannot register another SDK/package inside this process.
    const bootstrap = await readPacket(process.stdin);
    process.stdin.pause();
    if (bootstrap?.op !== 'configure') throw unavailable();
    const host = new ChatGPTAuthHost();
    await host.handle(bootstrap);
    await serveChatGPT(runDir, host, bootstrap.vaultId, createHash('sha256').update(bootstrap.key).digest('hex'));
    process.on('SIGHUP', () => {}); return;
  }
  if (command !== 'rpc') throw unavailable();
  const message = await readPacket(process.stdin);
  process.stdin.pause();
  // Administrative CLI responses never contain access or refresh tokens. Only a Pi's private
  // socket client may resolve request auth; admin callers configure/logout over stdin.
  if (!['configure', 'logout'].includes(message?.op)) throw unavailable();
  const path = await ensureDaemon(runDir, message);
  const result = await chatGPTRequest(path, message);
  process.stdout.write(JSON.stringify(result) + '\n');
}
let main = false;
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* imported by Electron or an embedded runtime */ }
if (main) {
  cli().catch(() => { process.stderr.write('ChatGPT authentication setup failed. Check this environment and reconnect in Settings.\n'); process.exitCode = 1; });
}
