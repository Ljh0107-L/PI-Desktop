import { useEffect, useId, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Spinner } from './ui.jsx';
import { clearSubagentRecords, closeSubagent, openFile, openSubagent, useStore } from './store.js';
import { formatTokens } from './transcript.js';
import { Transcript } from './Conversation.jsx';
import { subagentTranscript } from './subagent-transcript.js';
import { isSubagentActive, isSubagentFinished, subagentBatch, subagentElapsed, subagentHistoryId, subagentTaskStatus, subagentSummary, visibleSubagentTasks } from './subagent-state.js';

const duration = ms => ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
function StatusIcon({ status }) {
  if (['running', 'retrying'].includes(status)) return <Spinner size={13} />;
  return <Icon name={status === 'completed' ? 'check' : ['failed', 'timed_out'].includes(status) ? 'alert' : ['queued', 'pending'].includes(status) ? 'timer' : 'x'} size={14} />;
}
function TaskRow({ task, onClick }) {
  return <button className={`subagent-task-row ${task.status}`} onClick={onClick}>
    <StatusIcon status={task.status} />
    <span className="subagent-task-text"><span className="subagent-task-name">{task.name}</span>
      <span className="subagent-task-caption">{subagentTaskStatus(task)}{task.currentTool ? ` · ${task.currentTool}` : ''}</span></span>
    <Icon name="chevronRight" size={14} />
  </button>;
}

export function SubagentSummary({ sessionId, call, tool }) {
  const cleared = useStore(s => s.sessions.find(session => session.id === sessionId)?.clearedSubagentIds);
  const batch = subagentBatch(call, tool);
  const tasks = visibleSubagentTasks(batch.tasks, cleared);
  const wasCleared = batch.tasks.length > 0 && !tasks.length;
  return <section className="subagent-summary" data-call-id={call.id}>
    <button className="subagent-summary-head" disabled={wasCleared} onClick={() => openSubagent(sessionId, call.id)}>
      <Icon name="fork" size={16} /><b>Subagents</b><span>{wasCleared ? 'Task history cleared' : subagentSummary(tasks)}</span>{!wasCleared && <Icon name="chevronRight" size={15} />}
    </button>
    {tasks.map(task => <TaskRow key={task.key} task={task} onClick={() => openSubagent(sessionId, call.id, task.index)} />)}
  </section>;
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
  return <>
    <div className="subagent-inspector-head">
      <button className="tool-button" aria-label="Back to subagents" onClick={() => closeSubagent(sessionId)}><Icon name="arrowLeft" size={17} /></button>
      <b title={task.name}>{task.name}</b>
      <button className="link-button subagent-clear" aria-label="Clear this subagent record" disabled={!isSubagentFinished(task)} title="Clear this finished task from task history" onClick={() => clearSubagentRecords(sessionId, [subagentHistoryId(task)])}>Clear</button>
    </div>
    <div className={`subagent-inspector-meta ${task.status}`} title={[task.provider, task.model].filter(Boolean).join('/')}>
      <span>{subagentTaskStatus(task)}</span><span>·</span>
      <span>{elapsed == null ? 'Time unavailable' : duration(elapsed)}</span>
      <span>·</span><span>{task.turns ?? 0} turns</span><span>·</span><span>{formatTokens(task.usage?.totalTokens ?? 0)} tokens</span>
    </div>
    <div className="subagent-conversation">
      <Transcript session={session} transcript={transcript} readOnly copyText={!active ? task.output : null} onOpenFile={path => openFile(sessionId, path)} />
    </div>
  </>;
}
