// Claude-style file preview: tabs of open files, a rendered/source preview, and the session folder's tree.
import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { Icon } from './Icons.jsx';
import { MenuItem, Markdown, Popover, Spinner, useResizable } from './ui.jsx';
import { changeStats, hunkLines } from './diffs.js';
import { api, closeFile, notify, openFile, set as setStore, setFilePaneOpen, useStore } from './store.js';

const LANGS = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', zsh: 'bash', bash: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', json: 'json', rs: 'rust', go: 'go', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cu: 'cpp',
  java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', sql: 'sql',
  lua: 'lua', r: 'r', pl: 'perl', diff: 'diff', patch: 'diff', makefile: 'makefile', mk: 'makefile', md: 'markdown', graphql: 'graphql' };
const extOf = path => { const name = path.split('/').pop().toLowerCase(); return name === 'makefile' ? 'makefile' : name.includes('.') ? name.split('.').pop() : ''; };
const iconFor = name => {
  const ext = extOf(name);
  if (['md', 'txt', 'rst'].includes(ext)) return 'fileText';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'fileImage';
  if (LANGS[ext]) return 'fileCode';
  return 'fileAny';
};
const sizeLabel = n => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const joinRel = (dir, name) => dir ? `${dir}/${name}` : name;

// Folder listings per session, so expanding the tree twice doesn't refetch.
const listings = new Map();
function useListing(sessionId, rel, open, version) {
  const key = `${sessionId}\n${rel}`;
  const [state, setState] = useState(() => listings.get(key) ?? null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api('listFiles', sessionId, rel).then(r => { listings.set(key, r); if (alive) setState(r); }, e => { if (alive) setState({ error: e.message }); });
    return () => { alive = false; };
  }, [key, open, version]);
  return state;
}

function TreeDir({ sessionId, rel, depth, active, version }) {
  const listing = useListing(sessionId, rel, true, version);
  const [expanded, setExpanded] = useState({});
  if (!listing) return <div className="fp-tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}><Spinner size={11} /></div>;
  if (listing.error) return <div className="fp-tree-row error" style={{ paddingLeft: 12 + depth * 14 }}>{listing.error}</div>;
  return listing.entries.map(entry => {
    const path = joinRel(rel, entry.name);
    if (entry.dir) {
      const open = expanded[entry.name] ?? !!active?.startsWith(path + '/'); // reveal the open file
      return (
        <div key={path}>
          <button className="fp-tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setExpanded(x => ({ ...x, [entry.name]: !open }))}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="fp-caret" /><span className="fp-name">{entry.name}</span>
          </button>
          {open && <TreeDir sessionId={sessionId} rel={path} depth={depth + 1} active={active} version={version} />}
        </div>
      );
    }
    return (
      <button key={path} className={`fp-tree-row file ${active === path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 18 }} onClick={() => openFile(sessionId, path)} title={path}>
        <Icon name={iconFor(entry.name)} size={15} className="fp-file-icon" /><span className="fp-name">{entry.name}</span>
      </button>
    );
  });
}

function CodeView({ text, ext }) {
  const html = useMemo(() => {
    const lang = LANGS[ext];
    try { return lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(text.slice(0, 200000)).value; }
    catch { return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  }, [text, ext]);
  const lines = text.split('\n').length;
  return (
    <div className="fp-code">
      <pre className="fp-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</pre>
      <pre className="fp-source"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

function Preview({ sessionId, path, refreshKey }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(false);
  const scroller = useRef(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api('readFile', sessionId, path).then(f => { if (alive) setFile(f); }, e => { if (alive) { setFile(null); setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } });
    return () => { alive = false; };
  }, [sessionId, path, refreshKey]);
  useEffect(() => { setSource(false); scroller.current?.scrollTo(0, 0); }, [path]);
  const ext = extOf(path);
  const parts = path.split('/');
  const crumbs = parts.length > 4 ? [parts[0], '…', ...parts.slice(-3)] : parts;
  return (
    <div className="fp-preview">
      <div className="fp-crumbs">
        <span className="fp-crumb-path">{crumbs.map((c, i) => <span key={i} className={i === crumbs.length - 1 ? 'last' : ''}>{c}</span>)}</span>
        {file?.kind === 'text' && ext === 'md' && <button className={`tool-button ${source ? 'on' : ''}`} onClick={() => setSource(s => !s)} title={source ? 'Show preview' : 'Show source'} aria-label="Toggle source"><Icon name="code" size={16} /></button>}
      </div>
      <div className="fp-content" ref={scroller}>
        {error && <div className="fp-empty error"><Icon name="alert" size={15} /> {error}</div>}
        {!error && !file && <div className="fp-empty"><Spinner /></div>}
        {file?.kind === 'image' && (file.dataUrl ? <div className="fp-image"><img src={file.dataUrl} alt={parts.at(-1)} /></div> : <div className="fp-empty">Image too large to preview · {sizeLabel(file.size)}</div>)}
        {file?.kind === 'binary' && <div className="fp-empty"><Icon name="fileAny" size={16} /> Binary file · {sizeLabel(file.size)}</div>}
        {file?.kind === 'text' && (ext === 'md' && !source
          ? <div className="fp-markdown"><Markdown text={file.content} /></div>
          : <CodeView text={file.content} ext={ext} />)}
        {file?.truncated && file.kind === 'text' && <div className="fp-truncated">First {sizeLabel(file.content.length)} of {sizeLabel(file.size)}</div>}
      </div>
    </div>
  );
}

// The change review: every file one turn changed, as diffs.
function ChangesView({ sessionId, changes }) {
  return (
    <div className="fp-preview">
      <div className="fp-content changes">
        {changes.map(change => {
          const { added, removed } = changeStats(change);
          return (
            <section key={change.path} className="change-file">
              <button className="change-head" onClick={() => openFile(sessionId, change.path)} title="Open file">
                <Icon name={iconFor(change.path)} size={15} /><span className="change-path">{change.path}</span>
                <span className="plus">+{added}</span><span className="minus">−{removed}</span>
              </button>
              <div className="change-body">
                {change.hunks.map((h, i) => (
                  <div key={i} className="change-hunk">
                    {hunkLines(h).map((l, j) => l.type === 'gap'
                      ? <div key={j} className="diff-gap">⋯</div>
                      : <div key={j} className={`diff-row ${l.type}`}><span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span><span className="diff-text">{l.text || ' '}</span></div>)}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function FilePane({ session }) {
  const state = useStore(s => s.files[session.id]) ?? { tabs: [], active: null };
  const maximized = useStore(s => s.filePaneMax);
  const [tree, setTree] = useState(true);
  // The pane and its file tree are both draggable (double-click a handle to reset).
  const [paneWidth, paneHandle] = useResizable('file-pane', 760, 420, 1400, 'left');
  const [treeWidth, treeHandle] = useResizable('file-tree', 280, 180, 520, 'left');
  const [menu, setMenu] = useState(false);
  const [version, setVersion] = useState(0);
  const menuRef = useRef(null);
  // Re-read the open file and the tree whenever Pi finishes a tool call (it may have changed files).
  const toolsDone = useStore(s => Object.values(s.transcripts[session.id]?.tools ?? {}).filter(t => t.status !== 'running').length);
  const refresh = toolsDone + version;
  const local = session.environmentId === 'local';
  const absolute = path => path.startsWith('/') ? path : `${session.cwd.replace(/\/$/, '')}/${path}`;
  const target = state.active ? absolute(state.active) : session.cwd;
  return (
    <aside className={`file-pane ${state.active || state.changes ? 'has-file' : ''} ${maximized ? 'maximized' : ''}`} style={maximized ? undefined : { width: paneWidth }}>
      {!maximized && paneHandle}
      <div className="fp-bar">
        <div className="fp-tabs">
          {state.tabs.map(path => (
            <div key={path} className={`fp-tab ${path === state.active ? 'active' : ''}`} title={path}>
              <button className="fp-tab-name" onClick={() => openFile(session.id, path)}>{path.split('/').pop()}</button>
              <button className="fp-tab-close" onClick={() => closeFile(session.id, path)} aria-label="Close"><Icon name="x" size={13} /></button>
            </div>
          ))}
          {state.changes && <div className={`fp-tab ${!state.active ? 'active' : ''}`}>
            <button className="fp-tab-name" onClick={() => setStore(s => ({ files: { ...s.files, [session.id]: { ...state, active: null } } }))}>Changes</button>
            <button className="fp-tab-close" onClick={() => setStore(s => ({ files: { ...s.files, [session.id]: { ...state, changes: null } } }))} aria-label="Close"><Icon name="x" size={13} /></button>
          </div>}
          {!state.tabs.length && !state.changes && <span className="fp-title">Files</span>}
        </div>
        <div className="fp-actions">
          <button className={`tool-button ${tree ? 'on' : ''}`} onClick={() => setTree(t => !t)} title={tree ? 'Hide file tree' : 'Show file tree'} aria-label="Toggle file tree"><Icon name="listTree" size={16} /></button>
          <button ref={menuRef} className="tool-button" onClick={() => setMenu(m => !m)} title="More" aria-label="More file actions"><Icon name="more" size={16} /></button>
          <Popover anchor={menuRef} open={menu} onClose={() => setMenu(false)} width={220} placement="bottom-end">
            <MenuItem icon="refresh" label="Refresh" onClick={() => { setMenu(false); setVersion(v => v + 1); }} />
            <MenuItem icon="copy" label={state.active ? 'Copy file path' : 'Copy folder path'} onClick={() => { setMenu(false); navigator.clipboard.writeText(target); notify('Path copied'); }} />
            {local && <MenuItem icon="externalLink" label="Reveal in Finder" onClick={() => { setMenu(false); api('openPath', target); }} />}
            {state.tabs.length > 0 && <MenuItem icon="x" label="Close all tabs" onClick={() => { setMenu(false); state.tabs.forEach(t => closeFile(session.id, t)); }} />}
          </Popover>
          <button className="tool-button" onClick={() => setStore({ filePaneMax: !maximized })} title={maximized ? 'Restore' : 'Maximize'} aria-label="Maximize files"><Icon name={maximized ? 'minimize' : 'maximize'} size={15} /></button>
          <button className="tool-button" onClick={() => { setFilePaneOpen(false); setStore({ filePaneMax: false }); }} title="Close" aria-label="Close files"><Icon name="x" size={16} /></button>
        </div>
      </div>
      <div className="fp-body">
        {state.active
          ? <Preview sessionId={session.id} path={state.active} refreshKey={refresh} />
          : state.changes ? <ChangesView sessionId={session.id} changes={state.changes} />
          : <div className="fp-preview fp-placeholder"><Icon name="folder" size={26} /><span>Open files appear here</span></div>}
        {tree && (state.active || state.changes
          ? <div className="fp-tree-wrap" style={{ width: treeWidth }}>{treeHandle}<div className="fp-tree"><TreeDir sessionId={session.id} rel="" depth={0} active={state.active} version={refresh} /></div></div>
          : <div className="fp-tree"><TreeDir sessionId={session.id} rel="" depth={0} active={state.active} version={refresh} /></div>)}
      </div>
    </aside>
  );
}
