import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, rename, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitReview, remoteGitReviewScript, decodeGitReview } from '../app/main/git-review.mjs';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, commit = true) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'Review fixture'); git(dir, 'config', 'user.email', 'review@example.invalid');
  await writeFile(join(dir, 'file.txt'), 'baseline\n');
  if (commit) { git(dir, 'add', '.'); git(dir, 'commit', '-m', 'initial'); }
  return dir;
}
const diff = (dir, path = 'file.txt', group = 'unstaged') => gitReview(dir, { action: 'diff', path, group });
const change = (dir, action, file) => gitReview(dir, { action, path: file.path, group: file.group, token: file.token });

test('real staged, unstaged and untracked diffs include shell changes and preserve both versions', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'file.txt'), 'staged\n'); git(dir, 'add', '.');
  await writeFile(join(dir, 'file.txt'), 'working\n'); await writeFile(join(dir, 'new.txt'), 'new\n');
  const status = await gitReview(dir);
  assert.deepEqual(status.files.map(f => [f.group, f.path]), [['staged', 'file.txt'], ['unstaged', 'file.txt'], ['untracked', 'new.txt']]);
  assert.match((await diff(dir, 'file.txt', 'staged')).patch, /-baseline\n\+staged/);
  assert.match((await diff(dir)).patch, /-staged\n\+working/);
  assert.match((await diff(dir, 'new.txt', 'untracked')).patch, /\+new/);
  const unstaged = await diff(dir); await change(dir, 'discard', unstaged);
  assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'staged\n', 'discard restores index, not HEAD');
  assert.match((await diff(dir, 'file.txt', 'staged')).patch, /\+staged/);
});

test('stale file tokens prevent destructive changes, staging and unstaging', async t => {
  const dir = await fixture(t); await writeFile(join(dir, 'file.txt'), 'first\n'); const before = await diff(dir);
  await writeFile(join(dir, 'file.txt'), 'second\n');
  await assert.rejects(change(dir, 'discard', before), /changed since/);
  await assert.rejects(change(dir, 'stage', before), /changed since/);
  assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'second\n');
  await change(dir, 'stage', await diff(dir)); const staged = await diff(dir, 'file.txt', 'staged');
  await writeFile(join(dir, 'file.txt'), 'third\n'); await assert.rejects(change(dir, 'unstage', staged), /changed since/);
  await change(dir, 'unstage', await diff(dir, 'file.txt', 'staged'));
  assert.equal((await gitReview(dir)).files[0].group, 'unstaged');
});

test('rename, deletion, spaces, Unicode, newline and literal pathspec names are handled', async t => {
  const dir = await fixture(t);
  await rename(join(dir, 'file.txt'), join(dir, 'renamed 空格.txt')); git(dir, 'add', '-A');
  const renamed = (await gitReview(dir)).files[0]; assert.equal(renamed.originalPath, 'file.txt');
  assert.match((await diff(dir, renamed.path, renamed.group)).patch, /rename from/);
  await change(dir, 'unstage', await diff(dir, renamed.path, renamed.group));
  await mkdir(join(dir, 'nested')); await writeFile(join(dir, 'nested/gone.txt'), 'gone\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'rename and nested'); await rm(join(dir, 'nested'), { recursive: true });
  assert.match((await diff(dir, 'nested/gone.txt')).patch, /-gone/);
  for (const path of ['a\nb.txt', ':(glob)*.txt', '-flag.txt']) {
    await writeFile(join(dir, path), 'literal\n'); const file = await diff(dir, path, 'untracked');
    assert.match(file.patch, /\+literal/); await change(dir, 'stage', file);
  }
  assert.equal((await gitReview(dir)).files.filter(f => f.group === 'staged').length, 3);
});

test('binary changes, symlinks and stale binary contents are correctly represented', async t => {
  const dir = await fixture(t); const path = 'binary.bin';
  await writeFile(join(dir, path), Buffer.from([0, 1, 2])); const first = await diff(dir, path, 'untracked');
  assert.equal(first.binary, true); await writeFile(join(dir, path), Buffer.from([0, 3, 4]));
  await assert.rejects(change(dir, 'discard', first), /changed since/);
  await symlink('file.txt', join(dir, 'link')); const link = await diff(dir, 'link', 'untracked');
  assert.match(link.patch, /120000/); await change(dir, 'discard', link);
  assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'baseline\n');
});

test('unborn repository supports staging, unstaging and committing only reviewed index', async t => {
  const dir = await fixture(t, false);
  await change(dir, 'stage', await diff(dir, 'file.txt', 'untracked'));
  await change(dir, 'unstage', await diff(dir, 'file.txt', 'staged'));
  await change(dir, 'stage', await diff(dir, 'file.txt', 'untracked'));
  const snapshot = await gitReview(dir);
  await writeFile(join(dir, 'file.txt'), 'later working change\n');
  const result = await gitReview(dir, { action: 'commit', message: 'reviewed initial commit', token: snapshot.commitToken });
  assert.equal(git(dir, 'show', 'HEAD:file.txt'), 'baseline');
  assert.equal(result.files[0].group, 'unstaged');
  await change(dir, 'stage', await diff(dir)); const stale = await gitReview(dir);
  await writeFile(join(dir, 'other'), 'other'); git(dir, 'add', 'other');
  await assert.rejects(gitReview(dir, { action: 'commit', message: 'stale', token: stale.commitToken }), /Staged changes have changed/);
});

test('remote script executes the identical reader and mutation and preserves errors', async t => {
  const dir = await fixture(t); await writeFile(join(dir, 'file.txt'), 'remote\n');
  const remote = request => decodeGitReview(execFileSync('sh', ['-c', remoteGitReviewScript(process.execPath, dir, request)], { encoding: 'utf8' }));
  const file = remote({ action: 'diff', path: 'file.txt', group: 'unstaged' });
  assert.match(file.patch, /\+remote/);
  assert.equal(remote({ action: 'stage', path: file.path, group: file.group, token: file.token }).files[0].group, 'staged');
  assert.throws(() => remote({ action: 'discard', path: '../outside', group: 'untracked' }), /no longer exists/);
  assert.throws(() => decodeGitReview('noise'), /Invalid Git review/);
});

test('non-repositories have an explicit empty state and large diffs fail visibly', async t => {
  const plain = await mkdtemp(join(tmpdir(), 'pi-no-repo-')); t.after(() => rm(plain, { recursive: true, force: true }));
  assert.deepEqual(await gitReview(plain), { available: false });
  const dir = await fixture(t); await writeFile(join(dir, 'huge'), 'line\n'.repeat(450000));
  await assert.rejects(diff(dir, 'huge', 'untracked'), /too large/);
  assert.ok((await gitReview(dir)).files.some(f => f.path === 'huge'));
});

test('merge conflicts are visible and cannot be discarded through the review API', async t => {
  const dir = await fixture(t); git(dir, 'checkout', '-b', 'other');
  await writeFile(join(dir, 'file.txt'), 'other\n'); git(dir, 'commit', '-am', 'other'); git(dir, 'checkout', 'main');
  await writeFile(join(dir, 'file.txt'), 'main\n'); git(dir, 'commit', '-am', 'main');
  try { git(dir, 'merge', 'other'); } catch { /* expected conflict */ }
  const file = await diff(dir, 'file.txt', 'conflicts'); assert.equal(file.group, 'conflicts');
  await assert.rejects(change(dir, 'discard', file), /merge conflicts/);
});

test('staged renames with later edits operate only on the index destination', async t => {
  const dir = await fixture(t); await rename(join(dir, 'file.txt'), join(dir, 'renamed.txt')); git(dir, 'add', '-A');
  await writeFile(join(dir, 'renamed.txt'), 'edited after rename\n');
  const file = await diff(dir, 'renamed.txt', 'unstaged');
  assert.equal(file.originalPath, undefined);
  await change(dir, 'discard', file);
  assert.equal(await readFile(join(dir, 'renamed.txt'), 'utf8'), 'baseline\n');
  assert.equal((await gitReview(dir)).files[0].originalPath, 'file.txt');
  await writeFile(join(dir, 'renamed.txt'), 'edited again\n');
  await change(dir, 'stage', await diff(dir, 'renamed.txt', 'unstaged'));
  assert.equal(git(dir, 'show', ':renamed.txt'), 'edited again');
});

test('nested session folders still review repository-root relative paths', async t => {
  const dir = await fixture(t); await mkdir(join(dir, 'sub')); await writeFile(join(dir, 'file.txt'), 'root change\n');
  const status = await gitReview(join(dir, 'sub')); assert.equal(status.root, await (await import('node:fs/promises')).realpath(dir));
  const file = await gitReview(join(dir, 'sub'), { action: 'diff', path: 'file.txt', group: 'unstaged' });
  assert.match(file.patch, /\+root change/);
});
