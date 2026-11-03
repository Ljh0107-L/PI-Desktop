import { headingSlug, resolveMarkdownReference } from './file-paths.js';

// Called only with sanitized HTML. Strip local image URLs before insertion into the
// live DOM, so Electron never tries to fetch project files relative to index.html.
export function prepareFileMarkdown(html, documentPath) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const used = new Set();
  for (const heading of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = headingSlug(heading.textContent);
    let id = base, n = 0;
    while (used.has(id)) id = `${base}-${++n}`;
    used.add(id);
    heading.id = id;
  }
  for (const img of template.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    const ref = resolveMarkdownReference(src, documentPath);
    img.removeAttribute('srcset');
    // Do not trust data-* attributes supplied by the document.
    img.removeAttribute('data-preview-path');
    img.removeAttribute('data-preview-error');
    if (ref.kind === 'file') {
      img.removeAttribute('src');
      img.dataset.previewPath = ref.path;
    } else if (ref.kind === 'image' || (ref.kind === 'external' && /^https?:/i.test(ref.url))) {
      img.setAttribute('src', ref.url);
    } else {
      img.removeAttribute('src');
      img.dataset.previewError = 'Unsupported image URL';
    }
  }
  // A picture source would otherwise override the resolved img with a renderer URL.
  for (const source of template.content.querySelectorAll('picture source')) source.remove();
  return template.innerHTML;
}

// One bounded batch per rendered document/refresh; no persistent cache of stale image
// bytes. Cleanup prevents late SSH responses from touching a newly opened document.
export function loadMarkdownImages(root, readFile) {
  let alive = true;
  const disposers = [];
  const pending = new Map();
  for (const old of root.querySelectorAll('.markdown-image-error')) old.remove();
  const images = [...root.querySelectorAll('img')];
  const jobs = images.map(img => {
    img.hidden = false;
    let error;
    const clear = () => { error?.remove(); error = null; img.hidden = false; };
    const fail = message => {
      if (!alive) return;
      clear();
      img.hidden = true;
      error = document.createElement('span');
      error.className = 'markdown-image-error';
      error.setAttribute('role', 'status');
      error.textContent = `Could not load image${img.alt ? `: ${img.alt}` : ''}`;
      error.title = message;
      img.after(error);
    };
    const onError = () => fail('Invalid or unavailable image');
    img.addEventListener('error', onError);
    img.addEventListener('load', clear);
    disposers.push(() => { img.removeEventListener('error', onError); img.removeEventListener('load', clear); });
    return async () => {
      if (!alive) return;
      if (img.dataset.previewError) { fail(img.dataset.previewError); return; }
      const path = img.dataset.previewPath;
      if (path) {
        try {
          if (!pending.has(path)) pending.set(path, Promise.resolve().then(() => readFile(path)));
          const file = await pending.get(path);
          if (!alive) return;
          if (file.kind !== 'image') throw new Error('Referenced file is not a supported image');
          if (!file.dataUrl) throw new Error('Image is too large to preview (limit: 8 MB)');
          img.src = file.dataUrl;
        } catch (e) { fail(e.message); }
      } else if (img.complete && !img.naturalWidth) onError();
    };
  });
  let next = 0;
  const worker = async () => { while (alive && next < jobs.length) await jobs[next++](); };
  for (let n = 0; n < Math.min(4, jobs.length); n++) void worker();
  return () => { alive = false; for (const dispose of disposers) dispose(); };
}

export function scrollMarkdownAnchor(root, fragment) {
  const target = [...root.querySelectorAll('[id], a[name]')].find(el => el.id === fragment || el.getAttribute('name') === fragment);
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}
