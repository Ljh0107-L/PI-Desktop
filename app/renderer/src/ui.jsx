import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Icon } from './Icons.jsx';
import { api } from './store.js';

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

export function MenuItem({ icon, label, detail, checked, onClick, trailing, disabled, title, className = '' }) {
  return (
    <button type="button" className={`menu-item ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {icon && <span className="menu-icon">{typeof icon === 'string' ? <Icon name={icon} size={17} /> : icon}</span>}
      <span className="menu-text"><span className="menu-label">{label}</span>{detail && <span className="menu-detail">{detail}</span>}</span>
      {trailing}
      {checked && <Icon name="check" size={17} className="menu-check" />}
    </button>
  );
}

export const MenuSection = ({ title, children }) => (
  <div className="menu-section">{title && <div className="menu-section-title">{title}</div>}{children}</div>
);

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
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = (lang ?? '').split(/\s/)[0].toLowerCase();
  const known = language && hljs.getLanguage(language);
  const body = known ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button type="button" class="code-copy" data-copy="1">Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`;
};
// Inline code that looks like a file path (`src/app.ts`, `README.md`) opens in the file preview, like Claude.
const FILE_EXT = /\.(md|mdx|txt|rst|py|js|mjs|cjs|jsx|ts|tsx|json|ya?ml|toml|ini|cfg|sh|bash|zsh|c|h|cc|cpp|hpp|cu|cuh|rs|go|java|kt|swift|rb|php|css|scss|html|xml|sql|lua|r|pl|diff|patch|cmake|f90|f|png|jpe?g|gif|svg|webp|csv|tsv|log|lock|env)$/i;
export const looksLikePath = text => text.length < 240 && !/\s/.test(text) && !/^[a-z]+:\/\//i.test(text) && !text.startsWith('-')
  && /^(~|\.{1,2})?\/?[\w.@+-]+(\/[\w.@+-]+)*\/?$/.test(text) && (text.includes('/') ? /[\w-]/.test(text.split('/').pop() || 'x') : FILE_EXT.test(text) || /^(Makefile|Dockerfile|LICENSE|CMakeLists\.txt)$/.test(text));
renderer.codespan = ({ text }) => looksLikePath(text.replace(/&amp;/g, '&')) ? `<code class="file-ref" data-path="${text.replace(/"/g, '&quot;')}">${text}</code>` : `<code>${text}</code>`;
marked.setOptions({ gfm: true, breaks: false, renderer });
DOMPurify.addHook('afterSanitizeAttributes', node => { if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer'); } });

export function Markdown({ text, streaming }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '')), [text]);
  const onClick = e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(copy.closest('.code-block').querySelector('code').innerText);
      copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      return;
    }
    const ref = e.target.closest('[data-path]');
    if (ref) { window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: ref.dataset.path.replace(/&amp;/g, '&') })); return; }
    const link = e.target.closest('a');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) api('openExternal', href);
    else if (href && !href.startsWith('#')) window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: href }));
  };
  return <div className={`markdown ${streaming ? 'streaming' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
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
