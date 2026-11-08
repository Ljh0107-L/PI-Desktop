// Desktop OAuth interaction and per-environment configuration. Login is browser-based on this Mac;
// each environment has its own grant and an independent, encrypted host-side refresh owner.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { chatGPTModels, chatGPTModelOverrides } from '../../agent/pidesk-chatgpt.mjs';
import { CHATGPT_PROVIDER, chatGPTCapability, chatGPTSocketPath, sealChatGPT } from '../../agent/pidesk-chatgpt-vault.mjs';
import { runSsh } from './remote-setup.mjs';
import { shellQuote } from '../../core/transports.mjs';

const keyId = vaultId => `chatgpt-vault:${vaultId}`;
const loginError = () => new Error('ChatGPT sign-in failed. Check your connection and account permissions, then try again.');
function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(loginError()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
export async function runChatGPTAuth(target, request) {
  const input = JSON.stringify(request) + '\n';
  let output;
  if (target.env.kind === 'ssh') {
    output = await runSsh(target.env, [target.node, target.authPath, 'rpc', target.runDir].map(shellQuote).join(' '), { input, timeout: 65000 });
  } else {
    output = await new Promise((resolve, reject) => {
      const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'];
      const env = { ...Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), ...target.extraEnv };
      const child = spawn(target.node, [target.authPath, 'rpc', target.runDir], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      let text = '';
      const timer = setTimeout(() => { child.kill(); reject(loginError()); }, 65000);
      child.stdout.on('data', data => { text += data; if (text.length > 1024 * 1024) child.kill(); });
      child.on('error', () => { clearTimeout(timer); reject(loginError()); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(loginError()); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  const result = JSON.parse(output.trim());
  if (!result?.ok) throw loginError();
  return result;
}
async function directAccess(target) {
  if (target.env.kind !== 'ssh') return;
  // No credentials or model requests: prove this host does not need the Mac's temporary egress.
  const script = `const tls=require('node:tls');Promise.all(['auth.openai.com','api.openai.com'].map(host=>new Promise((resolve,reject)=>{const s=tls.connect({host,port:443,servername:host},()=>{s.destroy();resolve()});s.setTimeout(12000,()=>s.destroy(new Error('timeout')));s.on('error',reject)}))).then(()=>process.stdout.write('ok'),()=>{process.stderr.write('OpenAI is not directly reachable');process.exitCode=1})`;
  try { await runSsh(target.env, [target.node, '-e', script].map(shellQuote).join(' '), { timeout: 15000 }); }
  catch { throw new Error('This SSH environment must reach auth.openai.com and api.openai.com directly to keep running while this Mac is offline.'); }
}
export class ChatGPTLogin {
  #pending = null; #ready = new Map(); #revision = 0;
  constructor({ store, target, openExternal, changed = () => {}, configured = () => {}, provider = openaiProvider(), run = runChatGPTAuth, probe = directAccess }) {
    this.store = store; this.target = target; this.openExternal = openExternal; this.changed = changed; this.configured = configured;
    this.provider = provider; this.run = run; this.probe = probe;
  }
  accounts() { return this.store.settings.chatgpt?.accounts ?? {}; }
  status() {
    const pending = this.#pending;
    return { revision: this.#revision,
      accounts: Object.fromEntries(Object.entries(this.accounts()).map(([id, account]) => [id, { connected: !!account.connected }])),
      login: pending ? { environmentId: pending.environmentId, state: pending.state, manual: !!pending.prompt, error: pending.error } : null,
    };
  }
  #publish() { this.#revision++; this.changed(this.status()); }
  modelSettings() {
    return { available: chatGPTModels(this.provider), models: chatGPTModels(this.provider, this.store.settings.chatgpt?.models) };
  }
  saveModels(selection) {
    const models = chatGPTModelOverrides(this.provider.getModels(), selection);
    this.store.settings.chatgpt ??= { accounts: {} };
    if (models === undefined) delete this.store.settings.chatgpt.models;
    else this.store.settings.chatgpt.models = models;
    this.store.saveSettings(); this.configured();
    return this.modelSettings();
  }
  catalog() {
    const environments = Object.entries(this.accounts()).filter(([, a]) => a.connected).map(([id]) => id);
    return environments.length ? chatGPTModels(this.provider, this.store.settings.chatgpt?.models).map(m => ({ ...m, environments })) : [];
  }
  config(environmentId) {
    const account = this.accounts()[environmentId];
    if (!account?.connected) return null;
    const key = this.store.getKey(keyId(account.vaultId));
    if (!key) return null;
    return { id: CHATGPT_PROVIDER, kind: 'subscription', vaultId: account.vaultId,
      socketPath: chatGPTSocketPath(account.runDir, account.vaultId), capability: chatGPTCapability(key),
      models: this.store.settings.chatgpt?.models };
  }
  ensure(environmentId) {
    const account = this.accounts()[environmentId];
    if (!account?.connected) return Promise.reject(new Error('Sign in to ChatGPT for this environment in Settings first.'));
    const current = this.#ready.get(environmentId);
    if (current?.account === account) return current.promise;
    const promise = (async () => {
      const target = await this.target(environmentId);
      if (target.runDir !== account.runDir || target.agentDir !== account.agentDir) throw new Error('This environment moved. Reconnect ChatGPT in Settings.');
      const result = await this.run(target, { op: 'configure', vaultId: account.vaultId, key: this.store.getKey(keyId(account.vaultId)), agentDir: target.agentDir, piCli: target.piCli });
      if (!result.connected) throw new Error('Reconnect ChatGPT for this environment in Settings.');
    })();
    const entry = { account, promise }; this.#ready.set(environmentId, entry);
    promise.finally(() => { if (this.#ready.get(environmentId) === entry) this.#ready.delete(environmentId); }).catch(() => {});
    return promise;
  }
  async start(environmentId) {
    if (this.#pending && !['failed', 'cancelled'].includes(this.#pending.state)) throw new Error('Finish or cancel the other ChatGPT sign-in first.');
    const run = { environmentId, state: 'preparing', controller: new AbortController(), prompt: null, url: null };
    this.#pending = run; this.#publish();
    const timer = setTimeout(() => { if (run.state !== 'saving') run.controller.abort(); }, 10 * 60 * 1000);
    run.finished = this.#login(run).catch(error => {
      if (this.#pending !== run) return;
      run.state = run.controller.signal.aborted ? 'cancelled' : 'failed';
      // SDK token failures may include provider response bodies: never pass those to IPC or logs.
      run.error = run.state === 'failed' ? (error?.safe ? error.message : loginError().message) : undefined;
      run.prompt = null; run.url = null; this.#publish();
    }).finally(() => clearTimeout(timer));
    return this.status();
  }
  async #login(run) {
    const signal = run.controller.signal;
    const target = await cancellable(this.target(run.environmentId), signal);
    try { await cancellable(this.probe(target), signal); } catch (error) { throw Object.assign(error, { safe: true }); }
    signal.throwIfAborted();
    const settings = this.store.settings;
    settings.chatgpt ??= { accounts: {} }; settings.chatgpt.accounts ??= {};
    let account = settings.chatgpt.accounts[run.environmentId];
    if (!account) {
      account = { vaultId: randomUUID(), deviceId: randomUUID(), connected: false, agentDir: target.agentDir, runDir: target.runDir };
      this.store.setKey(keyId(account.vaultId), randomBytes(32).toString('hex'));
      settings.chatgpt.accounts[run.environmentId] = account; this.store.saveSettings();
    }
    run.state = 'authorizing'; this.#publish();
    const credential = await this.provider.auth.oauth.login({ signal,
      notify: event => {
        if (signal.aborted || this.#pending !== run) return;
        if (event.type === 'auth_url') {
          const url = new URL(event.url);
          if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) throw loginError();
          run.url = event.url; this.openExternal(run.url).catch(() => {});
        }
      },
      prompt: prompt => new Promise((resolve, reject) => {
        if (prompt.type !== 'manual_code') { reject(loginError()); return; }
        const cancelled = () => { clear(); reject(loginError()); };
        const clear = () => { signal.removeEventListener('abort', cancelled); prompt.signal?.removeEventListener('abort', cancelled); if (run.prompt?.resolve === done) run.prompt = null; };
        const done = value => { clear(); resolve(value); };
        run.prompt = { resolve: done };
        signal.addEventListener('abort', cancelled, { once: true }); prompt.signal?.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted || prompt.signal?.aborted) cancelled();
        this.#publish();
      }),
    }, { agentName: 'Pi Desktop', getDeviceId: () => account.deviceId });
    signal.throwIfAborted();
    const key = this.store.getKey(keyId(account.vaultId));
    const encoded = sealChatGPT({ openai: credential }, key);
    run.state = 'saving'; run.prompt = null; run.url = null; this.#publish();
    await this.run(target, { op: 'configure', vaultId: account.vaultId, key, encoded, agentDir: target.agentDir, piCli: target.piCli });
    settings.chatgpt.accounts[run.environmentId] = { ...account, connected: true, agentDir: target.agentDir, runDir: target.runDir };
    this.store.saveSettings(); this.#ready.delete(run.environmentId);
    this.#pending = null; this.#publish(); this.configured();
  }
  submit(value) {
    if (typeof value !== 'string' || value.length > 16384 || !this.#pending?.prompt) throw new Error('No ChatGPT authorization is waiting for a callback.');
    this.#pending.prompt.resolve(value.trim()); this.#publish(); return this.status();
  }
  async reopen() {
    if (!this.#pending?.url) throw new Error('No ChatGPT sign-in is waiting.');
    await this.openExternal(this.#pending.url);
  }
  async cancel() {
    const run = this.#pending;
    if (!run || run.state === 'saving') return this.status();
    run.controller.abort(); await run.finished;
    if (this.#pending === run) this.#pending = null;
    this.#publish(); return this.status();
  }
  async close() {
    if (this.#pending?.state === 'saving') await this.#pending.finished;
    else await this.cancel();
  }
  async logout(environmentId) {
    if (this.#pending?.environmentId === environmentId) {
      if (this.#pending.state === 'saving') throw new Error('Wait for sign-in to finish first.');
      await this.cancel();
    }
    const account = this.accounts()[environmentId];
    if (!account) return this.status();
    const target = await this.target(environmentId), key = this.store.getKey(keyId(account.vaultId));
    if (target.runDir !== account.runDir || target.agentDir !== account.agentDir) throw new Error('Reconnect the original environment before signing out.');
    await this.run(target, { op: 'configure', vaultId: account.vaultId, key, agentDir: target.agentDir, piCli: target.piCli });
    await this.run(target, { op: 'logout', vaultId: account.vaultId, key });
    this.store.settings.chatgpt.accounts[environmentId] = { ...account, connected: false };
    this.store.saveSettings(); this.#ready.delete(environmentId); this.#publish(); this.configured();
    return this.status();
  }
}
