// File paths are not URLs: only Markdown destinations/file: URLs are percent-decoded.
export function normalizeFilePath(path) {
  const absolute = path.startsWith('/');
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..' && parts.at(-1) !== '~') parts.pop();
    else if (part === '..' && absolute) continue;
    else parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/') || '.';
}

export function relativeSessionPath(cwd, path) {
  let value = String(path);
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  if (!value || /[\0\r]/.test(value)) return null;
  const normalized = normalizeFilePath(value);
  const base = cwd ? normalizeFilePath(cwd).replace(/\/$/, '') : '';
  return base && normalized.startsWith(base + '/') ? normalized.slice(base.length + 1) : normalized;
}

const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
// Resolve a URL destination against the document, not Electron's renderer URL or the session cwd.
export function resolveMarkdownReference(destination, documentPath = '') {
  const value = String(destination ?? '').trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return { kind: 'blocked' };
  if (value.startsWith('#')) return { kind: 'anchor', fragment: decode(value.slice(1)) };
  if (/^(https?:|mailto:)/i.test(value)) return { kind: 'external', url: value };
  if (value.startsWith('//')) return { kind: 'external', url: `https:${value}` };
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon)[;,]/i.test(value)) return { kind: 'image', url: value };
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return { kind: 'blocked' };
      return { kind: 'file', path: normalizeFilePath(decode(url.pathname)), fragment: decode(url.hash.slice(1)) };
    } catch { return { kind: 'blocked' }; }
  }
  if (/^[a-z][\w+.-]*:/i.test(value) || value.includes('\\')) return { kind: 'blocked' };
  const hash = value.indexOf('#');
  const fragment = hash < 0 ? '' : decode(value.slice(hash + 1));
  const pathname = decode((hash < 0 ? value : value.slice(0, hash)).split('?')[0]);
  if (!pathname) return { kind: 'anchor', fragment };
  if (/[\u0000-\u001f\u007f]/.test(pathname)) return { kind: 'blocked' };
  const base = documentPath.includes('/') ? documentPath.slice(0, documentPath.lastIndexOf('/') + 1) : '';
  const path = normalizeFilePath(pathname.startsWith('/') || pathname.startsWith('~/') ? pathname : base + pathname);
  return { kind: 'file', path, fragment };
}

export const headingSlug = text => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');

// Models explicitly selected in Settings, resolved against the cached Cursor list.
export function favouriteModels(settings) {
  const byId = new Map((settings?.models ?? []).map(model => [model.id, model]));
  return (settings?.favorites ?? []).map(id => byId.get(id) ?? { id, name: id });
}
