// Antigravity remains the owner of its credentials, tools and quota. The
// official macOS/Linux installer puts agy in ~/.local/bin on the chosen machine.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import app from '../../package.json' with { type: 'json' };
import { shellQuote } from '../../core/transports.mjs';
import { runSsh } from './remote-setup.mjs';

const exec = promisify(execFile);
const adapterPath = fileURLToPath(new URL('../../agent/pidesk-antigravity.mjs', import.meta.url));
const INSTALL_URL = 'https://antigravity.google/cli/install.sh';

export const ANTIGRAVITY_ENGINE = 'antigravity';
export const ANTIGRAVITY_REMOTE_LOGIN = 'Run agy acp --login in the SSH host’s terminal, then reconnect.';

export function antigravityInstallMessage(env) {
  const target = env.kind === 'local' ? '' : ` on ${env.label ?? env.host}`;
  return `Antigravity CLI (agy) was not found${target}. Install it from Settings → Antigravity, then try again.`;
}

export function antigravityBoot(bin, record, sessionsDir, remote = false, bypassPermissions = true) {
  return { antigravity: { bin, sessionsDir, sessionFile: record.piSessionFile ?? null, cwd: record.cwd, recordId: record.id, remote, bypassPermissions,
    ...(record.spare ? { standby: true } : {}), clientVersion: app.version } };
}

// Explicit Settings action only. Download to a private temporary file so a
// failed/incomplete HTTPS fetch can never start executing a partial installer.
export async function installAntigravityCli(env, { run = runSsh, invoke = exec } = {}) {
  const script = `set -eu
umask 077
installer=$(mktemp "\${TMPDIR:-/tmp}/pidesk-agy.XXXXXX")
trap 'rm -f "$installer"' EXIT
curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 -o "$installer" ${shellQuote(INSTALL_URL)}
/bin/bash "$installer"`;
  try {
    if (env.kind === 'local') await invoke('/bin/sh', ['-c', script], { timeout: 240000 });
    else await run(env, script, { timeout: 240000 });
  } catch (error) {
    const detail = String(error.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 280);
    throw new Error(`Could not install Antigravity on ${env.label ?? env.host}. Check that the machine has curl and can reach Google.${detail ? ` ${detail}` : ''}`);
  }
}

export async function antigravityAccount(env, { bin, local, facts, login = false, run = runSsh, invoke = exec }) {
  if (login && env.kind !== 'local') throw new Error(ANTIGRAVITY_REMOTE_LOGIN);
  const args = [login ? '--account-login' : '--account-check', bin, app.version];
  const timeout = login ? 145000 : 35000;
  let out;
  if (env.kind === 'local') {
    ({ stdout: out } = await invoke(local.node, [adapterPath, ...args], { cwd: homedir(), env: { ...process.env, ...local.extraEnv }, timeout }));
  } else {
    const cmd = [facts.node, facts.adapter, ...args].map(shellQuote).join(' ');
    out = await run(env, `cd "$HOME" && exec ${cmd}`, { timeout });
  }
  const line = out.trim().split('\n').at(-1);
  let result;
  try { result = JSON.parse(line); } catch { throw new Error('Antigravity did not report its sign-in status.'); }
  if (!result?.antigravityAccount) throw new Error(result?.antigravityAccountError ?? 'Antigravity did not report its sign-in status.');
  const { signedIn, canSignIn } = result.antigravityAccount;
  return { installed: true, signedIn: typeof signedIn === 'boolean' ? signedIn : null, canSignIn: env.kind === 'local' && canSignIn === true };
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
