import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, Popover, Spinner } from './ui.jsx';
import { api, goBack, goForward, newSession, notify, openSession, openSettings, toggleSidebar, useStore } from './store.js';

export function SessionMenuItems({ session, close, onRename }) {
  const active = useStore(s => s.activeId === session.id);
  return <>
    <MenuItem icon="edit" label="Rename" onClick={() => { close(); onRename(); }} />
    {(session.status === 'disconnected' || session.status === 'error') && <MenuItem icon="refresh" label="Reconnect" onClick={() => { close(); api('reconnect', session.id).catch(e => notify(e.message, 'error')); }} />}
    <MenuItem icon="compact" label="Compact conversation" disabled={session.streaming} onClick={() => { close(); api('compact', session.id).catch(e => notify(/too small|nothing to compact/i.test(e.message) ? 'This conversation is too short to compact' : e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[\w-]+: compact failed: /, ''), 'error')); }} />
    <MenuItem icon="copy" label="Copy folder path" onClick={() => { close(); navigator.clipboard.writeText(session.cwd); notify('Folder path copied'); }} />
    <MenuItem icon="archive" label="Archive" onClick={() => { close(); api('archive', session.id); if (active) newSession(); }} />
  </>;
}

function SessionRow({ session, active }) {
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const asking = useStore(s => s.questions[session.id]?.length ?? 0);
  const indicator = asking ? <span className="row-dot attention" title="Pi is waiting for your answer" />
    : session.status === 'reconnecting' ? <span className="row-dot reconnecting" title="Reconnecting…" />
    : session.streaming ? <Spinner size={11} />
    : session.status === 'error' || session.status === 'disconnected' ? <span className="row-dot error" title={session.statusMessage ?? 'Disconnected'} /> : null;
  return (
    <div className={`session-row ${active ? 'active' : ''}`}>
      {editing
        ? <input className="rename-input" autoFocus value={title} onChange={e => setTitle(e.target.value)}
            onBlur={() => { setEditing(false); if (title.trim() && title !== session.title) api('rename', session.id, title.trim()); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(session.title); setEditing(false); } }} />
        : <button className="session-row-main" onClick={() => openSession(session.id)} onDoubleClick={() => { setTitle(session.title); setEditing(true); }} title={session.title}>
            <span className="session-title">{session.title}</span>
            {indicator && <span className="session-indicator">{indicator}</span>}
          </button>}
      <button ref={anchor} className="row-more" onClick={() => setMenu(m => !m)} aria-label="Session actions"><Icon name="more" size={16} /></button>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={210} placement="bottom-end">
        <SessionMenuItems session={session} close={() => setMenu(false)} onRename={() => { setTitle(session.title); setEditing(true); }} />
      </Popover>
    </div>
  );
}

function Group({ group, activeId, view }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="session-group">
      <button className="group-head" onClick={() => setOpen(o => !o)} title={group.cwd}>
        <span className="group-name">{group.project}</span>
        <span className="group-sep">·</span>
        <span className="group-env">{group.env}</span>
        <Icon name={group.remote ? 'terminal' : 'laptop'} size={16} className="group-icon" />
        <Icon name={open ? 'caretDown' : 'caretRight'} size={13} className="group-caret" />
      </button>
      {open && group.items.map(s => <SessionRow key={s.id} session={s} active={view === 'session' && activeId === s.id} />)}
    </section>
  );
}

export function Sidebar() {
  const sessions = useStore(s => s.sessions);
  const activeId = useStore(s => s.activeId);
  const view = useStore(s => s.view);
  const canBack = useStore(s => s.history.length > 0);
  const canForward = useStore(s => s.future.length > 0);
  const groups = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      const key = `${s.environmentId}|${s.cwd}`;
      if (!map.has(key)) map.set(key, { key, cwd: s.cwd, project: s.project, env: s.environmentLabel, remote: s.environmentId !== 'local', items: [] });
      map.get(key).items.push(s);
    }
    return [...map.values()];
  }, [sessions]);
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <div className="window-tools">
          <button className="tool-button" onClick={toggleSidebar} aria-label="Hide sidebar" title="Hide sidebar"><Icon name="sidebarToggle" size={19} /></button>
          <button className="tool-button" onClick={goBack} disabled={!canBack} aria-label="Back"><Icon name="back" size={19} /></button>
          <button className="tool-button" onClick={goForward} disabled={!canForward} aria-label="Forward"><Icon name="forward" size={19} /></button>
        </div>
      </div>
      <nav className="sidebar-nav">
        <button className={`nav-item new ${view === 'new' ? 'active' : ''}`} onClick={newSession} title="New session (⌘N)"><Icon name="plus" size={18} /> New</button>
      </nav>
      <div className="sidebar-sessions">
        {groups.map(group => <Group key={group.key} group={group} activeId={activeId} view={view} />)}
      </div>
      <div className="sidebar-foot">
        <button className="nav-item settings-button" onClick={() => openSettings(true)} title="Settings (⌘,)"><Icon name="settings" size={17} /> Settings</button>
      </div>
    </aside>
  );
}
