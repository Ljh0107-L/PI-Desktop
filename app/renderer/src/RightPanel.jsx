import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { useResizable } from './ui.jsx';
import { formatTokens, speedDisplay, speedReply, speedTier, usageOf } from './transcript.js';
import { stopBackgroundJob, useStore } from './store.js';
import { subagentBatches, visibleSubagentBatches } from './subagent-state.js';
import { SubagentDetail, SubagentList } from './Subagents.jsx';

function Card({ title, children, open: initial = true, aside }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="panel-card">
      <button className="panel-card-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{title}</span>
        {children && <Icon name={open ? 'caretDown' : 'caretRight'} size={13} className="muted" />}
        {aside && <span className="panel-card-aside">{aside}</span>}
      </button>
      {open && children && <div className="panel-card-body">{children}</div>}
    </section>
  );
}

// Speed and token usage per turn, where a turn is one model call (one assistant message): the last turn's
// speed with a trend of recent turns, and input / cached / output tokens for the last turn and the session.
// Figures update as each turn finishes.
function UsageCard({ transcript }) {
  const messages = (transcript?.messages ?? []).filter(m => m.role === 'assistant' && m.usage && !['error', 'aborted', 'pending', 'deferred'].includes(m.stopReason));
  if (!messages.length) return null;
  const lastMessage = messages.at(-1);
  const last = usageOf([lastMessage]);
  const total = usageOf(transcript.messages);
  // Show each completed reply's request TPS, including short and single-chunk replies.
  const speedMessage = speedReply(messages);
  const timed = speedMessage === lastMessage ? last : usageOf([speedMessage]);
  // Compare one provider/model and matching token/timing provenance, all over the full request.
  const recent = messages.slice(-14).filter(m => m.provider === speedMessage.provider && (m.responseModel ?? m.model) === (speedMessage.responseModel ?? speedMessage.model))
    .map(m => usageOf([m])).filter(u => u.tps != null && u.speedBasis === timed.speedBasis && u.speedTokensEstimated === timed.speedTokensEstimated && u.speedTimeEstimated === timed.speedTimeEstimated).map(u => u.tps);
  const speed = speedDisplay(timed, { earlier: speedMessage !== lastMessage });
  const tier = speedTier(speedMessage);
  const peak = Math.max(...recent, 1);
  const rows = [
    ['Input', last.input + last.cacheWrite, total.input + total.cacheWrite],
    ['Cached', last.cacheRead, total.cacheRead],
    ['Output', last.output, total.output],
    ...(total.reasoningReported ? [['Reasoning', last.reasoningReported ? last.reasoning : null, total.reasoning]] : []),
  ];
  return (
    <Card title="Usage">
      <div className="usage">
        <div className="usage-speed">
          <div className="usage-speed-metric" title={speed.title}>
            <div className="usage-speed-value"><b>{speed.value}</b><span>tok/s</span></div>
            <span className="usage-speed-kind">{speed.label}{tier && <span className={`usage-speed-tier ${tier.slower ? 'slower' : ''}`} title={tier.title}>{tier.label}</span>}</span>
          </div>
          <div className="spark" aria-hidden="true">{recent.map((v, i) => <span key={i} style={{ height: `${Math.max(8, v / peak * 100)}%` }} />)}</div>
        </div>
        <div className="usage-table" title="Provider-reported counts; ~ marks bridge estimates. Missing cache measurements show —, not a fabricated cache hit. Reasoning is already included in output.">
          <span /><span className="th">Last turn</span><span className="th">Session</span>
          {rows.flatMap(([label, a, b]) => [<span key={label} className="td-label">{label}</span>, <span key={label + 'a'}>{label === 'Cached' && last.cacheUnknown ? '—' : `${last.usageEstimated && a != null ? '~' : ''}${formatTokens(a)}`}</span>, <span key={label + 'b'}>{label === 'Cached' && total.cacheUnknown ? '—' : `${total.usageEstimated && b != null ? '~' : ''}${formatTokens(b)}`}</span>])}
          <span className="td-label">Cache hit</span><span>{last.cacheHit == null ? '—' : `${Math.round(last.cacheHit * 100)}%`}</span><span>{total.cacheHit == null ? '—' : `${Math.round(total.cacheHit * 100)}%`}</span>
        </div>
      </div>
    </Card>
  );
}

// Live background jobs from this session's Pi (started with run_in_background): running jobs first,
// newest first. Each row shows its state, how long it has run (ticked locally while anything runs),
// a Stop button while running, and the output tail under a fold.
const jobMs = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}`.trim() : `${Math.floor(m / 60)}h ${m % 60}m`;
};
function BackgroundJobs({ sessionId }) {
  const jobs = useStore(s => s.jobs[sessionId]);
  const list = Object.values(jobs ?? {});
  const anyRunning = list.some(job => job.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a.status === 'running' ? -1 : b.status === 'running' ? 1 : b.startedAt - a.startedAt);
  const visible = sorted.slice(0, 6);
  return (
    <Card title="Background jobs" aside={<span className="muted">{list.filter(j => j.status === 'running').length} running</span>}>
      <div className="jobs">
        {visible.map(job => {
          const elapsed = job.status === 'running' ? now - job.startedAt : (job.endedAt ?? job.startedAt) - job.startedAt;
          const state = job.status === 'exited' ? (job.exitCode === 0 ? 'done' : job.exitCode == null ? `signal ${job.exitSignal}` : `exit ${job.exitCode}`) : job.status;
          return (
            <div key={job.id} className={`job ${job.status}`} title={job.command}>
              <div className="job-line">
                <span className="job-name"><b>{job.description || job.command}</b><span className="job-id">{job.id}</span></span>
                <span className={`job-state ${state === 'done' ? 'exited' : job.status}`}>{state}</span>
                <span className="muted">{job.status === 'running' ? `for ${jobMs(elapsed)}` : `took ${jobMs(elapsed)}`}</span>
                {job.status === 'running' && <button className="link-button job-stop" aria-label={`Stop job ${job.id}`} onClick={() => stopBackgroundJob(sessionId, job.id)}>Stop</button>}
              </div>
              {job.tail && <details className="job-tail"><summary className="muted">output</summary><pre>{job.tail}</pre></details>}
            </div>
          );
        })}
        {sorted.length > 6 && <div className="muted jobs-more">+{sorted.length - 6} earlier jobs</div>}
      </div>
    </Card>
  );
}

export function RightPanel({ session }) {
  const transcript = useStore(s => s.transcripts[session.id]);
  const stats = useStore(s => s.stats[session.id]);
  const selection = useStore(s => s.subagentSelection[session.id]);
  const live = useStore(s => s.agents[session.id]);
  const batches = useMemo(() => visibleSubagentBatches(subagentBatches(transcript, live), session.clearedSubagentIds), [transcript, live, session.clearedSubagentIds]);
  const batch = batches.find(b => b.callId === selection?.callId);
  const task = Number.isInteger(selection?.taskIndex) ? batch?.tasks.find(task => task.index === selection.taskIndex) : null;
  const [detailWidth, detailHandle] = useResizable('subagent-inspector', 480, 300, 680, 'left');
  const context = stats?.contextUsage;
  const percent = Number.isFinite(context?.percent) ? context.percent : null;
  const contextLabel = Number.isFinite(context?.tokens)
    ? `${formatTokens(context.tokens)} / ${Number.isFinite(context?.contextWindow) ? formatTokens(context.contextWindow) : '—'}`
    : percent != null ? `${Math.round(percent)}%` : 'Not reported';
  if (task) return <aside className="right-panel subagent-inspector" style={{ width: detailWidth }}>
    {detailHandle}<SubagentDetail key={`${session.id}:${task.key}`} sessionId={session.id} task={task} />
  </aside>;
  return (
    <aside className="right-panel">
      <Card title="Context" aside={<>
        <span className="muted" title="Context usage reported by the agent">{contextLabel}</span>
        {percent != null && <span className="meter" title={`${Math.round(percent)}% of the context window`}><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></span>}
      </>} />
      <UsageCard transcript={transcript} />
      {session.engine !== 'cursor' && <SubagentList sessionId={session.id} batches={batches} selectedCallId={selection?.callId} />}
      <BackgroundJobs sessionId={session.id} />
    </aside>
  );
}
