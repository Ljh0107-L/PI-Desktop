// Persistent desktop state under Electron's userData directory.
//   settings.json  providers (no keys), defaults, per-environment preferences
//   secrets.json   API keys encrypted with Electron safeStorage (macOS Keychain-backed)
//   sessions.json  session records (where each Pi session lives and how to resume it)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SETTINGS = {
  providers: [],
  defaults: { model: null, thinkingLevel: 'medium', environmentId: 'local' },
  environments: {},
  // Prompt caching: 1-hour provider caches where supported.
  context: { longCache: true },
  customHosts: [],
  recentEnvironments: [],
  recentFolders: {},
};

export class Store {
  constructor(dir, safeStorage, { insecureTestStorage = false } = {}) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.insecure = insecureTestStorage;
    mkdirSync(dir, { recursive: true });
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...this.#read('settings.json', {}) };
    this.settings.defaults = { ...DEFAULT_SETTINGS.defaults, ...this.settings.defaults };
    this.settings.context = { ...DEFAULT_SETTINGS.context, ...this.settings.context };
    this.secrets = this.#read('secrets.json', {});
    this.sessions = this.#read('sessions.json', []);
  }

  #read(name, fallback) {
    const path = join(this.dir, name);
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
  }
  #write(name, value) {
    const path = join(this.dir, name);
    writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  saveSettings() { this.#write('settings.json', this.settings); }
  saveSessions() { this.#write('sessions.json', this.sessions); }

  setKey(providerId, key) {
    if (!key) { delete this.secrets[providerId]; }
    else if (this.insecure) { this.secrets[providerId] = { insecure: Buffer.from(key).toString('base64') }; }
    else {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('System encryption is unavailable; cannot store API keys safely.');
      this.secrets[providerId] = { enc: this.safeStorage.encryptString(key).toString('base64') };
    }
    this.#write('secrets.json', this.secrets);
  }
  getKey(providerId) {
    const entry = this.secrets[providerId];
    if (!entry) return null;
    if (entry.insecure) return Buffer.from(entry.insecure, 'base64').toString();
    return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  }
  hasKey(providerId) { return !!this.secrets[providerId]; }

  touchRecent(environmentId, folder) {
    const s = this.settings;
    s.recentEnvironments = [environmentId, ...s.recentEnvironments.filter(id => id !== environmentId)].slice(0, 8);
    if (folder) s.recentFolders[environmentId] = [folder, ...(s.recentFolders[environmentId] ?? []).filter(f => f !== folder)].slice(0, 8);
    this.saveSettings();
  }
}
