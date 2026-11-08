// Encrypted OAuth storage. A host's auth daemon is the sole writer; SDK refreshes run inside
// the per-vault mutation queue, so concurrent Pi sessions cannot rotate the same token twice.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CHATGPT_PROVIDER = 'pidesk-chatgpt';
export const validVaultId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const keyBytes = key => {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid ChatGPT vault key');
  return Buffer.from(key, 'hex');
};
export const chatGPTCapability = key => createHmac('sha256', keyBytes(key)).update('Pi Desktop ChatGPT access v1').digest('hex');
function validate(data) {
  const credential = data?.openai;
  if (credential !== undefined && (credential?.type !== 'oauth' || typeof credential.access !== 'string' ||
      typeof credential.refresh !== 'string' || !Number.isFinite(credential.expires) ||
      !credential.access || !credential.refresh)) throw new Error('Invalid ChatGPT credential');
  return credential ? { openai: credential } : {};
}
export function sealChatGPT(data, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(validate(data)), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, data: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') });
}
export function openChatGPT(encoded, key) {
  if (typeof encoded !== 'string' || encoded.length > 1024 * 1024) throw new Error('Invalid ChatGPT vault');
  const envelope = JSON.parse(encoded);
  if (envelope.version !== 1 || typeof envelope.data !== 'string') throw new Error('Invalid ChatGPT vault');
  const raw = Buffer.from(envelope.data, 'base64');
  if (raw.length < 29) throw new Error('Invalid ChatGPT vault');
  const cipher = createDecipheriv('aes-256-gcm', keyBytes(key), raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(12, 28));
  return validate(JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8')));
}
function privatePath(path, directory) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) ||
      (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) {
    throw new Error('ChatGPT vault permissions are not private');
  }
  return info;
}
export function chatGPTVaultPath(agentDir, vaultId) {
  if (!validVaultId(vaultId)) throw new Error('Invalid ChatGPT vault identity');
  return join(agentDir, 'chatgpt', `${vaultId}.enc`);
}
export class ChatGPTCredentials {
  #key; #queue = Promise.resolve();
  constructor(path, key) { keyBytes(key); this.path = path; this.#key = key; }
  #load() {
    try {
      privatePath(dirname(this.path), true);
      if (privatePath(this.path, false).size > 1024 * 1024) throw new Error('Invalid ChatGPT vault');
      return openChatGPT(readFileSync(this.path, 'utf8'), this.#key);
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  #save(data) {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 }); privatePath(directory, true);
    try { privatePath(this.path, false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, sealChatGPT(data, this.#key), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
    } finally { try { unlinkSync(temporary); } catch { /* already renamed */ } }
  }
  #locked(fn, options) {
    const operation = this.#queue.catch(() => {}).then(async () => { options?.signal?.throwIfAborted(); return fn(); });
    this.#queue = operation; return operation;
  }
  async read(id, options) { options?.signal?.throwIfAborted(); return id === 'openai' ? this.#load().openai : undefined; }
  async list(options) { return await this.read('openai', options) ? [{ providerId: 'openai', type: 'oauth' }] : []; }
  modify(id, fn, options) {
    return this.#locked(async () => {
      if (id !== 'openai') throw new Error('Unsupported ChatGPT credential provider');
      const data = this.#load(), next = await fn(data.openai);
      options?.signal?.throwIfAborted();
      if (next !== undefined) { data.openai = next; this.#save(data); }
      return data.openai;
    }, options);
  }
  delete(id, options) {
    return this.#locked(() => { options?.signal?.throwIfAborted(); if (id === 'openai') this.#save({}); }, options);
  }
  install(encoded, options) {
    return this.#locked(() => { const data = openChatGPT(encoded, this.#key); options?.signal?.throwIfAborted(); this.#save(data); }, options);
  }
}
