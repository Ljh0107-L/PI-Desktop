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
