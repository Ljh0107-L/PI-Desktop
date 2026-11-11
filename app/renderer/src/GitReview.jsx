import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Spinner, useResizable } from './ui.jsx';
import { api, askConfirm, notify, openFile, set as setStore, setComposerDraft, useStore } from './store.js';
import { gitDiffLines, reviewComment } from './git-diff.js';

const GROUPS = { conflicts: 'Conflicts', staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' };
const keyOf = file => file ? `${file.group}\n${file.path}` : null;
const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function GitReview({ session }) {
  const [width, handle] = useResizable('git-review', 760, 460, 1400, 'left');
  const [snapshot, setSnapshot] = useState(null), [selected, setSelected] = useState(null);
  const [file, setFile] = useState(null), [error, setError] = useState(null), [diffError, setDiffError] = useState(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [diffLoading, setDiffLoading] = useState(false);
  const [line, setLine] = useState(null), [comment, setComment] = useState(''), [message, setMessage] = useState('');
  const [wrap, setWrap] = useState(true);
  const [showMetadata, setShowMetadata] = useState(false);
  const alive = useRef(true), seq = useRef(0), mutation = useRef(false);
  const toolsDone = useStore(s => Object.values(s.transcripts[session.id]?.tools ?? {}).filter(t => t.status !== 'running').length);
  const adopt = useCallback(next => {
    setSnapshot(next);
    setSelected(current => next.files?.some(f => keyOf(f) === current) ? current : keyOf(next.files?.[0]));
  }, []);
  const refresh = useCallback(async () => {
    if (mutation.current) return;
    const version = ++seq.current;
    setLoading(true);
    try {
      const next = await api('gitReview', session.id, { action: 'status' });
      if (alive.current && seq.current === version) { adopt(next); setError(null); }
    } catch (e) { if (alive.current && seq.current === version) setError(cleanError(e)); }
    finally { if (alive.current && seq.current === version) setLoading(false); }
  }, [session.id, adopt]);
  useEffect(() => {
    alive.current = true; refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { alive.current = false; ++seq.current; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => { const timer = setTimeout(refresh, 250); return () => clearTimeout(timer); }, [toolsDone, refresh]);
  useEffect(() => {
    const target = snapshot?.files?.find(f => keyOf(f) === selected);
    if (!target) { setFile(null); setDiffError(null); setDiffLoading(false); return; }
    let cancelled = false;
    setDiffLoading(true); setDiffError(null);
    setFile(previous => keyOf(previous) === selected ? previous : null);
    api('gitReview', session.id, { action: 'diff', path: target.path, group: target.group }).then(next => {
      if (!cancelled) setFile(previous => previous?.token === next.token ? previous : next);
    }, e => { if (!cancelled) { setDiffError(cleanError(e)); setFile(null); } }).finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [snapshot, selected, session.id]);
  useEffect(() => { setLine(null); }, [file?.token, selected]);
  const lines = useMemo(() => gitDiffLines(file?.patch), [file?.patch]);
  const counts = useMemo(() => ({ added: lines.filter(l => l.type === 'add').length, removed: lines.filter(l => l.type === 'del').length }), [lines]);
  const run = async request => {
    if (mutation.current) return;
    mutation.current = true; ++seq.current; setBusy(true); setError(null);
    try {
      const next = await api('gitReview', session.id, request);
      if (alive.current) { adopt(next); setFile(null); if (request.action === 'commit') setMessage(''); }
      if (request.action === 'commit') notify('Staged changes committed');
    } catch (e) { if (alive.current) setError(cleanError(e)); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); setLoading(false); } }
  };
  const act = action => {
    const request = { action, path: file.path, group: file.group, token: file.token };
    if (action === 'discard') askConfirm({ title: file.group === 'untracked' ? 'Delete untracked file?' : 'Discard unstaged changes?',
      message: `${file.path}\n${file.group === 'untracked' ? 'This deletes the untracked file.' : 'This restores the file from the index. Staged changes are kept.'}`, action: 'Discard', run: () => run(request) });
    else run(request);
  };
  const selectedFile = keyOf(file) === selected ? file : null;
  const editable = selectedFile && !file.submodule && file.group !== 'conflicts' && !busy && !diffLoading && !error;
  const staged = snapshot?.files?.filter(f => f.group === 'staged') ?? [];
  const addComment = () => {
    const text = reviewComment(file, line, comment);
    setComposerDraft(session.id, 'text', previous => `${previous}${previous ? '\n\n' : ''}${text}`);
    setComment(''); setLine(null); notify('Review feedback added to your message');
  };
  return <aside className={`git-review ${wrap ? 'wrap' : ''}`} style={{ width }} aria-label="Git review">
    {handle}
    <div className="git-review-head"><Icon name="fileDiff" size={18} /><strong title="All repository changes, including edits outside this conversation">Git review</strong>
      <span className="git-branch" title={snapshot?.root}><Icon name="branch" size={14} />{snapshot?.branch}</span>
      <button className="tool-button" onClick={() => setShowMetadata(x => !x)} aria-label="Show diff metadata" title="Diff metadata" aria-pressed={showMetadata}><Icon name="fileText" size={16} /></button>
      <button className="tool-button" onClick={() => setWrap(x => !x)} aria-label="Wrap diff lines" aria-pressed={wrap}><Icon name="code" size={16} /></button>
      <button className="tool-button" onClick={refresh} disabled={busy || loading} aria-label="Refresh Git review">{loading ? <Spinner size={14} /> : <Icon name="refresh" size={16} />}</button>
      <button className="tool-button" onClick={() => setStore({ gitReviewOpen: false })} aria-label="Close Git review"><Icon name="x" size={16} /></button>
    </div>
    {error && <div className="git-review-error" role="alert">{error}<button className="button small" onClick={refresh} disabled={busy}>Refresh</button></div>}
    {!snapshot && !error && <div className="fp-empty"><Spinner /> Reading repository…</div>}
    {snapshot?.available === false && <div className="fp-empty">This session folder is not in a Git repository.</div>}
    {snapshot?.available && <>
      {snapshot.files.length > 0 ? <div className="git-review-body">
        <nav className="git-file-list" aria-label="Changed files">
          {Object.entries(GROUPS).map(([group, label]) => {
            const files = snapshot.files.filter(f => f.group === group);
            if (!files.length) return null;
            return <section key={group}><h3>{label}<span>{files.length}</span></h3>{files.map(f => <button key={keyOf(f)}
              disabled={busy} className={`git-file ${selected === keyOf(f) ? 'selected' : ''}`} aria-pressed={selected === keyOf(f)}
              onClick={() => setSelected(keyOf(f))} title={f.originalPath ? `${f.originalPath} → ${f.path}` : f.path}>
              <span className="git-file-status">{f.status.trim()}</span><span>{f.path}</span></button>)}</section>;
          })}
        </nav>
        <div className="git-diff-pane">
          {diffError && <div className="git-review-error" role="alert">{diffError}</div>}
          {!selectedFile && !diffError && <div className="fp-empty">{diffLoading ? <Spinner /> : 'Select a changed file to review'}</div>}
          {selectedFile && <>
            <div className="git-file-head"><span title={file.path}>{file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}</span>
              {!file.binary && <small><span className="plus">+{counts.added}</span> <span className="minus">−{counts.removed}</span></small>}
              <button className="tool-button" onClick={() => openFile(session.id, `${file.root}/${file.path}`)} aria-label="Open reviewed file"><Icon name="externalLink" size={15} /></button>
            </div>
            <div className="git-file-actions">
              {file.group === 'staged' ? <button className="button small" disabled={!editable} onClick={() => act('unstage')}>Unstage file</button>
                : file.group !== 'conflicts' && <><button className="button small" disabled={!editable} onClick={() => act('stage')}>Stage file</button><button className="button small ghost" disabled={!editable} onClick={() => act('discard')}>Discard file</button></>}
              {diffLoading && <Spinner size={12} />}
              {(file.submodule || file.group === 'conflicts') && <span className="muted">Resolve in terminal</span>}
            </div>
            <div className="git-diff-lines">
              {file.binary && <div className="git-binary">Binary file changed · text preview unavailable</div>}
              {lines.slice(0, 2000).map((row, index) => row.type === 'meta' && !showMetadata && /^(diff --git |index |--- |\+\+\+ )/.test(row.text) ? null : row.type === 'hunk' || row.type === 'meta'
                ? <div key={index} className={`git-diff-meta ${row.type}`}>{row.text}</div>
                : <button key={index} className={`git-diff-line ${row.type} ${line === row ? 'selected' : ''}`} disabled={busy || diffLoading}
                  aria-label={`Comment on ${row.newLine != null ? 'new' : 'old'} line ${row.newLine ?? row.oldLine}`} onClick={() => setLine(row)}>
                  <span className="git-line-number">{row.oldLine}</span><span className="git-line-number">{row.newLine}</span>
                  <span className="git-line-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span><span className="git-line-text">{row.text || ' '}</span>
                </button>)}
              {lines.length > 2000 && <div className="git-binary">Showing the first 2,000 diff lines. Review the full diff in the terminal.</div>}
              {!file.patch && <div className="fp-empty">No text diff (empty file or metadata-only change)</div>}
            </div>
            {line && <div className="git-comment"><label>Feedback on {line.newLine != null ? 'new' : 'old'} line {line.newLine ?? line.oldLine}
              <textarea aria-label="Review feedback" value={comment} onChange={e => setComment(e.target.value)} placeholder="Describe the change you want…" /></label>
              <button className="button small" disabled={!comment.trim() || busy} onClick={addComment}>Add to message</button>
              <button className="button small ghost" onClick={() => setLine(null)}>Cancel</button></div>}
          </>}
        </div>
      </div> : <div className="git-clean"><Icon name="check" size={22} /><span>Working tree clean</span></div>}
      {staged.length > 0 && <form className="git-commit" onSubmit={e => { e.preventDefault(); if (message.trim() && staged.length && !busy && !error) run({ action: 'commit', message, token: snapshot.commitToken }); }}>
        <input aria-label="Commit message" placeholder="Commit message" value={message} onChange={e => setMessage(e.target.value)} disabled={busy} />
        <button className="button small" disabled={!message.trim() || !staged.length || busy || loading || !!error || snapshot.files.some(f => f.group === 'conflicts')} type="submit">{busy ? <Spinner size={13} /> : `Commit staged (${staged.length})`}</button>
      </form>}
    </>}
  </aside>;
}
