// Downloads from a session's machine to this Mac: exact bytes, no partial files, and the SSH host's
// side of the transfer run locally (the same script ssh runs there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { downloadLocal, receiveDownload, remoteDownloadScript, sessionPath } from '../app/main/file-download.mjs';

const BYTES = Buffer.from([...Array(256).keys(), 10, 0, 10, ...Buffer.from('end\n')]); // every byte value, newlines and NULs
function dirs(t) {
  const root = mkdtempSync(join(tmpdir(), 'pd-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), saves = join(root, 'saves');
  mkdirSync(join(project, 'out'), { recursive: true }); mkdirSync(saves);
  writeFileSync(join(project, 'out', 'data.bin'), BYTES);
  return { root, project, saves };
}

test('paths resolve like the file preview: relative to the session folder, ~ for that machine', () => {
  assert.equal(sessionPath('/work/app', 'out/a.txt', '/home/me'), '/work/app/out/a.txt');
  assert.equal(sessionPath('/work/app', '/etc/hosts', '/home/me'), '/etc/hosts');
  assert.equal(sessionPath('~/proj', '~/notes.md', '/home/me'), '/home/me/notes.md');
  assert.equal(sessionPath('~/proj', 'x', '/home/me'), '/home/me/proj/x');
});

test('a local download copies the exact bytes; a folder or a failed copy leaves nothing behind', async t => {
  const { project, saves } = dirs(t);
  const saved = await downloadLocal(project, 'out/data.bin', join(saves, 'data.bin'));
  assert.deepEqual(readFileSync(saved.path), BYTES);
  assert.equal(saved.size, BYTES.length);
  await assert.rejects(downloadLocal(project, 'out', join(saves, 'out')), /not a file/);
  await assert.rejects(downloadLocal(project, 'out/data.bin', join(saves, 'missing-dir', 'data.bin')));
  assert.deepEqual(readdirSync(saves), ['data.bin'], 'no partial or extra files');
});

const header = size => Buffer.from(JSON.stringify({ path: '/remote/data.bin', size }) + '\n');
async function feed(chunks, target, exited) {
  const stream = new PassThrough();
  const done = receiveDownload(stream, target, exited);
  for (const chunk of chunks) { stream.write(chunk); await new Promise(r => setImmediate(r)); }
  stream.end();
  return done;
}

test('the received stream is split into header and bytes however the chunks fall', async t => {
  const { saves } = dirs(t);
  const whole = Buffer.concat([header(BYTES.length), BYTES]);
  for (const cuts of [[whole.length], [3, 10, whole.length], [header(BYTES.length).length - 1, header(BYTES.length).length + 1, whole.length], [...Array(whole.length).keys()].map(i => i + 1)]) {
    const target = join(saves, `split-${cuts.length}.bin`);
    const chunks = cuts.map((end, i) => whole.subarray(i ? cuts[i - 1] : 0, end));
    const saved = await feed(chunks, target);
    assert.deepEqual(readFileSync(target), BYTES, `cuts: ${cuts.length}`);
    assert.equal(saved.source, '/remote/data.bin');
  }
});

test('an interrupted transfer, a failed sender or a bad header fails without leaving a file', async t => {
  const { saves } = dirs(t);
  const target = join(saves, 'out.bin');
  await assert.rejects(feed([header(BYTES.length), BYTES.subarray(0, 100)], target), new RegExp(`interrupted after 100 of ${BYTES.length} bytes`));
  await assert.rejects(feed([], target, async () => new Error('/remote/missing.txt: ENOENT')), /ENOENT/);
  await assert.rejects(feed([Buffer.from('not json\n'), BYTES], target), /Invalid download response/);
  await assert.rejects(feed([header(1)], target, async () => new Error('Could not connect to host')), /Could not connect/);
  assert.deepEqual(readdirSync(saves), []);
});

// What `ssh host sh -c <script>` runs on the host, run here with this Node.
function runHostScript(cwd, rel, target) {
  const child = spawn('sh', ['-c', remoteDownloadScript(process.execPath, cwd, rel)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exit = new Promise(resolve => child.on('close', code => resolve(code ? new Error(stderr.trim() || `exit ${code}`) : null)));
  return receiveDownload(child.stdout, target, () => exit);
}

test("the host's script streams the file's bytes, and reports folders and missing files", async t => {
  const { project, saves } = dirs(t);
  const saved = await runHostScript(project, 'out/data.bin', join(saves, 'data.bin'));
  assert.deepEqual(readFileSync(join(saves, 'data.bin')), BYTES);
  assert.equal(saved.source, join(project, 'out', 'data.bin'));
  await assert.rejects(runHostScript(project, 'out', join(saves, 'folder')), /is not a file/);
  await assert.rejects(runHostScript(project, 'nope.txt', join(saves, 'nope.txt')), /ENOENT|no such file/i);
  assert.ok(!existsSync(join(saves, 'folder')) && !existsSync(join(saves, 'nope.txt')));
});
