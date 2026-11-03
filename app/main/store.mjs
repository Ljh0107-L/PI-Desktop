// Persistent desktop state under Electron's userData directory.
//   settings.json  providers (no keys), defaults, per-environment preferences
//   secrets.json   API keys, AES-256-GCM encrypted; on macOS the key lives in the login Keychain (see below)
//   sessions.json  session records (where each Pi session lives and how to resume it)
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CURSOR_KEY_ID = 'sdk:cursor';

const DEFAULT_SETTINGS = {
  providers: [],
  defaults: { model: null, thinkingLevel: 'medium', environmentId: 'local' },
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

// A Cursor model's own settings (reasoning effort, other parameters) with Cursor's defaults, bounded.
const text = (value, max = 300) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
const cleanCursorOptions = options => (Array.isArray(options) ? options : [])
  .filter(o => o && typeof o.id === 'string' && o.id && o.id.length < 200 && (o.type === 'select' || o.type === 'boolean')).slice(0, 12)
  .map(o => ({
    id: o.id, name: text(o.name) ?? o.id, category: text(o.category, 60), type: o.type,
    currentValue: typeof o.currentValue === 'string' ? o.currentValue.slice(0, 200) : typeof o.currentValue === 'boolean' ? o.currentValue : undefined,
    ...(o.type === 'select' ? { options: (o.options ?? []).flatMap(v => v?.options ?? [v]).filter(v => v && typeof v.value === 'string' && v.value).slice(0, 30).map(v => ({ value: v.value.slice(0, 200), name: text(v.name) ?? v.value })) } : {}),
  }));
const cleanCursorModel = m => ({ id: m.id, name: text(m.name) ?? m.id, ...(Array.isArray(m.configOptions) ? { configOptions: cleanCursorOptions(m.configOptions) } : {}) });

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
  saveCursorSettings({ enabled, command, apiKey, clearKey = false }) {
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error('Cursor API Key must be text');
    const key = apiKey?.trim();
    if (key && (key.length > 16384 || /[\s\x00-\x1f\x7f]/.test(key))) throw new Error('Invalid Cursor API Key');
    if (key && clearKey) throw new Error('Cannot save and remove the Cursor API Key together');
    const previous = this.settings.cursor;
    const previousSecrets = this.secrets;
    const changed = !!key || (clearKey && this.hasKey(CURSOR_KEY_ID));
    const version = Number.isSafeInteger(previous?.credentialVersion) ? previous.credentialVersion : 0;
    let wroteKey = false;
    try {
      if (changed) { this.setKey(CURSOR_KEY_ID, key || null); wroteKey = true; }
      // Whitelist settings: plaintext keys and renderer hasKey flags never reach settings.json.
      this.settings.cursor = { ...previous, enabled: !!enabled, command, favorites: Array.isArray(previous?.favorites) ? previous.favorites : [], models: Array.isArray(previous?.models) ? previous.models : [], modelsAt: previous?.modelsAt, currentModelId: previous?.currentModelId, credentialVersion: version + (changed ? 1 : 0) };
      this.saveSettings();
    } catch (error) {
      if (previous === undefined) delete this.settings.cursor; else this.settings.cursor = previous;
      if (wroteKey) {
        try { this.#write('secrets.json', previousSecrets); this.secrets = previousSecrets; }
        catch { throw new Error('Could not save Cursor settings or restore the previous key. Check storage permissions and save the key again.'); }
      }
      throw error;
    }
  }
  saveCursorModels({ models, currentModelId }) {
    const clean = (models ?? []).filter(m => m && typeof m.id === 'string' && m.id && m.id.length < 300).slice(0, 500).map(cleanCursorModel);
    const previous = this.settings.cursor;
    this.settings.cursor = { ...previous, models: clean, modelsAt: Date.now(), currentModelId: typeof currentModelId === 'string' ? currentModelId : undefined };
    try { this.saveSettings(); } catch (error) { this.settings.cursor = previous; throw error; }
  }
  // Each model's settings as a pre-started Cursor CLI lists them (efforts and their defaults), so a new
  // conversation offers the right efforts. Only models already in the catalogue are updated.
  mergeCursorModelSettings(models) {
    const listed = new Map((Array.isArray(models) ? models : []).filter(m => m && typeof m.id === 'string' && Array.isArray(m.configOptions)).map(m => [m.id, cleanCursorOptions(m.configOptions)]));
    const previous = this.settings.cursor;
    if (!listed.size || !previous?.models?.some(m => listed.has(m.id))) return false;
    const updated = previous.models.map(m => listed.has(m.id) ? { ...m, configOptions: listed.get(m.id) } : m);
    if (JSON.stringify(updated) === JSON.stringify(previous.models)) return false;
    this.settings.cursor = { ...previous, models: updated };
    try { this.saveSettings(); } catch (error) { this.settings.cursor = previous; throw error; }
    return true;
  }
  clearCursorModels() {
    const previous = this.settings.cursor;
    this.settings.cursor = { ...previous, models: [], modelsAt: 0, currentModelId: undefined };
    try { this.saveSettings(); } catch (error) { this.settings.cursor = previous; throw error; }
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
