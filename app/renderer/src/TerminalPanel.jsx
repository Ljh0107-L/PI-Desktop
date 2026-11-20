// A terminal docked under the conversation, in the session's folder on the session's machine.
// Each session keeps its terminal (and scrollback) while the app runs; hiding the panel keeps it alive.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icons.jsx';
import { api, set as setStore, useStore } from './store.js';

const terms = new Map(); // session id -> { term, fit, el, termId, exited }
const byTermId = new Map();

window.pidesk.subscribe(({ channel, payload }) => {
  if (channel === 'term-data') byTermId.get(payload.id)?.term.write(payload.data);
  if (channel === 'term-exit') {
    const entry = byTermId.get(payload.id);
    if (entry) {
      entry.exited = true;
      if (entry.onExit) entry.onExit(payload.exitCode);
      else entry.term.write('\r\n\x1b[2m[process exited — press Enter to restart]\x1b[0m\r\n');
    }
  }
});

async function start(sessionId, entry) {
  entry.exited = false;
  entry.termId = await api('termOpen', sessionId, entry.term.cols, entry.term.rows);
  byTermId.set(entry.termId, entry);
}

function makeTerminal() {
  const term = new Terminal({
    fontFamily: 'SF Mono, ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true,
    theme: { background: '#161616', foreground: '#e6e4df', cursor: '#e8714e', selectionBackground: 'rgba(232,113,78,.3)', black: '#1e1e1e', brightBlack: '#6b6b6b' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function terminalFor(sessionId) {
  let entry = terms.get(sessionId);
  if (entry) return entry;
  const { term, fit } = makeTerminal();
  const el = document.createElement('div');
  el.className = 'terminal-host';
  entry = { term, fit, el, termId: null, exited: false, opened: false };
  terms.set(sessionId, entry);
  term.onData(data => {
    if (entry.exited) { if (data === '\r') { term.reset(); start(sessionId, entry); } return; }
    if (entry.termId) api('termWrite', entry.termId, data);
  });
  term.onResize(({ cols, rows }) => { if (entry.termId) api('termResize', entry.termId, cols, rows); });
  return entry;
}

export function closeTerminal(sessionId) {
  const entry = terms.get(sessionId);
  if (!entry) return;
  if (entry.termId) api('termClose', entry.termId);
  entry.term.dispose();
  terms.delete(sessionId);
}

// Short-lived CLI process inside Settings. Keep Google device codes and quota
// output in the terminal only, not in the session transcript or notifications.
export function AntigravityTerminal({ environmentId, action, onExit }) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let disposed = false, id;
    const { term, fit } = makeTerminal();
    term.open(host.current);
    const refit = () => { try { fit.fit(); } catch { /* hidden */ } };
    refit();
    term.focus();
    term.onData(data => { if (id) api('termWrite', id, data).catch(() => {}); });
    term.onResize(({ cols, rows }) => { if (id) api('termResize', id, cols, rows).catch(() => {}); });
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    api('termOpenAntigravity', environmentId, action, term.cols, term.rows).then(termId => {
      if (disposed) { api('termClose', termId).catch(() => {}); return; }
      id = termId;
      byTermId.set(id, { term, onExit: code => {
        term.write(`\r\n\x1b[2m[Antigravity exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
        onExit?.(code);
      } });
      return api('termReady', id);
    }).catch(err => { if (!disposed) setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
    return () => {
      disposed = true;
      observer.disconnect();
      if (id) { byTermId.delete(id); api('termClose', id).catch(() => {}); }
      term.dispose();
    };
  }, [environmentId, action, onExit]);
  return <>{error && <p className="agy-settings-error" role="alert">{error}</p>}<div className="agy-settings-terminal" ref={host} /></>;
}

export function TerminalPanel({ session }) {
  const host = useRef(null);
  const height = useStore(s => s.terminalHeight ?? 280);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const entry = terminalFor(session.id);
    host.current.appendChild(entry.el);
    if (!entry.opened) { entry.term.open(entry.el); entry.opened = true; }
    const refit = () => { try { entry.fit.fit(); } catch { /* hidden */ } };
    refit();
    if (!entry.termId) start(session.id, entry);
    entry.term.focus();
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    return () => { observer.disconnect(); entry.el.remove(); };
  }, [session.id]);
  const onDrag = e => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY, startH = height;
    const move = ev => setStore({ terminalHeight: Math.max(120, Math.min(window.innerHeight - 220, startH + startY - ev.clientY)) });
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className={`terminal-panel ${dragging ? 'dragging' : ''}`} style={{ height }}>
      <div className="terminal-grip" onMouseDown={onDrag} />
      <div className="terminal-bar">
        <Icon name="terminalPanel" size={14} /><span>{session.environmentLabel}</span>
        <span className="spacer" />
        <button className="tool-button" aria-label="Close terminal" title="Close terminal" onClick={() => setStore({ terminalOpen: false })}><Icon name="x" size={14} /></button>
      </div>
      <div className="terminal-body" ref={host} />
    </div>
  );
}
