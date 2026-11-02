// CI-only startup regressions. No app, real SSH host, provider request, or user data is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { SessionManager } from '../app/main/session-manager.mjs';
import { prepareRemote, remoteInspectionScript } from '../app/main/remote-setup.mjs';
import { PiSession } from '../core/pi-session.mjs';
import { sshRelayTransport } from '../core/transports.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-connect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function managerFixture(t, { remoteSetup } = {}) {
  const dir = temporary(t);
  const env = { id: 'remote', kind: 'ssh', host: 'fixture.invalid', label: 'Fixture', enabled: true };
  const store = {
    sessions: [], settings: { providers: [], environments: {} },
    getKey() {}, saveSettings() {}, saveSessions() {}, touchRecent() {},
  };
  const manager = new SessionManager({ store, environments: () => [env, { id: 'local', kind: 'local', label: 'Local' }],
    local: { agentDir: dir, node: process.execPath, runDir: dir, piCli: 'unused' }, remoteSetup });
  // These tests replace PiSession.start/request/stop; no relay is spawned or stopped.
  manager.stopRelay = async () => {};
  t.mock.method(PiSession.prototype, 'stop', async () => {});
  t.after(() => manager.shutdown());
  return { manager, dir, env, store };
}
function fakeSessions(t, { onStart, onRequest } = {}) {
  const calls = [];
  let number = 0;
  t.mock.method(PiSession.prototype, 'start', async function () {
    number++;
    this.attachInfo = { created: number === 1, pid: 123, startedAt: 456 };
    this.initialState = { sessionFile: '/fixture/session.jsonl', sessionId: 'fixture', thinkingLevel: 'medium', isStreaming: false };
    await onStart?.(this, number);
    this.emit('attached', this.attachInfo);
    return this;
  });
  t.mock.method(PiSession.prototype, 'request', async function (type, payload = {}) {
    calls.push({ session: this, type, ...payload });
    return await onRequest?.(this, type, payload) ?? {};
  });
  return calls;
}

// Exercise the actual shell guard rather than asserting source text: no npm/curl on an intact install.
test('current remote Pi never probes npm or the registry; upgrades still do', async t => {
  const dir = temporary(t), bin = join(dir, 'bin'), root = join(dir, "install with 'quotes");
  const pkg = join(root, 'pi/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(bin); mkdirSync(join(pkg, 'dist/bundle'), { recursive: true });
  writeFileSync(join(pkg, 'dist/bundle/cli.js'), '// fixture CLI');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho npm >> "$MARKER"\necho https://registry.invalid\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\necho curl >> "$MARKER"\n', { mode: 0o755 });
  const marker = join(dir, 'network-checks');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MARKER: marker };
  const exec = promisify(execFile);
  const current = await exec('sh', ['-c', remoteInspectionScript(root, join(bin, 'node'), '1.2.3')], { env });
  assert.match(current.stdout, /pi=1\.2\.3/);
  assert.equal(existsSync(marker), false);
  const upgrade = await exec('sh', ['-c', remoteInspectionScript(root, join(bin, 'node'), '1.2.4')], { env });
  assert.match(upgrade.stdout, /registry=1/);
  assert.equal(readFileSync(marker, 'utf8'), 'npm\ncurl\n');
  rmSync(marker); rmSync(join(pkg, 'dist/bundle/cli.js'));
  const broken = await exec('sh', ['-c', remoteInspectionScript(root, join(bin, 'node'), '1.2.3')], { env });
  assert.match(broken.stdout, /pi=\n/);
  assert.equal(readFileSync(marker, 'utf8'), 'npm\ncurl\n', 'matching package metadata without the CLI must be repaired');
});

function remoteFixture(t) {
  const dir = temporary(t), cacheDir = join(dir, 'cache');
  const env = { host: 'fixture.invalid', sshArgs: ['-p', '2222'] };
  const options = { piVersion: '1.2.3', root: '/fixture/install', cacheDir, bridgePath: join(dir, 'pidesk-bridge.js'), relayPath: join(dir, 'pidesk-relay.mjs') };
  const contents = Object.fromEntries(['pidesk-subagent.mjs', 'pidesk-bridge.js', 'pidesk-relay.mjs'].map(name => {
    const content = `// fixture ${name}\n`; writeFileSync(join(dir, name), content); return [name, content];
  }));
  const inspection = ({ nodeVersion = 'v22.19.0', hashes = true } = {}) =>
    `nodeVersion=${nodeVersion}\npi=1.2.3\n` + (hashes ? Object.entries(contents).map(([name, content]) => `${name}=${createHash('sha256').update(content).digest('hex')}\n`).join('') : '');
  const host = { home: '/fixture', hostname: 'fixture', nodes: [{ path: '/fixture/node/bin/node', version: 'v22.19.0' }], disks: [] };
  return { env, options, inspection, host, contents };
}

test('validated install hint skips discovery after app restart, without skipping version/hash checks', async t => {
  const f = remoteFixture(t), calls = [];
  let probes = 0;
  const deps = { probe: async () => { probes++; return f.host; }, run: async (_env, script) => { calls.push(script); return f.inspection(); } };
  await prepareRemote(f.env, f.options, deps);
  await prepareRemote(f.env, f.options, deps);
  assert.equal(probes, 1, 'second preparation must not invoke login shell/disk/Node discovery');
  assert.equal(calls.length, 2, 'one version/hash validation per preparation; no unchanged upload');
  const hint = JSON.parse(readFileSync(join(f.options.cacheDir, readdirSync(f.options.cacheDir)[0]), 'utf8'));
  assert.deepEqual(Object.keys(hint).sort(), ['home', 'hostname', 'node', 'root']);
  // A different root or SSH identity must never reuse a stale path hint.
  await prepareRemote(f.env, { ...f.options, root: '/other/install' }, deps);
  await prepareRemote({ ...f.env, sshArgs: ['-p', '2223'] }, f.options, deps);
  assert.equal(probes, 3);
});

test('removed cached Node falls back to discovery and repairs its hint', async t => {
  const f = remoteFixture(t);
  await prepareRemote(f.env, f.options, { probe: async () => f.host, run: async () => f.inspection() });
  let calls = 0, probes = 0;
  const facts = await prepareRemote(f.env, f.options, {
    probe: async () => { probes++; return { ...f.host, nodes: [{ path: '/replacement/bin/node', version: 'v22.19.0' }] }; },
    run: async () => f.inspection({ nodeVersion: ++calls === 1 ? '' : 'v22.19.0' }),
  });
  assert.equal(probes, 1); assert.equal(calls, 2); assert.equal(facts.node, '/replacement/bin/node');
});

test('bridge updates send only changed files together over stdin', async t => {
  const f = remoteFixture(t), uploads = [];
  await prepareRemote(f.env, f.options, { probe: async () => f.host, run: async (_env, script, options) => {
    if (!options?.input) return f.inspection({ hashes: false });
    uploads.push({ script, files: JSON.parse(options.input) }); return '';
  } });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].files.length, 3);
  for (const file of uploads[0].files) {
    assert.equal(Buffer.from(file.content, 'base64').toString(), f.contents[file.name]);
    assert.ok(!uploads[0].script.includes(file.content), 'file contents must not appear in argv');
  }
});

test('setup overlaps catalog discovery, and force joins in-flight preparation', async t => {
  const catalog = deferred(), setup = deferred();
  let calls = 0, receivedHosts;
  const { manager } = managerFixture(t, { remoteSetup: async (_env, options) => {
    calls++; receivedHosts = options.providerHosts; await setup.promise;
    return { root: '/fixture/install', unreachable: [] };
  } });
  manager.providerHosts = () => catalog.promise;
  const first = manager.prepare('remote');
  assert.equal(calls, 1, 'host setup begins before catalog settles');
  assert.equal(receivedHosts, catalog.promise);
  assert.equal(manager.prepare('remote', { force: true }), first);
  catalog.resolve([]); setup.resolve(); await first;
  await manager.prepare('remote');
  assert.equal(calls, 1, 'ordinary reconnect uses prepared facts');
});

test('provider edits serialize a new preparation behind the old one', async t => {
  const firstSetup = deferred();
  let calls = 0;
  const { manager } = managerFixture(t, { remoteSetup: async () => {
    calls++; if (calls === 1) await firstSetup.promise;
    return { root: '/fixture/install', unreachable: calls === 1 ? [] : ['new.invalid:443'] };
  } });
  manager.providerHosts = async () => [];
  const first = manager.prepare('remote');
  const ready = []; manager.on('environment', event => { if (event.status === 'ready') ready.push(event); });
  manager.store.settings.environments.remote = { label: 'Edited during setup', enabled: false };
  manager.providersChanged();
  const second = manager.prepare('remote'), third = manager.prepare('remote', { force: true });
  assert.equal(calls, 1); assert.equal(first, second); assert.equal(second, third);
  firstSetup.resolve();
  assert.deepEqual((await first).unreachable, ['new.invalid:443'], 'original caller also needs fresh provider reachability');
  assert.deepEqual((await second).unreachable, ['new.invalid:443']);
  await third; assert.equal(calls, 2, 'queued refresh callers must join the same deployment');
  assert.equal(ready.length, 1, 'never publish stale ready facts');
  assert.equal(manager.store.settings.environments.remote.label, 'Edited during setup');
  assert.equal(manager.store.settings.environments.remote.enabled, false);
  await manager.prepare('remote'); assert.equal(calls, 2, 'latest refresh remains cached');
});

test('failed setup is retryable and does not retain its in-flight entry', async t => {
  let calls = 0;
  const { manager } = managerFixture(t, { remoteSetup: async () => {
    if (++calls === 1) throw new Error('fixture offline');
    return { root: '/fixture/install', unreachable: [] };
  } });
  manager.providerHosts = async () => [];
  await assert.rejects(manager.prepare('remote'), /fixture offline/);
  assert.equal(manager.preparing.size, 0); assert.equal(manager.prepared.size, 0);
  await manager.prepare('remote'); assert.equal(calls, 2);
});

test('same-process reconnect skips provider/model/thinking mutations but refreshes goal', async t => {
  const { manager, dir } = managerFixture(t);
  const calls = fakeSessions(t);
  const statuses = []; manager.on('status', status => statuses.push(status));
  const record = { id: 'session', environmentId: 'local', cwd: dir, thinkingLevel: 'medium' };
  manager.store.sessions.push(record);
  await manager.ensureStarted(record.id);
  const runtime = manager.runtimes.get(record.id);
  assert.equal(calls.length, 0, 'matching initial thinking level needs no config RPC');
  runtime.status = 'reconnecting';
  await manager.ensureStarted(record.id);
  assert.deepEqual(calls.map(call => [call.type, call.message]), [['prompt', '/goal']]);
  assert.ok(statuses.some(status => status.phase === 'starting'));
  assert.ok(statuses.some(status => status.phase === 'configuring'));
  assert.equal(statuses.at(-1).phase, null);
  // An unknown or replaced relay process must not inherit the old sync acknowledgement.
  const replacedCalls = fakeSessions(t, { onStart: session => { session.attachInfo = { created: false, pid: 123, startedAt: 999 }; } });
  runtime.status = 'reconnecting';
  await manager.ensureStarted(record.id);
  assert.equal(replacedCalls.filter(call => call.message?.startsWith('/pidesk-providers ')).length, 1);
  assert.equal(runtime.providerProcess, '123:999');
  assert.equal(runtime.providersVersion, manager.providersVersion);
});

test('providers changed during startup are synced, then concurrent edits share one update', async t => {
  const { manager, dir } = managerFixture(t);
  const gate = deferred();
  let started;
  const entered = deferred();
  const calls = fakeSessions(t, { onStart: async session => { started = session; entered.resolve(); await gate.promise; } });
  const record = { id: 'session', environmentId: 'local', cwd: dir };
  manager.store.sessions.push(record);
  const starting = manager.ensureStarted(record.id); await entered.promise;
  manager.providersChanged(); gate.resolve(); await starting;
  assert.equal(calls.filter(call => call.message?.startsWith('/pidesk-providers ')).length, 1);
  const update = deferred(); let updates = 0;
  t.mock.method(PiSession.prototype, 'request', async function (_type, payload) {
    if (payload?.message?.startsWith('/pidesk-providers ')) { updates++; if (updates === 1) await update.promise; }
    return {};
  });
  manager.providersChanged(); manager.providersChanged();
  assert.equal(updates, 1);
  update.resolve(); await tick();
  assert.equal(updates, 2, 'latest provider version follows the pending one exactly once');
  assert.equal(manager.runtimes.get(record.id).providersVersion, manager.providersVersion);
  assert.equal(manager.runtimes.get(record.id).session, started);
});

test('existing egress port is preserved even if fresh reachability is empty', async t => {
  const { manager, dir } = managerFixture(t);
  const calls = fakeSessions(t);
  manager.prepare = async () => ({ unreachable: [], node: '/node', piCli: '/pi', bridge: '/bridge', relay: '/relay', runDir: '/run', agentDir: '/agent' });
  manager.providerHosts = async () => [];
  const allowed = [];
  manager.egress = { port: 43210, allow: hosts => allowed.push(hosts), close() {} };
  const record = { id: 'egress', environmentId: 'remote', cwd: dir, egressPort: 34567 };
  manager.store.sessions.push(record);
  const session = await manager.ensureStarted(record.id);
  assert.ok(session.transport.args.includes('127.0.0.1:34567:127.0.0.1:43210'));
  assert.equal(session.relay.spawn.env.HTTPS_PROXY, 'http://127.0.0.1:34567');
  assert.ok(session.transport.args.includes('ControlPath=none'), 'fixed forward must die with its own connection');
  assert.deepEqual(allowed, [[]]); assert.equal(calls.length, 0);
});

test('failed hint inspection falls back to discovery; invalid discovered Node fails clearly', async t => {
  const f = remoteFixture(t);
  await prepareRemote(f.env, f.options, { probe: async () => f.host, run: async () => f.inspection() });
  let probes = 0, calls = 0;
  await prepareRemote(f.env, f.options, {
    probe: async () => { probes++; return f.host; },
    run: async () => { if (++calls === 1) throw new Error('stale hint'); return f.inspection(); },
  });
  assert.equal(probes, 1); assert.equal(calls, 2);
  await assert.rejects(prepareRemote(f.env, { ...f.options, root: '/uncached' }, {
    probe: async () => f.host, run: async () => f.inspection({ nodeVersion: '' }),
  }), /No usable Node.js/);
});

test('catalog rejection during setup is observed immediately without releasing the deployment lock', async t => {
  const catalog = deferred(), setup = deferred();
  let calls = 0;
  const { manager } = managerFixture(t, { remoteSetup: async () => {
    calls++; await setup.promise; return { root: '/fixture/install', unreachable: [] };
  } });
  manager.providerHosts = () => catalog.promise;
  const first = manager.prepare('remote');
  const rejected = assert.rejects(first, /catalog failed/);
  catalog.reject(new Error('catalog failed')); await tick();
  assert.equal(manager.prepare('remote', { force: true }), first);
  assert.equal(calls, 1);
  setup.resolve(); await rejected;
  assert.equal(manager.preparing.size, 0);
});

test('catalog rejection after early remote failure is still observed', async t => {
  const f = remoteFixture(t), catalog = deferred();
  await assert.rejects(prepareRemote(f.env, { ...f.options, providerHosts: catalog.promise }, {
    probe: async () => { throw new Error('offline'); }, run: async () => f.inspection(),
  }), /offline/);
  catalog.reject(new Error('late catalog failure')); await tick();
});

test('direct remote setup observes catalog rejection while inspection is pending', async t => {
  const f = remoteFixture(t), catalog = deferred(), inspection = deferred();
  const preparing = prepareRemote(f.env, { ...f.options, providerHosts: catalog.promise }, {
    probe: async () => f.host, run: async () => inspection.promise,
  });
  const rejected = assert.rejects(preparing, /early catalog failure/);
  catalog.reject(new Error('early catalog failure')); await tick();
  inspection.resolve(f.inspection()); await rejected;
});

test('old catalog failure cannot evict a replacement catalog cache', async t => {
  const { manager, store } = managerFixture(t), first = deferred(), second = deferred();
  store.settings.providers = [{ id: 'fixture', kind: 'builtin' }];
  fakeSessions(t, { onStart: async (_session, number) => number === 1 ? first.promise : second.promise,
    onRequest: async () => ({ models: [] }) });
  const old = manager.catalog(), rejected = assert.rejects(old, /old catalog failure/);
  manager.invalidateCatalog();
  const fresh = manager.catalog(), cached = manager.catalogCache;
  first.reject(new Error('old catalog failure')); await rejected;
  assert.equal(manager.catalogCache, cached);
  second.resolve(); await fresh;
});

test('model switch completes before thinking is applied', async t => {
  const { manager, dir } = managerFixture(t), model = deferred(), entered = deferred();
  const calls = fakeSessions(t, { onRequest: async (_session, type) => {
    if (type === 'set_model') { entered.resolve(); await model.promise; }
  } });
  const record = { id: 'model-order', environmentId: 'local', cwd: dir, model: { provider: 'fixture', id: 'reasoning' }, thinkingLevel: 'high' };
  manager.store.sessions.push(record);
  const starting = manager.ensureStarted(record.id); await entered.promise;
  assert.deepEqual(calls.map(call => call.type), ['set_model']);
  model.resolve(); await starting;
  assert.deepEqual(calls.map(call => call.type), ['set_model', 'set_thinking_level']);
});

test('same-process reconnect drains an old provider update before sending newer settings', async t => {
  const { manager, dir } = managerFixture(t), pending = deferred();
  let updates = 0;
  fakeSessions(t, { onRequest: async (_session, _type, payload) => {
    if (payload.message?.startsWith('/pidesk-providers ') && ++updates === 1) await pending.promise;
  } });
  const record = { id: 'provider-reconnect', environmentId: 'local', cwd: dir };
  manager.store.sessions.push(record); await manager.ensureStarted(record.id);
  manager.providersChanged();
  const runtime = manager.runtimes.get(record.id); runtime.status = 'reconnecting';
  manager.providersChanged();
  const reconnecting = manager.ensureStarted(record.id); await tick();
  assert.equal(updates, 1, 'no new update may overtake the old transport');
  pending.resolve(); await reconnecting;
  assert.equal(updates, 2); assert.equal(runtime.providersVersion, manager.providersVersion);
});

test('failed provider update blocks a user prompt instead of silently using old keys', async t => {
  const { manager, dir } = managerFixture(t);
  const calls = fakeSessions(t, { onRequest: async (_session, _type, payload) => {
    if (payload.message?.startsWith('/pidesk-providers ')) throw new Error('provider sync failed');
  } });
  const record = { id: 'provider-failure', environmentId: 'local', cwd: dir };
  manager.store.sessions.push(record); await manager.ensureStarted(record.id);
  manager.providersChanged(); await tick();
  await assert.rejects(manager.prompt(record.id, 'must not send'), /provider sync failed/);
  assert.ok(!calls.some(call => call.message === 'must not send'));
  assert.notEqual(manager.runtimes.get(record.id).providersVersion, manager.providersVersion);
});

test('relay resume argv stays secret-free and egress connections never multiplex', () => {
  const transport = sshRelayTransport({ host: 'fixture.invalid', node: '/node', relayPath: '/relay', shared: true,
    egress: { remotePort: 34567, localPort: 43210 } });
  assert.ok(transport.args.includes('ControlMaster=no'));
  assert.ok(transport.args.includes('ExitOnForwardFailure=yes'));
  assert.ok(!transport.args.some(arg => /BOOT|apiKey|providers/.test(arg)));
});
