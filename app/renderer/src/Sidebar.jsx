import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, Popover, Spinner, useResizable } from './ui.jsx';
import { api, askConfirm, deleteSession, forkSession, goBack, goForward, newSession, notify, openSession, openSettings, toggleSidebar, useStore } from './store.js';

export function SessionMenuItems({ session, close, onRename }) {
  const active = useStore(s => s.activeId === session.id);
  const failed = e => notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  return <>
    <MenuItem icon="edit" label="Rename" onClick={() => { close(); onRename(); }} />
    <MenuItem icon="fork" label="Fork" onClick={() => { close(); forkSession(session.id).catch(failed); }} />
    <MenuItem icon="archive" label="Archive" onClick={() => { close(); api('archive', session.id); if (active) newSession(); }} />
    <MenuItem icon="trash" label="Delete" className="danger" onClick={() => { close(); askConfirm({ title: 'Delete conversation?', message: session.title, action: 'Delete', run: () => deleteSession(session.id).catch(failed) }); }} />
  </>;
}

// A menu opened at the pointer (right-click).
const pointAnchor = (x, y) => ({ current: { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false } });

function SessionRow({ session, active }) {
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [pointMenu, setPointMenu] = useState(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const rename = () => { setTitle(session.title); setEditing(true); };
  const asking = useStore(s => s.questions[session.id]?.length ?? 0);
  const indicator = asking ? <span className="row-dot attention" title="Pi is waiting for your answer" />
    : session.status === 'reconnecting' ? <span className="row-dot reconnecting" title="Reconnecting…" />
    : session.streaming ? <Spinner size={11} />
    : session.status === 'error' || session.status === 'disconnected' ? <span className="row-dot error" title={session.statusMessage ?? 'Disconnected'} /> : null;
  return (
    <div className={`session-row ${active ? 'active' : ''} ${menu || pointMenu ? 'menu-open' : ''}`} onContextMenu={e => { e.preventDefault(); setMenu(false); setPointMenu(pointAnchor(e.clientX, e.clientY)); }}>
      {editing
        ? <input className="rename-input" autoFocus value={title} onChange={e => setTitle(e.target.value)}
            onBlur={() => { setEditing(false); if (title.trim() && title !== session.title) api('rename', session.id, title.trim()); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(session.title); setEditing(false); } }} />
        : <button className="session-row-main" onClick={() => openSession(session.id)} onDoubleClick={() => { setTitle(session.title); setEditing(true); }} title={session.title}>
            <span className="session-title">{session.title}</span>
            {indicator && <span className="session-indicator">{indicator}</span>}
          </button>}
      <button ref={anchor} className="row-more" onClick={() => setMenu(m => !m)} aria-label="Session actions"><Icon name="more" size={16} /></button>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={200} placement="bottom-end">
        <SessionMenuItems session={session} close={() => setMenu(false)} onRename={rename} />
      </Popover>
      {pointMenu && <Popover anchor={pointMenu} open onClose={() => setPointMenu(null)} width={200} placement="bottom-start">
        <SessionMenuItems session={session} close={() => setPointMenu(null)} onRename={rename} />
      </Popover>}
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
  const update = useStore(s => s.update);
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
  const [sidebarWidth, sidebarHandle] = useResizable('sidebar', 284, 220, 480, 'right');
  return (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      {sidebarHandle}
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
        {update?.state === 'downloading' && <div className="update-button downloading" role="progressbar" aria-valuenow={Math.round((update.progress ?? 0) * 100)} title={`Downloading ${update.version}`}>
          <span className="update-fill" style={{ width: `${Math.max(4, Math.round((update.progress ?? 0) * 100))}%` }} />
          <span className="update-label">{Math.round((update.progress ?? 0) * 100)}%</span>
        </div>}
        {update?.state === 'ready' && <button className="update-button" onClick={() => api('installUpdate')} title={`Restart to update to ${update.version}`}><Icon name="download" size={14} /> Update</button>}
      </div>
    </aside>
  );
}
