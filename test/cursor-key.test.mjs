// Offline API-key regressions; executed by GitHub CI, never against a real Cursor account.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CURSOR_KEY_ID, Store } from '../app/main/store.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { CursorAcp, cursorEnvironment } from '../agent/cursor-acp.mjs';
import { CursorDesktopSession } from '../agent/pidesk-cursor.mjs';
import { shellQuote } from '../core/transports.mjs';

const KEY = 'cursor-fixture-key-one', NEXT_KEY = 'cursor-fixture-key-two';
const root = dirname(fileURLToPath(import.meta.url));
const config = { enabled: true, command: '~/.local/bin/agent' };
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-cursor-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const storeAt = dir => new Store(dir, {}, { keychainCommand: () => '12'.repeat(32) });

test('Cursor key is encrypted separately; blank saves preserve it and clear is explicit', { skip: process.platform !== 'darwin' }, t => {
  const dir = temp(t), store = storeAt(dir);
  store.saveCursorSettings({ ...config, apiKey: KEY });
  assert.equal(store.getKey(CURSOR_KEY_ID), KEY);
  assert.equal(store.settings.cursor.credentialVersion, 1);
  for (const file of ['settings.json', 'secrets.json']) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(KEY));
  assert.ok(store.secrets[CURSOR_KEY_ID].kc, 'uses the existing AES-GCM/Keychain store');
  store.saveCursorSettings({ ...config, apiKey: '   ' });
  assert.equal(store.settings.cursor.credentialVersion, 1);
  assert.equal(store.getKey(CURSOR_KEY_ID), KEY);
  const reloaded = storeAt(dir);
  assert.equal(reloaded.getKey(CURSOR_KEY_ID), KEY);
  reloaded.saveCursorSettings({ ...config, apiKey: NEXT_KEY });
  assert.equal(reloaded.settings.cursor.credentialVersion, 2);
  assert.equal(reloaded.getKey(CURSOR_KEY_ID), NEXT_KEY);
  reloaded.saveCursorSettings({ ...config, clearKey: true });
  assert.equal(reloaded.settings.cursor.credentialVersion, 3);
  assert.equal(reloaded.hasKey(CURSOR_KEY_ID), false);
  assert.equal(storeAt(dir).getKey(CURSOR_KEY_ID), null);
});

test('failed settings/key writes preserve the previously saved Cursor ciphertext', { skip: process.platform !== 'darwin' }, t => {
  const dir = temp(t), store = storeAt(dir);
  store.saveCursorSettings({ ...config, apiKey: KEY });
  const before = readFileSync(join(dir, 'secrets.json'), 'utf8');
  const saveSettings = store.saveSettings;
  store.saveSettings = () => { throw new Error('settings write failed'); };
  assert.throws(() => store.saveCursorSettings({ ...config, apiKey: NEXT_KEY }), /settings write failed/);
  assert.equal(readFileSync(join(dir, 'secrets.json'), 'utf8'), before);
  assert.equal(store.getKey(CURSOR_KEY_ID), KEY);
  assert.equal(store.settings.cursor.credentialVersion, 1);
  store.saveSettings = saveSettings;
  mkdirSync(join(dir, 'secrets.json.tmp'));
  assert.throws(() => store.setKey(CURSOR_KEY_ID, NEXT_KEY));
  assert.equal(store.getKey(CURSOR_KEY_ID), KEY, 'a failed disk write must not change the in-memory key');
  assert.equal(readFileSync(join(dir, 'secrets.json'), 'utf8'), before);
  for (const apiKey of [123, 'bad\nkey', 'bad\0key', 'a'.repeat(16385)]) assert.throws(() => store.saveCursorSettings({ ...config, apiKey }));
});

function cli(t) {
  const cwd = temp(t), command = join(cwd, 'mock cursor');
  writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'fixtures/cursor-peer.mjs'))} --require-key "$@"\n`);
  chmodSync(command, 0o700);
  return { cwd, command };
}

test('saved Cursor key overrides inherited auth without copying Pi credentials', () => {
  const env = cursorEnvironment({ HOME: '/tmp', CURSOR_AUTH_TOKEN: 'old-login', CURSOR_API_KEY: 'old-key', PIDESK_BOOT: 'pi-secret', ANTHROPIC_API_KEY: 'pi-key' }, KEY);
  assert.deepEqual(env, { HOME: '/tmp', CURSOR_API_KEY: KEY });
});

test('catalog reads API key from stdin, never argv or output', { timeout: 15000 }, async t => {
  const f = cli(t);
  let child;
  const output = new Promise((resolve, reject) => {
    child = execFile(process.execPath, [join(root, '../agent/pidesk-cursor.mjs'), '--catalog', '--boot-stdin', '--cwd', f.cwd, '--command', f.command], { timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  child.stdin.end(JSON.stringify({ cursorApiKey: KEY, cursorCredentialVersion: 7 }) + '\n');
  const stdout = await output;
  assert.equal(JSON.parse(stdout).models.length, 2);
  assert.ok(!child.spawnargs.join(' ').includes(KEY));
  assert.ok(!stdout.includes(KEY));
});

test('Cursor session uses supplied API key and redacts split authentication errors', { timeout: 15000 }, async t => {
  const f = cli(t);
  const client = new CursorAcp({ ...f, apiKey: KEY, env: { ...process.env, CURSOR_AUTH_TOKEN: 'old-login' } });
  t.after(() => client.close());
  const events = [], file = join(f.cwd, 'history.jsonl');
  const desktop = new CursorDesktopSession({ client, cwd: f.cwd, file, credentialVersion: 4, send: event => events.push(structuredClone(event)) });
  await desktop.start();
  assert.equal(desktop.state().cursorCredentialVersion, 4);
  desktop.prompt('auth-status'); await desktop.turn;
  assert.equal(desktop.messages().at(-1).content[0].text, 'Credential: primary');
  desktop.prompt('auth-error'); await desktop.turn;
  assert.equal(desktop.messages().at(-1).stopReason, 'error');
  assert.match(desktop.messages().at(-1).errorMessage, /\[redacted\]/);
  for (const text of [JSON.stringify(events), readFileSync(file, 'utf8'), client.stderr, client.child.spawnargs.join(' ')]) assert.ok(!text.includes(KEY));
});

test('credential changes restart idle sessions once; active work is not interrupted', async t => {
  const record = { id: 'cursor-id', engine: 'cursor', environmentId: 'local' };
  const manager = new SessionManager({ store: { settings: { cursor: { credentialVersion: 2 } }, sessions: [record] }, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  const old = {}, fresh = {};
  let closes = 0, stops = 0;
  manager.runtimes.set(record.id, { session: old, cursorCredentialVersion: 1, streaming: true, questions: new Map() });
  manager.ensureStarted = async () => manager.runtimes.get(record.id)?.session ?? fresh;
  manager.close = async () => { closes++; manager.runtimes.delete(record.id); };
  manager.stopRelay = async () => { stops++; await new Promise(resolve => setImmediate(resolve)); };
  await assert.rejects(manager.cursorSession(record.id), /current turn finish/);
  assert.equal(closes, 0);
  manager.runtimes.get(record.id).streaming = false;
  const one = manager.cursorSession(record.id), two = manager.cursorSession(record.id);
  assert.equal(one, two);
  assert.deepEqual(await Promise.all([one, two]), [fresh, fresh]);
  assert.equal(closes, 1); assert.equal(stops, 1);
});
