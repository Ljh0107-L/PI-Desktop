import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Cache } from '../../node_modules/@electron/get/dist/Cache.js';

// Populate the standard cache from the official asset API when the public
// release-download route is unavailable. Never disable Electron's validation.
const { version } = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a pinned stable Electron version');
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
const response = await fetch(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, { headers });
if (!response.ok) throw new Error(`Official release metadata: HTTP ${response.status}`);
const release = await response.json();
const asset = name => {
  const value = release.assets.find(a => a.name === name);
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value.digest ?? '')) throw new Error(`Missing official digest for ${name}`);
  return value;
};
async function download(item) {
  const redirect = await fetch(`https://api.github.com/repos/electron/electron/releases/assets/${item.id}`, {
    headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual',
  });
  if (redirect.status === 200) return redirect;
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (redirect.status !== 302 || !location || new URL(location).origin !== 'https://release-assets.githubusercontent.com') throw new Error(`Unexpected asset response for ${item.name}: HTTP ${redirect.status}`);
  // The API credential is deliberately not forwarded to the download host.
  const body = await fetch(location);
  if (!body.ok) throw new Error(`Official asset ${item.name}: HTTP ${body.status}`);
  return body;
}
const sumsAsset = asset('SHASUMS256.txt');
const sums = Buffer.from(await (await download(sumsAsset)).arrayBuffer());
if (`sha256:${createHash('sha256').update(sums).digest('hex')}` !== sumsAsset.digest) throw new Error('Checksum manifest digest mismatch');
const checksums = new Map(sums.toString('utf8').trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match) throw new Error('Invalid checksum manifest');
  return [match[2], match[1]];
}));
const cache = new Cache();
const temporary = await mkdtemp(join(tmpdir(), 'pidesk-electron-cache-'));
try {
  for (const arch of ['arm64', 'x64']) {
    const name = `electron-v${version}-darwin-${arch}.zip`;
    const item = asset(name), checksum = checksums.get(name);
    if (!checksum || item.digest !== `sha256:${checksum}`) throw new Error(`Official digests disagree for ${name}`);
    const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;
    const existing = cache.getPathForFileInCache(url, name);
    if (existing && await cache.hashFile(existing) === checksum) { console.log(`Verified cached ${name}`); continue; }
    const path = join(temporary, name);
    const body = await download(item);
    await pipeline(body.body, createWriteStream(path, { flags: 'wx' }));
    const hash = await cache.hashFile(path);
    if (hash !== checksum) throw new Error(`Downloaded digest mismatch for ${name}`);
    await cache.putFileInCache(url, path, name);
    console.log(`Verified ${name}: sha256 ${hash}`);
  }
  await mkdir(join(homedir(), 'Library/Caches/electron-builder'), { recursive: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
