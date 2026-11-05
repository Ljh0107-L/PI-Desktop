import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Sidebar, SessionMenuItems } from './Sidebar.jsx';
import { Composer, ComposerBar } from './Composer.jsx';
import { Transcript } from './Conversation.jsx';
import { AgentReport, SubagentSummary } from './Subagents.jsx';
import { RightPanel } from './RightPanel.jsx';
import { SettingsPage } from './Settings.jsx';
import { FilePane } from './FilePane.jsx';
import { TerminalPanel } from './TerminalPanel.jsx';
import { Palette } from './Palette.jsx';
import { MenuItem, Modal, Popover, Spinner } from './ui.jsx';
import { emptyTranscript } from './transcript.js';
import { api, bootstrap, closeConfirm, set as setStore, getState, newSession, notify, openFile, openPalette, openSettings, sendPrompt, setDraft, setFilePaneOpen, startSession, toggleRightPanel, toggleSidebar, useStore } from './store.js';

// The session's goal (/goal): objective, state, and pause / resume / clear.
function GoalBanner({ session }) {
  const goal = useStore(s => s.goals[session.id]);
  if (!goal?.objective) return null;
  const label = { active: 'Working', paused: 'Paused', complete: 'Achieved', blocked: 'Blocked' }[goal.status] ?? goal.status;
  const run = arg => api('prompt', session.id, `/goal ${arg}`).catch(e => notify(e.message, 'error'));
  return (
    <div className={`goal-banner ${goal.status}`}>
      <Icon name="target" size={15} className="goal-icon" />
      <span className="goal-objective" title={goal.objective}>{goal.objective}</span>
      <span className={`goal-state ${goal.status}`}>{goal.status === 'active' && <span className="goal-pulse" />}{label}</span>
      {goal.status === 'active' && <button className="goal-action" onClick={() => run('pause')}>Pause</button>}
      {(goal.status === 'paused' || goal.status === 'blocked') && <button className="goal-action" onClick={() => run('resume')}>Resume</button>}
      <button className="goal-close" aria-label="Clear goal" title="Clear goal" onClick={() => run('clear')}><Icon name="x" size={13} /></button>
    </div>
  );
}

function ConfirmHost() {
  const confirm = useStore(s => s.confirm);
  if (!confirm) return null;
  return (
    <Modal title={confirm.title} width={400} onClose={closeConfirm} footer={<>
      <button className="button" onClick={closeConfirm}>Cancel</button>
      <button className="button danger-solid" autoFocus onClick={() => { closeConfirm(); confirm.run(); }}>{confirm.action}</button>
    </>}>{confirm.message && <div className="confirm-text">{confirm.message}</div>}</Modal>
  );
}

function NewSessionView() {
  const draft = useStore(s => s.draft);
  // Start a Pi in the chosen place ahead of time, so the first message doesn't wait for it.
  useEffect(() => {
    if (!draft.model) return;
    const t = setTimeout(() => api('prewarm', { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, thinkingLevel: draft.thinkingLevel }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [draft.environmentId, draft.cwd, draft.model?.provider, draft.model?.id]);
  return (
    <div className="new-session">
      <div className="new-session-center" />
      <div className="dock">
        <Composer autoFocus placeholder="What should Pi work on?" onSubmit={startSession} />
        <ComposerBar />
      </div>
    </div>
  );
}

function ConnectionBanner({ session }) {
  if (session.status === 'reconnecting') {
    return <div className="conn-banner"><Spinner size={13} /> <span className="conn-text">Reconnecting to <b>{session.environmentLabel}</b>… Pi keeps working on the server.</span></div>;
  }
  if (session.status === 'disconnected' || session.status === 'error') {
    return <div className="conn-banner error"><Icon name="unplug" size={15} /> <span className="conn-text">{session.statusMessage || 'Disconnected from this session.'}</span>
      <button className="button small" onClick={() => api('reconnect', session.id).catch(e => notify(e.message, 'error'))}>Reconnect</button></div>;
  }
  return null;
}

function SessionView({ session }) {
  const transcript = useStore(s => s.transcripts[session.id]) ?? emptyTranscript();
  const questions = useStore(s => s.questions[session.id]) ?? [];
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const filePaneMax = useStore(s => s.filePaneMax) && filePaneOpen;
  useEffect(() => {
    const onKey = e => { if (e.ctrlKey && e.key === '`') { e.preventDefault(); setStore(st => ({ terminalOpen: !st.terminalOpen })); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Relative links in replies (e.g. "authoring/plan.md") open in the file preview.
  useEffect(() => {
    const onOpen = e => openFile(session.id, e.detail);
    window.addEventListener('pidesk:open-file', onOpen);
    return () => window.removeEventListener('pidesk:open-file', onOpen);
  }, [session.id]);
  return (
    <div className={`session-view ${filePaneMax ? 'files-max' : ''}`}>
      <div className="session-main">
        <Transcript session={session} transcript={transcript} questions={questions}
          renderSubagents={block => <SubagentSummary key={block.key} sessionId={session.id} call={block.call} tool={transcript.tools[block.call.id]} />}
          renderAgentReport={block => <AgentReport key={block.key} sessionId={session.id} agent={block.agent} />} />
        <div className="dock">
          {session.engine === 'cursor'
            // Cursor CLI was removed: its old conversations can still be read, copied and deleted.
            ? <div className="conn-banner"><Icon name="alert" size={15} /> <span className="conn-text">Cursor CLI was removed from Pi Desktop. This conversation is read-only.</span></div>
            : <>
              <ConnectionBanner session={session} />
              <GoalBanner session={session} />
              <Composer session={session} autoFocus placeholder={questions.length ? 'Answer the agent’s question…' : session.streaming ? 'Send to interrupt…' : 'Reply to Pi…'} onSubmit={(text, attachments) => sendPrompt(session.id, text, attachments)} />
              <ComposerBar session={session} />
            </>}
        </div>
        {terminalOpen && <TerminalPanel session={session} />}
      </div>
      {filePaneOpen ? <FilePane key={session.id} session={session} /> : rightPanel && <RightPanel session={session} />}
    </div>
  );
}

function Header({ session, view }) {
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const sidebar = useStore(s => s.sidebar);
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const local = session?.environmentId === 'local';
  return (
    <header className={`main-head drag ${sidebar ? '' : 'no-sidebar'}`}>
      {!sidebar && <div className="window-tools no-drag"><button className="tool-button" onClick={toggleSidebar} aria-label="Show sidebar"><Icon name="sidebarToggle" size={19} /></button></div>}
      {view === 'session' && session && session.id !== 'pending' ? <>
        {renaming
          ? <input className="title-input no-drag" autoFocus value={title} onChange={e => setTitle(e.target.value)} onBlur={() => { setRenaming(false); if (title.trim()) api('rename', session.id, title.trim()); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} />
          : <button ref={anchor} className="title-button no-drag" onClick={() => setMenu(m => !m)}>{session.title}<Icon name="chevronDown" size={16} /></button>}
        <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={220} placement="bottom-start">
          <SessionMenuItems session={session} close={() => setMenu(false)} onRename={() => { setTitle(session.title); setRenaming(true); }} />
        </Popover>
        <div className="main-tools no-drag">
          <button className={`tool-button ${terminalOpen ? 'on' : ''}`} onClick={() => setStore({ terminalOpen: !terminalOpen })} aria-label="Terminal" title="Terminal (⌃`)"><Icon name="terminalPanel" size={18} /></button>
          <button className={`tool-button ${filePaneOpen ? 'on' : ''}`} onClick={() => setFilePaneOpen(!filePaneOpen)} aria-label="Files" title="Files"><Icon name="folder" size={18} /></button>
          <button className={`tool-button ${rightPanel && !filePaneOpen ? 'on' : ''}`} onClick={() => { if (filePaneOpen) { setFilePaneOpen(false); if (!rightPanel) toggleRightPanel(); } else toggleRightPanel(); }} aria-label="Session details" title="Session details"><Icon name="panel" size={18} /></button>
        </div>
      </> : null}
    </header>
  );
}

export function App() {
  const ready = useStore(s => s.ready);
  const view = useStore(s => s.view);
  const activeId = useStore(s => s.activeId);
  const sessions = useStore(s => s.sessions);
  const settingsOpen = useStore(s => s.settingsOpen);
  const paletteOpen = useStore(s => s.paletteOpen);
  const notices = useStore(s => s.notices);
  const sidebar = useStore(s => s.sidebar);
  const pendingTranscript = useStore(s => s.transcripts.pending);
  useEffect(() => { bootstrap().catch(e => notify(e.message, 'error')); }, []);
  useEffect(() => {
    const onKey = e => {
      if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(!getState().paletteOpen); }
      else if (e.metaKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
      else if (e.metaKey && e.key === '\\') { e.preventDefault(); toggleSidebar(); }
      else if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(!getState().settingsOpen); }
      else if (e.key === 'Escape' && getState().settingsOpen && !document.querySelector('.modal')) openSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!ready) return <div className="app loading" />;
  const pending = activeId === 'pending';
  const session = sessions.find(s => s.id === activeId) ?? (pending ? { id: 'pending', title: 'New session', status: 'connecting', phase: 'starting', environmentId: 'local', cwd: '', streaming: true } : null);
  const toasts = <div className="toasts">{notices.map(n => <div key={n.id} className={`toast ${n.level}`}><Icon name={n.level === 'error' ? 'alert' : 'check'} size={15} /> {n.message}</div>)}</div>;
  if (settingsOpen) return <div className="app"><SettingsPage />{toasts}</div>;
  return (
    <div className="app">
      {sidebar && <Sidebar />}
      <main className="main">
        <Header session={session} view={view} />
        {view === 'session' && session ? (pending
          ? <div className="session-view"><div className="session-main"><Transcript session={session} transcript={pendingTranscript ?? emptyTranscript()} questions={[]} /></div></div>
          : <SessionView key={session.id} session={session} />) : <NewSessionView />}
      </main>
      {paletteOpen && <Palette />}
      <ConfirmHost />
      {toasts}
    </div>
  );
}
