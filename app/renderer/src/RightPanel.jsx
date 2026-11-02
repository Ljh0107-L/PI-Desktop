import { useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { useResizable } from './ui.jsx';
import { formatTokens, usageOf } from './transcript.js';
import { useStore } from './store.js';
import { subagentBatches } from './subagent-state.js';
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

const fmtTps = (v, estimated) => v == null ? '—' : `${estimated ? '~' : ''}${v >= 100 ? Math.round(v) : v.toFixed(1)}`;

// Speed and token usage per turn, where a turn is one model call (one assistant message): the last turn's
// speed with a trend of recent turns, and input / cached / output tokens for the last turn and the session.
// Figures update as each turn finishes.
function UsageCard({ transcript }) {
  const turns = (transcript?.messages ?? []).filter(m => m.role === 'assistant' && m.usage && m.stopReason !== 'error' && m.stopReason !== 'aborted').map(m => usageOf([m]));
  if (!turns.length) return null;
  const last = turns.at(-1);
  const total = usageOf(transcript.messages);
  // Measured speed only (provider token counts ÷ generation time), updated when a reply finishes.
  const recent = turns.slice(-14).map(t => t.tps).filter(v => v != null);
  const speed = last.tps; // Don't present an older call's speed as this one's when timing is missing.
  const speedEstimated = last.speedEstimated;
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
          <div className="usage-speed-value" title={speedEstimated ? "Estimated: the provider reported too few output tokens; speed uses the visible answer text. Output tokens ÷ first→last generation window (or API duration when timing is unavailable)." : "Output tokens ÷ first→last generation window; falls back to full API duration when timing is unavailable or a relay replay is detected."}><b>{fmtTps(speed, speedEstimated)}</b><span>tok/s</span></div>
          <div className="spark" aria-hidden="true">{recent.map((v, i) => <span key={i} style={{ height: `${Math.max(8, v / peak * 100)}%` }} />)}</div>
        </div>
        <div className="usage-table">
          <span /><span className="th">Last turn</span><span className="th">Session</span>
          {rows.flatMap(([label, a, b]) => [<span key={label} className="td-label">{label}</span>, <span key={label + 'a'}>{formatTokens(a)}</span>, <span key={label + 'b'}>{formatTokens(b)}</span>])}
          <span className="td-label">Cache hit</span><span>{last.cacheHit == null ? '—' : `${Math.round(last.cacheHit * 100)}%`}</span><span>{total.cacheHit == null ? '—' : `${Math.round(total.cacheHit * 100)}%`}</span>
        </div>
      </div>
    </Card>
  );
}

export function RightPanel({ session }) {
  const transcript = useStore(s => s.transcripts[session.id]);
  const stats = useStore(s => s.stats[session.id]);
  const selection = useStore(s => s.subagentSelection[session.id]);
  const batches = useMemo(() => subagentBatches(transcript), [transcript]);
  const batch = batches.find(b => b.callId === selection?.callId);
  const task = Number.isInteger(selection?.taskIndex) ? batch?.tasks[selection.taskIndex] : null;
  const [detailWidth, detailHandle] = useResizable('subagent-inspector', 420, 300, 680, 'left');
  const percent = stats?.contextUsage?.percent ?? null;
  if (task) return <aside className="right-panel subagent-inspector" style={{ width: detailWidth }}>
    {detailHandle}<SubagentDetail key={`${session.id}:${task.key}`} sessionId={session.id} task={task} />
  </aside>;
  return (
    <aside className="right-panel">
      <Card title="Context" aside={<>
        <span className="muted">{stats?.contextUsage?.tokens != null ? `${formatTokens(stats.contextUsage.tokens)} / ${formatTokens(stats.contextUsage.contextWindow)}` : '—'}</span>
        <span className="meter" title={percent == null ? undefined : `${Math.round(percent)}% of the context window`}><span style={{ width: `${percent > 0 ? Math.max(6, Math.min(100, percent)) : 0}%` }} /></span>
      </>} />
      <UsageCard transcript={transcript} />
      <SubagentList sessionId={session.id} batches={batches} selectedCallId={selection?.callId} />
    </aside>
  );
}
