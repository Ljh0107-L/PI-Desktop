// Fake SSH: execute setup commands against a temporary install root, never a real host.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareRemote, readInstallHint } from '../app/main/remote-setup.mjs';
import { shellQuote } from '../core/transports.mjs';

const exec = promisify(execFile);
const engine = 'antigravity';
const adapter = 'pidesk-antigravity.mjs';
const relay = 'pidesk-relay.mjs';
const history = 'pidesk-history.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-agy-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "install with 'quotes"), cacheDir = join(dir, 'cache');
  const env = { host: 'agy-fixture.invalid', sshArgs: ['-p', '2222'] };
  const options = { engine, root, cacheDir, relayPath: join(dir, relay), antigravityAdapterPath: join(dir, adapter) };
  writeFileSync(options.relayPath, '// fixture relay\n');
  writeFileSync(options.antigravityAdapterPath, '// fixture adapter\n');
  const host = { home: dir, hostname: 'agy-fixture', nodes: [{ path: process.execPath, version: process.version }], disks: [] };
  const calls = [];
  const run = async (target, script, { input } = {}) => {
    assert.equal(target, env);
    assert.doesNotMatch(script, /registry\.npm|\/npm\b|\/pi\/node_modules|\/ext\/|pidesk-bridge|cursor-sdk|models\.invalid/);
    calls.push({ script, input });
    const command = exec('/bin/sh', ['-c', script], { env: { ...process.env, HOME: dir }, timeout: 5000 });
    command.child.stdin.on('error', () => {});
    command.child.stdin.end(input);
    return (await command).stdout;
  };
  return { dir, root, cacheDir, env, host, options, calls, run };
}

function file(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('standalone Antigravity deploys no Pi runtime and keeps old session data', async t => {
  const f = fixture(t);
  const existing = ['ext/pidesk-relay.mjs', 'ext/pidesk-antigravity.mjs', 'cursor-sdk/runtime', 'agent/sessions/antigravity/old.jsonl', 'run/relay.log'];
  for (const entry of existing) file(join(f.root, entry), entry);
  let probes = 0;
  const deps = { run: f.run, probe: async () => {
    probes++;
    return { ...f.host, disks: [{ dir: f.dir, kb: 100 * 1024, exec: true }, { dir: '/tmp', kb: 9999999, exec: true }] };
  } };
  let catalogStarts = 0;
  const providerHosts = { then(resolve) { catalogStarts++; resolve(['models.invalid:443']); } };
  const facts = await prepareRemote(f.env, { ...f.options, providerHosts, bridgePath: join(f.dir, 'missing-bridge.js'), piPackageDir: join(f.dir, 'missing-pi') }, deps);
  assert.equal(catalogStarts, 0, 'Antigravity must not start the provider catalog');
  assert.equal(facts.root, f.root);
  assert.equal(facts.relay, join(f.root, 'antigravity', relay));
  assert.equal(facts.adapter, join(f.root, 'antigravity', adapter));
  assert.equal(facts.agentDir, join(f.root, 'agent'));
  assert.equal(facts.runDir, join(f.root, 'run'));
  assert.equal(facts.tmpDir, join(f.root, 'tmp'));
  assert.equal(statSync(facts.runDir).mode & 0o777, 0o700);
  assert.equal(facts.piCli, undefined);
  assert.deepEqual(facts.unreachable, []);
  assert.equal(existsSync(join(f.root, 'pi')), false);
  assert.equal(facts.history, join(f.root, 'antigravity', history));
  assert.deepEqual(readdirSync(dirname(facts.adapter)).sort(), [adapter, history, relay]);
  assert.equal(readFileSync(facts.relay, 'utf8'), '// fixture relay\n');
  assert.equal(readFileSync(facts.adapter, 'utf8'), '// fixture adapter\n');
  for (const entry of existing) assert.equal(readFileSync(join(f.root, entry), 'utf8'), entry);
  assert.equal(probes, 1);
  assert.equal(f.calls.length, 2, 'inspection and all assets in one upload');
  const uploads = f.calls.filter(call => call.input);
  assert.deepEqual(JSON.parse(uploads[0].input).map(asset => asset.name), [relay, adapter, history]);

  const warm = await prepareRemote(f.env, { ...f.options, providerHosts: ['models.invalid:443'] }, deps);
  assert.equal(warm.node, facts.node);
  assert.equal(probes, 1, 'warm setup skips discovery');
  assert.equal(f.calls.length, 3, 'warm setup checks hashes without uploading');

  writeFileSync(f.options.antigravityAdapterPath, '// updated adapter\n');
  await prepareRemote(f.env, f.options, deps);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(JSON.parse(f.calls.at(-1).input).map(asset => asset.name), [adapter]);
  assert.equal(readFileSync(facts.adapter, 'utf8'), '// updated adapter\n');
});

test('Antigravity can reuse a Pi Node hint without changing the hint for Pi', async t => {
  const f = fixture(t);
  const key = createHash('sha256').update(JSON.stringify([f.env.host, f.env.sshArgs])).digest('hex');
  const piHint = { root: f.root, node: process.execPath, home: f.dir, hostname: f.host.hostname };
  const hintPath = join(f.cacheDir, `remote-install-${key}.json`);
  file(hintPath, JSON.stringify(piHint));
  const facts = await prepareRemote(f.env, f.options, { run: f.run, probe: async () => assert.fail('usable Pi Node hint must skip discovery') });
  assert.equal(facts.node, piHint.node);
  assert.equal(readFileSync(hintPath, 'utf8'), JSON.stringify(piHint));
  assert.deepEqual(readInstallHint(f.env, f.root, f.cacheDir), piHint);
  assert.deepEqual(readInstallHint(f.env, f.root, f.cacheDir, engine), piHint);
  assert.equal(readInstallHint({ ...f.env, sshArgs: ['-p', '2223'] }, f.root, f.cacheDir, engine), null);
});

test('cached portable Node fallback uses a private deployment, never Pi staging paths', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture offline'); });
  const archive = join(f.cacheDir, 'node-v22.19.0-linux-x64.tar.gz');
  const fakeNode = join(f.dir, 'node-fixture/bin/node');
  mkdirSync(dirname(fakeNode), { recursive: true });
  mkdirSync(f.cacheDir);
  writeFileSync(fakeNode, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  execFileSync('tar', ['-czf', archive, '-C', f.dir, 'node-fixture'], { timeout: 5000 });
  for (const name of ['node', 'node.tmp', 'node.extract']) file(join(f.root, name, 'pi-fixture'), name);
  const deps = { run: f.run, probe: async () => ({ ...f.host, os: 'Linux', arch: 'x86_64', nodes: [{ path: '/old-node/bin/node', version: 'v22.18.0' }] }) };
  const facts = await prepareRemote(f.env, f.options, deps);
  assert.equal(facts.node, join(f.root, 'antigravity/node/bin/node'));
  assert.equal(facts.nodeVersion, process.version);
  assert.equal(f.calls.length, 3, 'portable Node upload, inspection, and one asset upload');
  assert.ok(Buffer.isBuffer(f.calls[0].input));
  assert.equal(readInstallHint(f.env, f.root, f.cacheDir), null);
  assert.equal(readInstallHint(f.env, f.root, f.cacheDir, engine).node, facts.node);
  for (const name of ['node', 'node.tmp', 'node.extract']) assert.equal(readFileSync(join(f.root, name, 'pi-fixture'), 'utf8'), name);

  // After losing the desktop hint, discovery can still reuse the remote portable Node.
  const rediscovered = await prepareRemote(f.env, { ...f.options, cacheDir: undefined }, { run: async (env, script, options) => {
    if (!script.includes('uname -s')) return f.run(env, script, options);
    assert.ok(script.includes(`${shellQuote(f.root)}/antigravity/node/bin/node`));
    return `home=${f.dir}\nhostname=agy-fixture\nnode=${facts.node} ${process.version}\n`;
  } });
  assert.equal(rediscovered.node, facts.node);
  assert.equal(f.calls.length, 4, 'rediscovery needs only the existing version/hash inspection');
});

test('Antigravity uploads portable Node even when the host has curl and a checksum tool', async t => {
  const f = fixture(t);
  const node = join(f.dir, 'node-fixture/bin/node');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const release = 'node-v22.19.0-linux-x64.tar.gz';
  const archive = execFileSync('tar', ['-czf', '-', '-C', f.dir, 'node-fixture']);
  const sum = createHash('sha256').update(archive).digest('hex');
  t.mock.method(globalThis, 'fetch', async url => new Response(url.endsWith('SHASUMS256.txt') ? `${sum}  ${release}\n` : archive));
  const run = (env, script, options) => {
    assert.doesNotMatch(script, /curl -|nodejs\.org|npmmirror/);
    return f.run(env, script, options);
  };
  const facts = await prepareRemote(f.env, f.options, { run, probe: async () => ({ ...f.host, os: 'Linux', arch: 'x86_64', nodes: [], curl: true, sha: 'sha256sum' }) });
  assert.equal(facts.node, join(f.root, 'antigravity/node/bin/node'));
  assert.deepEqual(f.calls[0].input, archive);
});

test('not enough room for portable Node does not move an existing relay to another root', async t => {
  const f = fixture(t);
  const deps = { run: f.run, probe: async () => ({ ...f.host, nodes: [], disks: [{ dir: f.dir, kb: 100 * 1024, exec: true }, { dir: '/tmp', kb: 9999999, exec: true }] }) };
  await assert.rejects(prepareRemote(f.env, f.options, deps), { code: 'DISK_FULL' });
  assert.equal(f.calls.length, 0);
});
