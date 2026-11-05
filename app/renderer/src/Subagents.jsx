import { useEffect, useId, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Spinner } from './ui.jsx';
import { clearSubagentRecords, closeSubagent, messageAgent, openFile, openSubagent, stopAgent, useStore } from './store.js';
import { formatTokens } from './transcript.js';
import { Transcript } from './Conversation.jsx';
import { subagentTranscript } from './subagent-transcript.js';
import { agentSnapshots, isSubagentActive, isSubagentFinished, subagentBatch, subagentElapsed, subagentHistoryId, subagentTaskStatus, subagentSummary, visibleSubagentTasks } from './subagent-state.js';

const TYPE_LABELS = { explore: 'Explore', fork: 'Fork' };
const typeLabel = task => task.type && task.type !== 'general' ? TYPE_LABELS[task.type] ?? task.type : null;

const duration = ms => ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
function StatusIcon({ status }) {
  if (['running', 'retrying'].includes(status)) return <Spinner size={13} />;
  return <Icon name={status === 'completed' ? 'check' : ['failed', 'timed_out'].includes(status) ? 'alert' : ['queued', 'pending'].includes(status) ? 'timer' : 'x'} size={14} />;
}
function TaskRow({ task, onClick }) {
  return <button className={`subagent-task-row ${task.status}`} onClick={onClick}>
    <StatusIcon status={task.status} />
    <span className="subagent-task-text"><span className="subagent-task-name">{task.name}</span>
      <span className="subagent-task-caption">{subagentTaskStatus(task)}{typeLabel(task) ? ` · ${typeLabel(task)}` : ''}{task.currentTool ? ` · ${task.currentTool}` : ''}</span></span>
    <Icon name="chevronRight" size={14} />
  </button>;
}

export function SubagentSummary({ sessionId, call, tool }) {
  const cleared = useStore(s => s.sessions.find(session => session.id === sessionId)?.clearedSubagentIds);
  const transcript = useStore(s => s.transcripts[sessionId]);
  const live = useStore(s => s.agents[sessionId]);
  const latest = useMemo(() => agentSnapshots(transcript, live), [transcript, live]);
  const batch = subagentBatch(call, tool, latest);
  const tasks = visibleSubagentTasks(batch.tasks, cleared);
  const wasCleared = batch.tasks.length > 0 && !tasks.length;
  const working = batch.background && tasks.some(isSubagentActive);
  return <section className="subagent-summary" data-call-id={call.id}>
    <button className="subagent-summary-head" disabled={wasCleared} onClick={() => openSubagent(sessionId, call.id)}>
      <Icon name="fork" size={16} /><b>Subagents</b><span>{wasCleared ? 'Task history cleared' : subagentSummary(tasks)}</span>{!wasCleared && <Icon name="chevronRight" size={15} />}
    </button>
    {working && <div className="subagent-summary-hint">Working in the background. Pi continues when each one reports.</div>}
    {tasks.map(task => <TaskRow key={task.key} task={task} onClick={() => openSubagent(sessionId, call.id, task.index)} />)}
  </section>;
}

// A background agent's report in the conversation: who reported, and a way into its activity.
export function AgentReport({ sessionId, agent }) {
  if (!agent) return null;
  const done = agent.status === 'completed';
  const canOpen = typeof agent.callId === 'string' && Number.isInteger(agent.index);
  return <button className={`agent-report ${agent.status}`} disabled={!canOpen} title={agent.error || undefined}
    onClick={() => openSubagent(sessionId, agent.callId, agent.index)}>
    <Icon name={done ? 'check' : agent.status === 'cancelled' ? 'x' : 'alert'} size={14} />
    <span className="agent-report-text"><b>{agent.name}</b> {done ? 'reported back' : agent.status === 'cancelled' ? 'was stopped' : 'failed'}{typeLabel(agent) ? ` · ${typeLabel(agent)}` : ''}</span>
    {canOpen && <Icon name="chevronRight" size={14} />}
  </button>;
}

function AgentMessageForm({ sessionId, agentId, name }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async event => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try { await messageAgent(sessionId, agentId, value); setText(''); } catch { /* reported by the store */ }
    finally { setBusy(false); }
  };
  return <form className="subagent-message" onSubmit={send}>
    <textarea value={text} rows={2} placeholder={`Message ${name}…`} aria-label="Message this agent" onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
    <button type="submit" className="tool-button" aria-label="Send to this agent" disabled={!text.trim() || busy}><Icon name="arrowUp" size={16} /></button>
  </form>;
}

export function SubagentList({ sessionId, batches, selectedCallId }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const selected = batches.find(b => b.callId === selectedCallId);
  const ordered = [...batches].reverse();
  const visible = selected ? [selected] : showAll ? ordered : ordered.slice(0, 5);
  const hasFinished = batches.some(batch => batch.tasks.some(isSubagentFinished));
  return <section className="panel-card subagent-list">
    <div className="subagent-list-header">
      <button type="button" className="panel-card-head subagent-list-head" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-controls={bodyId}>
        <span>Subagents</span><Icon name={open ? 'caretDown' : 'caretRight'} size={13} className="muted" />
      </button>
      <button className="link-button subagent-clear" aria-label="Clear finished subagents" title="Clear finished task records from this session’s task history" disabled={!hasFinished} onClick={() => clearSubagentRecords(sessionId)}>Clear</button>
      {open && selected && <button className="link-button" onClick={() => closeSubagent(sessionId)}>Show all</button>}
    </div>
    <div id={bodyId} hidden={!open}>
      {open && <>
        {visible.map(batch => <div className="subagent-batch" key={batch.callId}>
          <div className="subagent-batch-count">{subagentSummary(batch.tasks)}</div>
          {batch.tasks.map(task => <TaskRow key={task.key} task={task} onClick={() => openSubagent(sessionId, batch.callId, task.index)} />)}
        </div>)}
        {!selected && ordered.length > 5 && <button className="panel-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show recent' : 'Show all batches'}</button>}
      </>}
    </div>
  </section>;
}

export function SubagentDetail({ sessionId, task }) {
  const [, tick] = useState(0);
  const active = isSubagentActive(task);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const transcript = useMemo(() => subagentTranscript(task), [task]);
  const session = useMemo(() => ({ id: task.key, status: 'connected', streaming: active,
    activityLabel: task.status === 'queued' ? 'Queued' : task.status === 'retrying' ? 'Retrying' : task.currentTool ? `Working · ${task.currentTool}` : 'Working',
  }), [task.key, task.status, task.currentTool, active]);
  const elapsed = subagentElapsed(task);
  // Controls need the agent's live state from its Pi: older or restarted sessions only have the record.
  const live = useStore(s => task.id ? s.agents[sessionId]?.[task.id] : null);
  const canMessage = !!live && live.retained !== false && task.status !== 'cancelled';
  return <>
    <div className="subagent-inspector-head">
      <button className="tool-button" aria-label="Back to subagents" onClick={() => closeSubagent(sessionId)}><Icon name="arrowLeft" size={17} /></button>
      <b title={task.name}>{task.name}</b>
      {active && live && <button className="link-button subagent-stop" aria-label="Stop this agent" onClick={() => stopAgent(sessionId, task.id)}>Stop</button>}
      <button className="link-button subagent-clear" aria-label="Clear this subagent record" disabled={!isSubagentFinished(task)} title="Clear this finished task from task history" onClick={() => clearSubagentRecords(sessionId, [subagentHistoryId(task)])}>Clear</button>
    </div>
    <div className={`subagent-inspector-meta ${task.status}`} title={[task.provider, task.model].filter(Boolean).join('/')}>
      <span>{subagentTaskStatus(task)}</span><span>·</span>
      {typeLabel(task) && <><span>{typeLabel(task)}</span><span>·</span></>}
      <span>{elapsed == null ? 'Time unavailable' : duration(elapsed)}</span>
      <span>·</span><span>{task.turns ?? 0} turns</span><span>·</span><span>{formatTokens(task.usage?.totalTokens ?? 0)} tokens</span>
    </div>
    {task.worktree?.branch && <div className="subagent-inspector-worktree" title={task.worktree.path}>
      <Icon name="branch" size={13} /> {task.worktree.branch}{task.worktree.changed === false ? ' · removed, no changes' : task.worktree.changed ? ` · ${task.worktree.files ?? 0} changed files` : ''}
    </div>}
    <div className="subagent-conversation">
      <Transcript session={session} transcript={transcript} readOnly copyText={!active ? task.output : null} onOpenFile={path => openFile(sessionId, path)} />
    </div>
    {canMessage && <AgentMessageForm sessionId={sessionId} agentId={task.id} name={task.name} />}
  </>;
}
