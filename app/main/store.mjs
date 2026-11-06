// Persistent desktop state under Electron's userData directory.
//   settings.json  providers (no keys), defaults, per-environment preferences
//   secrets.json   API keys, AES-256-GCM encrypted; on macOS the key lives in the login Keychain (see below)
//   sessions.json  session records (where each Pi session lives and how to resume it)
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Cursor CLI was removed from Pi Desktop; its saved key and settings are deleted on first start.
const CURSOR_KEY_ID = 'sdk:cursor';

const DEFAULT_SETTINGS = {
  providers: [],
  defaults: { model: null, thinkingLevel: 'medium', environmentId: 'local', subagents: 'limited' },
  environments: {},
  customHosts: [],
  recentEnvironments: [],
  recentFolders: {},
};

// On macOS, API keys are encrypted with a random key kept in a login-Keychain item that is read and written
// through Apple's /usr/bin/security tool. The item trusts that tool, whose signature never changes, so the
// Keychain never asks again after an app update. (Electron's safeStorage item trusts the app's own
// signature, which changes with every ad-hoc-signed release, so macOS asked for the password after each
// update.) Keys saved by older versions are moved over the first time they are read.
const KEYCHAIN_SERVICE = 'Pi Desktop Keys';
const security = args => execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();

export class Store {
  #master = null;
  constructor(dir, safeStorage, { insecureTestStorage = false, keychainCommand = security } = {}) {
    this.dir = dir;
    this.keychainCommand = keychainCommand;
    this.safeStorage = safeStorage;
    this.insecure = insecureTestStorage;
    mkdirSync(dir, { recursive: true });
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...this.#read('settings.json', {}) };
    this.settings.defaults = { ...DEFAULT_SETTINGS.defaults, ...this.settings.defaults };
    this.secrets = this.#read('secrets.json', {});
    this.sessions = this.#read('sessions.json', []);
    this.#forgetCursor();
  }
  #forgetCursor() {
    if (this.settings.cursor !== undefined) { delete this.settings.cursor; try { this.saveSettings(); } catch { /* retried next start */ } }
    if (this.secrets[CURSOR_KEY_ID]) {
      const { [CURSOR_KEY_ID]: _, ...rest } = this.secrets;
      try { this.#write('secrets.json', rest); this.secrets = rest; } catch { /* retried next start */ }
    }
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

  // The Keychain-held key (macOS), created on first use.
  #masterKey() {
    if (this.#master) return this.#master;
    let hex = '', missing = false;
    try { hex = this.keychainCommand(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'master', '-w']); }
    catch (error) {
      // security's item-not-found status is 44. Denied/locked/unavailable is NOT
      // permission to replace the master key and strand every encrypted API key.
      if (error.status !== 44 || Object.values(this.secrets).some(entry => entry?.kc)) throw new Error('Cannot read the existing Pi Desktop key from Keychain. Unlock Keychain and try again; saved keys were not changed.');
      missing = true;
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      if (!missing) throw new Error('Invalid Pi Desktop Keychain key; saved keys were not changed.');
      hex = randomBytes(32).toString('hex');
      // No -U: a racing first launch must fail rather than overwrite another master's key.
      this.keychainCommand(['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'master', '-l', 'Pi Desktop API keys', '-T', '/usr/bin/security', '-w', hex]);
    }
    this.#master = Buffer.from(hex, 'hex');
    return this.#master;
  }
  #seal(text) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#masterKey(), iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { kc: Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64') };
  }
  #open(entry) {
    const raw = Buffer.from(entry.kc, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  get #keychain() { return process.platform === 'darwin' && !this.insecure; }

  setKey(providerId, key) {
    const next = { ...this.secrets };
    if (!key) { delete next[providerId]; }
    else if (this.insecure) { next[providerId] = { insecure: Buffer.from(key).toString('base64') }; }
    else if (this.#keychain) { next[providerId] = this.#seal(key); }
    else {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('System encryption is unavailable; cannot store API keys safely.');
      next[providerId] = { enc: this.safeStorage.encryptString(key).toString('base64') };
    }
    this.#write('secrets.json', next);
    this.secrets = next;
  }
  getKey(providerId) {
    const entry = this.secrets[providerId];
    if (!entry) return null;
    if (entry.insecure) return Buffer.from(entry.insecure, 'base64').toString();
    if (entry.kc) return this.#open(entry);
    if (this.#keychain) { this.#migrate(); return this.getKey(providerId); }
    return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  }
  // Keys saved by older versions (safeStorage): read them all at once (one last Keychain prompt) and re-save.
  #migrate() {
    // Commit the migration only if every entry can be decrypted and re-encrypted.
    // Denying a Keychain prompt must not silently delete the stored ciphertext.
    const migrated = { ...this.secrets };
    for (const [id, entry] of Object.entries(this.secrets)) {
      if (!entry.enc) continue;
      migrated[id] = this.#seal(this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64')));
    }
    this.#write('secrets.json', migrated);
    this.secrets = migrated;
  }
  hasKey(providerId) { return !!this.secrets[providerId]; }

  touchRecent(environmentId, folder) {
    const s = this.settings;
    s.recentEnvironments = [environmentId, ...s.recentEnvironments.filter(id => id !== environmentId)].slice(0, 8);
    if (folder) s.recentFolders[environmentId] = [folder, ...(s.recentFolders[environmentId] ?? []).filter(f => f !== folder)].slice(0, 8);
    this.saveSettings();
  }
}
