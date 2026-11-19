// Antigravity is an account-backed CLI engine. Pi Desktop never installs it or
// reads its credentials. The official macOS/Linux installer puts agy in ~/.local/bin.
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import app from '../../package.json' with { type: 'json' };
import { runSsh } from './remote-setup.mjs';

export const ANTIGRAVITY_ENGINE = 'antigravity';
export const ANTIGRAVITY_REMOTE_LOGIN = 'Run agy acp --login in the SSH host’s terminal, then reconnect.';

export function antigravityInstallMessage(env) {
  const target = env.kind === 'local' ? '' : ` on ${env.label ?? env.host}`;
  return `Antigravity CLI (agy) was not found${target}. Install the official Google CLI there, then try again.`;
}

export function antigravityBoot(bin, record, sessionsDir, remote = false) {
  return { antigravity: { bin, sessionsDir, sessionFile: record.piSessionFile ?? null, cwd: record.cwd, recordId: record.id, remote, clientVersion: app.version } };
}

export function findAntigravityCli({ home = homedir(), path = process.env.PATH ?? '' } = {}) {
  const dirs = [join(home, '.local', 'bin'), ...path.split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of new Set(dirs.filter(isAbsolute))) {
    const bin = join(dir, 'agy');
    try {
      if (!statSync(bin).isFile()) continue;
      accessSync(bin, constants.X_OK);
      return bin;
    } catch { /* try the next installation location */ }
  }
  return null;
}

// Run only presence checks in the remote account. Never execute agy or ask for credentials here.
export async function findRemoteAntigravityCli(env, { run = runSsh } = {}) {
  const output = await run(env, `for bin in "$HOME/.local/bin/agy" "$(command -v agy 2>/dev/null)" /opt/homebrew/bin/agy /usr/local/bin/agy; do
  case "$bin" in /*) if [ -f "$bin" ] && [ -x "$bin" ]; then printf 'PIDESK_AGY=%s\\n' "$bin"; break; fi;; esac
 done`, { timeout: 30000 });
  const bin = output.split('\n').findLast(line => line.startsWith('PIDESK_AGY='))?.slice('PIDESK_AGY='.length);
  return bin && isAbsolute(bin) && !/[\u0000-\u001f\u007f]/.test(bin) ? bin : null;
}
