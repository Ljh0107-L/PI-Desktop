import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { EffortTrigger, MenuItem, MenuSection, Modal, SpeedTrigger, Spinner, Trigger, baseName, envIcon, fileBadgeKind, shortPath } from './ui.jsx';
import { effectiveSpeed } from '../../../agent/pidesk-speed.mjs';
import { api, captureComposerDraft, clearQueued, defaultFolder, getState, notify, openSettings, recoverComposerDraft, restoreComposerDraft, setComposerDraft, setDraft, setEnvironments, set as setStore, takeComposerDraft, useStore } from './store.js';
import { createComposerDraft, draftReadToken, updateComposerDraft, takeComposerDraft as takeDraft, restoreComposerDraft as restoreDraft, recoverComposerDraft as recoverDraft } from './composer-draft.js';
import { createComposerSizer } from './composer-size.js';
import { cachedDir, listDir, prefetchDir } from './dirs.js';
import { isModelForEngine, modelsForEnvironment } from './model-catalog.js';

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const effortLabel = level => ({ off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }[level] ?? level);
// Levels a model offers, per Pi: a thinkingLevelMap value of null removes a level; unmapped levels use the
// provider default up to high, and xhigh/max exist only when mapped.
const effortsFor = model => {
  const map = model?.thinkingLevelMap ?? {};
  return EFFORTS.filter(l => map[l] === null ? false : ['xhigh', 'max'].includes(l) ? map[l] != null : true);
};

// ---------------------------------------------------------------- environment menu (Claude-style, with a "More" flyout)
function EnvItem({ env, value, onPick, status }) {
  return <MenuItem icon={envIcon(env)} label={env.label} title={status?.status === 'preparing' ? status.message : status?.status === 'error' ? `Setup failed: ${status.message ?? 'see Settings'}` : undefined}
    checked={value === env.id} onClick={() => onPick(env.id)} trailing={status?.status === 'preparing' ? <Spinner /> : status?.status === 'error' ? <Icon name="alert" size={14} className="menu-alert" /> : null} />;
}

export function EnvironmentMenu({ value, onChange, close }) {
  const environments = useStore(s => s.environments);
  const recent = useStore(s => s.settings?.recentEnvironments ?? []);
  const envStatus = useStore(s => s.envStatus);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rank = e => { const r = recent.indexOf(e.id); return r < 0 ? 1e3 : r; };
  // Only the connections the user added (Settings → Connections) are offered; searching also finds
  // other hosts from ~/.ssh/config, which get added when picked.
  const added = environments.filter(e => e.kind === 'ssh' && e.added && e.enabled).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const others = q ? environments.filter(e => e.kind === 'ssh' && !e.added && `${e.label} ${e.detail}`.toLowerCase().includes(q)).slice(0, 8) : [];
  const matchAdded = q ? added.filter(e => `${e.label} ${e.detail}`.toLowerCase().includes(q)) : added;
  const pick = id => { onChange(id); close(); };
  const pickNew = async id => { setEnvironments(await api('addConnections', [id])); pick(id); };
  return (
    <div className="env-menu">
      <input className="menu-search" autoFocus placeholder="Search environments…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="menu-scroll">
        {(!q || 'this computer local'.includes(q)) && <MenuSection><MenuItem icon="laptop" label="This computer" checked={value === 'local'} onClick={() => pick('local')} /></MenuSection>}
        {matchAdded.length > 0 && <MenuSection title="SSH">{matchAdded.map(env => <EnvItem key={env.id} env={env} value={value} onPick={pick} status={envStatus[env.id]} />)}</MenuSection>}
        {others.length > 0 && <MenuSection title="From ~/.ssh/config">{others.map(env => <EnvItem key={env.id} env={env} value={value} onPick={pickNew} />)}</MenuSection>}
        {q && !matchAdded.length && !others.length && !'this computer local'.includes(q) && <div className="menu-empty">No matching hosts</div>}
      </div>
      <div className="menu-foot">
        <MenuItem icon="plus" label="Add SSH connection…" onClick={() => { close(); openSettings(true, 'connections', { addConnection: true }); }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- folders
function RemoteBrowser({ environmentId, start, onPick, onClose }) {
  const initial = cachedDir(environmentId, start);
  const [dir, setDir] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!initial);
  const [typed, setTyped] = useState(initial?.path ?? start ?? '');
  const seq = useRef(0);
  const editing = useRef(false); // the user typed a path: a finishing refresh must not replace it
  // Show a cached listing at once and refresh it quietly; only the latest request may update the view.
  const load = async path => {
    const mine = ++seq.current;
    editing.current = false;
    const cached = cachedDir(environmentId, path);
    if (cached) { setDir(cached); setTyped(cached.path); setError(null); } else setLoading(true);
    try {
      const r = await listDir(environmentId, path);
      if (mine === seq.current && !editing.current) { setDir(r); setTyped(r.path); setError(null); }
      prefetchDir(environmentId, r.path);
    } catch (e) { if (mine === seq.current && !cached) setError(e.message); }
    finally { if (mine === seq.current) setLoading(false); }
  };
  useEffect(() => { load(start); }, []);
  const parent = dir?.path && dir.path !== '/' ? dir.path.replace(/\/[^/]+\/?$/, '') || '/' : null;
  const join = name => `${dir.path.replace(/\/$/, '')}/${name}`;
  return (
    <Modal title="Choose a folder" onClose={onClose} width={560} footer={<>
      <button className="button" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={!dir || loading} onClick={() => { onPick(dir.path); onClose(); }}>Use this folder</button>
    </>}>
      <form className="browse-path" onSubmit={e => { e.preventDefault(); load(typed); }}>
        <input value={typed} onChange={e => { editing.current = true; setTyped(e.target.value); }} spellCheck={false} aria-label="Folder path" />
        <button className="button" type="submit">Go</button>
      </form>
      <div className="browse-list">
        {loading && !dir && <div className="browse-empty"><Spinner /> Loading…</div>}
        {error && <div className="browse-empty error">{error}</div>}
        {dir && <>
          {parent && <button className="browse-item" onClick={() => load(parent)}><Icon name="back" size={16} /> Parent folder</button>}
          {dir.entries.map(name => <button key={name} className="browse-item" onClick={() => load(join(name))}><Icon name="folder" size={16} /> {name}</button>)}
          {!dir.entries.length && <div className="browse-empty">No sub-folders</div>}
        </>}
      </div>
    </Modal>
  );
}

function FolderMenu({ environmentId, value, onChange, close, onBrowse }) {
  const recents = useStore(s => s.settings?.recentFolders?.[environmentId] ?? []);
  const env = useStore(s => s.environments.find(e => e.id === environmentId));
  const local = env?.kind !== 'ssh';
  return <>
    <MenuItem icon="chat" label="No folder" checked={!value} onClick={() => { onChange(null); close(); }} />
    {recents.length > 0 && <MenuSection title="Recent folders">
      {recents.map(path => <MenuItem key={path} icon="folder" label={baseName(path)} title={path} checked={value === path} onClick={() => { onChange(path); close(); }} />)}
    </MenuSection>}
    <div className="menu-foot">
      <MenuItem icon="plus" label={local ? 'Choose a folder…' : `Browse ${env?.label ?? 'host'}…`} onClick={async () => {
        close();
        if (local) { const path = await api('pickLocalFolder'); if (path) onChange(path); }
        else onBrowse();
      }} />
    </div>
  </>;
}

// ---------------------------------------------------------------- models
export function ModelMenu({ value, environmentId, engine = 'pi', onChange, close }) {
  const catalog = useStore(s => modelsForEnvironment(s.catalog, environmentId, engine));
  const catalogError = useStore(s => s.catalogError);
  const providers = useStore(s => s.settings?.providers ?? []);
  const builtin = useStore(s => s.settings?.builtinProviders ?? {});
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map();
    for (const m of catalog) {
      if (q && !`${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q)) continue;
      if (!out.has(m.provider)) out.set(m.provider, []);
      out.get(m.provider).push(m);
    }
    return [...out.entries()];
  }, [catalog, q]);
  const providerName = id => providers.find(p => p.id === id)?.name ?? builtin[id] ?? id;
  const emptyText = engine === 'claude-code'
    ? 'No Anthropic Messages models — add Anthropic or an Anthropic-compatible endpoint in Settings → Models.'
    : 'No models for this environment — add a provider in Settings → Models.';
  return (
    <div className="model-menu">
      <input className="menu-search" autoFocus placeholder="Search models…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="menu-scroll">
        {catalogError && <div className="menu-empty error">{catalogError}</div>}
        {!catalog.length && !catalogError && <div className="menu-empty">{emptyText}</div>}
        {groups.map(([provider, models]) => (
          <MenuSection key={provider} title={providerName(provider)}>
            {models.map(m => <MenuItem key={m.id} label={m.name} title={`${m.provider}/${m.id}`} checked={value?.provider === m.provider && value?.id === m.id}
              onClick={() => { onChange({ provider: m.provider, id: m.id }); close(); }} />)}
          </MenuSection>
        ))}
      </div>
      <div className="menu-foot"><MenuItem icon="settings" label="Manage models…" onClick={() => { close(); openSettings(true, 'providers'); }} /></div>
    </div>
  );
}

export const modelLabel = (model, catalog) => {
  if (!model) return 'Choose a model';
  return catalog.find(x => x.provider === model.provider && x.id === model.id)?.name ?? model.id;
};

// ---------------------------------------------------------------- composer
// Built-in commands handled by the desktop (or the bridge, for /goal); Pi's own skills and prompt templates
// are listed after them.
export const BUILTIN_COMMANDS = [
  { name: 'goal', args: true, description: 'Set a goal Pi keeps working toward' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'fork', description: 'Continue in a copy of this conversation' },
  { name: 'new', description: 'Start a new conversation' },
];

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const toBase64 = buffer => { let s = ''; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function attachmentFromFile(file) {
  const path = window.pidesk.pathForFile?.(file) ?? '';
  if (IMAGE_TYPES.includes(file.type)) {
    if (file.size > 20 << 20) throw new Error(`${file.name} is too large (images up to 20 MB)`);
    const data = toBase64(await file.arrayBuffer());
    return { kind: 'image', name: file.name || 'image.png', mimeType: file.type, data, preview: `data:${file.type};base64,${data}` };
  }
  if (path) return { kind: 'file', name: file.name, path };
  if (file.size > 50 << 20) throw new Error(`${file.name} is too large (files up to 50 MB)`);
  return { kind: 'file', name: file.name || 'file', data: toBase64(await file.arrayBuffer()) };
}

// Lists while typing. Items sit indented (INDENT per level) so a list reads as one:
// - typing "1. " or "- " at the start of a line indents it;
// - Shift+Enter starts the next item (later numbers shift up); on an empty item it steps out a level,
//   and at the top level ends the list;
// - Tab / Shift+Tab nest an item one level deeper or shallower.
export const INDENT = '   ';
const ITEM = /^(\s*)(?:(\d+)([.)])|([-*\u2022]))(\s+)/;
const lineBounds = (text, caret) => {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  const nl = text.indexOf('\n', caret);
  return { start, end: nl === -1 ? text.length : nl };
};
export function continueList(text, caret) {
  const { start, end } = lineBounds(text, caret);
  const m = ITEM.exec(text.slice(start, end));
  if (!m || caret < start + m[0].length) return null;
  const [marker, indent, num, delim, bullet, gap] = m;
  if (!text.slice(start + marker.length, end).trim()) {
    // Empty item: step out one level, or leave the list from the top level.
    if (indent.length > INDENT.length) return nestItem(text, caret, -1);
    return { text: text.slice(0, start) + text.slice(end), caret: start };
  }
  const insert = `\n${indent}${num ? `${Number(num) + 1}${delim}` : bullet}${gap}`;
  let after = text.slice(caret);
  if (num) {
    const lines = after.split('\n');
    let n = Number(num) + 2;
    for (let i = 1; i < lines.length; i++) {
      const item = /^(\s*)(\d+)([.)])(\s.*)$/.exec(lines[i]);
      if (!item || item[1].length < indent.length) break;
      if (item[1] !== indent || item[3] !== delim) continue; // deeper items keep their own numbering
      lines[i] = `${indent}${n++}${delim}${item[4]}`;
    }
    after = lines.join('\n');
  }
  return { text: text.slice(0, caret) + insert + after, caret: caret + insert.length };
}
// Tab (dir 1) / Shift+Tab (dir -1) on a list item; a nested numbered item restarts at 1.
export function nestItem(text, caret, dir) {
  const { start, end } = lineBounds(text, caret);
  const line = text.slice(start, end);
  const m = ITEM.exec(line);
  if (!m) return null;
  const [marker, indent, num, delim, bullet, gap] = m;
  if (dir < 0 && !indent) return null;
  const nextIndent = dir > 0 ? indent + INDENT : indent.slice(0, Math.max(0, indent.length - INDENT.length));
  let nextNum = num;
  if (num) {
    // Number it after the previous item at the new level, or 1.
    let n = 1;
    for (const prev of (start ? text.slice(0, start - 1).split('\n') : []).reverse()) {
      const p = ITEM.exec(prev);
      if (!p || p[1].length < nextIndent.length) break; // left the list, or reached the parent item
      if (p[1].length === nextIndent.length) { if (p[2]) n = Number(p[2]) + 1; break; }
    }
    nextNum = String(n);
  }
  const nextMarker = `${nextIndent}${num ? nextNum + delim : bullet}${gap}`;
  const nextLine = nextMarker + line.slice(marker.length);
  return { text: text.slice(0, start) + nextLine + text.slice(end), caret: Math.max(start + nextMarker.length, caret + nextMarker.length - marker.length) };
}
// Typing the space after "1." or "-" at the very start of a line: indent the new item.
export function autoIndent(prev, next, caret) {
  if (next.length !== prev.length + 1 || next[caret - 1] !== ' ') return null;
  const { start } = lineBounds(next, caret);
  if (!/^(?:\d+[.)]|[-*]) $/.test(next.slice(start, caret))) return null;
  return { text: next.slice(0, start) + INDENT + next.slice(start), caret: caret + INDENT.length };
}

function SlashMenu({ items, index, onPick }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div className="slash-menu" ref={ref} role="listbox" aria-label="Slash commands">
      <div className="slash-menu-list">
        {items.map((c, i) => (
          <button key={c.name} type="button" role="option" aria-selected={i === index} className={`slash-item ${i === index ? 'on' : ''}`} title={[c.argumentHint && `/${c.name} ${c.argumentHint}`, c.description].filter(Boolean).join(' — ') || undefined} onMouseDown={e => { e.preventDefault(); onPick(c); }}>
            <span className="slash-name">/{c.name}</span>
            {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
            {c.description && <span className="slash-desc">{c.description}</span>}
            {i === index && <Icon name="enter" size={13} className="slash-enter" />}
          </button>
        ))}
      </div>
      <div className="menu-kbd-foot" aria-hidden="true"><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> dismiss</span></div>
    </div>
  );
}

const mentionIconName = item => {
  if (item.dir) return 'folder';
  const kind = fileBadgeKind(item.path);
  return kind === 'jsx' ? 'atom' : kind === 'braces' ? 'braces' : kind === 'doc' ? 'fileText' : kind === 'image' ? 'fileImage' : 'fileCode';
};

// Detect `@query` immediately before the caret (at start of text or after whitespace).
export function activeMentionAt(text, caret) {
  if (caret == null || caret < 1) return null;
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  const start = caret - query.length - 1; // index of '@'
  return { start, end: caret, query };
}

function MentionMenu({ items, index, loading, onPick }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('.mention-item.on')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div className="slash-menu mention-menu" ref={ref} role="listbox" aria-label="File mentions">
      <div className="slash-menu-list">
        {loading && !items.length && <div className="mention-empty"><Spinner size={12} /> Searching workspace…</div>}
        {items.map((item, i) => {
          const clean = item.path.replace(/\/$/, '');
          const slash = clean.lastIndexOf('/');
          const dirPart = slash > 0 ? clean.slice(0, slash) : '';
          return (
            <button key={item.path} type="button" role="option" aria-selected={i === index} className={`slash-item mention-item ${i === index ? 'on' : ''}`}
              title={item.path} onMouseDown={e => { e.preventDefault(); onPick(item); }}>
              <Icon name={mentionIconName(item)} size={14} className={`mention-icon ${fileBadgeKind(item.path)}`} />
              <span className="mention-name">{item.dir ? `${item.name}/` : item.name}</span>
              {dirPart && <span className="mention-dir">{dirPart}</span>}
              {i === index && <Icon name="enter" size={13} className="slash-enter" />}
            </button>
          );
        })}
      </div>
      {items.length > 0 && <div className="menu-kbd-foot" aria-hidden="true"><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> mention</span><span><kbd>esc</kbd> dismiss</span></div>}
    </div>
  );
}

const mentionCache = new Map();

export function Composer({ session, onSubmit, autoFocus, placeholder, initialText = '', onCancel, compact, footer }) {
  // History editors are ephemeral; the main composer survives remounts/settings/navigation.
  const draftKey = session?.id ?? 'new';
  const savedDraft = useStore(s => s.composerDrafts[draftKey]);
  const draftTarget = useStore(s => s.draft);
  const [editor, setEditor] = useState(() => createComposerDraft(initialText));
  const editorRef = useRef(editor);
  const changeEditor = transform => {
    const next = transform(editorRef.current);
    editorRef.current = next;
    setEditor(next);
    return next;
  };
  const currentDraft = onCancel ? editor : savedDraft;
  const text = currentDraft?.text ?? '';
  const attachments = currentDraft?.attachments ?? [];
  const setText = update => onCancel ? changeEditor(draft => updateComposerDraft(draft, 'text', update)) : setComposerDraft(draftKey, 'text', update);
  const setAttachments = (update, token) => onCancel ? changeEditor(draft => updateComposerDraft(draft, 'attachments', update, token)) : setComposerDraft(draftKey, 'attachments', update, token);
  const [dragging, setDragging] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [pi, setPi] = useState([]);
  const [caretPos, setCaretPos] = useState(null);
  const [dismissedMention, setDismissedMention] = useState(null);
  const [mentionFiles, setMentionFiles] = useState([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const ref = useRef(null);
  const fileInput = useRef(null);
  const streaming = session?.streaming;
  const size = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus, session?.id]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const sizer = createComposerSizer(el);
    size.current = sizer;
    sizer.update();
    const observer = new ResizeObserver(() => sizer.update());
    observer.observe(el);
    return () => { observer.disconnect(); sizer.destroy(); size.current = null; };
  }, []);
  useLayoutEffect(() => { size.current?.update(); }, [text]);
  // Slash commands: shown while the message is a single "/word" being typed.
  const activeEngine = (session ? session.engine : draftTarget?.engine) === 'claude-code' ? 'claude-code' : 'pi';
  const slashQuery = /^\/[\w:.-]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  useEffect(() => { setPi([]); }, [session?.id, activeEngine]);
  useEffect(() => { if (slashQuery !== null && session?.id) api('commands', session.id).then(setPi).catch(() => {}); }, [slashQuery !== null, session?.id]);
  const mergedCommands = useMemo(() => {
    const builtins = activeEngine === 'claude-code'
      ? BUILTIN_COMMANDS.filter(c => session && c.name !== 'goal')
      : BUILTIN_COMMANDS.filter(c => session || c.name === 'goal');
    const byName = new Map(builtins.map(c => [c.name, c]));
    for (const c of pi) byName.set(c.name, { ...byName.get(c.name), ...c });
    return [...byName.values()];
  }, [Boolean(session), activeEngine, pi]);
  const commands = slashQuery === null ? [] : mergedCommands.filter(c => c.name.toLowerCase().includes(slashQuery)).slice(0, 12);
  useEffect(() => setSlashIndex(0), [slashQuery]);
  const pickCommand = c => { setText(`/${c.name} `); ref.current?.focus(); };

  // @file mentions: workspace search on local Mac or remote SSH host.
  const targetCwd = session ? session.cwd : draftTarget?.cwd;
  const targetEnv = session ? session.environmentId : draftTarget?.environmentId;
  const rawMention = !commands.length && targetCwd ? activeMentionAt(text, caretPos ?? text.length) : null;
  const mentionKey = rawMention ? `${rawMention.start}:${rawMention.query}` : null;
  const mention = rawMention && dismissedMention !== mentionKey ? rawMention : null;
  useEffect(() => {
    if (!mention || !targetCwd) { setMentionFiles([]); setMentionLoading(false); return; }
    const cacheKey = `${session?.id ?? `${targetEnv}:${targetCwd}`}\n${mention.query.toLowerCase()}`;
    const cached = mentionCache.get(cacheKey);
    if (cached) { setMentionFiles(cached); setMentionLoading(false); return; }
    let alive = true;
    setMentionLoading(true);
    const timer = setTimeout(() => {
      const target = session?.id ?? { environmentId: targetEnv, cwd: targetCwd };
      api('searchFiles', target, mention.query).then(res => {
        if (!alive) return;
        const list = Array.isArray(res?.files) ? res.files : [];
        mentionCache.set(cacheKey, list);
        if (mentionCache.size > 120) mentionCache.delete(mentionCache.keys().next().value);
        setMentionFiles(list);
      }).catch(() => { if (alive) setMentionFiles([]); }).finally(() => { if (alive) setMentionLoading(false); });
    }, mention.query ? 45 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [mention?.query, Boolean(mention), session?.id, targetEnv, targetCwd]);
  useEffect(() => setMentionIndex(0), [mention?.query]);

  // Where the caret goes after a list edit or @mention insertion: set right after React writes the new text.
  const pendingCaret = useRef(null);
  const placeCaret = pos => { pendingCaret.current = pos; setCaretPos(pos); };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current != null) { el.selectionStart = el.selectionEnd = pendingCaret.current; pendingCaret.current = null; }
  }, [text]);

  const pickMention = item => {
    if (!mention) return;
    const inserted = item.dir ? `@${item.path}` : `@${item.path} `;
    const nextText = text.slice(0, mention.start) + inserted + text.slice(mention.end);
    const nextCaret = mention.start + inserted.length;
    setText(nextText);
    placeCaret(nextCaret);
    if (!item.dir) setDismissedMention(null);
    ref.current?.focus();
  };

  const add = async files => {
    // Capture once for the whole batch, before any read. Navigation preserves this
    // token; sending, recovering, or deleting the originating draft invalidates it.
    const token = onCancel ? draftReadToken(changeEditor(draft => updateComposerDraft(draft, 'attachments', list => list))) : captureComposerDraft(draftKey);
    for (const file of files) {
      try { const att = await attachmentFromFile(file); setAttachments(list => [...list, { ...att, key: Math.random().toString(36).slice(2) }], token); }
      catch (e) { notify(e.message, 'error'); }
    }
  };
  // Clear at once and let the backend work in the background: a slow command (e.g. /goal starting a
  // run) must not block the next message. The draft comes back if sending fails.
  const submit = async () => {
    let receipt;
    if (onCancel) {
      const taken = takeDraft(editorRef.current);
      if (taken) { receipt = taken.receipt; changeEditor(() => taken.next); }
    } else receipt = takeComposerDraft(draftKey);
    if (!receipt) return; // read and consume atomically, even before React rerenders
    try { await onSubmit(receipt.text.trim(), receipt.attachments.map(({ preview, key, ...a }) => a)); }
    catch (e) {
      notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      if (onCancel) changeEditor(draft => restoreDraft(draft, receipt));
      else restoreComposerDraft(draftKey, receipt);
    }
  };
  const canSend = !!(text.trim() || attachments.length);
  const attachmentControl = <button type="button" className="composer-plus" aria-label="Add attachment" title="Add files or images" onClick={() => fileInput.current?.click()}><Icon name="plus" size={17} /></button>;
  const stopButton = streaming && !onCancel
    ? <button type="button" className="send-button stop" onClick={() => { clearQueued(session.id); api('abort', session.id); }} aria-label="Stop" title="Stop generation"><Icon name="stop" size={16} /></button>
    : null;
  const sendButton = (!streaming || canSend || onCancel)
    ? <button type="button" className={`send-button ${canSend ? 'ready' : ''}`} disabled={!canSend} onClick={submit} aria-label="Send" title={streaming ? 'Send to interrupt (Enter)' : 'Send (Enter)'}><Icon name="arrowUp" size={15} stroke={2.4} /></button>
    : null;
  const sendControl = <div className="composer-actions">{sendButton}{stopButton}</div>;
  const showMentionMenu = !!mention && (mentionLoading || mentionFiles.length > 0);
  return (
    <div className={`composer ${footer ? 'with-toolbar' : ''} ${dragging ? 'dragging' : ''} ${attachments.length ? 'has-attachments' : ''} ${compact ? 'compact' : ''}`}
      onClick={e => { if (e.target === e.currentTarget) ref.current?.focus(); }}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}>
      {!!currentDraft?.recoveries.length && <button type="button" className="button ghost small"
        title="Restore a saved message; your current message is kept separately"
        onClick={() => onCancel ? changeEditor(recoverDraft) : recoverComposerDraft(draftKey)}>
        Recover saved message ({currentDraft.recoveries.length})
      </button>}
      {commands.length > 0 && <SlashMenu items={commands} index={slashIndex} onPick={pickCommand} />}
      {showMentionMenu && <MentionMenu items={mentionFiles} index={mentionIndex} loading={mentionLoading} onPick={pickMention} />}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map(a => (
            <div key={a.key} className={`attachment ${a.kind}`} title={a.path ?? a.name}>
              {a.kind === 'image' ? <img src={a.preview} alt={a.name} /> : <><Icon name="fileAny" size={15} /><span>{a.name}</span></>}
              <button type="button" className="attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(list => list.filter(x => x.key !== a.key))}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" onChange={e => { add([...e.target.files]); e.target.value = ''; }} />
        {!footer && attachmentControl}
        <textarea ref={ref} rows={1} value={text} placeholder={placeholder} aria-label="Message"
          onSelect={e => setCaretPos(e.currentTarget.selectionStart)}
          onChange={e => {
            const sel = e.target.selectionStart;
            setCaretPos(sel);
            setDismissedMention(null);
            const indented = autoIndent(text, e.target.value, sel);
            if (indented) { setText(indented.text); placeCaret(indented.caret); } else setText(e.target.value);
          }}
          onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); add(files); } }}
          onKeyDown={e => {
            if (commands.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % commands.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + commands.length) % commands.length); return; }
              if ((e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
                const c = commands[slashIndex];
                if (c && (e.key === 'Tab' || c.args || c.argumentHint?.startsWith('<') || text.slice(1) !== c.name)) { e.preventDefault(); pickCommand(c); return; }
              }
            }
            if (showMentionMenu && mentionFiles.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionFiles.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionFiles.length) % mentionFiles.length); return; }
              if ((e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
                const chosen = mentionFiles[mentionIndex];
                if (chosen) { e.preventDefault(); pickMention(chosen); return; }
              }
              if (e.key === 'Escape') { e.preventDefault(); setDismissedMention(mentionKey); return; }
            }
            if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); return; }
            const collapsed = e.target.selectionStart === e.target.selectionEnd && !e.nativeEvent.isComposing;
            const list = collapsed && e.key === 'Enter' && e.shiftKey ? continueList(text, e.target.selectionStart)
              : collapsed && e.key === 'Tab' && !commands.length ? nestItem(text, e.target.selectionStart, e.shiftKey ? -1 : 1) : null;
            if (list) { e.preventDefault(); setText(list.text); placeCaret(list.caret); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }} />
        {onCancel && <button type="button" className="button ghost small" onClick={onCancel}>Cancel</button>}
        {!footer && sendControl}
      </div>
      {footer && <div className="composer-toolbar">{attachmentControl}{footer}{sendControl}</div>}
    </div>
  );
}

// Faster processing where the model's provider sells it (agent/pidesk-speed.mjs), priced per reply.
const SPEED_LABELS = { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' };

const shortError = (message = '', label) => /disk .* is full/i.test(message) ? `${label}: disk full`
  : /could not connect/i.test(message) ? `Can’t reach ${label}` : `${label} unavailable`;

// Antigravity-style recessed top tray bar for New Conversation: Folder, Environment, Engine, and setup progress.
export function NewSessionTrayHead() {
  const draft = useStore(s => s.draft);
  const environments = useStore(s => s.environments);
  const prep = useStore(s => s.envStatus[draft.environmentId]);
  const ccPrep = useStore(s => s.claudeStatus[draft.environmentId]);
  const home = useStore(s => s.home);
  const [browsing, setBrowsing] = useState(false);
  const environmentId = draft.environmentId;
  const env = environments.find(e => e.id === environmentId) ?? { id: environmentId, label: 'This computer', kind: environmentId?.startsWith('ssh:') ? 'ssh' : 'local' };
  const cwd = draft.cwd;
  const isClaude = draft.engine === 'claude-code';
  const changeEnv = id => {
    setDraft({ environmentId: id, cwd: defaultFolder(getState().settings, id) });
    if (id !== 'local') api('prepareEnvironment', id);
  };
  return (
    <div className="composer-tray-head">
      <div className="composer-tray-left">
        <Trigger className="folder-trigger" width={300} placement="top-start" label="Folder" title={cwd ? shortPath(cwd, home) : 'No folder'}
          menu={close => <FolderMenu environmentId={environmentId} value={cwd} onChange={path => setDraft({ cwd: path })} close={close} onBrowse={() => setBrowsing(true)} />}>
          <Icon name={cwd ? 'folder' : 'chat'} size={13.5} /><span>{cwd ? baseName(cwd) : 'No folder'}</span><Icon name="chevronDown" size={11} className="tray-caret" />
        </Trigger>
        <Trigger className="env-trigger" title={env.label} width={330} placement="top-start" label="Environment" menu={close => <EnvironmentMenu value={environmentId} onChange={changeEnv} close={close} />}>
          <Icon name={envIcon(env)} size={13.5} /><span>{env.kind === 'local' ? 'Local' : env.label}</span><Icon name="chevronDown" size={11} className="tray-caret" />
        </Trigger>
        <Trigger width={210} placement="top-start" label="Engine" title={`Engine: ${isClaude ? 'Claude Code' : 'Pi'}`} className={`engine-trigger ${isClaude ? 'cc' : ''}`}
          menu={close => (
            <MenuSection title="Agent engine">
              <MenuItem icon="sparkle" label="Pi" checked={!isClaude} onClick={() => { setDraft({ engine: 'pi' }); close(); }} />
              <MenuItem icon="console" label="Claude Code" checked={isClaude} onClick={() => { setDraft({ engine: 'claude-code' }); close(); }} />
            </MenuSection>
          )}>
          <Icon name={isClaude ? 'console' : 'sparkle'} size={13} /><span>{isClaude ? 'Claude Code' : 'Pi'}</span><Icon name="chevronDown" size={11} className="tray-caret" />
        </Trigger>
      </div>
      {isClaude && ccPrep?.status === 'preparing' ? (
        <span className="bar-status"><Spinner size={11.5} /><span>{ccPrep.message || 'Preparing Claude Code…'}</span></span>
      ) : isClaude && ccPrep?.status === 'error' ? (
        <button type="button" className="bar-status error" title={ccPrep.message} onClick={() => api('prepareClaudeCode', environmentId)}>
          <Icon name="alert" size={13} /><span>Claude Code unavailable</span><span className="bar-retry">Retry</span>
        </button>
      ) : prep?.status === 'preparing' ? (
        <span className="bar-status"><Spinner size={11.5} /><span>{prep.message}</span></span>
      ) : prep?.status === 'error' ? (
        <button type="button" className="bar-status error" title={prep.message} onClick={() => api('prepareEnvironment', environmentId, true)}>
          <Icon name="alert" size={13} /><span>{shortError(prep.message, env.label)}</span><span className="bar-retry">Retry</span>
        </button>
      ) : null}
      {browsing && <RemoteBrowser environmentId={environmentId} start={cwd ?? undefined} onPick={path => setDraft({ cwd: path })} onClose={() => setBrowsing(false)} />}
    </div>
  );
}

// Antigravity-style inner composer toolbar: Model + Effort on the left; Ultra / Ultracode + Speed on the right.
export function ComposerBar({ session }) {
  const [branch, setBranch] = useState('');
  useEffect(() => {
    if (!session?.id) { setBranch(''); return; }
    let alive = true;
    const refresh = () => api('gitBranch', session.id).then(value => { if (alive) setBranch(value || ''); }).catch(() => {});
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, [session?.id, session?.cwd]);
  const draft = useStore(s => s.draft);
  const catalog = useStore(s => s.catalog);
  const isNew = !session;
  const engine = (isNew ? draft.engine : session.engine) === 'claude-code' ? 'claude-code' : 'pi';
  const isClaude = engine === 'claude-code';
  const environmentId = isNew ? draft.environmentId : session.environmentId;
  const availableModels = useMemo(() => modelsForEnvironment(catalog, environmentId, engine), [catalog, environmentId, engine]);
  const model = isNew ? draft.model : session.model;
  const effort = (isNew ? draft.thinkingLevel : session.thinkingLevel) ?? 'medium';
  const ccEffort = (isNew ? draft.effort : session.effort) || 'medium';
  const speed = (isNew ? draft.speed : session.speed) ?? 'standard';
  const modelInfo = catalog.find(m => m.provider === model?.provider && m.id === model?.id);
  const hasValidModel = availableModels.length > 0 || (model && (!isClaude || isModelForEngine(modelInfo ?? model, 'claude-code')));
  const modelTitle = model ? `${model.provider}/${model.id}` : undefined;

  const changeModel = m => isNew ? setDraft({ model: m }) : api('setModel', session.id, m.provider, m.id).catch(e => notify(e.message, 'error'));
  const changeEffort = l => isNew ? setDraft({ thinkingLevel: l }) : api('setThinking', session.id, l).catch(e => notify(e.message, 'error'));
  const changeCcEffort = l => isNew ? setDraft({ effort: l }) : api('setEffort', session.id, l).catch(e => notify(e.message, 'error'));
  const changeSpeed = s => isNew ? setDraft({ speed: s }) : api('setSpeed', session.id, s).catch(e => notify(e.message, 'error'));
  const ultraOn = isNew ? !!draft.ultra : !!session.ultra;
  const toggleUltra = () => isNew ? setDraft({ ultra: !ultraOn }) : api('setUltra', session.id, !ultraOn).catch(e => notify(e.message, 'error'));
  const ultracodeOn = isNew ? !!draft.ultracode : !!session.ultracode;
  const toggleUltracode = () => isNew ? setDraft({ ultracode: !ultracodeOn }) : api('setUltracode', session.id, !ultracodeOn).catch(e => notify(e.message, 'error'));
  const speeds = isClaude
    ? (modelInfo?.speeds ?? []).filter(s => s === 'standard' || s === 'fast')
    : (modelInfo?.speeds ?? []);

  return (
    <div className="composer-bar">
      <div className="composer-bar-left">
        {hasValidModel
          ? <Trigger width={320} placement="top-start" label="Model" title={modelTitle} className="model-trigger" menu={close => <ModelMenu value={model} environmentId={environmentId} engine={engine} onChange={changeModel} close={close} />}>
              <span className="strong">{modelLabel(model, catalog)}</span>{!isClaude && modelInfo?.reasoning === false && <Icon name="chevronDown" size={11} />}
            </Trigger>
          : <button type="button" className="trigger attention" onClick={() => openSettings(true, 'providers')}><Icon name="key" size={14} /><span>{isClaude ? 'Add Anthropic model' : 'Add a model'}</span></button>}
        {isClaude
          ? (hasValidModel && <EffortTrigger levels={CLAUDE_EFFORTS.map(level => ({ value: level, label: effortLabel(level) }))} value={ccEffort} onChange={changeCcEffort} title={`Reasoning effort: ${effortLabel(ccEffort)}`} />)
          : (modelInfo?.reasoning !== false && <EffortTrigger levels={effortsFor(modelInfo).map(level => ({ value: level, label: effortLabel(level) }))} value={effort} onChange={changeEffort} title={`Reasoning effort: ${effortLabel(effort)}`} />)}
        {!isNew && branch && <button type="button" className="trigger workspace-chip" onClick={() => setStore({ gitReviewOpen: true, filePaneOpen: false })} title="Review repository changes"><Icon name="branch" size={12.5} /><span>{branch}</span></button>}
      </div>
      <div className="composer-bar-right">
        {isClaude ? (
          <button type="button" className={`trigger ultracode-trigger ${ultracodeOn ? 'on' : ''}`} aria-label="Ultracode" aria-pressed={ultracodeOn} onClick={toggleUltracode}
            title={ultracodeOn ? 'Ultracode is on: Claude Code coordinates multi-agent workflows where supported' : 'Ultracode: enable Claude Code’s native multi-agent mode'}>
            <Icon name="layers" size={13.5} /><span>Ultracode</span>
          </button>
        ) : (
          <button type="button" className={`trigger ultra-trigger ${ultraOn ? 'on' : ''}`} aria-label="Ultra mode" aria-pressed={ultraOn} onClick={toggleUltra}
            title={ultraOn ? 'Ultra is on: Pi works on each request on its own until it is done' : 'Ultra mode: keep working autonomously until the task is done'}>
            <Icon name={ultraOn ? 'shield' : 'infinity'} size={13.5} /><span>Ultra</span>
          </button>
        )}
        {speeds.length > 1 && <SpeedTrigger speeds={speeds.map(value => ({ value, label: SPEED_LABELS[value] }))} value={effectiveSpeed(speed, speeds)} onChange={changeSpeed} />}
      </div>
    </div>
  );
}
