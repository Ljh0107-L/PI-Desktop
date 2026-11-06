import { useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { useResizable } from './ui.jsx';
import { formatTokens, MIN_SPEED_TOKENS, speedDisplay, speedReply, speedTier, usageOf } from './transcript.js';
import { useStore } from './store.js';
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
  // Speed: the latest reply long enough to time. A few-token reply after a tool call is noise.
  const speedMessage = speedReply(messages);
  const timed = speedMessage === lastMessage ? last : usageOf([speedMessage]);
  // Compare like with like: no mixing providers/models, answer-only/full generation scopes,
  // or estimated and reported token numerators in one unlabelled trend.
  const recent = messages.slice(-14).filter(m => m.provider === speedMessage.provider && (m.responseModel ?? m.model) === (speedMessage.responseModel ?? speedMessage.model) && (m.usage?.output ?? 0) >= MIN_SPEED_TOKENS)
    .map(m => usageOf([m])).filter(u => u.tps != null && u.speedBasis === timed.speedBasis && u.speedScope === timed.speedScope && u.speedTokensEstimated === timed.speedTokensEstimated).map(u => u.tps);
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
    </aside>
  );
}
