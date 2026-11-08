import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// Launch descriptions for a Pi RPC process, either on this machine or on an SSH host.
//
// Both transports run the same tiny POSIX sh bootstrap on the target machine. The bootstrap
// reads exactly one line from stdin (the boot record: provider definitions, API keys and
// permission mode as JSON), exports it to the Pi process only, then execs Pi in RPC mode so the
// rest of stdin is the RPC command stream. Secrets therefore never appear in any argv, on this
// machine or on the remote one. The pidesk bridge extension removes the variable from
// process.env during startup so tool subprocesses do not inherit it.

export const BOOTSTRAP = [
  'IFS= read -r PIDESK_BOOT || { echo "pidesk: missing boot record" >&2; exit 97; }',
  'export PIDESK_BOOT',
  'cd "$1" || { echo "pidesk: cannot enter working directory" >&2; exit 98; }',
  'shift',
  'exec "$@"',
].join('\n');

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, `'\\''`) + "'";
}

// The command executed on the target: sh -c BOOTSTRAP pidesk <cwd> env K=V... <node> <pi> --mode rpc ...
// `extraEnv` must hold non-secret values only: it is visible in argv on the target.
function targetArgv({ cwd, node, piCli, agentDir, sessionDir, extensions = [], piArgs = [], extraEnv = {} }) {
  const env = [
    `PI_CODING_AGENT_DIR=${agentDir}`,
    'PI_OFFLINE=1',
    'PI_SKIP_VERSION_CHECK=1',
    'PI_TELEMETRY=0',
    ...Object.entries(extraEnv).map(([name, value]) => `${name}=${value}`),
  ];
  if (sessionDir) env.push(`PI_CODING_AGENT_SESSION_DIR=${sessionDir}`);
  const extensionArgs = extensions.flatMap(path => ['-e', path]);
  return ['sh', '-c', BOOTSTRAP, 'pidesk', cwd, 'env', ...env, node, piCli, '--mode', 'rpc', '-ne', ...extensionArgs, ...piArgs];
}

export function localTransport(target) {
  const [command, ...args] = targetArgv(target);
  return { kind: 'local', label: 'This computer', command, args, spawnOptions: { env: minimalEnv(process.env) } };
}

// `egress`: { localPort, remotePort } routes the remote Pi's model traffic through the desktop's
// egress proxy (core/egress-proxy.mjs) via an SSH reverse forward bound to the remote loopback.
export function sshTransport({ host, sshOptions = [], egress, ...target }) {
  const forward = [];
  if (egress) {
    const proxy = `http://127.0.0.1:${egress.remotePort}`;
    target = { ...target, extraEnv: { ...target.extraEnv, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } };
    forward.push('-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${egress.remotePort}:127.0.0.1:${egress.localPort}`);
  }
  const remoteCommand = targetArgv(target).map(shellQuote).join(' ');
  // -T: no TTY (binary-safe JSONL). BatchMode: never block on an interactive prompt.
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', ...forward, ...sshOptions, host, remoteCommand];
  return { kind: 'ssh', label: host, command: 'ssh', args, spawnOptions: { env: process.env } };
}

// Local Pi processes should not inherit unrelated credentials from the desktop app's environment.
// ELECTRON_RUN_AS_NODE is kept: where node is an Electron helper (Pi Desktop's own runtime
// fallback), a child needs it to behave as plain node instead of refusing to start.
function minimalEnv(source) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'ELECTRON_RUN_AS_NODE'];
  return Object.fromEntries(keep.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

// ---------------------------------------------------------------- relay (sessions that survive disconnects)
// The relay on this machine: local sessions keep running after the app quits.
export function localRelayTransport({ node, relayPath, runDir, extraEnv = {} }) {
  return { kind: 'local-relay', label: 'This computer', command: node, args: [relayPath, 'attach'], spawnOptions: { env: { ...minimalEnv(process.env), ...extraEnv, PIDESK_RUN_DIR: runDir } } };
}
// What the relay daemon spawns on the host when the session is not already running there.
export function relaySpawnSpec({ cwd, node, piCli, agentDir, sessionDir, extensions = [], piArgs = [], extraEnv = {} }) {
  const env = { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', ...extraEnv };
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  return { cwd, env, argv: [node, piCli, '--mode', 'rpc', '-ne', ...extensions.flatMap(path => ['-e', path]), ...piArgs] };
}

// ssh <host> <node> <relay> attach — one connection per attached session. With `egress`, the session's
// fixed remote port is reverse-forwarded to the desktop's egress proxy for as long as this connection lives.
export function sshRelayTransport({ host, sshOptions = [], node, relayPath, egress, runDir, shared = false }) {
  const forward = egress ? ['-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${egress.remotePort}:127.0.0.1:${egress.localPort}`] : [];
  // Shared connection (fast attach) for the first few sessions on a host; beyond that, or with a reverse
  // forward that must die with the connection, a connection of its own so the server's MaxSessions is never hit.
  const mux = shared && !egress ? sshMuxArgs() : ['-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', ...mux, ...forward, ...sshOptions, host, [...(runDir ? ['env', `PIDESK_RUN_DIR=${runDir}`] : []), node, relayPath, 'attach'].map(shellQuote).join(' ')];
  return { kind: 'ssh-relay', label: host, command: 'ssh', args, spawnOptions: { env: process.env } };
}

export const egressEnv = remotePort => {
  const proxy = `http://127.0.0.1:${remotePort}`;
  // Codex subscription requests must keep working after the Mac's forward disappears.
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1,chatgpt.com,.chatgpt.com,auth.openai.com' };
};

// OpenSSH connection sharing: the first connection to a host becomes a master that later ones reuse,
// so setup steps, folder listings and session attaches skip the TCP/auth handshake (~2-3 s each).
// The socket lives in a short private directory (Unix socket paths are limited to ~104 bytes).
let muxDir = null;
export function sshMuxArgs() {
  if (process.env.PIDESK_NO_SSH_MUX) return [];
  if (!muxDir) {
    muxDir = `/tmp/pidesk-ssh-${process.getuid?.() ?? 'u'}`;
    try { mkdirSync(muxDir, { recursive: true, mode: 0o700 }); chmodSync(muxDir, 0o700); } catch { muxDir = null; return []; }
  }
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${muxDir}/%C`, '-o', 'ControlPersist=600'];
}
// Close this app's shared SSH connections when it quits; ControlPersist would keep them for ten minutes.
// Sessions on the hosts are unaffected: their relays keep them.
export async function closeSshMux() {
  if (!muxDir) return;
  let sockets = [];
  try { sockets = readdirSync(muxDir); } catch { return; }
  await Promise.all(sockets.map(name => new Promise(resolve => {
    execFile('ssh', ['-o', `ControlPath=${join(muxDir, name)}`, '-O', 'exit', 'pidesk'], { timeout: 3000 }, () => resolve());
  })));
}
