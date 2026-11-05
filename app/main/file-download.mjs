// Saving a file from a session's machine (this Mac or an SSH host) to this Mac.
//
// A download is written next to its target and renamed into place only once complete, so a
// dropped connection or an unreadable file never leaves a partial file under the chosen name.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { shellQuote } from '../../core/transports.mjs';
import { sshBaseArgs } from './remote-setup.mjs';

const partOf = target => `${target}.pidesk-download`;

// A path as the file preview resolves it: relative to the session folder, ~ for that machine's home.
export function sessionPath(cwd, rel, home = homedir()) {
  const expand = value => value === '~' ? home : value.startsWith('~/') ? resolve(home, value.slice(2)) : value;
  return resolve(expand(cwd), expand(rel));
}

export async function downloadLocal(cwd, rel, target) {
  const source = sessionPath(cwd, rel);
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`${basename(source)} is not a file`);
  const part = partOf(target);
  try {
    await copyFile(source, part);
    await rename(part, target);
  } catch (error) { await rm(part, { force: true }); throw error; }
  return { path: target, size: info.size };
}

// Runs with the host's Node: resolves the path there, opens it without blocking on a FIFO, and writes
// one JSON header line ({ path, size }) followed by the file's bytes.
export function remoteDownloadScript(node, cwd, rel) {
  const source = `const fs = require('node:fs'), { resolve } = require('node:path'), home = require('node:os').homedir();
const [cwd, rel] = ${JSON.stringify([cwd, rel])};
const expand = v => v === '~' ? home : v.startsWith('~/') ? resolve(home, v.slice(2)) : v;
const file = resolve(expand(cwd), expand(rel));
try {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  const info = fs.fstatSync(fd);
  if (!info.isFile()) { fs.closeSync(fd); throw new Error(file + ' is not a file'); }
  process.stdout.write(JSON.stringify({ path: file, size: info.size }) + '\\n');
  fs.createReadStream(null, { fd }).pipe(process.stdout);
} catch (error) { console.error(error.message); process.exitCode = 1; }`;
  return `${shellQuote(node)} -e ${shellQuote(source)}`;
}

// Read a header line and the bytes after it from `stream` into `target`. Resolves once the stream has
// ended and the file is complete; `exited()` reports the sender's failure, if any.
export function receiveDownload(stream, target, exited = async () => null) {
  const part = partOf(target);
  return new Promise((resolvePromise, reject) => {
    let header = null, pending = Buffer.alloc(0), out = null, received = 0, failed = false;
    const fail = async error => {
      if (failed) return;
      failed = true;
      stream.destroy?.();
      // The write stream opens its file asynchronously: wait until it is closed, or removing the
      // partial file could run before the open creates it.
      if (out && !out.closed) await new Promise(resolveClose => { out.once('close', resolveClose); out.destroy(); });
      await rm(part, { force: true }).catch(() => {});
      reject(error);
    };
    const write = chunk => {
      received += chunk.length;
      if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()); }
    };
    stream.on('data', chunk => {
      if (failed) return;
      if (header) { write(chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline < 0) { if (pending.length > 64 << 10) fail(new Error('Invalid download response')); return; }
      try { header = JSON.parse(pending.subarray(0, newline).toString('utf8')); } catch { fail(new Error('Invalid download response')); return; }
      if (!Number.isInteger(header?.size) || header.size < 0) { fail(new Error('Invalid download response')); return; }
      out = createWriteStream(part);
      out.on('error', fail);
      const rest = pending.subarray(newline + 1);
      pending = null;
      if (rest.length) write(rest);
    });
    stream.on('error', fail);
    stream.on('end', async () => {
      const error = await exited();
      if (failed) return;
      if (error) return fail(error);
      if (!header) return fail(new Error('No file data received'));
      // A connection that dropped mid-file must not pass for a complete download.
      if (received < header.size) return fail(new Error(`Download interrupted after ${received} of ${header.size} bytes`));
      out.end(async () => {
        try { await rename(part, target); resolvePromise({ path: target, size: received, source: header.path }); }
        catch (renameError) { fail(renameError); }
      });
    });
  });
}

export function downloadRemote(env, node, cwd, rel, target) {
  const child = spawn('ssh', [...sshBaseArgs(env), env.host, `sh -c ${shellQuote(remoteDownloadScript(node, cwd, rel))}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exit = new Promise(resolvePromise => {
    child.on('error', error => resolvePromise(error));
    child.on('close', code => {
      if (code === 0) return resolvePromise(null);
      const detail = stderr.split('\n').filter(l => l.trim() && !/^Warning: Permanently added/.test(l)).slice(-1)[0];
      resolvePromise(new Error(code === 255 ? `Could not connect to ${env.label ?? env.host}${detail ? `: ${detail}` : ''}` : detail || `exit ${code}`));
    });
  });
  return receiveDownload(child.stdout, target, () => exit).finally(() => { if (child.exitCode === null) child.kill(); });
}
