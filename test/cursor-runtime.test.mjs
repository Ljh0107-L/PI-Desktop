// Installation/identity regressions. Executes only as part of the CI test suites.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { CursorAcp, validateCursorCommand } from '../agent/cursor-acp.mjs';
import { CursorRuntime, validCursorInstall } from '../app/main/cursor-runtime.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { cursorRelease, managedCursor } from '../core/cursor-release.mjs';

const exec = promisify(execFile);
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const dir = await temporary(t), source = join(dir, 'dist-package');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@anysphere/agent-cli-runtime' }));
  // If an installer executes these placeholders, it fails. Installation is extraction only.
  for (const name of ['cursor-agent', 'node']) await writeFile(join(source, name), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
  await writeFile(join(source, 'index.js'), '// fixture, not executed\n');
  const archive = join(dir, 'fixture.tar.gz');
  await exec('tar', ['-czf', archive, '-C', dir, 'dist-package']);
  const data = await readFile(archive);
  const release = { version: 'fixture-v1', platform: process.platform, arch: process.arch, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), url: 'https://downloads.cursor.com/fixture' };
  const options = { cacheDir: join(dir, 'cache'), localRoot: join(dir, 'private runtime'), releaseFor: () => release, fetchImpl: async () => new Response(data) };
  return { dir, data, release, options };
}

test('pinned platforms and legacy generic agent settings use managed installation', () => {
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    const release = cursorRelease(platform, arch);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.ok(release.size > 100_000_000);
    assert.match(release.url, /^https:\/\/downloads\.cursor\.com\//);
  }
  assert.throws(() => cursorRelease('win32', 'x64'), /does not support/);
  for (const command of [undefined, '', 'auto', 'managed', 'agent', '~/.local/bin/agent']) assert.equal(managedCursor(command), true);
  assert.equal(managedCursor('/custom/cursor-agent'), false);
});

test('a generic agent pointing at Grok is rejected before any key-bearing spawn', async t => {
  const dir = await temporary(t), grok = join(dir, 'grok');
  await writeFile(grok, '#!/bin/sh\nexit 77\n', { mode: 0o755 });
  const agent = join(dir, 'agent'); await symlink(grok, agent);
  let spawned = false;
  const client = new CursorAcp({ command: agent, cwd: dir, apiKey: 'secret-not-for-grok', spawnProcess: () => { spawned = true; throw new Error('must not execute'); } });
  await assert.rejects(client.start(), /No API key was passed/);
  assert.equal(spawned, false);
  assert.equal(await readlink(agent), grok);
  await assert.rejects(validateCursorCommand(join(dir, 'missing')), /was not found/);
});

test('managed installation is checksum-verified, shared, reusable and leaves aliases untouched', async t => {
  const f = await fixture(t), alias = join(f.dir, 'agent');
  await symlink('/unchanged/grok', alias);
  let downloads = 0;
  const runtime = new CursorRuntime({ ...f.options, fetchImpl: async () => { downloads++; return new Response(f.data); } });
  const env = { id: 'local', kind: 'local' };
  const a = runtime.ensure(env), b = runtime.ensure(env);
  assert.equal(a, b);
  const [command] = await Promise.all([a, b]);
  assert.equal(downloads, 1);
  assert.equal(await validateCursorCommand(command), await realpath(command));
  assert.equal(await readlink(alias), '/unchanged/grok');
  assert.equal(await runtime.ensure(env), command);
  assert.equal(downloads, 1);
  const next = new CursorRuntime({ ...f.options, fetchImpl: async () => { throw new Error('offline: must reuse install'); } });
  assert.equal(await next.ensure(env), command);
  assert.ok(await validCursorInstall(command.slice(0, command.lastIndexOf('/')), f.release));
});

test('bad downloads cannot become installed runtimes and failed requests can be retried', async t => {
  const f = await fixture(t);
  const runtime = new CursorRuntime({ ...f.options, releaseFor: () => ({ ...f.release, sha256: '0'.repeat(64) }) });
  await assert.rejects(runtime.ensure({ id: 'local', kind: 'local' }), /checksum mismatch/);
  assert.deepEqual(await readdir(f.options.localRoot), []);
  assert.deepEqual(await readdir(f.options.cacheDir), []);
  let count = 0;
  const retry = new CursorRuntime({ ...f.options, fetchImpl: async () => ++count === 1 ? new Response('', { status: 503 }) : new Response(f.data) });
  await assert.rejects(retry.ensure({ id: 'local', kind: 'local' }), /503/);
  await access(await retry.ensure({ id: 'local', kind: 'local' }));
  assert.equal(count, 2);
});

test('remote installer quotes private paths and reuses a healthy install', async t => {
  const f = await fixture(t);
  const facts = { root: join(f.dir, "remote user's install"), node: process.execPath };
  let uploads = 0;
  const run = async (_env, script) => (await exec('sh', ['-c', script], { timeout: 30000, maxBuffer: 2 << 20 })).stdout;
  const upload = async (_env, script, path) => {
    uploads++;
    const input = await readFile(path);
    await new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', script], { timeout: 30000 }, error => error ? reject(error) : resolve());
      child.stdin.end(input);
    });
  };
  const runtime = new CursorRuntime({ ...f.options, run, upload });
  const env = { id: 'ssh:fixture', kind: 'ssh' };
  const command = await runtime.ensure(env, facts);
  assert.ok(command.startsWith(facts.root + '/cursor-sdk/'));
  await validateCursorCommand(command);
  assert.equal(await runtime.ensure(env, facts), command);
  assert.equal(uploads, 1);
});

test('server preparation leaves optional Cursor setup on demand and retries download failures', async t => {
  const env = { id: 'ssh:fixture', kind: 'ssh', label: 'Fixture' };
  let calls = 0, fail = false;
  const store = { settings: { providers: [], environments: {}, cursor: { enabled: true, command: '' } }, sessions: [], saveSettings() {} };
  const runtime = { ensure: async () => { calls++; if (fail) throw new Error('download unavailable'); return '/private/cursor-agent'; } };
  const manager = new SessionManager({ store, environments: () => [env], local: {}, cursorRuntime: runtime, remoteSetup: async () => ({ root: '/fixture', node: '/node' }) });
  t.after(() => clearInterval(manager.sweeper));
  assert.equal((await manager.prepare(env.id)).root, '/fixture');
  assert.equal(calls, 0, 'enabling Cursor must not put downloads on the Pi connection critical path');
  assert.equal(await manager.cursorCommand(env.id), '/private/cursor-agent');
  assert.equal(calls, 1);
  fail = true;
  const facts = await manager.prepare(env.id, { force: true });
  assert.equal(facts.root, '/fixture');
  assert.equal(calls, 1, 'reconnecting must not revalidate Cursor twice');
  await assert.rejects(manager.cursorCommand(env.id), /download unavailable/);
  fail = false;
  assert.equal(await manager.cursorCommand(env.id), '/private/cursor-agent');
});
