// Updates from GitHub Releases. The app is ad-hoc signed (no Apple Developer ID), which rules out
// Squirrel.Mac, so this downloads the release zip for this architecture, checks its SHA-512 against
// the release's latest-mac.yml, unpacks it next to the update cache, and swaps the .app bundle in
// place after the app quits, then relaunches it.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const REPO = 'Ljh0107-L/PI-Desktop';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = b.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0); }
  return false;
};
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 300000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));

export class Updater {
  status = { state: 'idle' }; // idle | checking | downloading | ready | current | error
  #timer = null;
  constructor({ app, net, cacheDir, send }) { Object.assign(this, { app, net, cacheDir, send }); }

  get bundlePath() { const exe = this.app.getPath('exe'); const i = exe.indexOf('.app/'); return i === -1 ? null : exe.slice(0, i + 4); }
  #set(status) { this.status = status; this.send('update', status); }

  start() {
    if (!this.app.isPackaged || process.platform !== 'darwin') return;
    // Downloads of versions already installed (or older) are no longer needed.
    try { for (const v of readdirSync(this.cacheDir)) if (!newer(v, this.app.getVersion())) rmSync(join(this.cacheDir, v), { recursive: true, force: true }); } catch { /* none yet */ }
    const check = () => this.check().catch(() => {});
    setTimeout(check, 15000);
    this.#timer = setInterval(check, CHECK_EVERY_MS);
    this.#timer.unref?.();
  }

  async check({ manual = false } = {}) {
    if (['checking', 'downloading', 'ready'].includes(this.status.state)) return this.status;
    this.#set({ state: 'checking' });
    try {
      const res = await this.net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const release = await res.json();
      const version = release.tag_name.replace(/^v/, '');
      if (!newer(version, this.app.getVersion())) { this.#set({ state: 'current', version: this.app.getVersion() }); return this.status; }
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const zip = release.assets.find(a => a.name.endsWith('.zip') && a.name.includes(`-${arch}`)) ?? (arch === 'x64' ? release.assets.find(a => a.name.endsWith('-mac.zip') && !a.name.includes('arm64')) : null);
      const manifest = release.assets.find(a => a.name === 'latest-mac.yml');
      if (!zip || !manifest) throw new Error('This release has no build for this Mac');
      const yml = await (await this.net.fetch(manifest.browser_download_url)).text();
      const sha512 = new RegExp(`url: ${zip.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+sha512: (\\S+)`).exec(yml)?.[1];
      if (!sha512) throw new Error('The release manifest has no checksum for this build');
      await this.#download(version, zip, sha512);
      return this.status;
    } catch (error) {
      this.#set({ state: manual ? 'error' : 'idle', message: error.message });
      return this.status;
    }
  }

  async #download(version, asset, sha512) {
    this.#set({ state: 'downloading', version, progress: 0 });
    const dir = join(this.cacheDir, version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const res = await this.net.fetch(asset.browser_download_url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const chunks = [];
    let received = 0, last = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk); received += chunk.length;
      const progress = total ? received / total : 0;
      if (progress - last > 0.01) { last = progress; this.#set({ state: 'downloading', version, progress }); }
    }
    const data = Buffer.concat(chunks);
    if (createHash('sha512').update(data).digest('base64') !== sha512) throw new Error('The download did not match its checksum');
    const zipPath = join(dir, 'update.zip');
    writeFileSync(zipPath, data);
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, join(dir, 'app')]);
    const app = (await readdir(join(dir, 'app'))).find(name => name.endsWith('.app'));
    if (!app) throw new Error('The update has no app bundle');
    rmSync(zipPath, { force: true });
    this.#set({ state: 'ready', version, path: join(dir, 'app', app) });
  }

  // Replace the running bundle once this process exits, then start the new version.
  install() {
    const target = this.bundlePath;
    if (this.status.state !== 'ready' || !target || !existsSync(this.status.path)) return false;
    try { accessSync(dirname(target), constants.W_OK); }
    catch { this.#set({ ...this.status, state: 'error', message: `Can’t replace the app in ${dirname(target)}; move Pi Desktop to Applications and try again.` }); return false; }
    const script = `
      while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
      rm -rf "$T.old"
      mv "$T" "$T.old" && mv "$N" "$T" && rm -rf "$T.old" || { [ -d "$T.old" ] && [ ! -d "$T" ] && mv "$T.old" "$T"; }
      xattr -dr com.apple.quarantine "$T" 2>/dev/null
      open "$T"`;
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, T: target, N: this.status.path } });
    child.unref();
    this.app.quit();
    return true;
  }
}
