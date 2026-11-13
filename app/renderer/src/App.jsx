import { useEffect, useMemo, useRef, useState } from 'react';
import { ClaudeMascot, Icon, Mascot } from './Icons.jsx';
import { Sidebar, SessionMenuItems } from './Sidebar.jsx';
import { Composer, ComposerBar, NewSessionTrayHead } from './Composer.jsx';
import { Transcript } from './Conversation.jsx';
import { AgentReports, SubagentSummary } from './Subagents.jsx';
import { RightPanel, UsageMetrics } from './RightPanel.jsx';
import { SettingsPage } from './Settings.jsx';
import { FilePane } from './FilePane.jsx';
import { GitReview } from './GitReview.jsx';
import { TerminalPanel } from './TerminalPanel.jsx';
import { Palette } from './Palette.jsx';
import { Modal, Popover, Spinner, Trigger } from './ui.jsx';
import { emptyTranscript, formatTokens } from './transcript.js';
import { sortedBackgroundJobs } from './background-jobs.js';
import { api, bootstrap, closeConfirm, dismissNotice, set as setStore, getState, isPendingSession, newSession, notify, openFile, openPalette, openSettings, sendPrompt, setFilePaneOpen, startSession, toggleRightPanel, toggleSidebar, useStore } from './store.js';

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

// The conversation's Ultra task: what Pi works on, for how long, and stop / resume / dismiss. The latest
// progress report and any error show on hover.
const elapsed = ms => { const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60); return m < 1 ? '<1m' : h ? `${h}h ${m % 60}m` : `${m}m`; };
function UltraBanner({ session }) {
  const ultra = useStore(s => s.ultra[session.id]);
  const [, tick] = useState(0);
  const task = ultra?.task;
  useEffect(() => {
    if (task?.status !== 'active') return;
    const timer = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(timer);
  }, [task?.status]);
  if (!task?.objective) return null;
  const retrying = task.status === 'active' && task.retryAt > Date.now();
  const label = task.status === 'active' ? (task.reviewing ? 'Reviewing' : retrying ? 'Retrying soon' : 'Working') : { paused: 'Paused', stalled: 'Stalled', needs_attention: 'Needs attention', complete: 'Done' }[task.status] ?? task.status;
  const run = verb => api('prompt', session.id, `/pidesk-ultra ${verb}`).catch(e => notify(e.message, 'error'));
  const stop = () => { api('abort', session.id).catch(() => {}); run('pause'); };
  const title = [task.objective, task.progress?.done && `Done: ${task.progress.done}`, task.progress?.next && `Next: ${task.progress.next}`, task.reason, task.lastError].filter(Boolean).join('\n');
  return (
    <div className="ultra-task"><div className={`goal-banner ultra-banner ${task.status}`} title={title}>
      <Icon name="infinity" size={15} className="goal-icon" />
      <span className="goal-objective">{task.objective}</span>
      <span className={`goal-state ${task.status === 'complete' ? 'complete' : ['stalled', 'needs_attention'].includes(task.status) ? 'blocked' : ''}`}>{task.status === 'active' && <span className="goal-pulse" />}{label} · {elapsed((task.finishedAt ?? Date.now()) - task.startedAt)}</span>
      {task.status === 'active' && <button className="goal-action" onClick={stop}>Stop</button>}
      {['paused', 'stalled', 'needs_attention'].includes(task.status) && ultra.enabled && <button className="goal-action" onClick={() => run('resume')}>Resume</button>}
      {task.status !== 'active' && <button className="goal-close" aria-label="Dismiss" title="Dismiss" onClick={() => run('dismiss')}><Icon name="x" size={13} /></button>}
    </div>{task.status === 'needs_attention' && <div className="ultra-review-gaps" role="status"><strong>{task.reason}</strong><pre>{task.review?.text}</pre></div>}</div>
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
  const isClaude = draft.engine === 'claude-code';
  // Start a Pi (or install Claude Code) in the chosen place ahead of time, so the first message doesn't wait for it.
  useEffect(() => {
    if (!draft.model && !isClaude) return;
    const t = setTimeout(() => api('prewarm', { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, thinkingLevel: draft.thinkingLevel, speed: draft.speed, engine: draft.engine }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [draft.environmentId, draft.cwd, draft.model?.provider, draft.model?.id, draft.engine, isClaude]);
  return (
    <div className="new-session">
      <div className="welcome-stage">
        <div className="code-empty" aria-label="Ready to code">
          {isClaude ? <ClaudeMascot size={7} /> : <Mascot size={7} />}
          <h1 className="welcome-heading">What can we build today?</h1>
        </div>
        <div className="dock new-session-dock">
          <div className="composer-shell">
            <NewSessionTrayHead />
            <Composer autoFocus placeholder="Ask anything, @ to mention, / for actions" onSubmit={startSession} footer={<ComposerBar />} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionBanner({ session }) {
  if (session.status === 'reconnecting') {
    const agent = session.engine === 'claude-code' ? 'Claude Code' : 'Pi';
    return <div className="conn-banner"><Spinner size={13} /> <span className="conn-text">Reconnecting to <b>{session.environmentLabel}</b>… {agent} keeps working on the server.</span></div>;
  }
  if (session.status === 'disconnected' || session.status === 'error') {
    return <div className="conn-banner error"><Icon name="unplug" size={15} /> <span className="conn-text">{session.statusMessage || 'Disconnected from this session.'}</span>
      <button className="button small" onClick={() => api('reconnect', session.id).catch(e => notify(e.message, 'error'))}>Reconnect</button></div>;
  }
  return null;
}

function SessionFindBar({ onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const collect = q => {
    const clean = q.trim().toLowerCase();
    if (!clean) return [];
    const root = document.querySelector('.session-main .transcript-inner');
    if (!root) return [];
    return [...root.querySelectorAll('.markdown, .user-bubble, .ultra-progress, .cc-task-card, .cc-todo-card, .tool-group-head, .step-head')]
      .filter(el => el.textContent?.toLowerCase().includes(clean));
  };
  const jump = (q, nextIdx) => {
    const hits = collect(q);
    setCount(hits.length);
    document.querySelectorAll('.find-active-block').forEach(el => el.classList.remove('find-active-block'));
    if (!hits.length) { setIndex(0); return; }
    const wrapped = ((nextIdx % hits.length) + hits.length) % hits.length;
    setIndex(wrapped);
    const target = hits[wrapped];
    target.classList.add('find-active-block');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  useEffect(() => () => { document.querySelectorAll('.find-active-block').forEach(el => el.classList.remove('find-active-block')); }, []);
  return (
    <div className="session-find-bar" role="search" aria-label="Find in conversation">
      <Icon name="search" size={14} className="find-icon" />
      <input ref={inputRef} value={query} placeholder="Find in conversation…" aria-label="Find in conversation"
        onChange={e => { const v = e.target.value; setQuery(v); jump(v, 0); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          else if (e.key === 'Enter') { e.preventDefault(); jump(query, index + (e.shiftKey ? -1 : 1)); }
        }} />
      {query.trim() && <span className="find-count">{count ? `${index + 1} / ${count}` : '0 results'}</span>}
      <button type="button" className="icon-button" disabled={!count} onClick={() => jump(query, index - 1)} aria-label="Previous match" title="Previous (⇧↵)"><Icon name="chevronUp" size={14} /></button>
      <button type="button" className="icon-button" disabled={!count} onClick={() => jump(query, index + 1)} aria-label="Next match" title="Next (↵)"><Icon name="chevronDown" size={14} /></button>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close find" title="Close (Esc)"><Icon name="x" size={14} /></button>
    </div>
  );
}

function SessionView({ session }) {
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const transcript = useStore(s => s.transcripts[session.id]) ?? emptyTranscript();
  const questions = useStore(s => s.questions[session.id]) ?? [];
  const ultraWorking = useStore(s => s.ultra[session.id]?.task?.status === 'active');
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const filePaneMax = useStore(s => s.filePaneMax) && filePaneOpen;
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setStore(st => ({ terminalOpen: !st.terminalOpen })); }
      else if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFindOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Relative links in replies (e.g. "authoring/plan.md") open in the file preview.
  useEffect(() => {
    const onOpen = e => openFile(session.id, e.detail);
    window.addEventListener('pidesk:open-file', onOpen);
    return () => window.removeEventListener('pidesk:open-file', onOpen);
  }, [session.id]);
  const isClaude = session.engine === 'claude-code';
  const placeholder = questions.length
    ? 'Answer the agent’s question…'
    : !isClaude && ultraWorking
      ? 'Add to the task, @ to mention, / for actions'
      : 'Ask anything, @ to mention, / for actions';
  return (
    <div className={`session-view ${filePaneMax ? 'files-max' : ''}`}>
      <div className="session-main">
        {findOpen && <SessionFindBar onClose={() => setFindOpen(false)} />}
        {!transcript.messages.length && !transcript.live && !session.streaming && session.status === 'connected' && !questions.length ? <div className="code-empty" aria-label="Ready to code">{isClaude ? <ClaudeMascot size={7} /> : <Mascot size={7} />}</div> : <Transcript session={session} transcript={transcript} questions={questions}
          renderSubagents={block => <SubagentSummary key={block.key} sessionId={session.id} call={block.call} tool={transcript.tools[block.call.id]} />}
          renderAgentReport={block => <AgentReports key={block.key} sessionId={session.id} agents={block.agents} />} />}
        <div className="dock">
          {session.engine === 'cursor'
            // Cursor CLI was removed: its old conversations can still be read, copied and deleted.
            ? <div className="conn-banner"><Icon name="alert" size={15} /> <span className="conn-text">Cursor CLI was removed from Pi Desktop. This conversation is read-only.</span></div>
            : <div className="composer-shell">
                <ConnectionBanner session={session} />
                {!isClaude && <GoalBanner session={session} />}
                {!isClaude && <UltraBanner session={session} />}
                <Composer session={session} autoFocus placeholder={placeholder} onSubmit={(text, attachments) => sendPrompt(session.id, text, attachments)} footer={<ComposerBar session={session} />} />
              </div>}
        </div>
        {terminalOpen && <TerminalPanel session={session} />}
      </div>
      {gitReviewOpen ? <GitReview key={session.id} session={session} /> : filePaneOpen ? <FilePane key={session.id} session={session} /> : rightPanel && <RightPanel session={session} />}
    </div>
  );
}

function HeaderTelemetry({ session }) {
  const stats = useStore(s => s.stats[session.id]);
  const transcript = useStore(s => s.transcripts[session.id]);
  const jobsSnapshot = useStore(s => s.jobs[session.id]);
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const runningJobs = useMemo(() => sortedBackgroundJobs(jobsSnapshot?.jobs).filter(j => j.status === 'running').length, [jobsSnapshot]);
  const context = stats?.contextUsage;
  const percent = Number.isFinite(context?.percent) ? Math.round(context.percent) : null;
  const contextLabel = Number.isFinite(context?.tokens)
    ? `${formatTokens(context.tokens)} / ${Number.isFinite(context?.contextWindow) ? formatTokens(context.contextWindow) : '—'}`
    : percent != null ? `${percent}%` : null;
  const hasUsage = (transcript?.messages ?? []).some(m => m.role === 'assistant' && m.usage);
  const inspectorVisible = rightPanel && !filePaneOpen && !gitReviewOpen;
  return <>
    {runningJobs > 0 && !inspectorVisible && (
      <button type="button" className="header-pill live" onClick={() => setStore({ filePaneOpen: false, gitReviewOpen: false, rightPanel: true })} title="View running background tasks">
        <Spinner size={11} /><span>{runningJobs} running</span>
      </button>
    )}
    {!inspectorVisible && (contextLabel || hasUsage) && (
      <Trigger width={264} placement="bottom-end" label="Context and token usage" className="header-pill context-pill"
        title={contextLabel ? `Context: ${contextLabel}` : 'Token usage'}
        menu={() => (
          <div className="telemetry-popover">
            {contextLabel && (
              <div className="telemetry-context">
                <span>Context</span>
                <span className="telemetry-context-val">
                  {contextLabel}
                  {percent != null && <span className={`meter ${percent > 100 ? 'over' : ''}`}><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></span>}
                </span>
              </div>
            )}
            <UsageMetrics transcript={transcript} />
          </div>
        )}>
        {percent != null ? <>
          <span className={`context-ring ${percent > 85 ? 'high' : ''}`} style={{ '--pct': `${Math.max(4, Math.min(100, percent))}%` }} />
          <span>{percent}%</span>
        </> : <Icon name="activity" size={13} />}
      </Trigger>
    )}
  </>;
}

function Header({ session, view }) {
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const sidebar = useStore(s => s.sidebar);
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const local = session?.environmentId === 'local';
  const activeSession = view === 'session' && session && !isPendingSession(session.id);
  return (
    <header className={`main-head drag ${activeSession ? '' : 'welcome-head'} ${sidebar ? '' : 'no-sidebar'}`}>
      {!sidebar && <div className="window-tools no-drag"><button className="tool-button" onClick={toggleSidebar} aria-label="Show sidebar"><Icon name="sidebarToggle" size={17} /></button></div>}
      {activeSession ? <>
        {renaming
          ? <input className="title-input no-drag" autoFocus value={title} onChange={e => setTitle(e.target.value)} onBlur={() => { setRenaming(false); if (title.trim()) api('rename', session.id, title.trim()); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} />
          : <div className="header-context">
              {session.project && <>
                <span className="header-crumb" title={session.cwd}>
                  {session.project}{!local && session.environmentLabel ? ` · ${session.environmentLabel}` : ''}
                </span>
                <span className="header-crumb-sep" aria-hidden="true">/</span>
              </>}
              <button ref={anchor} className="title-button no-drag" onClick={() => setMenu(m => !m)} aria-expanded={menu} title={session.title}>
                <span>{session.title}</span><Icon name="chevronDown" size={12} />
              </button>
              {session.engine === 'claude-code' && (
                <span className="header-engine-badge" title="Running on Claude Code">Claude Code</span>
              )}
              {!session.project && !local && session.environmentLabel && (
                <span className="header-env-badge" title={session.cwd}><Icon name="terminal" size={11} />{session.environmentLabel}</span>
              )}
            </div>}
        <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={220} placement="bottom-start">
          <SessionMenuItems session={session} close={() => setMenu(false)} onRename={() => { setTitle(session.title); setRenaming(true); }} />
        </Popover>
        <div className="main-tools no-drag">
          <HeaderTelemetry session={session} />
          <button className={`tool-button git-review-toggle ${gitReviewOpen ? 'on' : ''}`} onClick={() => setStore({ gitReviewOpen: !gitReviewOpen, filePaneOpen: false, filePaneMax: false })} aria-label="Review Git changes" aria-pressed={gitReviewOpen} title="Review repository changes"><Icon name="fileDiff" size={15} /><span>Review</span></button>
          <button className={`tool-button ${terminalOpen ? 'on' : ''}`} onClick={() => setStore({ terminalOpen: !terminalOpen })} aria-label="Terminal" aria-pressed={terminalOpen} title="Terminal (⌃`)"><Icon name="terminalPanel" size={16} /></button>
          <button className={`tool-button ${filePaneOpen ? 'on' : ''}`} onClick={() => setFilePaneOpen(!filePaneOpen)} aria-label="Files" aria-pressed={filePaneOpen} title="Files"><Icon name="folder" size={16} /></button>
          <button className={`tool-button ${rightPanel && !filePaneOpen && !gitReviewOpen ? 'on' : ''}`} onClick={() => { if (filePaneOpen || gitReviewOpen) { setStore({ filePaneOpen: false, gitReviewOpen: false, rightPanel: true }); } else toggleRightPanel(); }} aria-label="Session details" aria-pressed={rightPanel && !filePaneOpen && !gitReviewOpen} title="Session details"><Icon name="panel" size={16} /></button>
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
  const draft = useStore(s => s.draft);
  const pendingTranscript = useStore(s => s.transcripts[s.activeId]);
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
  const pending = isPendingSession(activeId);
  const session = sessions.find(s => s.id === activeId) ?? (pending ? { id: activeId, title: 'New session', status: 'connecting', phase: draft.engine === 'claude-code' ? 'preparing' : 'starting', environmentId: draft.environmentId, engine: draft.engine, cwd: draft.cwd ?? '', streaming: true } : null);
  const toasts = <div className="toasts">{notices.map(n => <div key={n.id} className={`toast ${n.level}`}><Icon name={n.level === 'error' ? 'alert' : 'check'} size={15} /> <span className="toast-text">{n.message}</span>
    {n.action && <button className="toast-action" onClick={() => { dismissNotice(n.id); n.action.run(); }}>{n.action.label}</button>}</div>)}</div>;
  if (settingsOpen) return <div className="app"><SettingsPage />{toasts}</div>;
  return (
    <div className="app workspace-app">
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
