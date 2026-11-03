// CI-only regressions for local reads and the identical implementation sent over SSH.
// The shell tests execute the remote command locally in CI, without needing a real host.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { decodeRemoteFilePreview, filePreview, remoteFilePreviewScript } from '../app/main/file-preview.mjs';

const exec = promisify(execFile);
const TEXT_LIMIT = 1 << 20;
const IMAGE_LIMIT = 8 << 20;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pidesk-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A deterministic shrinking/growing/short-read file without racing the real filesystem.
function memoryFile(content, { size = content.length, chunk = Infinity, regular = true, failure, statFailure } = {}) {
  const data = Buffer.from(content);
  const state = { closed: false, calls: 0, bytes: 0, flags: null };
  const fs = {
    async open(_path, flags) {
      state.flags = flags;
      return {
        async stat() {
          if (statFailure) throw statFailure;
          return { size, isFile: () => regular };
        },
        async read(buffer, offset, length, position) {
          state.calls++;
          if (failure) throw failure;
          const bytesRead = Math.min(chunk, length, Math.max(0, data.length - position));
          data.copy(buffer, offset, position, position + bytesRead);
          state.bytes += bytesRead;
          return { bytesRead, buffer };
        },
        async close() { state.closed = true; },
      };
    },
  };
  return { fs, state };
}

const shellPreview = async (operation, cwd, rel = '', options = {}) => {
  const { stdout } = await exec('sh', ['-c', remoteFilePreviewScript(process.execPath, operation, cwd, rel)], { timeout: 15000, maxBuffer: 20 << 20, ...options });
  return decodeRemoteFilePreview(stdout);
};

test('paths resolve against the document machine home, including tilde cwd and absolute paths', async t => {
  const root = await fixture(t);
  const home = join(root, 'remote home'), cwd = join(root, 'project');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'notes.md'), 'home content');
  await writeFile(join(cwd, 'notes.md'), 'project content');
  const options = { home };
  assert.equal((await filePreview('read', cwd, '~/notes.md', options)).content, 'home content');
  assert.equal((await filePreview('read', '~', 'notes.md', options)).path, join(home, 'notes.md'));
  assert.equal((await filePreview('read', cwd, join(home, 'notes.md'), options)).content, 'home content');
  assert.equal((await filePreview('read', cwd, './notes.md', options)).content, 'project content');
  assert.equal((await filePreview('list', cwd, '~', options)).path, home);
  assert.equal((await filePreview('list', cwd, '', options)).path, cwd);
  await assert.rejects(filePreview('read', cwd, 'bad\0path'), /Invalid file path/);
  await assert.rejects(filePreview('list', null), /Invalid file path/);
  await assert.rejects(filePreview('unexpected', cwd), /Unknown file preview operation/);
});

test('listing preserves hidden/newline/Unicode names and follows directory symlinks', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const names = ['new\nline.md', "quote' 文件.md", '.hidden', 'file10.md', 'file2.md'];
  for (const name of [...names, '.DS_Store']) await writeFile(join(root, name), name);
  await mkdir(join(root, 'folder\n文件'));
  await symlink('folder\n文件', join(root, 'linked directory'));
  await symlink('missing', join(root, 'broken link'));
  const local = await filePreview('list', root);
  const remote = await shellPreview('list', root);
  assert.deepEqual(remote, local);
  assert.deepEqual(local.entries.filter(entry => entry.dir).map(entry => entry.name), ['folder\n文件', 'linked directory']);
  for (const name of [...names, 'broken link']) assert.ok(local.entries.some(entry => entry.name === name && !entry.dir), name);
  assert.ok(!local.entries.some(entry => entry.name === '.DS_Store'));
  assert.ok(local.entries.findIndex(entry => entry.name === 'file2.md') < local.entries.findIndex(entry => entry.name === 'file10.md'));
  assert.equal((await shellPreview('list', root, 'linked directory')).path, join(root, 'linked directory'));
});

test('short reads and shrinking files return only actual bytes, never zero-filled allocation tails', async () => {
  const content = Buffer.from('Short reads: 文件\n');
  const { fs, state } = memoryFile(content, { size: 5000, chunk: 2 });
  const result = await filePreview('read', homedir(), 'notes.txt', { fs });
  assert.equal(result.kind, 'text');
  assert.equal(result.content, content.toString('utf8'));
  assert.equal(result.size, content.length);
  assert.equal(result.truncated, false);
  assert.ok(state.calls > 2);
  assert.equal(state.closed, true);
});

test('reads discover growth after fstat and remain bounded to the preview plus one byte', async () => {
  const { fs, state } = memoryFile(Buffer.alloc(TEXT_LIMIT + 100, 0x61), { size: 0 });
  const result = await filePreview('read', homedir(), 'growing.txt', { fs });
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, TEXT_LIMIT);
  assert.equal(result.size, TEXT_LIMIT + 1);
  assert.equal(state.bytes, TEXT_LIMIT + 1);
  assert.equal(state.closed, true);
});

test('exact-limit and empty text files are not marked truncated', async () => {
  for (const data of [Buffer.alloc(0), Buffer.alloc(TEXT_LIMIT, 0x61)]) {
    const { fs } = memoryFile(data);
    const result = await filePreview('read', homedir(), 'exact.txt', { fs });
    assert.equal(result.truncated, false);
    assert.equal(result.size, data.length);
    assert.equal(result.content, data.toString('utf8'));
  }
});

test('UTF-8 preview boundaries omit only the unfinished final code point', async () => {
  for (const character of ['é', '文', '😀']) {
    const encoded = Buffer.from(character);
    for (let cut = 1; cut < encoded.length; cut++) {
      const prefix = Buffer.alloc(TEXT_LIMIT - cut, 0x61);
      const { fs } = memoryFile(Buffer.concat([prefix, encoded, Buffer.from('tail')]));
      const result = await filePreview('read', homedir(), 'unicode.md', { fs });
      assert.equal(result.truncated, true);
      assert.equal(result.content, prefix.toString('utf8'));
      assert.ok(!result.content.includes('\uFFFD'));
    }
  }
  const { fs } = memoryFile(Buffer.from([0x61, 0xe6]));
  assert.equal((await filePreview('read', homedir(), 'malformed.txt', { fs })).content, 'a\uFFFD', 'malformed source bytes at actual EOF must not be hidden');
});

test('directory/special descriptors and all read/stat errors reject and close the handle', async () => {
  for (const options of [{ regular: false }, { failure: new Error('read failed') }, { statFailure: new Error('stat failed') }]) {
    const { fs, state } = memoryFile(Buffer.from('file'), options);
    await assert.rejects(filePreview('read', homedir(), 'bad', { fs }), /not a regular file|read failed|stat failed/);
    assert.equal(state.closed, true);
    if (!options.regular && !options.failure && !options.statFailure) assert.equal(state.calls, 0);
    if (constants.O_NONBLOCK) assert.ok(state.flags & constants.O_NONBLOCK, 'FIFO opens must not block before validating descriptor type');
  }
});

test('binary detection includes bytes beyond the old 8 KB sample and inherited MIME keys are text', async () => {
  const data = Buffer.alloc(9000, 0x61); data[8500] = 0;
  const result = await filePreview('read', homedir(), 'binary.dat', { fs: memoryFile(data).fs });
  assert.equal(result.kind, 'binary');
  assert.equal(result.content, null);
  assert.equal((await filePreview('read', homedir(), 'notes.constructor', { fs: memoryFile(Buffer.from('plain text')).fs })).kind, 'text');
});

test('image data remains byte-exact and oversized images never return partial data URLs', async () => {
  const bytes = Buffer.from([0, 1, 128, 255]);
  const small = await filePreview('read', homedir(), 'photo.PNG', { fs: memoryFile(bytes).fs });
  assert.equal(small.kind, 'image');
  assert.equal(small.truncated, false);
  assert.equal(small.dataUrl, `data:image/png;base64,${bytes.toString('base64')}`);
  const data = Buffer.alloc(IMAGE_LIMIT + 2, 0x61);
  for (const size of [IMAGE_LIMIT, IMAGE_LIMIT + 2]) {
    const { fs, state } = memoryFile(data.subarray(0, size));
    const result = await filePreview('read', homedir(), 'large.svg', { fs });
    assert.equal(result.truncated, size > IMAGE_LIMIT);
    assert.equal(result.dataUrl === null, size > IMAGE_LIMIT);
    assert.ok(state.bytes <= IMAGE_LIMIT + 1);
  }
});

test('remote command quotes paths and resolves ~/ on the remote host without shell interpolation', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const home = join(root, "remote ' home"), cwd = join(root, 'project');
  await mkdir(home); await mkdir(cwd);
  const name = "-文件 ' $(echo injected)\nnotes.md";
  const content = '# Remote 文件\n😀\n';
  await writeFile(join(home, name), content);
  const remote = await shellPreview('read', cwd, `~/${name}`, { env: { ...process.env, HOME: home } });
  assert.equal(remote.path, resolve(home, name));
  assert.equal(remote.content, content);
  assert.equal(remote.size, Buffer.byteLength(content));
  assert.equal(remote.truncated, false);
});

test('real remote missing, directory and permission errors reject instead of yielding empty success', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await assert.rejects(shellPreview('read', root, 'missing'), /ENOENT/);
  await assert.rejects(shellPreview('read', root), /not a regular file/);
  await assert.rejects(shellPreview('list', root, 'missing'), /ENOENT/);
  const path = join(root, 'unreadable.txt');
  await writeFile(path, 'must not silently become empty');
  if (process.getuid?.() !== 0) {
    await chmod(path, 0);
    try { await assert.rejects(shellPreview('read', root, path), /EACCES|EPERM/); }
    finally { await chmod(path, 0o600); }
  }
  await writeFile(join(root, 'empty.txt'), '');
  const empty = await shellPreview('read', root, 'empty.txt');
  assert.equal(empty.content, '');
  assert.equal(empty.size, 0);
});

test('remote responses reject malformed or empty transport output', () => {
  const result = { path: '/文件', entries: [{ name: 'a\nb', dir: false }] };
  const encoded = Buffer.from(JSON.stringify(result)).toString('base64');
  assert.deepEqual(decodeRemoteFilePreview(`${encoded}\n`), result);
  for (const output of ['', 'missing', `${encoded}!`, encoded.slice(0, -2), Buffer.from('null').toString('base64')]) {
    assert.throws(() => decodeRemoteFilePreview(output), /Invalid file preview response/);
  }
});
