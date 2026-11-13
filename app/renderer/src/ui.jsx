import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import 'katex/dist/katex.min.css';
import { mathExtension, withMath } from './markdown-math.js';
import { Icon } from './Icons.jsx';
import { api, downloadFile, notify, openFile } from './store.js';
import { resolveMarkdownReference } from './file-paths.js';
import { loadMarkdownImages, prepareFileMarkdown, scrollMarkdownAnchor } from './markdown-files.js';

// ---------------------------------------------------------------- popover menu
export function Popover({ anchor, open, onClose, children, placement = 'top-start', width, className = '' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const a = anchor.current.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? width ?? 280, h = el?.offsetHeight ?? 0;
      let left, top;
      if (placement.startsWith('right')) {
        left = a.right + 10;
        if (left + w > window.innerWidth - 8) left = a.left - w - 10;
        top = Math.max(8, Math.min(a.top - 6, window.innerHeight - h - 8));
      } else {
        left = placement.endsWith('end') ? a.right - w : a.left;
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
        top = placement.startsWith('top') ? a.top - h - 8 : a.bottom + 6;
        if (top < 8) top = a.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 8);
      }
      setPos(prev => prev && prev.left === left && prev.top === top ? prev : { left, top });
    };
    place();
    // Re-place when the popover's own content changes size (search filtering, async items).
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [open, anchor, placement, width]);
  useEffect(() => {
    if (!open) return;
    // Clicks inside another popover (a flyout submenu) do not dismiss this one.
    const onDown = e => { if (!ref.current?.contains(e.target) && !anchor.current?.contains(e.target) && !e.target.closest?.('.popover')) onClose(); };
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}>{children}</div>,
    document.body,
  );
}

export function MenuItem({ icon, label, checked, onClick, trailing, disabled, title, className = '' }) {
  return (
    <button type="button" className={`menu-item ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {icon && <span className="menu-icon">{typeof icon === 'string' ? <Icon name={icon} size={17} /> : icon}</span>}
      <span className="menu-text"><span className="menu-label">{label}</span></span>
      {trailing}
      {checked && <Icon name="check" size={17} className="menu-check" />}
    </button>
  );
}

export const MenuSection = ({ title, children }) => (
  <div className="menu-section">{title && <div className="menu-section-title">{title}</div>}{children}</div>
);

// A text-style trigger (no chrome) that opens a popover — the controls under Claude's composer.
export function Trigger({ children, menu, width = 300, placement = 'top-end', className = '', title, label, disabled }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={anchor} type="button" className={`trigger ${open ? 'active' : ''} ${className}`} onClick={() => setOpen(o => !o)} title={title} aria-label={label} aria-expanded={open && !disabled} disabled={disabled}>{children}</button>
    <Popover anchor={anchor} open={open && !disabled} onClose={() => setOpen(false)} width={width} placement={placement}>{menu(() => setOpen(false))}</Popover>
  </>;
}

// Reasoning effort in the composer toolbar. `levels`: [{ value, label }].
export function EffortTrigger({ levels, value, onChange, disabled, title }) {
  const current = levels.find(level => level.value === value)?.label ?? value ?? 'Default';
  return <Trigger width={200} placement="top-start" label="Effort" className={`effort-trigger ${value && value !== 'off' ? 'active-effort' : ''}`} disabled={disabled} title={title}
    menu={close => <MenuSection title="Reasoning effort">{levels.map(level => <MenuItem key={String(level.value)} label={level.label} checked={value === level.value} onClick={() => { onChange(level.value); close(); }} />)}</MenuSection>}>
    <span>{current}</span><Icon name="chevronDown" size={11} />
  </Trigger>;
}

// Fast / Ultrafast processing under the composer, for models that offer it. `speeds`: [{ value, label }].
export function SpeedTrigger({ speeds, value, onChange }) {
  const current = speeds.find(speed => speed.value === value) ?? speeds[0];
  return <Trigger width={200} label="Speed" className={`speed-trigger ${value !== 'standard' ? 'on' : ''}`} title={`Speed: ${current.label}`}
    menu={close => <MenuSection title="Speed">
      {speeds.map(speed => <MenuItem key={speed.value} label={speed.label} checked={value === speed.value} onClick={() => { onChange(speed.value); close(); }} />)}
    </MenuSection>}>
    <Icon name="bolt" size={14} />{value !== 'standard' && <span>{current.label}</span>}
  </Trigger>;
}

// A chip that opens a popover; used for the selectors under the composer.
export function Chip({ icon, label, title, children, width = 300, placement = 'top-start', disabled, className = '' }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" className={`chip ${open ? 'active' : ''} ${className}`} onClick={() => setOpen(o => !o)} title={title} disabled={disabled}>
        {icon && (typeof icon === 'string' ? <Icon name={icon} size={15} /> : icon)}
        <span className="chip-label">{label}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={width} placement={placement}>
        {typeof children === 'function' ? children(() => setOpen(false)) : children}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- markdown
const escapeHtml = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pointAnchor = (x, y) => ({
  current: { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false },
});

export function FileContextMenu({ menu, sessionId, onOpen, onClose }) {
  if (!menu) return null;
  const open = () => {
    onClose();
    if (onOpen) onOpen(menu.path);
    else if (sessionId) openFile(sessionId, menu.path);
    else window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: menu.path }));
  };
  const canOpen = Boolean(onOpen || sessionId);
  const canDownload = Boolean(sessionId && !menu.dir);
  return (
    <Popover anchor={menu.anchor} open onClose={onClose} width={200} placement="bottom-start">
      {canOpen && <MenuItem icon={menu.dir ? 'folder' : 'fileText'} label="Open" onClick={open} />}
      {canDownload && <MenuItem icon="download" label="Download" onClick={() => { onClose(); downloadFile(sessionId, menu.path); }} />}
      <MenuItem icon="copy" label="Copy path" onClick={() => { onClose(); navigator.clipboard.writeText(menu.path); notify('Path copied'); }} />
    </Popover>
  );
}

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = (lang ?? '').split(/\s/)[0].toLowerCase();
  const known = language && hljs.getLanguage(language);
  const body = known && text.length <= 150000 ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button type="button" class="code-copy" data-copy="1">Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`;
};
// Inline code that looks like a file path (`src/app.ts`, `README.md`) opens in the file preview, with a subtle file-type glyph.
const FILE_EXT = /\.(md|mdx|txt|rst|py|js|mjs|cjs|jsx|ts|tsx|json|ya?ml|toml|ini|cfg|sh|bash|zsh|c|h|cc|cpp|hpp|cu|cuh|rs|go|java|kt|swift|rb|php|css|scss|html|xml|sql|lua|r|pl|diff|patch|cmake|f90|f|png|jpe?g|gif|svg|webp|csv|tsv|pdf|log|lock|env)$/i;
const KNOWN_FILES = /^(Makefile|Dockerfile|LICENSE|CMakeLists\.txt|Gemfile|Procfile|Justfile)$/i;
const GIT_REF_PREFIX = /^(origin|upstream|refs)\//i;
export function fileBadgeKind(path = '') {
  const clean = String(path).replace(/\/$/, '');
  if (String(path).endsWith('/')) return 'folder';
  const ext = (clean.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (['jsx', 'tsx'].includes(ext)) return 'jsx';
  if (['css', 'scss', 'less', 'json', 'yaml', 'yml', 'toml'].includes(ext)) return 'braces';
  if (['md', 'mdx', 'txt', 'rst', 'pdf'].includes(ext)) return 'doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
  return 'code';
}
export function looksLikePath(text) {
  if (!text || text.length >= 240 || /\s/.test(text) || /^[a-z]+:\/\//i.test(text) || text.startsWith('-')) return false;
  if (!/^(~|\.{1,2})?\/?[\w.@+-]+(\/[\w.@+-]+)*\/?$/.test(text)) return false;
  if (GIT_REF_PREFIX.test(text)) return false;
  if (text.endsWith('/')) return text.length > 1;
  const last = text.split('/').filter(Boolean).pop() ?? '';
  return FILE_EXT.test(last) || KNOWN_FILES.test(last) || /^\.[a-z][a-z0-9._-]*$/i.test(last);
}
renderer.codespan = ({ text }) => {
  const escaped = escapeHtml(text);
  if (!looksLikePath(text)) return `<code>${escaped}</code>`;
  const parts = text.split('/').filter(Boolean);
  const label = escapeHtml(parts.length >= 3 && !text.endsWith('/') ? parts.at(-1) : text);
  return `<code class="file-ref" data-kind="${fileBadgeKind(text)}" data-path="${escaped}" title="${escaped}">${label}</code>`;
};
marked.setOptions({ gfm: true, breaks: false, renderer });
marked.use(mathExtension);
DOMPurify.addHook('afterSanitizeAttributes', node => { if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer'); } });

export function Markdown({ text, streaming, sessionId, documentPath, refreshKey }) {
  const root = useRef(null);
  const [menu, setMenu] = useState(null);
  const html = useMemo(() => {
    const clean = withMath(() => marked.parse(text ?? ''), html => DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_ATTR: ['srcset'] }));
    return documentPath !== undefined ? prepareFileMarkdown(clean, documentPath) : clean;
  }, [text, documentPath]);
  useEffect(() => {
    if (!sessionId || documentPath === undefined || !root.current) return;
    return loadMarkdownImages(root.current, path => api('readFile', sessionId, path));
  }, [html, sessionId, documentPath, refreshKey]);
  const openTarget = path => {
    if (sessionId) openFile(sessionId, path);
    else window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path }));
  };
  const fileTargetFrom = target => {
    const link = target.closest('a');
    if (link) {
      const destination = resolveMarkdownReference(link.getAttribute('href'), documentPath);
      return destination.kind === 'file' ? { path: destination.path, dir: destination.path.endsWith('/') } : null;
    }
    const ref = target.closest('[data-path]');
    if (ref) {
      const path = ref.dataset.path;
      return { path, dir: path.endsWith('/') || ref.dataset.kind === 'folder' };
    }
    const image = target.closest('img[data-preview-path]');
    if (image) return { path: image.dataset.previewPath, dir: false };
    return null;
  };
  const onClick = e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(copy.closest('.code-block').querySelector('code').innerText);
      copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      return;
    }
    const link = e.target.closest('a');
    if (link) {
      e.preventDefault();
      const destination = resolveMarkdownReference(link.getAttribute('href'), documentPath);
      if (destination.kind === 'external') api('openExternal', destination.url);
      else if (destination.kind === 'anchor') scrollMarkdownAnchor(root.current, destination.fragment);
      else if (destination.kind === 'file') openTarget(destination.path);
      return;
    }
    const ref = e.target.closest('[data-path]');
    if (ref) { openTarget(ref.dataset.path); return; }
    const image = e.target.closest('img[data-preview-path]');
    if (image && sessionId) openTarget(image.dataset.previewPath);
  };
  const onContextMenu = e => {
    const target = fileTargetFrom(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ ...target, anchor: pointAnchor(e.clientX, e.clientY) });
  };
  return <>
    <div ref={root} className={`markdown ${streaming ? 'streaming' : ''}`} onClick={onClick} onContextMenu={onContextMenu} dangerouslySetInnerHTML={{ __html: html }} />
    <FileContextMenu menu={menu} sessionId={sessionId} onClose={() => setMenu(null)} />
  </>;
}

export function Spinner({ size = 14 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Modal({ title, onClose, children, width = 640, footer, bare }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${bare ? 'bare' : ''}`} style={{ width }} role="dialog" aria-label={title}>
        {!bare && <div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button></div>}
        {bare ? children : <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const envIcon = env => env?.kind === 'ssh' ? 'terminal' : 'laptop';
export const shortPath = (path, home) => home && path?.startsWith(home) ? '~' + path.slice(home.length) : path;
export const baseName = path => path?.split('/').filter(Boolean).pop() ?? path ?? '';

// A width the user can drag (sidebar, file pane, file tree), remembered across launches.
// `edge`: which side of the element the handle sits on; dragging away from the element widens it.
export function useResizable(key, initial, min, max, edge = 'right') {
  const storageKey = `pidesk.width.${key}`;
  const clamp = w => Math.round(Math.min(max, Math.max(min, w)));
  const [width, setWidth] = useState(() => { const saved = Number(localStorage.getItem(storageKey)); return saved ? clamp(saved) : initial; });
  const onPointerDown = e => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    let last = startW;
    document.body.classList.add('resizing');
    const move = ev => { last = clamp(startW + (edge === 'right' ? ev.clientX - startX : startX - ev.clientX)); setWidth(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      localStorage.setItem(storageKey, String(last));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const reset = () => { setWidth(initial); localStorage.removeItem(storageKey); };
  const handle = <div className={`resize-handle ${edge}`} role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} onDoubleClick={reset} />;
  return [width, handle];
}
