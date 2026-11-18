// Update checks must work even when the shared corporate IP has no GitHub API quota.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { Updater } from '../app/main/updater.mjs';
import { clearSessionUpdate, loadSessionUpdate, planSessionUpdate, restartUpdatedSessions, saveSessionUpdate } from '../app/main/session-update.mjs';
import { MAX_MANIFEST_BYTES, parseUpdateManifest, UPDATE_MANIFEST_URL } from '../core/update-manifest.mjs';

const checksum = data => createHash('sha512').update(data).digest('base64');
const manifest = (data = Buffer.from('zip'), version = '0.1.18') => ({
  version, releaseDate: '2026-11-02T00:00:00.000Z',
  files: ['arm64', 'x64'].map(arch => ({ url: `Pi-Desktop-${version}-${arch}-mac.zip`, sha512: checksum(data), size: data.length })),
});
function fixture(t, { version = '0.1.17', fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [], events = [];
  const updater = new Updater({ app: { getVersion: () => version }, cacheDir: join(dir, 'updates'), send: (channel, status) => events.push({ channel, ...status }), net: {
    fetch: async (url, options) => {
      assert.notEqual(new URL(url).hostname, 'api.github.com', 'REST API is unavailable behind the corporate proxy');
      assert.ok(options?.signal instanceof AbortSignal, 'every update request has a deadline');
      assert.ok(!options?.headers?.Authorization, 'no GitHub token required');
      calls.push({ url, options });
      return fetch(url, options);
    },
  } });
  return { dir, calls, events, updater };
}

for (const arch of ['arm64', 'x64']) test(`manifest chooses ${arch} and pins downloads to its release version`, () => {
  const parsed = parseUpdateManifest(stringify(manifest()), arch);
  assert.equal(parsed.version, '0.1.18');
  assert.equal(parsed.asset.browser_download_url, `https://github.com/Ljh0107-L/PI-Desktop/releases/download/v0.1.18/Pi-Desktop-0.1.18-${arch}-mac.zip`);
});

test('manifest rejects unsafe versions, paths, checksums, sizes and ambiguous assets', () => {
  for (const version of ['../escape', '0.1.18/../../escape', '0.1.18-beta.1', '01.1.18', '999999999999999999.1.1', null, 18]) {
    assert.throws(() => parseUpdateManifest(stringify({ ...manifest(), version })), /invalid release version/);
  }
  for (const url of ['../update.zip', 'https://example.com/update.zip', 'Pi-Desktop-0.1.19-arm64-mac.zip']) {
    const doc = manifest(); doc.files[0].url = url;
    assert.throws(() => parseUpdateManifest(stringify(doc), 'arm64'), /one arm64 build/);
  }
  for (const patch of [{ sha512: 'not-a-checksum' }, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: 3 * 1024 ** 3 }]) {
    const doc = manifest(); Object.assign(doc.files[0], patch);
    assert.throws(() => parseUpdateManifest(stringify(doc), 'arm64'), /invalid/);
  }
  const duplicate = manifest(); duplicate.files.push({ ...duplicate.files[0] });
  assert.throws(() => parseUpdateManifest(stringify(duplicate), 'arm64'), /one arm64 build/);
  assert.throws(() => parseUpdateManifest(stringify(manifest()), 'ia32'), /architecture ia32/);
});

test('manifest rejects malformed YAML, aliases, duplicate keys and oversized input', () => {
  for (const text of ['files: [', 'version: 0.1.18\nversion: 0.1.19\n']) assert.throws(() => parseUpdateManifest(text), /not valid YAML/);
  assert.throws(() => parseUpdateManifest('version: &v 0.1.18\nfiles: *v'), /aliases/);
  assert.throws(() => parseUpdateManifest('x'.repeat(MAX_MANIFEST_BYTES + 1)), /too large/);
});

for (const version of ['0.1.18', '0.1.19']) test(`installed ${version} needs only the public manifest, with no API or downgrade`, async t => {
  const f = fixture(t, { version, fetch: () => new Response(stringify(manifest())) });
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'current');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, UPDATE_MANIFEST_URL);
  assert.equal(f.calls[0].options.cache, 'no-store');
  assert.equal(f.calls[0].options.headers['Cache-Control'], 'no-cache');
});

test('zero API quota: public manifest → pinned ZIP → SHA-512 → extracted update', { skip: process.platform !== 'darwin' }, async t => {
  let archive;
  const f = fixture(t, { fetch: url => new Response(url === UPDATE_MANIFEST_URL ? stringify(manifest(archive)) : archive) });
  const contents = join(f.dir, 'Pi Desktop.app', 'Contents'); mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, 'version.txt'), '0.1.18');
  const zip = join(f.dir, 'fixture.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(f.dir, 'Pi Desktop.app'), zip]);
  archive = readFileSync(zip);
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '0.1.18');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].url.includes(`/download/v0.1.18/Pi-Desktop-0.1.18-${process.arch}-mac.zip`));
  assert.equal(readFileSync(join(status.path, 'Contents/version.txt'), 'utf8'), '0.1.18');
  assert.ok(!existsSync(join(f.dir, 'updates/0.1.18/update.zip')));
  assert.ok(f.events.some(e => e.state === 'downloading'));
});

for (const fault of ['checksum', 'truncated', 'oversized']) test(`rejects ${fault} downloads before extracting or offering install`, async t => {
  const expected = Buffer.from('abc');
  const body = Buffer.from(fault === 'checksum' ? 'xyz' : fault === 'truncated' ? 'ab' : 'abcd');
  const f = fixture(t, { fetch: url => new Response(url === UPDATE_MANIFEST_URL ? stringify(manifest(expected)) : body) });
  const result = await f.updater.check({ manual: true });
  assert.equal(result.state, 'error');
  assert.match(result.message, fault === 'checksum' ? /checksum/ : /size/);
  assert.ok(!f.events.some(e => e.state === 'ready'));
  assert.ok(!existsSync(join(f.dir, 'updates/0.1.18/app')));
});

test('HTTP failure is actionable and retryable, never falls back to the quota-limited API', async t => {
  let blocked = true;
  const f = fixture(t, { version: '0.1.18', fetch: () => blocked ? new Response('blocked', { status: 403 }) : new Response(stringify(manifest())) });
  const failed = await f.updater.check({ manual: true });
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /HTTP 403.*Releases download page/);
  assert.equal(f.calls.length, 1);
  blocked = false;
  assert.equal((await f.updater.check({ manual: true })).state, 'current');
  assert.equal(f.calls.length, 2);
});

test('oversized network manifest fails without downloading a ZIP', async t => {
  const f = fixture(t, { fetch: () => new Response('x'.repeat(MAX_MANIFEST_BYTES + 1)) });
  const result = await f.updater.check({ manual: true });
  assert.equal(result.state, 'error');
  assert.match(result.message, /too large/);
  assert.equal(f.calls.length, 1);
});

test('overlapping checks make one request; network failure releases checking state', async t => {
  let reject;
  const f = fixture(t, { fetch: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const first = f.updater.check({ manual: true });
  assert.equal((await f.updater.check({ manual: true })).state, 'checking');
  assert.equal(f.calls.length, 1);
  reject(new Error('network unavailable'));
  assert.equal((await first).state, 'error');
});

test('a flaky 504 on the manifest is retried before reaching the user', async t => {
  let flaky = true;
  const f = fixture(t, { version: '0.1.18', fetch: url => (flaky ? (flaky = false, new Response('flaky', { status: 504 })) : new Response(stringify(manifest()))) });
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'current');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, UPDATE_MANIFEST_URL);
});

test('a 404 on the manifest is not retried', async t => {
  const f = fixture(t, { version: '0.1.18', fetch: () => new Response('missing', { status: 404 }) });
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'error');
  assert.match(status.message, /HTTP 404/);
  assert.equal(f.calls.length, 1);
});

test('a flaky 504 on the ZIP is retried and the update completes', { skip: process.platform !== 'darwin' }, async t => {
  let archive, flakyZip = true;
  const f = fixture(t, { fetch: url => url === UPDATE_MANIFEST_URL
    ? new Response(stringify(manifest(archive)))
    : (flakyZip ? (flakyZip = false, new Response('flaky', { status: 504 })) : new Response(archive)) });
  const contents = join(f.dir, 'Pi Desktop.app', 'Contents'); mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, 'version.txt'), '0.1.18');
  const zip = join(f.dir, 'fixture.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(f.dir, 'Pi Desktop.app'), zip]);
  archive = readFileSync(zip);
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'ready');
  assert.equal(f.calls.filter(c => c.url.includes('/download/v0.1.18/')).length, 2);
  assert.equal(readFileSync(join(status.path, 'Contents/version.txt'), 'utf8'), '0.1.18');
});

test('a ZIP transfer dropped mid-stream is retried; a repeated drop fails without extracting', async t => {
  const data = Buffer.from('zip');
  const drop = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fetch failed')); } }));
  let attempts = 0;
  const f = fixture(t, { fetch: url => url === UPDATE_MANIFEST_URL
    ? new Response(stringify(manifest(data)))
    : ((attempts += 1) < 3 ? drop() : new Response('wrong')) });
  const status = await f.updater.check({ manual: true });
  assert.equal(status.state, 'error');
  assert.equal(f.calls.length, 4); // the manifest plus three download attempts
  assert.ok(!f.events.some(e => e.state === 'ready'));
  assert.ok(!existsSync(join(f.dir, 'updates/0.1.18/app')));
});

test('failed update preparation leaves the bundle running and makes install retryable', async t => {
  const f = fixture(t);
  const appBundle = join(f.dir, 'Pi Desktop.app'), downloaded = join(f.dir, 'New.app');
  mkdirSync(appBundle); mkdirSync(downloaded);
  f.updater.app.getPath = () => join(appBundle, 'Contents/MacOS/Pi Desktop');
  f.updater.app.quit = () => assert.fail('must not quit if the restart plan was not saved');
  f.updater.status = { state: 'ready', version: '0.2.29', path: downloaded };
  await assert.rejects(f.updater.install({ prepare: async version => {
    assert.equal(version, '0.2.29');
    assert.equal((await f.updater.check()).state, 'installing');
    assert.equal(await f.updater.install(), false, 'cannot launch two bundle replacers');
    throw new Error('read-only profile');
  } }), /read-only profile/);
  assert.equal(f.updater.status.state, 'ready');
  assert.ok(existsSync(downloaded));
});

test('the old updater leaves an empty staging directory; a newer updater writes a versioned restart plan', t => {
  const { dir } = fixture(t);
  const legacyCache = join(dir, 'updates'), stage = join(legacyCache, '0.2.29', 'app');
  mkdirSync(join(stage, 'Pi Desktop.app'), { recursive: true });
  assert.equal(loadSessionUpdate(dir, '0.2.29', { legacyCache }), null, 'downloaded is not installed');
  rmSync(join(stage, 'Pi Desktop.app'), { recursive: true });
  const incomplete = join(legacyCache, '0.2.29', 'update.zip');
  writeFileSync(incomplete, 'unextracted');
  assert.equal(loadSessionUpdate(dir, '0.2.29', { legacyCache }), null, 'a failed extraction is not installed');
  rmSync(incomplete);
  const plan = loadSessionUpdate(dir, '0.2.29', { legacyCache });
  assert.deepEqual(plan, { version: '0.2.29', reopen: [], done: [] }, 'cannot guess which local sessions were live');
  rmSync(legacyCache, { recursive: true });
  assert.deepEqual(loadSessionUpdate(dir, '0.2.29', { legacyCache }), plan);
  const pending = { version: '0.2.30', reopen: ['live-local'], done: [] };
  saveSessionUpdate(dir, pending);
  assert.equal(loadSessionUpdate(dir, '0.2.29'), null);
  assert.deepEqual(loadSessionUpdate(dir, pending.version), pending);
  clearSessionUpdate(dir);
  assert.equal(loadSessionUpdate(dir, pending.version), null);
});

function restartFixture() {
  const local = { id: 'local', kind: 'local', label: 'This Mac' };
  const ssh = { id: 'ssh:gpu', kind: 'ssh', label: 'GPU', added: true, enabled: true };
  const down = { ...ssh, id: 'ssh:down', label: 'Down' };
  const disabled = { ...ssh, id: 'ssh:disabled', enabled: false };
  const record = (id, env, fields = {}) => ({ id, title: id, environmentId: env.id, piSessionFile: `/sessions/${id}.jsonl`, ...fields });
  const sessions = [record('local-live', local), record('local-idle', local), record('remote-live', ssh), record('remote-claude', ssh, { engine: 'claude-code' }), record('remote-idle', ssh),
    record('archive', ssh, { archived: true }), record('cursor', ssh, { engine: 'cursor' }), record('disabled', disabled), record('offline', down)];
  const live = new Set(['local-live', 'remote-live', 'remote-claude', 'archive', 'cursor', 'disabled']);
  const trace = [], errors = new Map();
  let online = false;
  const manager = {
    store: { sessions }, environments: () => [local, ssh, down, disabled],
    async relaySessions(env) {
      trace.push(['list', env.id]);
      if (env === down && !online) throw new Error('SSH timeout');
      return sessions.filter(r => r.environmentId === env.id).map(({ id }) => ({ id, alive: live.has(id) }));
    },
    async stopRelay(env, id, options) {
      trace.push(['stop', id]); assert.equal(options.forUpdate, true);
      if (errors.has(id)) return errors.get(id);
      live.delete(id); return '{"relay":"stopped","found":true}\n';
    },
    async ensureStarted(id) {
      trace.push(['start', id]);
      assert.equal(live.has(id), false, 'never launch another writer before acknowledging the stop');
      live.add(id);
      return { attachInfo: { created: true } };
    },
  };
  return { manager, trace, live, errors, setOnline: () => { online = true; } };
}

test('update reopens saved local history and restarts only live SSH sessions; retries only failures', async () => {
  const f = restartFixture();
  const plan = await planSessionUpdate(f.manager, '0.2.30');
  assert.deepEqual(plan.reopen, ['local-live']);
  assert.deepEqual(f.trace.splice(0), [['list', 'local']]);
  f.live.delete('local-live'); // the old Mac app shut down
  f.errors.set('remote-live', '{"relay":"error"}');
  const checkpoints = [];
  const result = await restartUpdatedSessions(f.manager, plan, { checkpoint: plan => checkpoints.push(plan) });
  assert.deepEqual(result.restarted.map(r => r.id).sort(), ['local-live', 'remote-claude']);
  assert.deepEqual(result.retryPlan.only.sort(), ['offline', 'remote-live']);
  assert.ok(result.failures.some(failure => /SSH timeout/.test(failure.message)));
  assert.ok(result.failures.some(failure => /did not acknowledge/.test(failure.message)));
  assert.ok(result.skipResume.has('remote-live'));
  assert.ok(!f.trace.some(([op, id]) => op === 'list' && id === 'ssh:disabled'));
  assert.deepEqual(f.trace.filter(([op]) => op === 'stop').map(([, id]) => id).sort(), ['remote-claude', 'remote-live']);
  assert.deepEqual(f.trace.filter(([op]) => op === 'start').map(([, id]) => id).sort(), ['local-live', 'remote-claude']);
  assert.ok(checkpoints.some(p => p.reopen.includes('remote-claude') && !p.done.includes('remote-claude')));
  f.setOnline(); f.errors.clear(); f.trace.length = 0;
  const retried = await restartUpdatedSessions(f.manager, result.retryPlan);
  assert.deepEqual(retried.restarted.map(r => r.id), ['remote-live']);
  assert.deepEqual(retried.failures, []);
  assert.deepEqual(f.trace.filter(([op]) => op === 'stop' || op === 'start'), [['stop', 'remote-live'], ['start', 'remote-live']]);
});

test('quitting after a remote stop keeps that session in the persisted reopen set', async () => {
  const { manager, live } = restartFixture();
  let checkpoint, quitting = false;
  const stop = manager.stopRelay;
  manager.stopRelay = async (...args) => { const ack = await stop(...args); quitting = true; return ack; };
  const plan = { version: '0.2.29', reopen: [], done: [], only: ['remote-live'] };
  await restartUpdatedSessions(manager, plan, { checkpoint: plan => { checkpoint = plan; }, cancelled: () => quitting });
  assert.equal(live.has('remote-live'), false);
  assert.deepEqual(checkpoint.reopen, ['remote-live']);
  const result = await restartUpdatedSessions(manager, checkpoint);
  assert.deepEqual(result.restarted.map(r => r.id), ['remote-live']);
});
