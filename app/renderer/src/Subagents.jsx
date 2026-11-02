import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Markdown, Spinner } from './ui.jsx';
import { closeSubagent, openFile, openSubagent } from './store.js';
import { formatTokens } from './transcript.js';
import { isSubagentActive, subagentBatch, subagentStatus, subagentSummary } from './subagent-state.js';

const duration = ms => ms < 60000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
function StatusIcon({ status }) {
  if (['running', 'retrying'].includes(status)) return <Spinner size={13} />;
  return <Icon name={status === 'completed' ? 'check' : ['failed', 'timed_out'].includes(status) ? 'alert' : ['queued', 'pending'].includes(status) ? 'timer' : 'x'} size={14} />;
}
function TaskRow({ task, onClick }) {
  return <button className={`subagent-task-row ${task.status}`} onClick={onClick}>
    <StatusIcon status={task.status} />
    <span className="subagent-task-text"><span className="subagent-task-name">{task.name}</span>
      <span className="subagent-task-caption">{subagentStatus(task.status)}{task.currentTool ? ` · ${task.currentTool}` : ''}</span></span>
    <Icon name="chevronRight" size={14} />
  </button>;
}

export function SubagentSummary({ sessionId, call, tool }) {
  const batch = subagentBatch(call, tool);
  return <section className="subagent-summary" data-call-id={call.id}>
    <button className="subagent-summary-head" onClick={() => openSubagent(sessionId, call.id)}>
      <Icon name="fork" size={16} /><b>Subagents</b><span>{subagentSummary(batch.tasks)}</span><Icon name="chevronRight" size={15} />
    </button>
    {batch.tasks.map(task => <TaskRow key={task.key} task={task} onClick={() => openSubagent(sessionId, call.id, task.index)} />)}
  </section>;
}

export function SubagentList({ sessionId, batches, selectedCallId }) {
  const [showAll, setShowAll] = useState(false);
  const selected = batches.find(b => b.callId === selectedCallId);
  const ordered = [...batches].reverse();
  const visible = selected ? [selected] : showAll ? ordered : ordered.slice(0, 5);
  return <section className="panel-card subagent-list">
    <div className="subagent-list-head"><Icon name="fork" size={16} /><b>Subagents</b>
      {selected && <button className="link-button" onClick={() => closeSubagent(sessionId)}>Show all</button>}</div>
    {!batches.length && <div className="subagent-empty">Delegated tasks will appear here.</div>}
    {visible.map(batch => <div className="subagent-batch" key={batch.callId}>
      <div className="subagent-batch-count">{subagentSummary(batch.tasks)}</div>
      {batch.tasks.map(task => <TaskRow key={task.key} task={task} onClick={() => openSubagent(sessionId, batch.callId, task.index)} />)}
    </div>)}
    {!selected && ordered.length > 5 && <button className="panel-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show recent' : 'Show all batches'}</button>}
  </section>;
}

function TraceStep({ sessionId, step, onInteract }) {
  if (step.type === 'notice') return <div className="subagent-trace-notice">{step.text}</div>;
  if (step.type === 'message') return <div className="subagent-trace-message">
    {step.text && <Markdown text={step.text} streaming={step.status === 'running'} />}
    {step.error && <div className="block-error">{step.error}</div>}
  </div>;
  const summary = step.summary && step.summary !== step.name ? step.summary : step.name === 'bash' ? step.input?.split('\n')[0] : '';
  return <details className={`subagent-trace-tool ${step.status}`} onToggle={onInteract}>
    <summary><StatusIcon status={step.status} /><span className="subagent-trace-label"><b>{step.name}</b>{summary && <span>{summary}</span>}</span>
      {step.durationMs != null && <span className="subagent-trace-time">{duration(step.durationMs)}</span>}</summary>
    <div className="subagent-trace-body">
      {step.input && <pre className="subagent-trace-input">{step.name === 'bash' ? '$ ' : ''}{step.input}</pre>}
      {step.output && <pre className="subagent-trace-output">{step.output}</pre>}
      {!step.output && <div className="muted">{step.status === 'running' ? 'Waiting for output…' : 'No text output.'}</div>}
      {step.path && <button className="link-button" onClick={() => openFile(sessionId, step.path)}>Open file</button>}
    </div>
  </details>;
}

export function SubagentDetail({ sessionId, task }) {
  const scroller = useRef(null), following = useRef(true);
  const [isFollowing, setFollowing] = useState(true);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isSubagentActive(task)) return;
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [task.status]);
  const followLatest = () => { following.current = true; setFollowing(true); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; };
  const pause = () => { following.current = false; setFollowing(false); };
  useLayoutEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [task.steps, task.output, task.status]);
  const elapsed = Math.max(0, (task.finishedAt ?? Date.now()) - (task.runStartedAt ?? task.startedAt ?? Date.now()));
  const hasTrace = Array.isArray(task.steps);
  return <>
    <div className="subagent-inspector-head"><button className="tool-button" aria-label="Back to subagents" onClick={() => closeSubagent(sessionId)}><Icon name="arrowLeft" size={17} /></button><b>{task.name}</b></div>
    <div className={`subagent-inspector-meta ${task.status}`}><StatusIcon status={task.status} /><span>{subagentStatus(task.status)}</span>
      {task.startedAt && <span>{duration(elapsed)}</span>}<span>{task.turns ?? 0} turns</span><span>{formatTokens(task.usage?.totalTokens ?? 0)} tokens</span></div>
    <div className="subagent-inspector-model">{[task.provider, task.model].filter(Boolean).join('/')}</div>
    <div ref={scroller} className="subagent-timeline" onWheel={e => { if (e.deltaY < 0) pause(); }} onScroll={e => {
      if (e.target !== scroller.current) return;
      const el = e.currentTarget, atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      following.current = atBottom; setFollowing(atBottom);
    }}>
      {task.task && <details className="subagent-assignment" onToggle={pause}><summary>Assigned task</summary><pre>{task.task}</pre></details>}
      {!hasTrace && <div className="subagent-trace-notice">{isSubagentActive(task) ? 'Waiting for live execution details…' : 'This older task saved only its result, not a detailed execution trace.'}</div>}
      {task.omittedSteps > 0 && <div className="subagent-trace-notice">{task.omittedSteps} earlier records omitted to keep the activity log bounded.</div>}
      {hasTrace && task.steps.map(step => <TraceStep key={step.id} sessionId={sessionId} step={step} onInteract={pause} />)}
      {hasTrace && !task.steps.length && <div className="subagent-empty">{task.status === 'queued' ? 'Waiting for an available subagent slot…' : isSubagentActive(task) ? 'Waiting for the first action…' : 'No execution steps were recorded.'}</div>}
      {task.error && <div className="block-error">{task.error}</div>}
      {task.output && (!hasTrace || !task.steps.some(step => step.type === 'message' && step.text === task.output)) && <div className="subagent-final-output"><h4>{isSubagentActive(task) ? 'Latest output' : 'Result'}</h4><Markdown text={task.output} /></div>}
    </div>
    {!isFollowing && <button className="subagent-latest" onClick={followLatest}><Icon name="arrowDown" size={13} /> Latest activity</button>}
  </>;
}
