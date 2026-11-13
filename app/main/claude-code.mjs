// Claude Code engine: the pinned native binary, installed where a conversation runs.
//
// Pi Desktop never uses a `claude` found on PATH, nor the machine's own Claude Code login. It keeps its
// own copy of one pinned release, outside every PATH:
//   this Mac   <userData>/claude-code/<version>/claude
//   SSH host   <install root>/claude-code/<version>/claude   (the root Pi already lives in, e.g. ~/.pidesk)
// and runs it with CLAUDE_CONFIG_DIR pointing at a private directory beside it, so the official
// subscription state in ~/.claude is never read; credentials come from Settings → Models only.
//
// An SSH host downloads its build itself when it can reach the npm registry (or a mirror). Otherwise
// this Mac downloads it (cached), verifies it and streams it over SSH, as for Pi and Node. Every
// tarball is checked against the SHA-512 pinned below before anything is extracted.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../core/transports.mjs';

export const CLAUDE_CODE_VERSION = '2.1.322';
// dist.integrity of each platform package at CLAUDE_CODE_VERSION.
export const CLAUDE_CODE_INTEGRITY = {
  'darwin-arm64': 'sha512-OAx5Y7V7tGCi0tWuDV3lwcDWmIua512NgpClLbqvwC9m+mbLiaytgVLXf4unTXBjMf+QbQiIUO1Kus90PklDhA==',
  'darwin-x64': 'sha512-nGpWAtSEI1OMMVzlMGS4MuXZ6Op0kzXPnTzhbipgEA7Ym3LFHuCWE//9jB20xcy55zx9lagSe4tb9kRfvZ9Xdw==',
  'linux-x64': 'sha512-0DoaNAXLWCYYIGachWBCkTUsS8dOOgvk4R2fFKdrLejO9XlRTwaWUMD9ONdDmv0csdpwxj4qLUN6zWMaG2Sz6g==',
  'linux-arm64': 'sha512-YYNp1op87WWcBEE6jC1neOjMDPdn4Iy+kUHyFcI1GsLl4IwH7EjZlwVKcpsZqVbE0IXEFaOldmyOHC1y3j18Ag==',
  'linux-x64-musl': 'sha512-Tmb7C0xAFVLe4pWBmIxlAfulysXfdqgAd1GGp0DWrGxY9YZ5uiIaq25GeddBxB9IfNfWrZBcWU2g9Skb4piazQ==',
  'linux-arm64-musl': 'sha512-lcJl5oH4RtUVp7uRSpj/jrXubXDrK1v62lt50lyAaILH5wJM/psaTTlF8E+aFGFd0MT7nGinypjYapgB88Zhvg==',
};
// The official registry first, then a public mirror for networks that cannot reach it. The pinned
// checksum makes every source equally trustworthy.
export const CLAUDE_CODE_REGISTRIES = (process.env.PIDESK_CLAUDE_REGISTRY ? [process.env.PIDESK_CLAUDE_REGISTRY] : [])
  .concat(['https://registry.npmjs.org', 'https://registry.npmmirror.com']);

export const claudeTarballUrl = (registry, platform, version = CLAUDE_CODE_VERSION) =>
  `${registry.replace(/\/+$/, '')}/@anthropic-ai/claude-code-${platform}/-/claude-code-${platform}-${version}.tgz`;
const integrityHex = integrity => Buffer.from(String(integrity).replace(/^sha512-/, ''), 'base64').toString('hex');

// `uname -s`, `uname -m` and whether libc is musl → the platform package name, or null.
export function claudePlatform(os, arch, musl = false) {
  const cpu = { x86_64: 'x64', amd64: 'x64', x64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[String(arch).toLowerCase()];
  const system = { darwin: 'darwin', linux: 'linux' }[String(os).toLowerCase()];
  if (!cpu || !system) return null;
  return system === 'linux' && musl ? `linux-${cpu}-musl` : `${system}-${cpu}`;
}

// Directory layout shared by this Mac and SSH hosts.
export const claudeLayout = root => ({
  dir: `${root}/claude-code/${CLAUDE_CODE_VERSION}`,
  bin: `${root}/claude-code/${CLAUDE_CODE_VERSION}/claude`,
  configDir: `${root}/claude-code/config`,
});

// ------------------------------------------------------------------ download on this Mac (cached)
// Resolves to the verified tarball path. Concurrent callers for one platform share the download.
const downloads = new Map();
export function downloadClaudeTarball(platform, cacheDir, { onProgress = () => {}, fetchImpl = fetch, registries = CLAUDE_CODE_REGISTRIES, integrities = CLAUDE_CODE_INTEGRITY } = {}) {
  const integrity = integrities[platform];
  if (!integrity) return Promise.reject(new Error(`Claude Code ${CLAUDE_CODE_VERSION} has no build for ${platform}.`));
  const out = join(cacheDir, `claude-code-${platform}-${CLAUDE_CODE_VERSION}.tgz`);
  if (existsSync(out)) {
    try {
      const actual = `sha512-${createHash('sha512').update(readFileSync(out)).digest('base64')}`;
      if (actual === integrity) return Promise.resolve(out);
    } catch { /* re-download */ }
    rmSync(out, { force: true });
  }
  const key = out;
  if (downloads.has(key)) return downloads.get(key);
  const promise = (async () => {
    mkdirSync(cacheDir, { recursive: true });
    let lastError;
    for (const registry of registries) {
      const url = claudeTarballUrl(registry, platform);
      const part = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
      try {
        const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} from ${url}`);
        const total = Number(res.headers.get('content-length')) || 0;
        const hash = createHash('sha512');
        const file = createWriteStream(part);
        let received = 0, last = -1;
        for await (const chunk of res.body) {
          hash.update(chunk);
          received += chunk.length;
          if (!file.write(chunk)) await new Promise(r => file.once('drain', r));
          const pct = total ? Math.floor(received * 100 / total / 5) * 5 : -1;
          if (pct !== last) { last = pct; onProgress(total ? `Downloading Claude Code… ${pct}%` : `Downloading Claude Code… ${Math.round(received / 1048576)} MB`); }
        }
        await new Promise((resolve, reject) => file.end(error => error ? reject(error) : resolve()));
        if (`sha512-${hash.digest('base64')}` !== integrity) throw new Error(`Claude Code download from ${registry} failed its checksum`);
        renameSync(part, out);
        return out;
      } catch (error) {
        rmSync(part, { force: true });
        lastError = error;
      }
    }
    throw new Error(`Could not download Claude Code ${CLAUDE_CODE_VERSION}: ${lastError?.message ?? 'no registry reachable'}`);
  })().finally(() => downloads.delete(key));
  downloads.set(key, promise);
  return promise;
}

const run = (command, args, options = {}) => new Promise((resolve, reject) =>
  execFile(command, args, { maxBuffer: 1 << 20, ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));

// ------------------------------------------------------------------ this Mac
export function localClaudePlatform(platform = process.platform, arch = process.arch) {
  return claudePlatform(platform, arch, false);
}

// Installs (once) and returns { bin, configDir } under <userData>/claude-code.
const localInstalls = new Map();
export function ensureLocalClaude({ root, cacheDir, onProgress = () => {}, platform = localClaudePlatform(), fetchImpl, registries, integrities } = {}) {
  const layout = claudeLayout(root);
  const ready = () => { try { return statSync(layout.bin).isFile() && (statSync(layout.bin).mode & 0o111) !== 0; } catch { return false; } };
  if (ready()) { mkdirSync(layout.configDir, { recursive: true, mode: 0o700 }); return Promise.resolve(layout); }
  if (localInstalls.has(layout.bin)) return localInstalls.get(layout.bin);
  const promise = (async () => {
    if (!platform) throw new Error(`Claude Code is not available for ${process.platform} ${process.arch}.`);
    const tarball = await downloadClaudeTarball(platform, cacheDir, { onProgress, fetchImpl, ...(registries ? { registries } : {}), ...(integrities ? { integrities } : {}) });
    onProgress('Installing Claude Code…');
    const tmp = `${layout.dir}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    await run('tar', ['-xzf', tarball, '-C', tmp, '--strip-components=1', 'package/claude']);
    chmodSync(join(tmp, 'claude'), 0o755);
    rmSync(layout.dir, { recursive: true, force: true });
    renameSync(tmp, layout.dir);
    mkdirSync(layout.configDir, { recursive: true, mode: 0o700 });
    return layout;
  })().finally(() => localInstalls.delete(layout.bin));
  localInstalls.set(layout.bin, promise);
  return promise;
}

// ------------------------------------------------------------------ SSH hosts
// One script: is the pinned binary installed, which platform package fits, and can the host fetch it.
export function remoteClaudeProbeScript(root) {
  const { bin } = claudeLayout(root);
  return String.raw`
printf 'os=%s\n' "$(uname -s)"; printf 'arch=%s\n' "$(uname -m)"
if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] || (ldd --version 2>&1 | grep -qi musl); then echo 'musl=1'; fi
if [ -x ${shellQuote(bin)} ]; then printf 'installed=%s\n' "$(${shellQuote(bin)} --version 2>/dev/null | head -1)"; fi
command -v curl >/dev/null && echo 'curl=1'
if command -v sha512sum >/dev/null; then echo 'sha=sha512sum'; elif command -v shasum >/dev/null; then echo 'sha=shasum'; fi
if command -v npm >/dev/null; then printf 'registry=%s\n' "$(npm config get registry 2>/dev/null)"; fi
true`;
}
const kv = text => Object.fromEntries(String(text).split('\n').map(line => { const i = line.indexOf('='); return i > 0 ? [line.slice(0, i), line.slice(i + 1).trim()] : null; }).filter(Boolean));

// Extract the binary from a tarball on stdin (or a file) into the pinned directory, atomically,
// without --strip-components=1 so BusyBox tar works too. Prune superseded Claude Code versions.
function remoteExtract(root, source) {
  const { dir } = claudeLayout(root);
  const q = shellQuote(dir);
  const parentQ = shellQuote(`${root}/claude-code`);
  return [
    'set -e',
    `rm -rf ${q}.extract ${q}.tmp`,
    `mkdir -p ${q}.extract ${q}.tmp`,
    `tar -xzf ${source} -C ${q}.extract package/claude`,
    `mv ${q}.extract/package/claude ${q}.tmp/claude`,
    `chmod 755 ${q}.tmp/claude`,
    `rm -rf ${q}.extract ${q}`,
    `mv ${q}.tmp ${q}`,
    `for old in ${parentQ}/[0-9]*.[0-9]*; do [ "$old" = ${q} ] || rm -rf "$old"; done`,
    `mkdir -p ${shellQuote(claudeLayout(root).configDir)}`,
    `chmod 700 ${shellQuote(claudeLayout(root).configDir)}`,
  ].join('\n');
}

// Installs Claude Code on an SSH host (Pi's install root `facts.root`) and returns { bin, configDir }.
// `runSsh(env, script, { input, timeout, onUpload })` runs a POSIX sh script there.
export async function prepareRemoteClaude(env, facts, { runSsh, cacheDir, onProgress = () => {}, fetchImpl, registries = CLAUDE_CODE_REGISTRIES, integrities = CLAUDE_CODE_INTEGRITY, forceUpload = !!process.env.PIDESK_FORCE_CLAUDE_UPLOAD } = {}) {
  const root = facts.root;
  const layout = claudeLayout(root);
  onProgress('Checking Claude Code…');
  const state = kv(await runSsh(env, remoteClaudeProbeScript(root), { timeout: 60000 }));
  if ((state.installed ?? '').includes(CLAUDE_CODE_VERSION)) {
    await runSsh(env, `mkdir -p ${shellQuote(layout.configDir)} && chmod 700 ${shellQuote(layout.configDir)}`, { timeout: 30000 });
    return layout;
  }
  const platform = claudePlatform(state.os, state.arch, state.musl === '1');
  if (!platform || !integrities[platform]) throw new Error(`Claude Code is not available for ${state.os} ${state.arch} on ${env.label ?? env.host}.`);
  const hex = integrityHex(integrities[platform]);
  const hostRegistry = /^https?:\/\//i.test(state.registry ?? '') && state.registry !== 'undefined' ? state.registry.replace(/\/+$/, '') : null;
  const hostRegistries = hostRegistry && !registries.some(r => r.replace(/\/+$/, '') === hostRegistry) ? [hostRegistry, ...registries] : registries;
  // The host downloads it itself when it can reach a registry: fastest, and nothing crosses this Mac.
  if (!forceUpload && state.curl === '1' && state.sha) {
    const sum = state.sha === 'shasum' ? 'shasum -a 512' : 'sha512sum';
    const tarball = `${root}/tmp/claude-code-${platform}-${CLAUDE_CODE_VERSION}.tgz`;
    const tarballQ = shellQuote(tarball);
    for (const registry of hostRegistries) {
      onProgress(`Installing Claude Code on ${env.label ?? env.host}…`);
      const script = [
        'set -e',
        `trap 'rm -f ${tarballQ}' EXIT`,
        `mkdir -p ${shellQuote(`${root}/tmp`)}`,
        // A short connection check first, so a host without internet does not wait for a long timeout.
        `curl -fsS -m 8 -o /dev/null -r 0-0 ${shellQuote(claudeTarballUrl(registry, platform))}`,
        `curl -fsSL --connect-timeout 8 -m 900 ${shellQuote(claudeTarballUrl(registry, platform))} -o ${tarballQ}`,
        `[ "$(${sum} ${tarballQ} | cut -d' ' -f1)" = ${hex} ]`,
        remoteExtract(root, tarballQ),
      ].join('\n');
      try { await runSsh(env, script, { timeout: 960000 }); return layout; }
      catch (error) {
        if (/No space left|ENOSPC|Permission denied|tar: .*not found/i.test(error?.message ?? '')) throw error;
      }
    }
  }
  // No internet on the host (or the download failed): download here and upload over SSH.
  const local = await downloadClaudeTarball(platform, cacheDir, { onProgress, fetchImpl, registries, integrities });
  const data = readFileSync(local);
  const size = Math.round(data.length / 1048576);
  onProgress(`Uploading Claude Code from this Mac (${size} MB)…`);
  let last = -1;
  await runSsh(env, remoteExtract(root, '-'), {
    input: data, timeout: 3600000,
    onUpload: f => { const pct = Math.floor(f * 100 / 5) * 5; if (pct !== last) { last = pct; onProgress(`Uploading Claude Code from this Mac… ${pct}%`); } },
  });
  return layout;
}

// ------------------------------------------------------------------ models
// Built-in providers whose models Pi runs via OpenAI/other protocols, but that also serve an
// official Anthropic Messages endpoint for Claude Code (`ANTHROPIC_BASE_URL`).
export const CLAUDE_CODE_BUILTIN_BASE_URLS = {
  deepseek: 'https://api.deepseek.com/anthropic',
  moonshotai: 'https://api.moonshot.ai/anthropic',
  zai: 'https://api.z.ai/api/anthropic',
  openrouter: 'https://openrouter.ai/api',
  fireworks: 'https://api.fireworks.ai/inference',
  together: 'https://api.together.ai',
  xai: 'https://api.x.ai',
  mistral: 'https://api.mistral.ai',
};

// Claude Code speaks the Anthropic Messages API: native `anthropic-messages` models (built-in
// Anthropic or custom Anthropic-compatible endpoints) plus built-in providers with official
// Anthropic Messages endpoints.
export const ANTHROPIC_MESSAGES = 'anthropic-messages';
export function isClaudeCodeModel(model, savedProvider) {
  if (model?.api === ANTHROPIC_MESSAGES) return true;
  if (savedProvider?.kind === 'custom') return false;
  return Boolean(model?.provider && CLAUDE_CODE_BUILTIN_BASE_URLS[model.provider]);
}
export function claudeBuiltinBaseUrl(providerId, modelBaseUrl) {
  if (providerId === 'anthropic') return undefined;
  return CLAUDE_CODE_BUILTIN_BASE_URLS[providerId] ?? modelBaseUrl;
}
// Claude Code's effort levels (`--effort`, /effort). Pi's thinking levels map onto the nearest one.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function claudeEffort(level) {
  if (CLAUDE_EFFORTS.includes(level)) return level;
  return { off: 'low', minimal: 'low' }[level] ?? null;
}
export function claudeEffortsFor(model) {
  if (model?.reasoning === false) return [];
  if (!model?.thinkingLevelMap) return [...CLAUDE_EFFORTS];
  const map = model.thinkingLevelMap;
  return CLAUDE_EFFORTS.filter(level => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped != null;
    return true;
  });
}
export function clampClaudeEffort(model, level) {
  if (level == null) return null;
  const mapped = claudeEffort(level);
  if (!mapped) return null;
  const allowed = claudeEffortsFor(model);
  if (!allowed.length) return null;
  if (allowed.includes(mapped)) return mapped;
  const requestedIndex = CLAUDE_EFFORTS.indexOf(mapped);
  for (let i = requestedIndex; i < CLAUDE_EFFORTS.length; i++) {
    if (allowed.includes(CLAUDE_EFFORTS[i])) return CLAUDE_EFFORTS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    if (allowed.includes(CLAUDE_EFFORTS[i])) return CLAUDE_EFFORTS[i];
  }
  return allowed[0] ?? null;
}
export function resolveClaudeEffort(model, level) {
  const clamped = clampClaudeEffort(model, level);
  if (!clamped) return null;
  const mapped = model?.thinkingLevelMap?.[clamped];
  return typeof mapped === 'string' && CLAUDE_EFFORTS.includes(mapped) ? mapped : clamped;
}
