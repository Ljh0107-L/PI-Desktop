import { shellQuote } from '../../core/transports.mjs';

// Self-contained so the same implementation runs on the session's SSH host.
export async function gitReview(cwd, request = {}) {
  const { execFile } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const { resolve, relative, isAbsolute, dirname } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new Error('Invalid session folder');
  if (cwd === '~' || cwd.startsWith('~/')) cwd = resolve(homedir(), cwd.slice(2));
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git = (args, { at = cwd, diffExit = false } = {}) => new Promise((yes, no) => {
    execFile('git', ['--no-pager', ...args], { cwd: at, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      if (!error || (diffExit && error.code === 1)) yes(stdout);
      else no(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'This diff is too large to display (2 MB limit). Review it in the terminal.' : (stderr.trim() || error.message)));
    });
  });
  let root;
  try { root = (await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''); }
  catch (error) {
    if (/not a git repository/i.test(error.message) && (!request.action || request.action === 'status')) return { available: false };
    throw error;
  }
  const run = (args, options) => git(args, { at: root, ...options });
  const head = () => run(['rev-parse', '--verify', 'HEAD']).then(s => s.trim(), () => null);
  const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3'];
  const status = async () => {
    const raw = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const chunks = raw.split('\0'), files = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]; if (!chunk) continue;
      const xy = chunk.slice(0, 2), path = chunk.slice(3);
      const originalPath = /[RC]/.test(xy) ? chunks[++i] : undefined;
      const base = { path, originalPath, status: xy };
      if (xy === '??') files.push({ ...base, group: 'untracked' });
      else if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) files.push({ ...base, group: 'conflicts' });
      else {
        if (xy[0] !== ' ') files.push({ ...base, originalPath: /[RC]/.test(xy[0]) ? originalPath : undefined, group: 'staged' });
        if (xy[1] !== ' ') files.push({ ...base, originalPath: /[RC]/.test(xy[1]) ? originalPath : undefined, group: 'unstaged' });
      }
    }
    return files;
  };
  const indexToken = async () => hash(JSON.stringify([await head(), await run(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-ext-diff'])]));
  const overview = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await indexToken();
      const branch = (await run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || (await head())?.slice(0, 12) || 'Unborn branch';
      const files = await status(), commitToken = await indexToken();
      if (before === commitToken) return { available: true, root, branch, files, commitToken };
    }
    throw new Error('The index is changing. Refresh the review when staging has finished.');
  };
  const action = request.action ?? 'status';
  if (action === 'status') return overview();
  if (action === 'commit') {
    const message = String(request.message ?? '').trim();
    if (!message || message.length > 20000) throw new Error('Enter a commit message (up to 20,000 characters).');
    if (!request.token || request.token !== await indexToken()) throw new Error('Staged changes have changed. Refresh and review them before committing.');
    const files = await status();
    if (files.some(f => f.group === 'conflicts')) throw new Error('Resolve merge conflicts before committing.');
    if (!files.some(f => f.group === 'staged')) throw new Error('There are no staged changes to commit.');
    const output = await run(['commit', '-m', message]);
    return { ...await overview(), output };
  }
  if (!['diff', 'stage', 'unstage', 'discard'].includes(action)) throw new Error('Unknown Git review action');
  const files = await status();
  const file = files.find(f => f.path === request.path && f.group === request.group);
  if (!file) throw new Error('This change no longer exists. Refresh the review.');
  const paths = [...new Set([file.path, file.originalPath].filter(Boolean))];
  // Refuse traversal and symlinked parent directories even if the checkout changed since status.
  for (const path of paths) {
    const rel = relative(root, resolve(root, path));
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Invalid repository path');
    let directory = dirname(resolve(root, path)), parent;
    while (!parent) {
      try { parent = await fs.realpath(directory); }
      catch (error) {
        if (error.code !== 'ENOENT' || directory === dirname(directory)) throw error;
        directory = dirname(directory);
      }
    }
    const parentRel = relative(await fs.realpath(root), parent);
    if (parentRel === '..' || parentRel.startsWith('../') || isAbsolute(parentRel)) throw new Error('File is outside the repository');
  }
  const args = file.group === 'untracked'
    ? ['diff', '--no-index', ...diffFlags, '--', '/dev/null', file.path]
    : ['diff', ...(file.group === 'staged' ? ['--cached'] : []), ...diffFlags, '--', ...paths];
  const patch = await run(args, { diffExit: file.group === 'untracked' });
  const fingerprints = []; let submodule = false;
  for (const path of paths) {
    const full = resolve(root, path), stat = await fs.lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) fingerprints.push([path, null]);
    else if (stat.isSymbolicLink()) fingerprints.push([path, 'link', await fs.readlink(full)]);
    else if (stat.isFile()) {
      // Git computes a streaming content hash without loading large files into Electron.
      fingerprints.push([path, stat.mode, (await run(['hash-object', '--no-filters', '--', path])).trim()]);
    } else { submodule = true; fingerprints.push([path, 'directory']); }
  }
  const token = hash(JSON.stringify([file, patch, fingerprints, await indexToken()]));
  const result = { ...file, root, patch, token, submodule, binary: /^Binary files |^GIT binary patch/m.test(patch) };
  if (action === 'diff') return result;
  if (!request.token || token !== request.token) throw new Error('This file has changed since you reviewed it. Refresh before continuing.');
  if (submodule || file.group === 'conflicts') throw new Error('Review submodules and merge conflicts in the terminal.');
  if (action === 'stage') {
    if (!['unstaged', 'untracked'].includes(file.group)) throw new Error('Select an unstaged or untracked file.');
    await run(['add', '--', ...paths]);
  } else if (action === 'unstage') {
    if (file.group !== 'staged') throw new Error('Select a staged file.');
    if (await head()) await run(['reset', '-q', 'HEAD', '--', ...paths]);
    else await run(['rm', '--cached', '-q', '-f', '--', ...paths]);
  } else {
    if (file.group === 'untracked') await fs.unlink(resolve(root, file.path));
    else if (file.group === 'unstaged') await run(['restore', '--worktree', '--', ...paths]);
    else throw new Error('Only unstaged or untracked changes can be discarded.');
  }
  return overview();
}

export function remoteGitReviewScript(node, cwd, request) {
  const source = `(${gitReview.toString()})(...${JSON.stringify([cwd, request])}).then(result => process.stdout.write(JSON.stringify({ result })), error => { process.stdout.write(JSON.stringify({ error: error.message })); });`;
  return `${shellQuote(node)} --input-type=module -e ${shellQuote(source)}`;
}
export function decodeGitReview(output) {
  let data;
  try { data = JSON.parse(output); } catch { throw new Error('Invalid Git review response from SSH host'); }
  if (data.error) throw new Error(data.error);
  if (!data.result || typeof data.result !== 'object') throw new Error('Invalid Git review response from SSH host');
  return data.result;
}
