import { shellQuote } from '../../core/transports.mjs';

// Self-contained so the identical implementation can run on the SSH host's prepared Node.
// Keep imports inside this function: remoteFilePreviewScript serializes it, not this module.
export async function filePreview(operation, cwd, rel = '', { fs, home } = {}) {
  fs ??= await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { extname, join, resolve } = await import('node:path');
  home ??= (await import('node:os')).homedir();
  for (const value of [cwd, rel]) {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path');
  }
  // Expansion belongs on the machine being browsed, not the desktop. Do not use a shell
  // to interpret paths: quotes, newlines, dollar signs and leading dashes are filenames.
  const expand = value => value === '~' ? home : value.startsWith('~/') ? resolve(home, value.slice(2)) : value;
  const path = resolve(expand(cwd), expand(rel));
  if (operation === 'list') {
    const entries = [];
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      let dir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { dir = (await fs.stat(join(path, entry.name))).isDirectory(); }
        catch { /* Broken or inaccessible links remain visible as files. */ }
      }
      entries.push({ name: entry.name, dir });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path, entries };
  }
  if (operation === 'search') {
    const root = resolve(expand(cwd));
    const query = String(rel ?? '').trim().toLowerCase().replace(/^\.\//, '');
    const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'release', 'out', '.next', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'coverage', '.cache', '.DS_Store']);
    const queue = [''];
    const candidates = [];
    let visited = 0;
    while (queue.length && visited < 5000) {
      const dirRel = queue.shift();
      const depth = dirRel ? dirRel.split('/').length : 0;
      let list;
      try { list = await fs.readdir(dirRel ? join(root, dirRel) : root, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of list) {
        if (skip.has(entry.name)) continue;
        visited++;
        if (visited > 5000) break;
        const entryRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { isDir = (await fs.stat(join(root, entryRel))).isDirectory(); }
          catch { isDir = false; }
        }
        if (isDir) {
          if (depth < 5) queue.push(entryRel);
          if (query && entryRel.toLowerCase().includes(query)) candidates.push({ path: `${entryRel}/`, name: entry.name, dir: true, depth });
        } else {
          const lowerName = entry.name.toLowerCase();
          const lowerRel = entryRel.toLowerCase();
          if (!query || lowerRel.includes(query)) {
            const rank = !query ? depth * 10
              : lowerName === query ? 0
              : lowerName.startsWith(query) ? 1
              : lowerRel.startsWith(query) ? 2
              : lowerName.includes(query) ? 3 : 4;
            candidates.push({ path: entryRel, name: entry.name, dir: false, depth, rank });
          }
        }
      }
    }
    candidates.sort((a, b) => (a.dir - b.dir) || ((a.rank ?? 5) - (b.rank ?? 5)) || (a.depth - b.depth) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    return { path: root, files: candidates.slice(0, 32).map(({ path: p, name, dir }) => ({ path: p, name, dir })) };
  }
  if (operation !== 'read') throw new Error('Unknown file preview operation');

  const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };
  const extension = extname(path).slice(1).toLowerCase();
  const image = Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : null;
  const pdf = extension === 'pdf';
  const limit = pdf ? 32 << 20 : image ? 8 << 20 : 1 << 20;
  // Nonblocking open prevents a FIFO (including one substituted during a race) from
  // hanging the main process. Validate the opened descriptor, never an earlier stat(path).
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let data, size, truncated;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    const chunks = [];
    let total = 0;
    // Read an extra byte to distinguish an exact-limit file from a truncated preview.
    // Short reads are legal, and the file may grow or shrink after fstat. Only retain
    // bytes actually read; zero-filled allocation tails must not turn text into binary.
    while (total <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 << 10, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    truncated = total > limit;
    size = truncated ? Math.max(info.size, total) : total;
    data = Buffer.concat(chunks, Math.min(total, limit));
  } finally {
    await handle.close();
  }
  if (pdf) return { path, size, kind: 'pdf', truncated, dataUrl: truncated ? null : `data:application/pdf;base64,${data.toString('base64')}` };
  if (image) return { path, size, kind: 'image', truncated, dataUrl: truncated ? null : `data:${image};base64,${data.toString('base64')}` };
  const binary = data.includes(0);
  // StringDecoder holds an incomplete trailing UTF-8 sequence instead of displaying a
  // replacement character introduced only by the preview's byte limit. At real EOF,
  // ordinary decoding still exposes malformed source bytes rather than hiding them.
  const content = binary ? null : truncated ? new (await import('node:string_decoder')).StringDecoder('utf8').write(data) : data.toString('utf8');
  return { path, size, kind: binary ? 'binary' : 'text', truncated, content };
}

export function remoteFilePreviewScript(node, operation, cwd, rel = '') {
  const source = `(${filePreview.toString()})(...${JSON.stringify([operation, cwd, rel])})
.then(result => process.stdout.write(Buffer.from(JSON.stringify(result)).toString('base64')))
.catch(error => { console.error(error.message); process.exitCode = 1; });`;
  return `${shellQuote(node)} -e ${shellQuote(source)}`;
}

export function decodeRemoteFilePreview(output) {
  // ASCII transport also avoids corrupting Unicode filenames/content if an SSH stdout
  // chunk splits a UTF-8 character (runSsh collects chunks as strings).
  try {
    const encoded = output.trim();
    const data = Buffer.from(encoded, 'base64');
    // Buffer's base64 decoder otherwise silently ignores junk or incomplete output.
    if (!encoded || data.toString('base64') !== encoded) throw new Error('Invalid base64');
    const result = JSON.parse(data.toString('utf8'));
    if (!result || typeof result !== 'object' || typeof result.path !== 'string') throw new Error('Invalid preview');
    return result;
  } catch (cause) {
    throw new Error('Invalid file preview response from SSH host', { cause });
  }
}
