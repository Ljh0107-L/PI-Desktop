// Use the same native builds and SHA-512 manifests as Google's installer, but download
// on this Mac. SSH hosts only receive the verified package, not the installer or credentials.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { shellQuote } from '../../core/transports.mjs';
import { runSsh } from './remote-setup.mjs';

const exec = promisify(execFile);
const MANIFESTS = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
const ARTIFACTS = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';
const MAX_PACKAGE = 384 * 1024 * 1024;
const downloads = new Map();

function platformFor(os, arch, musl) {
  const cpu = ['x86_64', 'x64', 'amd64'].includes(arch) ? 'amd64' : ['arm64', 'aarch64'].includes(arch) ? 'arm64' : null;
  const system = os.toLowerCase();
  if (!cpu || !['darwin', 'linux', 'android'].includes(system)) throw new Error(`Antigravity does not support ${os || 'this system'} ${arch}.`);
  return `${system}_${cpu}${system === 'linux' && musl ? '_musl' : ''}`;
}

async function targetPlatform(env, run) {
  if (env.kind === 'local') return platformFor(process.platform, process.arch, false);
  const info = await run(env, `set -e
os=$(uname -s)
arch=$(uname -m)
musl=0
if [ "$os" = Linux ]; then
  if [ "$(uname -o 2>/dev/null || true)" = Android ]; then os=Android
  elif [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] || [ -e /lib/libc.musl-x86_64.so.1 ] || [ -e /lib/libc.musl-aarch64.so.1 ] || (ldd --version 2>&1 | grep -qi musl); then musl=1
  fi
fi
printf 'PIDESK_AGY_PLATFORM=%s %s %s\\n' "$os" "$arch" "$musl"`, { timeout: 30000 });
  const target = info.split('\n').map(line => /^PIDESK_AGY_PLATFORM=([\w-]+) ([\w-]+) ([01])$/.exec(line)).findLast(Boolean);
  if (!target) throw new Error('Could not identify the SSH host’s operating system and CPU.');
  return platformFor(target[1], target[2], target[3] === '1');
}

async function readManifest(platform, fetchImpl) {
  const res = await fetchImpl(`${MANIFESTS}/${platform}.json`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Google has no available Antigravity download for this machine (HTTP ${res.status}).`);
  const { url, sha512 } = await res.json() ?? {};
  let parsed;
  try { parsed = new URL(url); } catch { /* validated below */ }
  if (!parsed?.href.startsWith(ARTIFACTS) || !/^[\da-f]{128}$/i.test(sha512 ?? '')) throw new Error('Google returned an invalid Antigravity download manifest.');
  return { url: parsed.href, sha512: sha512.toLowerCase(), archive: parsed.pathname.endsWith('.tar.gz') };
}

async function verifiedSize(path, expected) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size || info.size > MAX_PACKAGE) return 0;
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === expected ? info.size : 0;
}

function download(platform, release, cacheDir, onProgress, fetchImpl) {
  const path = join(cacheDir, `agy-${platform}-${release.sha512}.package`);
  const existing = downloads.get(path);
  if (existing) {
    existing.listeners.add(onProgress);
    if (existing.progress) onProgress(existing.progress);
    return existing.promise;
  }
  const entry = { listeners: new Set([onProgress]), promise: null, progress: null };
  const report = (percent = null) => {
    entry.progress = { stage: 'downloading', percent };
    for (const listener of entry.listeners) listener(entry.progress);
  };
  entry.promise = (async () => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const cached = await verifiedSize(path, release.sha512).catch(() => 0);
    if (cached) return { path, size: cached };
    report();
    const res = await fetchImpl(release.url, { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Could not download Antigravity (HTTP ${res.status}).`);
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_PACKAGE) throw new Error('The Antigravity download is larger than expected.');
    const total = Number.isSafeInteger(length) && length > 0 ? length : null;
    const temporary = await mkdtemp(join(cacheDir, '.agy-download-'));
    const part = join(temporary, 'payload');
    try {
      const hash = createHash('sha512');
      let size = 0, last = total ? 0 : null;
      if (total) report(0);
      const track = new Transform({ transform(chunk, _, done) {
        size += chunk.length;
        if (size > MAX_PACKAGE) { done(new Error('The Antigravity download is larger than expected.')); return; }
        hash.update(chunk);
        const percent = total ? Math.min(99, Math.floor(size / total * 100)) : null;
        if (percent !== last) { last = percent; report(percent); }
        done(null, chunk);
      } });
      await pipeline(res.body, track, createWriteStream(part, { mode: 0o600 }));
      if (!size || (total && size !== total) || hash.digest('hex') !== release.sha512) throw new Error('The Antigravity download failed verification. Try downloading it again.');
      await rename(part, path);
      return { path, size };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  })().finally(() => downloads.delete(path));
  downloads.set(path, entry);
  return entry.promise;
}

function installCommand({ path, size }, archive, remote) {
  return `set -eu
umask 077
target="$HOME/.local/bin"
mkdir -p "$target"
bin="$target/agy"
if [ -f "$bin" ] && [ -x "$bin" ]; then exit 0; fi
if [ -d "$bin" ]; then echo 'The agy install path is a directory.' >&2; exit 1; fi
stage=$(mktemp -d "$target/.pidesk-agy.XXXXXX")
trap 'rm -rf "$stage"' EXIT
${remote ? `cat > "$stage/payload"
payload="$stage/payload"` : `payload=${shellQuote(path)}`}
[ "$(wc -c < "$payload" | tr -d '[:space:]')" = ${size} ] || { echo 'The Antigravity package was not transferred completely.' >&2; exit 1; }
${archive ? 'tar -xOzf "$payload" antigravity > "$stage/agy"' : 'cp "$payload" "$stage/agy"'}
[ -s "$stage/agy" ]
chmod 755 "$stage/agy"
if [ ! -f "$bin" ] || [ ! -x "$bin" ]; then
  [ ! -d "$bin" ]
  mv -f "$stage/agy" "$bin"
fi`;
}

export async function installAntigravityCli(env, { cacheDir, onProgress = () => {}, run = runSsh, invoke = exec, fetchImpl = fetch, home = homedir() } = {}) {
  const remote = env.kind === 'ssh';
  const temporary = !cacheDir && await mkdtemp(join(tmpdir(), 'pidesk-agy-'));
  try {
    onProgress({ stage: 'preparing' });
    const platform = await targetPlatform(env, run);
    const release = await readManifest(platform, fetchImpl);
    const pkg = await download(platform, release, cacheDir || temporary, onProgress, fetchImpl);
    const command = installCommand(pkg, release.archive, remote);
    if (!remote) {
      onProgress({ stage: 'installing' });
      await invoke('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, timeout: 120000 });
      return;
    }
    let last = 0;
    onProgress({ stage: 'uploading', percent: 0 });
    await run(env, command, { upload: pkg, timeout: 10 * 60_000, onUpload: fraction => {
      const percent = Math.min(99, Math.floor(fraction * 100));
      if (fraction >= 1) {
        if (last !== 100) onProgress({ stage: 'installing' });
        last = 100;
      } else if (percent > last) {
        last = percent;
        onProgress({ stage: 'uploading', percent });
      }
    } });
  } catch (error) {
    const detail = String(error.stderr?.trim() || error.message).split('\n').at(-1).slice(0, 240);
    throw new Error(`Could not install Antigravity${remote ? ` on ${env.label ?? env.host}` : ''}. ${detail}`, { cause: error });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
