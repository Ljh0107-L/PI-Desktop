// Prepare an SSH host for Pi Desktop sessions, the way Claude Desktop does: no manual setup.
//
// Everything lives in one install root on the host (default ~/.pidesk):
//   <root>/node   a portable Node.js, only if the host has no usable Node (>= 22.19)
//   <root>/pi     Pi, installed with npm --ignore-scripts at the same version as the desktop
//   <root>/ext    the bridge extension, Cursor adapter and relay (uploaded over stdin, refreshed by hash)
//   <root>/agent  Pi's agent directory (sessions, settings)
//   <root>/run    the relay's socket and log;  <root>/tmp  TMPDIR for Pi and npm
//
// Node is looked up on PATH, in a login shell, and in the usual version managers (nvm, fnm, volta,
// asdf, Homebrew), because non-interactive SSH shells usually don't load them. When the home
// directory is nearly full, the root moves to the roomiest writable scratch disk.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { join } from 'node:path';
import { shellQuote, sshMuxArgs } from '../../core/transports.mjs';
import { EXTENSION_FILES, EXTENSION_PACKAGE } from './extensions.mjs';

const MIN_NODE = '22.19.0';
const NEEDED_KB = 600 * 1024;                 // Pi + portable Node with headroom
const SCRATCH = ['/opt/tmp', '/data', '/data00', '/data0', '/mnt/data', '/scratch', '/var/tmp', '/tmp'];

export function sshBaseArgs(env) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', ...sshMuxArgs(), ...(env.sshArgs ?? [])];
}

export function runSsh(env, script, { input, timeout = 120000, onUpload } = {}) {
  return new Promise((resolve, reject) => {
    // Always POSIX sh: the login shell may be zsh/fish, where e.g. unmatched globs are errors.
    const child = spawn('ssh', [...sshBaseArgs(env), env.host, `sh -c ${shellQuote(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${env.label ?? env.host}: timed out`)); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const detail = stderr.split('\n').filter(l => l.trim() && !/^Warning: Permanently added/.test(l)).slice(-3).join(' ') || stdout.trim().slice(-300);
        reject(Object.assign(new Error(code === 255 ? `Could not connect to ${env.label ?? env.host}: ${detail}` : detail || `exit ${code}`), { code, stderr }));
      }
    });
    child.stdin.on('error', () => {});
    if (!Buffer.isBuffer(input) || input.length < 4 << 20) { child.stdin.end(input ?? ''); return; }
    // Large uploads go in chunks so the caller can show progress.
    (async () => {
      const CHUNK = 1 << 20;
      for (let offset = 0; offset < input.length; offset += CHUNK) {
        if (!child.stdin.write(input.subarray(offset, offset + CHUNK))) await new Promise(r => child.stdin.once('drain', r));
        onUpload?.(Math.min(1, (offset + CHUNK) / input.length));
      }
      child.stdin.end();
    })().catch(() => {});
  });
}

const parseVersion = v => String(v ?? '').replace(/^v/, '').split('.').map(Number);
const versionAtLeast = (version, minimum) => {
  const a = parseVersion(version), b = parseVersion(minimum);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};
const kv = text => {
  const out = {};
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) (out[line.slice(0, i)] ??= []).push(line.slice(i + 1)); }
  return out;
};

// Step 1: what the host has (Node candidates, disk space, platform).
export async function probeHost(env) {
  const scratchNodes = SCRATCH.map(d => d + '/.pidesk-$(id -un)/node/bin/node').join(' ');
  const script = [
    "printf 'home=%s\\n' \"$HOME\"; printf 'user=%s\\n' \"$(id -un)\"; printf 'hostname=%s\\n' \"$(hostname)\"",
    "printf 'os=%s\\n' \"$(uname -s)\"; printf 'arch=%s\\n' \"$(uname -m)\"",
    'SH=$SHELL; [ -n "$SH" ] || SH=sh',
    'for c in "$(command -v node 2>/dev/null)" "$($SH -lc \'command -v node\' 2>/dev/null | tail -1)" ' +
      '$HOME/.nvm/versions/node/*/bin/node $HOME/.local/share/fnm/node-versions/*/installation/bin/node $HOME/.fnm/node-versions/*/installation/bin/node ' +
      '$HOME/.volta/bin/node $HOME/.asdf/installs/nodejs/*/bin/node $HOME/.local/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node ' +
      '$HOME/.pidesk/node/bin/node ' + scratchNodes + '; do',
    "  [ -n \"$c\" ] && [ -x \"$c\" ] && printf 'node=%s %s\\n' \"$c\" \"$(\"$c\" -v 2>/dev/null)\"",
    'done',
    'for d in "$HOME" ' + SCRATCH.join(' ') + '; do',
    // -w is not enough: read-only mounts still pass it. Create a file to be sure.
    "  t=\"$d/.pidesk-probe.$$\"; if [ -d \"$d\" ] && touch \"$t\" 2>/dev/null; then rm -f \"$t\"; printf 'disk=%s %s\\n' \"$d\" \"$(df -Pk \"$d\" 2>/dev/null | awk 'NR==2{print $4}')\"; fi",
    'done',
    "command -v curl >/dev/null && echo 'curl=1'; command -v sha256sum >/dev/null && echo 'sha=sha256sum'; command -v shasum >/dev/null && echo 'sha=shasum'",
    'true',
  ].join('\n');
  const raw = kv(await runSsh(env, script));
  const nodes = (raw.node ?? []).map(line => { const [path, version] = line.split(' '); return { path, version }; })
    .filter(n => n.version?.startsWith('v'));
  const disks = (raw.disk ?? []).map(line => { const [dir, kb] = line.split(' '); return { dir, kb: Number(kb) || 0 }; });
  return { home: raw.home?.[0], user: raw.user?.[0], hostname: raw.hostname?.[0], os: raw.os?.[0], arch: raw.arch?.[0], nodes, disks, curl: !!raw.curl, sha: raw.sha?.[0] };
}

function chooseRoot(host, preferred) {
  if (preferred) return preferred;
  const home = host.disks.find(d => d.dir === host.home);
  if (home && home.kb >= NEEDED_KB) return `${host.home}/.pidesk`;
  const roomy = host.disks.filter(d => d.dir !== host.home && d.kb >= 4 * NEEDED_KB).sort((a, b) => b.kb - a.kb)[0];
  if (!roomy) {
    const free = home ? `${Math.round(home.kb / 1024)} MB free` : 'no write access';
    throw Object.assign(new Error(`The disk on ${host.label} is full (${free} in ${host.home}). Free up about 600 MB there, then try again.`), { code: 'DISK_FULL' });
  }
  return `${roomy.dir.replace(/\/$/, '')}/.pidesk-${host.user}`;
}

// Portable Node for hosts without one: newest 22.x from nodejs.org, downloaded on the host when it has
// internet, otherwise on this Mac (cached, checksum-verified) and streamed over SSH.
async function nodeRelease(platform) {
  const base = 'https://nodejs.org/dist/latest-v22.x/';
  const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
  const line = sums.split('\n').find(l => l.endsWith(`-${platform}.tar.gz`));
  if (!line) throw new Error(`No Node.js build for ${platform}`);
  const [sha, file] = line.trim().split(/\s+/);
  return { url: base + file, file, sha };
}
const PLATFORMS = { 'Linux x86_64': 'linux-x64', 'Linux aarch64': 'linux-arm64', 'Linux arm64': 'linux-arm64', 'Darwin arm64': 'darwin-arm64', 'Darwin x86_64': 'darwin-x64' };

async function installNode(env, host, root, cacheDir, onProgress) {
  const platform = PLATFORMS[`${host.os} ${host.arch}`];
  if (!platform) throw new Error(`No usable Node.js on ${env.label} and no portable build for ${host.os} ${host.arch}.`);
  onProgress('Installing Node.js…');
  const release = await nodeRelease(platform);
  const dest = `${root}/node`;
  const extract = `rm -rf ${shellQuote(dest)}.tmp && mkdir -p ${shellQuote(dest)}.tmp && tar -xzf - -C ${shellQuote(dest)}.tmp --strip-components=1 && rm -rf ${shellQuote(dest)} && mv ${shellQuote(dest)}.tmp ${shellQuote(dest)}`;
  if (host.curl && host.sha) {
    const sum = host.sha === 'shasum' ? 'shasum -a 256' : 'sha256sum';
    const tarball = `${root}/tmp/${release.file}`;
    const remote = `set -e; mkdir -p ${shellQuote(root)}/tmp; curl -fsSL -m 300 ${shellQuote(release.url)} -o ${shellQuote(tarball)}; [ "$(${sum} ${shellQuote(tarball)} | cut -d' ' -f1)" = ${release.sha} ]; ${extract} < ${shellQuote(tarball)}; rm -f ${shellQuote(tarball)}`;
    try { await runSsh(env, remote, { timeout: 420000 }); return `${dest}/bin/node`; } catch { /* no internet on the host: upload instead */ }
  }
  mkdirSync(cacheDir, { recursive: true });
  const local = join(cacheDir, release.file);
  if (!existsSync(local)) {
    onProgress('Downloading Node.js…');
    const body = Buffer.from(await (await fetch(release.url)).arrayBuffer());
    if (createHash('sha256').update(body).digest('hex') !== release.sha) throw new Error('Node.js download failed its checksum');
    writeFileSync(local + '.part', body); renameSync(local + '.part', local);
  }
  onProgress('Uploading Node.js…');
  await runSsh(env, `set -e; mkdir -p ${shellQuote(root)}; ${extract}`, { input: readFileSync(local), timeout: 600000 });
  return `${dest}/bin/node`;
}

// Pi and its whole dependency tree, taken from this app's own node_modules (the exact version the desktop
// runs), as a tarball laid out like an npm install. Pi ships no native binaries, so it runs on any OS.
export function piBundle(piPackageDir, cacheDir) {
  const version = JSON.parse(readFileSync(join(piPackageDir, 'package.json'), 'utf8')).version;
  const out = join(cacheDir, `pi-${version}.tgz`);
  if (existsSync(out)) return { path: out, version };
  let top = piPackageDir; while (!top.endsWith('/node_modules')) top = dirname(top); // the root node_modules
  const resolveDep = (fromDir, name) => {
    for (let dir = fromDir; dir.startsWith(top); dir = dirname(dirname(dir)) === dir ? top + '/x' : dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      if (dir === top) break;
    }
    const candidate = join(top, name);
    return existsSync(join(candidate, 'package.json')) ? candidate : null;
  };
  const seen = new Set();
  const visit = dir => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const found = resolveDep(dir, name);
      if (found) visit(found);
    }
  };
  visit(piPackageDir);
  // Nested packages are included with their parent directory entries; tar the top-level ones only once.
  const paths = [...seen].map(dir => relative(top, dir)).sort();
  const roots = paths.filter(p => !paths.some(q => q !== p && p.startsWith(q + '/')));
  mkdirSync(cacheDir, { recursive: true });
  execFileSync('tar', ['-czf', out + '.part', '--exclude', '.cache', '-C', top, ...roots.map(p => './' + p)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  renameSync(out + '.part', out);
  return { path: out, version };
}

async function uploadPi(env, root, bundle, onProgress) {
  const q = shellQuote(root);
  const size = Math.round(statSync(bundle.path).size / 1048576);
  onProgress(`Uploading Pi from this Mac (${size} MB)…`);
  const data = readFileSync(bundle.path);
  let last = -1;
  await runSsh(env, `set -e; rm -rf ${q}/pi.new; mkdir -p ${q}/pi.new/node_modules; tar -xzf - -C ${q}/pi.new/node_modules 2>/dev/null || tar -xzf - -C ${q}/pi.new/node_modules; printf '{"private":true}\\n' > ${q}/pi.new/package.json; rm -rf ${q}/pi.old; [ -d ${q}/pi ] && mv ${q}/pi ${q}/pi.old; mv ${q}/pi.new ${q}/pi; rm -rf ${q}/pi.old`, {
    input: data, timeout: 1800000,
    onUpload: f => { const pct = Math.floor(f * 100 / 5) * 5; if (pct !== last) { last = pct; onProgress(`Uploading Pi from this Mac… ${pct}%`); } },
  });
}

// Installation hints contain paths/version metadata only, never provider definitions or credentials.
// They are revalidated over SSH on every preparation; stale/missing hints fall back to discovery.
function installHintPath(env, cacheDir) {
  if (!cacheDir) return null;
  const key = createHash('sha256').update(JSON.stringify([env.host, env.sshArgs ?? []])).digest('hex');
  return join(cacheDir, `remote-install-${key}.json`);
}
function readInstallHint(env, root, cacheDir) {
  if (!root) return null;
  try {
    const hint = JSON.parse(readFileSync(installHintPath(env, cacheDir), 'utf8'));
    return hint.root === root && typeof hint.root === 'string' && hint.root.startsWith('/') && typeof hint.node === 'string' && hint.node.startsWith('/') && typeof hint.home === 'string' && typeof hint.hostname === 'string' ? hint : null;
  } catch { return null; }
}

export function remoteInspectionScript(root, node, piVersion) {
  const q = shellQuote(root), n = shellQuote(node);
  const packagePath = `${root}/pi/node_modules/@earendil-works/pi-coding-agent/package.json`;
  return String.raw`
mkdir -p ${q}/ext ${q}/agent ${q}/run ${q}/tmp 2>/dev/null || exit 1
chmod 700 ${q}/run 2>/dev/null || exit 1
# npm's shebang must use the selected Node, not an older Node on the login PATH.
export PATH=${shellQuote(dirname(node))}:"$PATH"
printf 'nodeVersion=%s\n' "$(${n} -v 2>/dev/null)"
PI=$(${n} -p ${shellQuote(`require(${JSON.stringify(packagePath)}).version`)} 2>/dev/null)
[ -r ${q}/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js ] || PI=
printf 'pi=%s\n' "$PI"
# npm config and registry access are install prerequisites, not connection prerequisites.
if [ "$PI" != ${shellQuote(piVersion)} ]; then
  [ -x ${shellQuote(node.replace(/\/node$/, '/npm'))} ] && echo 'npm=1'
  REG=$(${shellQuote(node.replace(/\/node$/, '/npm'))} config get registry 2>/dev/null); [ -n "$REG" ] || REG=https://registry.npmjs.org/
  command -v curl >/dev/null && curl -fsS -m 6 -o /dev/null "$REG" 2>/dev/null && echo 'registry=1'
fi
for f in ${[...EXTENSION_FILES, 'pidesk-relay.mjs', 'package.json'].join(' ')}; do printf '%s=%s\n' "$f" "$( (sha256sum ${q}/ext/$f 2>/dev/null || shasum -a 256 ${q}/ext/$f 2>/dev/null) | cut -d' ' -f1)"; done
true`;
}

export async function prepareRemote(env, { piVersion, piPackageDir, bridgePath, relayPath, providerHosts = [], root: preferredRoot, cacheDir, onProgress = () => {} }, { run = runSsh, probe = probeHost } = {}) {
  // The catalog can reject while SSH is still discovering/installing (or after SSH fails).
  // Observe it now without masking its eventual error at the egress selection boundary.
  providerHosts = Promise.resolve(providerHosts);
  providerHosts.catch(() => {});
  onProgress('Checking remote installation…');
  let host, state, node, nodeVersion, root;
  const hint = readInstallHint(env, preferredRoot, cacheDir);
  if (hint) {
    // One lightweight check instead of a login shell, every Node version manager, and every disk.
    state = kv(await run(env, remoteInspectionScript(hint.root, hint.node, piVersion)).catch(() => ''));
    nodeVersion = state.nodeVersion?.[0];
    if (/^v\d+\.\d+\.\d+/.test(nodeVersion ?? '') && versionAtLeast(nodeVersion, MIN_NODE)) {
      ({ root, node } = hint);
      host = { home: hint.home, hostname: hint.hostname };
    }
  }
  if (!node) {
    onProgress('Discovering remote environment…');
    host = { ...(await probe(env)), label: env.label ?? env.host };
    root = chooseRoot(host, preferredRoot);
    const suitable = host.nodes.filter(n => versionAtLeast(n.version, MIN_NODE)).sort((a, b) => (versionAtLeast(a.version, b.version) ? -1 : 1));
    node = suitable.find(n => n.path.startsWith(root + '/'))?.path ?? suitable[0]?.path;
    if (!node) node = await installNode(env, host, root, cacheDir, onProgress);
    state = kv(await run(env, remoteInspectionScript(root, node, piVersion)));
    nodeVersion = state.nodeVersion?.[0];
  }
  if (!/^v\d+\.\d+\.\d+/.test(nodeVersion ?? '') || !versionAtLeast(nodeVersion, MIN_NODE)) {
    throw new Error(`No usable Node.js at ${node} on ${env.label ?? env.host}; remote installation changed during setup.`);
  }
  const q = shellQuote(root);

  if (state.pi?.[0] !== piVersion) {
    // Like Claude Code: install on the host when it can reach the npm registry, otherwise (or if that
    // fails or stalls) package Pi on this Mac and upload it over SSH.
    const bin = shellQuote(node.replace(/\/node$/, ''));
    const canNpm = !process.env.PIDESK_FORCE_PI_UPLOAD && state.npm?.[0] === '1' && state.registry?.[0] === '1';
    let installed = false;
    if (canNpm) {
      onProgress(`Installing Pi ${piVersion}…`);
      installed = await run(env, `set -e; export PATH=${bin}:"$PATH" TMPDIR=${q}/tmp npm_config_cache=${q}/npm-cache npm_config_fetch_timeout=20000 npm_config_fetch_retries=1; mkdir -p ${q}/pi; cd ${q}/pi; [ -f package.json ] || printf '{"private":true}\\n' > package.json; npm install --ignore-scripts --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@${piVersion}`, { timeout: 240000 })
        .then(() => true, () => false);
    }
    if (!installed) {
      if (!piPackageDir) throw new Error(`Installing Pi on ${env.label} failed`);
      onProgress('Packaging Pi…');
      await uploadPi(env, root, piBundle(piPackageDir, cacheDir), onProgress);
    }
  }

  const changed = [];
  // package.json keeps the bridge out of any "type": "module" package above the root (extensions.mjs).
  const files = [
    ...EXTENSION_FILES.map(name => [name, readFileSync(name === 'pidesk-bridge.js' ? bridgePath : join(dirname(bridgePath), name))]),
    ['pidesk-relay.mjs', readFileSync(relayPath)],
    ['package.json', Buffer.from(EXTENSION_PACKAGE)],
  ];
  for (const [name, content] of files) {
    if (state[name]?.[0] !== createHash('sha256').update(content).digest('hex')) changed.push({ name, content: content.toString('base64') });
  }
  if (changed.length) {
    onProgress('Updating desktop bridge…');
    // All changed files travel on stdin in one SSH operation, not three serial round trips.
    const upload = `const fs = require('node:fs'), path = require('node:path');
for (const { name, content } of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  const dest = path.join(process.argv[1], name), tmp = dest + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(content, 'base64'), { mode: 0o644 }); fs.renameSync(tmp, dest);
}`;
    await run(env, `${shellQuote(node)} -e ${shellQuote(upload)} ${q}/ext`, { input: JSON.stringify(changed) });
  }
  try {
    const path = installHintPath(env, cacheDir);
    if (path) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ root, node, home: host.home, hostname: host.hostname }), { mode: 0o600 });
    }
  } catch { /* a read-only cache must not prevent connecting */ }

  // Catalog discovery runs alongside host setup; only egress selection needs its result.
  providerHosts = await providerHosts;
  // Which provider endpoints can the host reach on its own? (DNS failure, refused, timeout → no)
  const unreachable = [];
  if (providerHosts.length) {
    onProgress('Checking model access…');
    // All endpoints at once. Bound the whole curl process when timeout is available;
    // a separate getent lookup would sit outside that deadline and repeat DNS work.
    const checks = providerHosts.map(hp => {
      return `( if $T curl -sS -m 4 -o /dev/null ${shellQuote(`https://${hp.replace(/:443$/, '')}/`)} 2>/dev/null; then echo ${shellQuote(`ok ${hp}`)}; else rc=$?; case $rc in 6|7|28|35|124) echo ${shellQuote(`no ${hp}`)};; *) echo ${shellQuote(`ok ${hp}`)};; esac; fi ) &`;
    }).join(' ');
    const out = await run(env, `command -v curl >/dev/null || { echo nocurl; exit 0; }; T=; command -v timeout >/dev/null && T="timeout 5"; ${checks} wait`).catch(() => '');
    for (const line of out.trim().split('\n')) if (line.startsWith('no ')) unreachable.push(line.slice(3));
  }
  onProgress('Ready');
  return {
    hostname: host.hostname, home: host.home, root, node, nodeVersion, piVersion,
    piCli: `${root}/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
    bridge: `${root}/ext/pidesk-bridge.js`,
    relay: `${root}/ext/pidesk-relay.mjs`,
    agentDir: `${root}/agent`,
    runDir: `${root}/run`,
    tmpDir: `${root}/tmp`,
    unreachable,
    preparedAt: Date.now(),
  };
}

export async function listRemoteDir(env, path) {
  const script = `cd ${path ? shellQuote(path) : '~'} 2>/dev/null || cd ~; pwd; ls -1pA 2>/dev/null | grep '/$' | head -500`;
  const out = await runSsh(env, script, { timeout: 30000 });
  const [cwd, ...entries] = out.split('\n').filter(Boolean);
  return { path: cwd, entries: entries.map(e => e.replace(/\/$/, '')).filter(e => !e.startsWith('.')).sort((a, b) => a.localeCompare(b)) };
}

const relayCmd = (facts, args) => `env PIDESK_RUN_DIR=${shellQuote(facts.runDir)} ${shellQuote(facts.node)} ${shellQuote(facts.relay)} ${args}`;

// Sessions the relay on this host is running (alive or recently exited).
export async function listRelaySessions(env, facts) {
  const out = await runSsh(env, relayCmd(facts, 'list'), { timeout: 30000 });
  return JSON.parse(out.trim().split('\n').pop()).sessions ?? [];
}

export function stopRelaySession(env, facts, sessionId) {
  return runSsh(env, relayCmd(facts, `stop ${shellQuote(sessionId)}`), { timeout: 30000 });
}
