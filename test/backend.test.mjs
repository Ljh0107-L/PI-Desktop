// Backend lifecycle regressions. Isolated relay + fake RPC, no SSH/model required.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { PiSession } from '../core/pi-session.mjs';
import { localRelayTransport, relaySpawnSpec } from '../core/transports.mjs';
import { startEgressProxy } from '../core/egress-proxy.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { Store } from '../app/main/store.mjs';

const exec = promisify(execFile);
const relaySource = resolve('agent/pidesk-relay.mjs');
const peer = resolve('test/fixtures/rpc-peer.mjs');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(25); }
  assert.fail('condition timed out');
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(t, { startDaemon = true, mode, delay = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdb-'));
  const runDir = join(dir, 'run'); mkdirSync(runDir);
  const relayPath = join(dir, 'relay.mjs'); copyFileSync(relaySource, relayPath);
  const env = { ...process.env, PIDESK_RUN_DIR: runDir };
  const relay = async (...args) => JSON.parse((await exec(process.execPath, [relayPath, ...args], { env, timeout: 10000 })).stdout);
  let daemon;
  if (startDaemon) {
    daemon = spawn(process.execPath, [relayPath, 'daemon'], { env, stdio: 'ignore' });
    await waitFor(async () => (await relay('list')).daemon !== false);
  }
  const sessions = [], cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await Promise.all(sessions.map(s => s.stop(50).catch(() => {})));
    for (const s of (await relay('list')).sessions ?? []) if (s.alive) await relay('stop', s.id);
    if (daemon) { const closed = once(daemon, 'close'); daemon.kill(); await closed; }
    else { // only this fixture's private script; never stop an app/user relay
      await exec('pkill', ['-f', `${relayPath} daemon`]).catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const spec = relaySpawnSpec({ cwd: dir, node: process.execPath, piCli: peer, agentDir: dir,
    extraEnv: { TEST_RPC_MODE: mode ?? '', TEST_READY_DELAY: String(delay) } });
  const connect = (id = 'test', spawnSpec = spec) => {
    const session = new PiSession({ id, transport: localRelayTransport({ node: process.execPath, relayPath, runDir }), relay: { spawn: spawnSpec } });
    sessions.push(session); return session;
  };
  return { dir, runDir, relayPath, relay, connect, cleanups };
}
function managerFor(t, f, extraEnv = {}) {
  const store = { sessions: [], settings: { providers: [], environments: {} }, saveSessions() {}, touchRecent() {} };
  const manager = new SessionManager({ store, environments: () => [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', enabled: true }],
    local: { node: process.execPath, piCli: peer, agentDir: f.dir, runDir: f.runDir, extraEnv }, relayPath: f.relayPath, bridgePath: peer });
  f.cleanups.push(() => manager.shutdown());
  return manager;
}

test('cancelling a starting spare is silent and cannot drop its replacement', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const manager = managerFor(t, f, { TEST_READY_DELAY: '400' });
  const statuses = []; manager.on('status', s => statuses.push(s));
  const draft = { environmentId: 'local', cwd: f.dir };
  await manager.prewarm(draft);
  const oldId = [...manager.spares.values()][0].id;
  await waitFor(() => manager.runtimes.get(oldId)?.session?.attachInfo);
  manager.providersChanged(); // cancels while get_state is pending
  await manager.prewarm(draft); // same key, new identity
  const replacement = [...manager.spares.values()][0];
  await waitFor(() => manager.runtimes.get(replacement.id)?.status === 'connected');
  await waitFor(async () => !(await f.relay('list')).sessions.find(s => s.id === oldId)?.alive);
  assert.equal([...manager.spares.values()][0], replacement);
  assert.equal(statuses.length, 0, 'background warm/cancel must not publish a visible error/status');
  const record = await manager.create(draft);
  assert.equal(record.id, replacement.id, 'warm process remains adoptable');
});

test('closing during remote preparation prevents a late spawn or visible error', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const manager = managerFor(t, f);
  let prepared;
  const preparing = new Promise(resolve => { prepared = resolve; });
  manager.prepare = () => preparing;
  manager.stopRelay = async () => {};
  let starts = 0;
  t.mock.method(PiSession.prototype, 'start', async () => { starts++; throw new Error('should not spawn'); });
  const statuses = []; manager.on('status', s => statuses.push(s));
  await manager.prewarm({ environmentId: 'remote', cwd: f.dir });
  const id = [...manager.spares.values()][0].id;
  const closing = manager.close(id);
  prepared({ unreachable: [] });
  await closing;
  assert.equal(starts, 0);
  assert.equal(statuses.length, 0);
  assert.equal(manager.runtimes.has(id), false);
});

test('real foreground startup errors are still visible', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const manager = managerFor(t, f, { TEST_RPC_MODE: 'exit' });
  const statuses = []; manager.on('status', s => statuses.push(s));
  await assert.rejects(manager.create({ environmentId: 'local', cwd: f.dir }), /Pi exited.*code=23/);
  assert.ok(statuses.some(s => s.status === 'error' && s.message.includes('cannot load session')));
});

test('relay preserves Pi exit code and stderr through attach shutdown', { timeout: 10000 }, async t => {
  const f = await fixture(t, { mode: 'exit' });
  const s = f.connect();
  await assert.rejects(s.start(), /Pi exited \(code=23 signal=null\)\nfixture: cannot load session/);
  assert.equal(s.piExit.code, 23);
});

test('spawn ENOENT is reported promptly and is not retained as an alive session', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const s = f.connect('missing', { cwd: f.dir, argv: [join(f.dir, 'does-not-exist')], env: {} });
  await assert.rejects(s.start({ readyTimeout: 1500 }), /spawn failed:.*ENOENT/);
  assert.equal((await f.relay('list')).sessions.find(s => s.id === 'missing').alive, false);
});

test('malformed handshakes cannot crash the shared relay daemon', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const value of [null, [], { op: 'attach', sessionId: 'bad', spawn: {} }]) {
    const socket = net.connect(join(f.runDir, 'relay.sock'));
    socket.on('error', () => {}); socket.resume();
    const closed = once(socket, 'close');
    socket.end(JSON.stringify(value) + '\n'); await closed;
  }
  const s = f.connect(); await s.start();
  assert.equal(s.initialState.sessionId, 'fixture');
});

test('stop acknowledgement waits for forced exit before reusing the session id', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mode: 'stubborn' });
  const s = f.connect(); await s.start();
  const pid = s.attachInfo.pid;
  await f.relay('stop', s.id);
  assert.equal(alive(pid), false, 'old writer must be dead when stop returns');
  const next = f.connect(); await next.start();
  assert.equal(next.attachInfo.created, true);
  assert.notEqual(next.attachInfo.pid, pid);
});

test('startup timeout cleans up its attach transport', { timeout: 10000 }, async t => {
  const f = await fixture(t, { mode: 'silent' });
  const s = f.connect();
  await assert.rejects(s.start({ readyTimeout: 100 }), /timeout waiting for get_state/);
  assert.equal(alive(s.pid), false);
  assert.equal((await f.relay('list')).sessions[0].clients, 0);
});

test('concurrent cold attaches recover a stale socket without split daemons', { timeout: 15000 }, async t => {
  const f = await fixture(t, { startDaemon: false });
  // A regular stale socket-path file produces EADDRINUSE/EEXIST across Node/macOS versions.
  writeFileSync(join(f.runDir, 'relay.sock'), 'stale');
  const sessions = Array.from({ length: 12 }, (_, i) => f.connect(`concurrent-${i}`));
  await Promise.all(sessions.map(s => s.start({ readyTimeout: 10000 })));
  const list = (await f.relay('list')).sessions;
  assert.equal(list.length, sessions.length);
  assert.ok(list.every(s => s.alive && s.clients === 1));
  const log = readFileSync(join(f.runDir, 'relay.log'), 'utf8');
  assert.ok(!/EEXIST|EADDRINUSE|uncaught/i.test(log), log);
});

test('interrupt deadline includes a hung abort RPC', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const manager = managerFor(t, f, { TEST_RPC_MODE: 'stubborn' });
  const record = await manager.create({ environmentId: 'local', cwd: f.dir });
  const runtime = manager.runtimes.get(record.id);
  const pid = runtime.session.attachInfo.pid;
  runtime.streaming = true;
  const started = Date.now();
  const result = await manager.prompt(record.id, 'replacement', [], { interrupt: true });
  assert.equal(result.interrupted, true);
  assert.ok(Date.now() - started < 9000, 'must not await the 30s RPC timeout ahead of the 4s deadline');
  assert.equal(alive(pid), false);
  assert.notEqual(manager.runtimes.get(record.id).session.attachInfo.pid, pid);
});

test('cancelled forks never persist a second record pointing at the source file', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const manager = managerFor(t, f);
  const file = join(f.dir, 'source.jsonl'); writeFileSync(file, 'source history\n');
  manager.store.sessions.push({ id: 'source', title: 'Source', environmentId: 'local', cwd: f.dir, piSessionFile: file });
  const request = PiSession.prototype.request;
  t.mock.method(PiSession.prototype, 'request', function (type, ...args) {
    if (type === 'clone') return Promise.resolve({ cancelled: true });
    return request.call(this, type, ...args);
  });
  await assert.rejects(manager.fork('source'), /Forking was cancelled/);
  assert.equal(manager.store.sessions.length, 1);
  assert.equal(readFileSync(file, 'utf8'), 'source history\n');
  assert.ok((await f.relay('list')).sessions.every(s => !s.alive));
});

test('Keychain failures never replace the master key or erase saved ciphertext', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'pdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { provider: { kc: Buffer.alloc(64).toString('base64') } };
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(saved));
  for (const status of [36, 44, 128]) {
    const calls = [];
    const store = new Store(dir, {}, { keychainCommand: args => { calls.push(args[0]); throw Object.assign(new Error('Keychain unavailable'), { status }); } });
    assert.throws(() => store.getKey('provider'), /saved keys were not changed/);
    assert.deepEqual(calls, ['find-generic-password']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')), saved);
  }
  const invalid = new Store(dir, {}, { keychainCommand: () => 'invalid key' });
  assert.throws(() => invalid.setKey('new', 'test-only'), /Invalid Pi Desktop Keychain key/);
});

test('legacy key migration is all-or-nothing when a decryption is denied', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'pdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { a: { enc: Buffer.from('a').toString('base64') }, b: { enc: Buffer.from('b').toString('base64') } };
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(saved));
  const store = new Store(dir, { decryptString: buffer => { if (buffer.toString() === 'b') throw new Error('Denied'); return 'test-only'; } },
    { keychainCommand: () => '01'.repeat(32) });
  assert.throws(() => store.getKey('a'), /Denied/);
  assert.deepEqual(store.secrets, saved);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')), saved);
});

test('first Keychain key creation does not overwrite a racing existing item', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'pdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const store = new Store(dir, {}, { keychainCommand: args => {
    calls.push(args);
    if (args[0] === 'find-generic-password') throw Object.assign(new Error('missing'), { status: 44 });
    return '';
  } });
  store.setKey('provider', 'test-only');
  assert.equal(calls[1][0], 'add-generic-password');
  assert.ok(!calls[1].includes('-U'));
  assert.equal(store.getKey('provider'), 'test-only');
  assert.ok(!readFileSync(join(dir, 'secrets.json'), 'utf8').includes('test-only'));
});

test('egress shutdown destroys CONNECT tunnels and handles listen errors', { timeout: 5000 }, async t => {
  const peers = new Set();
  const upstream = net.createServer(s => { peers.add(s); s.on('close', () => peers.delete(s)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { for (const s of peers) s.destroy(); upstream.close(); });
  const target = `127.0.0.1:${upstream.address().port}`;
  const proxy = await startEgressProxy({ allow: [target] });
  t.after(() => proxy.close());
  const client = net.connect(proxy.port, '127.0.0.1');
  client.on('error', () => {});
  client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const [response] = await once(client, 'data');
  assert.match(response.toString(), /200 Connection Established/);
  await assert.rejects(startEgressProxy({ port: proxy.port }), { code: 'EADDRINUSE' });
  await proxy.close();
  await waitFor(() => client.destroyed && peers.size === 0);
});

// Nothing of the app keeps running on this Mac after it quits; sessions on SSH hosts keep their relays.
test('the relay shutdown stops every session, answers, then exits', { timeout: 15000 }, async t => {
  const f = await fixture(t, { startDaemon: false });
  const a = f.connect('quit-a'), b = f.connect('quit-b');
  await a.start(); await b.start();
  const pids = (await f.relay('list')).sessions.map(s => s.pid);
  assert.equal(pids.length, 2);
  assert.equal((await f.relay('shutdown')).relay, 'shutdown');
  await waitFor(async () => (await f.relay('list')).daemon === false);
  for (const pid of pids) assert.equal(alive(pid), false, `Pi ${pid} stopped with the relay`);
});

test('quitting the app leaves no local relay or Pi behind', { timeout: 15000 }, async t => {
  const f = await fixture(t, { startDaemon: false });
  const manager = managerFor(t, f);
  const record = await manager.create({ environmentId: 'local', cwd: f.dir, model: { provider: 'fixture', id: 'model' } });
  const pid = (await f.relay('list')).sessions.find(s => s.id === record.id)?.pid;
  assert.ok(pid && alive(pid));
  await manager.shutdown();
  assert.equal((await f.relay('list')).daemon, false, 'the relay daemon exited');
  assert.equal(alive(pid), false);
});

test('quitting also ends a relay daemon from an older version, which has no shutdown', { timeout: 15000 }, async t => {
  const f = await fixture(t, { startDaemon: false });
  writeFileSync(f.relayPath, readFileSync(relaySource, 'utf8').replace("message.op === 'shutdown'", "message.op === 'not-in-older-versions'"));
  const manager = managerFor(t, f);
  const record = await manager.create({ environmentId: 'local', cwd: f.dir, model: { provider: 'fixture', id: 'model' } });
  const pid = (await f.relay('list')).sessions.find(s => s.id === record.id)?.pid;
  assert.ok(pid && alive(pid));
  assert.equal(await f.relay('shutdown').catch(() => 'no answer'), 'no answer', 'this daemon ignores shutdown');
  await manager.shutdown();
  assert.equal((await f.relay('list')).daemon, false, 'the old daemon was ended, not left to idle');
  assert.equal(alive(pid), false);
});
