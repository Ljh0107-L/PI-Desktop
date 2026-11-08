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
