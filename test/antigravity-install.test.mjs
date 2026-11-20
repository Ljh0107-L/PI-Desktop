import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installAntigravityCli } from '../app/main/antigravity-install.mjs';
import { runSsh } from '../app/main/remote-setup.mjs';
import { shellQuote } from '../core/transports.mjs';

const artifact = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/test/asset.tar.gz';
const target = { kind: 'ssh', label: 'Test host', host: 'never-connect.invalid' };
const binaryPath = home => join(home, '.local', 'bin', 'agy');

function fixture(t, { withSsh = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pd-agy-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "fixture home 'quotes'"), cacheDir = join(root, 'cache');
  mkdirSync(home);
  const binary = randomBytes(256 * 1024); // More than a single download / upload chunk.
  writeFileSync(join(root, 'antigravity'), binary);
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'antigravity']);
  const data = readFileSync(archive);
  const manifest = { version: '1.2.3', url: artifact, sha512: createHash('sha512').update(data).digest('hex') };
  const requests = [], progress = [], commands = [];
  const fetchImpl = (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    if (url.endsWith('.json')) return Response.json(manifest);
    assert.equal(url, artifact);
    const chunks = new ReadableStream({ start(controller) {
      for (let i = 0; i < data.length; i += 32 * 1024) controller.enqueue(data.subarray(i, i + 32 * 1024));
      controller.close();
    } });
    return new Response(chunks, { headers: { 'content-length': String(data.length) } });
  };
  if (withSsh) {
    const tools = join(root, 'tools'), path = process.env.PATH;
    mkdirSync(tools);
    writeFileSync(join(tools, 'ssh'), `#!/bin/sh\nexport HOME=${shellQuote(home)}\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n`, { mode: 0o700 });
    process.env.PATH = `${tools}:${path}`;
    t.after(() => { process.env.PATH = path; });
  }
  const run = (env, script, options) => {
    assert.equal(env, target);
    assert.doesNotMatch(script, /curl|wget|https?:\/\//, 'no host-side external download or connectivity check');
    commands.push(script);
    if (script.includes('uname -s')) return Promise.resolve('login banner\nPIDESK_AGY_PLATFORM=Linux aarch64 1\n');
    assert.equal(options.upload.size, data.length);
    return runSsh(env, script, options);
  };
  return { home, cacheDir, binary, manifest, requests, progress, commands, options: { home, cacheDir, fetchImpl, run, onProgress: p => progress.push(p) } };
}

test('Antigravity installs locally from a verified download and reuses the cached package', async t => {
  const f = fixture(t);
  await installAntigravityCli({ kind: 'local' }, f.options);
  const path = binaryPath(f.home);
  assert.deepEqual(readFileSync(path), f.binary);
  assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.ok(f.progress.some(p => p.stage === 'downloading' && p.percent > 0));
  assert.equal(f.progress.at(-1).stage, 'installing');
  rmSync(path);
  await installAntigravityCli({ kind: 'local' }, f.options);
  assert.deepEqual(readFileSync(path), f.binary);
  assert.equal(f.requests.filter(url => url === artifact).length, 1);
});

test('Antigravity picks the SSH host build and streams upload progress without remote internet', { timeout: 10000 }, async t => {
  const f = fixture(t, { withSsh: true });
  await installAntigravityCli(target, f.options);
  assert.ok(f.requests[0].endsWith('/linux_arm64_musl.json'));
  assert.deepEqual(readFileSync(binaryPath(f.home)), f.binary);
  assert.equal(f.commands.length, 2, 'one platform detection and one install');
  assert.ok(f.progress.some(p => p.stage === 'uploading' && p.percent > 0));
  assert.equal(f.progress.at(-1).stage, 'installing');
  assert.deepEqual(readdirSync(join(f.home, '.local', 'bin')), ['agy']);
});

test('a bad manifest or invalid checksum is never uploaded or installed', async t => {
  const f = fixture(t);
  f.manifest.url = 'https://untrusted.invalid/asset.tar.gz';
  await assert.rejects(installAntigravityCli(target, f.options), /invalid Antigravity download manifest/);
  assert.equal(f.requests.length, 1);
  f.manifest.url = artifact;
  f.manifest.sha512 = '0'.repeat(128);
  await assert.rejects(installAntigravityCli(target, f.options), /download failed verification/);
  assert.equal(f.commands.length, 2, 'only platform detection, never an upload');
  assert.equal(existsSync(binaryPath(f.home)), false);
  assert.deepEqual(readdirSync(f.cacheDir), []);
});

test('a partial upload does not publish a CLI or leave staging data on the host', async t => {
  const f = fixture(t, { withSsh: true });
  const run = (env, script, options) => script.includes('uname -s') ? f.options.run(env, script, options)
    : runSsh(env, script, { input: 'too short', timeout: 5000 });
  await assert.rejects(installAntigravityCli(target, { ...f.options, run }), /not transferred completely/);
  assert.deepEqual(readdirSync(join(f.home, '.local', 'bin')), []);
});
