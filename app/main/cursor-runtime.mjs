// App-owned Cursor runtime installation. Downloads/extraction never execute Cursor or
// the upstream installer, and never touch ~/.local/bin/agent or ~/.grok.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { cursorRelease } from '../../core/cursor-release.mjs';
import { shellQuote } from '../../core/transports.mjs';
import { runSsh, sshBaseArgs } from './remote-setup.mjs';

const exec = promisify(execFile);
export async function validCursorInstall(dir, release) {
  // Self-contained: the same check runs through the prepared Node on SSH hosts.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(dir, '.pidesk-runtime.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (receipt.version !== release.version || receipt.sha256 !== release.sha256 || pkg.name !== '@anysphere/agent-cli-runtime') return false;
    for (const name of ['cursor-agent', 'node', 'index.js']) if (!(await fs.stat(path.join(dir, name))).isFile()) return false;
    return true;
  } catch { return false; }
}

async function validateArchive(path) {
  const { stdout } = await exec('tar', ['-tzf', path], { timeout: 60000, maxBuffer: 16 << 20 });
  if (stdout.split('\n').filter(Boolean).some(name => !name.startsWith('dist-package/') || name.split('/').includes('..'))) throw new Error('Invalid Cursor archive paths');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const receipt = release => JSON.stringify({ version: release.version, sha256: release.sha256 });
const targetName = release => `${release.version}-${release.platform}-${release.arch}`;

// Stream a verified archive to SSH instead of buffering ~180 MB per connection.
function uploadArchive(env, script, path, size, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshBaseArgs(env), env.host, `sh -c ${shellQuote(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const input = createReadStream(path);
    let stderr = '', sent = 0, last = 0;
    const timer = setTimeout(() => { input.destroy(); child.kill('SIGTERM'); reject(new Error('Cursor SDK upload timed out')); }, 600000);
    child.stdout.resume();
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); input.destroy(); reject(error); });
    child.once('close', code => { clearTimeout(timer); input.destroy(); code === 0 ? resolve() : reject(new Error(stderr.trim() || `Cursor SDK upload exited ${code}`)); });
    child.stdin.on('error', () => input.destroy());
    input.on('error', error => { child.kill('SIGTERM'); reject(error); });
    input.on('data', chunk => { sent += chunk.length; if (Date.now() - last > 500) { last = Date.now(); progress(`Uploading Cursor SDK… ${Math.floor(sent / size * 100)}%`); } });
    input.pipe(child.stdin);
  });
}

export class CursorRuntime {
  constructor({ cacheDir, localRoot, fetchImpl = fetch, releaseFor = cursorRelease, run = runSsh, upload = uploadArchive }) {
    Object.assign(this, { cacheDir, localRoot, fetchImpl, releaseFor, run, upload });
    this.downloads = new Map(); this.installs = new Map();
  }
  archive(release, progress = () => {}) {
    const key = targetName(release);
    if (this.downloads.has(key)) return this.downloads.get(key);
    const pending = this.download(release, progress);
    this.downloads.set(key, pending);
    const clear = () => { if (this.downloads.get(key) === pending) this.downloads.delete(key); };
    pending.then(clear, clear);
    return pending;
  }
  async download(release, progress) {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = join(this.cacheDir, targetName(release) + '.tar.gz');
    try { if ((await stat(path)).size === release.size && await hashFile(path) === release.sha256) { await validateArchive(path); return path; } } catch { /* cache miss */ }
    const temp = path + `.${randomUUID()}.part`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240000);
    try {
      progress('Downloading official Cursor SDK…');
      const response = await this.fetchImpl(release.url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Cursor download failed: HTTP ${response.status}`);
      if (response.url && (new URL(response.url).protocol !== 'https:' || new URL(response.url).hostname !== 'downloads.cursor.com')) throw new Error('Cursor download redirected outside the official download host');
      const length = response.headers.get('content-length');
      if (length && Number(length) !== release.size) throw new Error('Cursor download size does not match the pinned release');
      const hash = createHash('sha256'); let bytes = 0, last = 0;
      const meter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > release.size) { done(new Error('Cursor download exceeds the pinned size')); return; }
        hash.update(chunk);
        if (Date.now() - last > 500) { last = Date.now(); progress(`Downloading Cursor SDK… ${Math.floor(bytes / release.size * 100)}%`); }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (bytes !== release.size || hash.digest('hex') !== release.sha256) throw new Error('Cursor download checksum mismatch; the package was not installed');
      await validateArchive(temp);
      await rename(temp, path);
      return path;
    } finally { clearTimeout(timer); controller.abort(); await rm(temp, { force: true }); }
  }
  ensure(env, facts = {}, progress = () => {}) {
    const root = env.kind === 'local' ? this.localRoot : `${facts.root}/cursor-sdk`;
    const key = `${env.id}\n${root}`;
    if (this.installs.has(key)) return this.installs.get(key);
    const pending = env.kind === 'local' ? this.installLocal(root, progress) : this.installRemote(env, facts, root, progress);
    this.installs.set(key, pending);
    const clear = () => { if (this.installs.get(key) === pending) this.installs.delete(key); };
    pending.then(clear, clear);
    return pending;
  }
  async installLocal(root, progress) {
    const release = this.releaseFor(process.platform, process.arch);
    const target = join(root, targetName(release));
    if (await validCursorInstall(target, release)) return join(target, 'cursor-agent');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const space = await statfs(root);
    if (space.bavail * space.bsize < Math.max(1 << 30, release.size * 4)) throw new Error('Free at least 1 GB for the Cursor SDK installation');
    const archive = await this.archive(release, progress);
    progress('Installing Cursor SDK in Pi’s private directory…');
    const stage = await mkdtemp(join(root, '.install-'));
    try {
      await exec('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '-C', stage], { timeout: 120000 });
      await writeFile(join(stage, '.pidesk-runtime.json'), receipt(release), { mode: 0o600 });
      if (!await validCursorInstall(stage, release)) throw new Error('Cursor SDK package is incomplete');
      if (await validCursorInstall(target, release)) return join(target, 'cursor-agent');
      // Preserve any incomplete prior directory rather than deleting unknown files.
      try { await rename(target, target + `.incomplete-${randomUUID()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, target);
      return join(target, 'cursor-agent');
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  async installRemote(env, facts, root, progress) {
    const { node } = facts;
    const platform = JSON.parse(await this.run(env, `${shellQuote(node)} -e 'console.log(JSON.stringify({platform:process.platform,arch:process.arch}))'`, { timeout: 30000 }));
    const release = this.releaseFor(platform.platform, platform.arch);
    const target = `${root}/${targetName(release)}`;
    const inspect = `(${validCursorInstall.toString()})(${JSON.stringify(target)},${JSON.stringify(release)}).then(ok=>console.log(JSON.stringify(ok)))`;
    if (JSON.parse((await this.run(env, `${shellQuote(node)} -e ${shellQuote(inspect)}`, { timeout: 30000 })).trim())) return `${target}/cursor-agent`;
    const archive = await this.archive(release, progress);
    const stage = `${root}/.install-${randomUUID()}`;
    const finalize = `const fs=require('node:fs'); (async()=>{
const stage=${JSON.stringify(stage)}, target=${JSON.stringify(target)}, release=${JSON.stringify(release)};
fs.writeFileSync(stage+'/.pidesk-runtime.json',${JSON.stringify(receipt(release))},{mode:0o600});
const valid=${validCursorInstall.toString()};
if(!await valid(stage,release)) throw new Error('Cursor SDK package is incomplete');
if(await valid(target,release)) return;
if(fs.existsSync(target)) fs.renameSync(target,target+'.incomplete-'+process.pid);
fs.renameSync(stage,target);
})().catch(e=>{console.error(e.message);process.exitCode=1});`;
    const space = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(root)},{recursive:true,mode:0o700});const s=fs.statfsSync(${JSON.stringify(root)});if(s.bavail*s.bsize<${Math.max(1 << 30, release.size * 4)}){console.error('Free at least 1 GB for Cursor SDK');process.exit(1)}`;
    const script = [
      'set -e', 'umask 077',
      `${shellQuote(node)} -e ${shellQuote(space)}`,
      `mkdir ${shellQuote(stage)}`,
      `trap ${shellQuote(`rm -rf -- ${shellQuote(stage)}`)} EXIT`,
      `tar -xzf - --strip-components=1 --no-same-owner -C ${shellQuote(stage)}`,
      `${shellQuote(node)} -e ${shellQuote(finalize)}`,
    ].join('\n');
    progress('Uploading Cursor SDK to the SSH host…');
    await this.upload(env, script, archive, release.size, progress);
    return `${target}/cursor-agent`;
  }
}
