// Terminal panel: a real pty per session, on this machine or on the session's SSH host (ssh -tt).
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { sshMuxArgs } from '../../core/transports.mjs';

const require = createRequire(import.meta.url);
let pty = null;
// npm installs node-pty's prebuilt spawn-helper without its execute bit when install scripts are skipped.
function ensureHelperExecutable() {
  try {
    const dir = dirname(require.resolve('node-pty/package.json'));
    for (const helper of [join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(dir, 'build', 'Release', 'spawn-helper')]) {
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    }
  } catch { /* read-only install: packaging sets the bit */ }
}
const loadPty = () => { if (!pty) { ensureHelperExecutable(); pty = require('node-pty'); } return pty; };

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

export class Terminals {
  #terms = new Map(); // terminal id -> pty
  #next = 1;
  constructor({ send }) { this.send = send; }

  open({ env, cwd, cols = 80, rows = 24 }) {
    const id = `t${this.#next++}`;
    const shellEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
    delete shellEnv.ELECTRON_RUN_AS_NODE;
    let file, args, options = { name: 'xterm-256color', cols, rows, env: shellEnv };
    if (env.kind === 'local') {
      file = process.env.SHELL || '/bin/zsh';
      args = ['-l'];
      options.cwd = cwd;
    } else {
      // A login shell in the session's folder on the host; the window size follows over SSH.
      file = 'ssh';
      args = ['-tt', '-o', 'ServerAliveInterval=15', ...sshMuxArgs(), ...(env.sshArgs ?? []), env.host, `cd ${quote(cwd)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`];
      options.cwd = process.env.HOME;
    }
    const term = loadPty().spawn(file, args, options);
    this.#terms.set(id, term);
    term.onData(data => this.send('term-data', { id, data }));
    term.onExit(({ exitCode }) => { this.#terms.delete(id); this.send('term-exit', { id, exitCode }); });
    return id;
  }
  write(id, data) { this.#terms.get(id)?.write(data); }
  resize(id, cols, rows) { try { this.#terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* exited */ } }
  close(id) { const t = this.#terms.get(id); this.#terms.delete(id); try { t?.kill(); } catch { /* gone */ } }
  closeAll() { for (const id of [...this.#terms.keys()]) this.close(id); }
}
