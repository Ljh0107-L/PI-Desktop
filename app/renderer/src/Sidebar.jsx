import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, Popover, Spinner, useResizable } from './ui.jsx';
import { groupSessions } from './session-groups.js';
import { setAppearance } from './store.js';
import { api, askConfirm, deleteSession, forkSession, goBack, goForward, newSession, notify, openPalette, openSession, openSettings, toggleSidebar, useStore, warmSession } from './store.js';

export function SessionMenuItems({ session, close, onRename }) {
  const active = useStore(s => s.activeId === session.id);
  const failed = e => notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  return <>
    <MenuItem icon="edit" label="Rename" onClick={() => { close(); onRename(); }} />
    <MenuItem icon="fork" label="Fork" disabled={session.engine === 'cursor'} title={session.engine === 'cursor' ? 'Cursor conversations are read-only' : undefined} onClick={() => { close(); forkSession(session.id).catch(failed); }} />
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
        : <button className="session-row-main" onClick={() => openSession(session.id)} onMouseEnter={() => warmSession(session.id)} onDoubleClick={() => { setTitle(session.title); setEditing(true); }} title={session.title}>
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
      <button className="group-head" onClick={() => setOpen(o => !o)} aria-expanded={open} title={group.noFolder ? 'Conversations without a project folder' : group.cwd}>
        <Icon name={group.noFolder ? 'chat' : open ? 'folderOpen' : 'folder'} size={14} className="project-icon" />
        <span className="group-name">{group.project}</span>
        {group.remote && <span className="group-env" title={group.env}>{group.env}</span>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={12} className="group-caret" />
      </button>
      {open && <div className="group-items">{group.items.map(s => <SessionRow key={s.id} session={s} active={view === 'session' && activeId === s.id} />)}</div>}
    </section>
  );
}

export function Sidebar() {
  // The project-first layout replaces the experimental flat-list preference.
  const [grouped, setGrouped] = useState(() => { try { return localStorage.getItem('pidesk.sidebar.view') !== 'recents'; } catch { return true; } });
  const changeView = projects => {
    setGrouped(projects);
    try { localStorage.setItem('pidesk.sidebar.view', projects ? 'projects' : 'recents'); } catch {}
  };
  const appearance = useStore(s => s.appearance);
  const update = useStore(s => s.update);
  const sessions = useStore(s => s.sessions);
  const activeId = useStore(s => s.activeId);
  const view = useStore(s => s.view);
  const canBack = useStore(s => s.history.length > 0);
  const canForward = useStore(s => s.future.length > 0);
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const [sidebarWidth, sidebarHandle] = useResizable('sidebar', 252, 216, 380, 'right');
  return (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      {sidebarHandle}
      <div className="sidebar-top drag">
        <div className="window-tools">
          <button className="tool-button" onClick={toggleSidebar} aria-label="Hide sidebar" title="Hide sidebar (⌘\)"><Icon name="sidebarToggle" size={16} /></button>
          <button className="tool-button" onClick={goBack} disabled={!canBack} aria-label="Back" title="Back"><Icon name="back" size={16} /></button>
          <button className="tool-button" onClick={goForward} disabled={!canForward} aria-label="Forward" title="Forward"><Icon name="forward" size={16} /></button>
          <button className="tool-button" onClick={() => openPalette(true)} aria-label="Search" title="Search (⌘K)"><Icon name="search" size={15} /></button>
        </div>
      </div>
      <nav className="sidebar-nav">
        <button className={`nav-item new ${view === 'new' ? 'active' : ''}`} onClick={newSession} aria-label="New" title="New Conversation (⌘N)">
          <Icon name="plus" size={15} /><span>New Conversation</span><span className="nav-shortcut">⌘N</span>
        </button>
      </nav>
      <div className="sidebar-section-head" role="group" aria-label="Conversation organization">
        <span className="sidebar-section-label">{grouped ? 'Projects' : 'Recents'}</span>
        <div className="sidebar-section-tools">
          <button className="sidebar-icon-btn" aria-label="Group conversations by project" title="Group by project" aria-pressed={grouped} onClick={() => changeView(true)}><Icon name="folder" size={13} /></button>
          <button className="sidebar-icon-btn" aria-label="Show recent conversations" title="Recent conversations" aria-pressed={!grouped} onClick={() => changeView(false)}><Icon name="clock" size={13} /></button>
          <button className="sidebar-icon-btn" aria-label="Projects" title="Browse projects" onClick={() => openPalette(true, 'Projects')}><Icon name="listTree" size={13} /></button>
        </div>
      </div>
      <div className="sidebar-sessions">
        {grouped ? groups.map(group => <Group key={group.key} group={group} activeId={activeId} view={view} />) : sessions.map(session => <SessionRow key={session.id} session={session} active={view === 'session' && activeId === session.id} />)}
      </div>
      <div className="sidebar-foot">
        <button className="nav-item settings-button" onClick={() => openSettings(true)} aria-label="Settings" title="Settings (⌘,)"><Icon name="settings" size={15} /><span>Settings</span></button>
        <button className="tool-button appearance-toggle" onClick={() => setAppearance(appearance === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} theme`} title={`${appearance === 'dark' ? 'Light' : 'Dark'} appearance`}><Icon name={appearance === 'dark' ? 'sun' : 'moon'} size={15} /></button>
        {update?.state === 'downloading' && <div className="update-button downloading" role="progressbar" aria-valuenow={Math.round((update.progress ?? 0) * 100)} title={`Downloading ${update.version}`}>
          <span className="update-fill" style={{ width: `${Math.max(4, Math.round((update.progress ?? 0) * 100))}%` }} />
          <span className="update-label">{Math.round((update.progress ?? 0) * 100)}%</span>
        </div>}
        {update?.state === 'ready' && <button className="update-button" onClick={() => api('installUpdate')} title={`Restart to update to ${update.version}`}><Icon name="download" size={13} /> Update</button>}
      </div>
    </aside>
  );
}
