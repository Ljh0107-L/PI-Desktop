import { useState } from 'react';
import { Icon } from './Icons.jsx';
import { baseName, envIcon, shortPath } from './ui.jsx';
import { formatTokens, outputs, turnUsages, usageOf } from './transcript.js';
import { api, openFile, useStore } from './store.js';

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

const fmtTps = v => v == null ? '—' : v >= 100 ? String(Math.round(v)) : v.toFixed(1);

// Speed and token usage: the live/last reply's speed with a trend of recent replies, and input / cached /
// output tokens for the last reply and the whole session.
function UsageCard({ transcript }) {
  const turns = turnUsages(transcript?.messages ?? []);
  if (!turns.length) return null;
  const last = turns.at(-1);
  const total = usageOf(transcript.messages);
  // Measured speed only (provider token counts ÷ generation time), updated when a reply finishes.
  const recent = turns.slice(-14).map(t => t.tps).filter(v => v != null);
  const speed = [...turns].reverse().find(t => t.tps != null)?.tps ?? null;
  const peak = Math.max(...recent, 1);
  const rows = [
    ['Input', last.input + last.cacheWrite, total.input + total.cacheWrite],
    ['Cached', last.cacheRead, total.cacheRead],
    ['Output', last.output, total.output],
    ...(total.reasoningReported && total.reasoning > 0 ? [['Reasoning', last.reasoning, total.reasoning]] : []),
  ];
  return (
    <Card title="Usage">
      <div className="usage">
        <div className="usage-speed">
          <div className="usage-speed-value"><b>{fmtTps(speed)}</b><span>tok/s</span></div>
          <div className="spark" aria-hidden="true">{recent.map((v, i) => <span key={i} style={{ height: `${Math.max(8, v / peak * 100)}%` }} />)}</div>
        </div>
        <div className="usage-table">
          <span /><span className="th">Last reply</span><span className="th">Session</span>
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
  const branch = useStore(s => s.branches[session.id]);
  const env = useStore(s => s.environments.find(e => e.id === session.environmentId));
  const home = useStore(s => s.home);
  const [showAll, setShowAll] = useState(false);
  const files = transcript ? outputs(transcript) : [];
  const percent = stats?.contextUsage?.percent ?? null;
  const local = session.environmentId === 'local';
  const statusLabel = { connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', disconnected: 'Disconnected', error: 'Unavailable' }[session.status];
  return (
    <aside className="right-panel">
      <Card title="Environment">
        <div className="panel-row"><Icon name={envIcon(env ?? { kind: local ? 'local' : 'ssh' })} size={18} /><span className="panel-row-text">{session.environmentLabel}</span>
          {statusLabel && <span className={`status-dot ${session.status}`} title={statusLabel} />}</div>
        <div className="panel-row" title={session.cwd}><Icon name="folder" size={18} /><span className="panel-row-text">{baseName(session.cwd)} <span className="muted">· {local ? shortPath(session.cwd, home).replace(/\/[^/]+$/, '') || '~' : session.cwd.replace(/\/[^/]+$/, '')}</span></span></div>
        {branch && <div className="panel-row"><Icon name="branch" size={18} /><span className="panel-row-text">{branch}</span></div>}
      </Card>
      <Card title="Context" aside={<>
        <span className="muted">{stats?.contextUsage?.tokens != null ? `${formatTokens(stats.contextUsage.tokens)} / ${formatTokens(stats.contextUsage.contextWindow)}` : '—'}</span>
        <span className="meter" title={percent == null ? undefined : `${Math.round(percent)}% of the context window`}><span style={{ width: `${percent > 0 ? Math.max(6, Math.min(100, percent)) : 0}%` }} /></span>
      </>} />
      <UsageCard transcript={transcript} />
      {files.length > 0 && <Card title="Outputs">
        {(showAll ? files : files.slice(0, 5)).map(f => (
          <button key={f.path} className="panel-row file" title={f.path} onClick={() => openFile(session.id, f.path)}>
            <Icon name={f.tool === 'edit' ? 'fileEdit' : 'file'} size={18} /><span className="panel-row-text">{baseName(f.path)}</span>
          </button>
        ))}
        {files.length > 5 && <button className="panel-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show less' : 'Show more'}</button>}
      </Card>}
    </aside>
  );
}
