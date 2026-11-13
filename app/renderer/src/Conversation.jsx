import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Markdown, Spinner, fileBadgeKind, looksLikePath } from './ui.jsx';
import { changesOf, displayBlocks, formatTokens, isAbortText, retainWorkKeys, toolSummary, ultraProgress } from './transcript.js';
import { api, editMessage, isPendingSession, loadEarlierHistory, loadHistoryEntry, notify, openChanges, openFile, useStore } from './store.js';
import { VirtualHistory } from './VirtualHistory.jsx';
import { historyBookmark, restoreHistoryBookmark } from './history-scroll.js';
import { ImagePreview } from './ImagePreview.jsx';
import { DownloadButton, iconFor, sizeLabel } from './FilePane.jsx';
import { changeStats, hunkLines } from './diffs.js';
import { Composer } from './Composer.jsx';

// Disclosure state belongs to the transcript, not a transient grouped row. A streamed thought can
// become a work group, and groups can split when text arrives. Preserve the user's choices by step ID.
const DisclosureContext = createContext(null);
function useDisclosure(ids) {
  const { expanded, setExpanded, pauseFollowing } = useContext(DisclosureContext);
  const keys = Array.isArray(ids) ? ids : [ids];
  const open = keys.some(id => expanded[id]);
  const setOpen = action => {
    pauseFollowing();
    setExpanded(previous => {
      const next = typeof action === 'function' ? action(keys.some(id => previous[id])) : action;
      return { ...previous, ...Object.fromEntries(keys.map(id => [id, next])) };
    });
  };
  return [open, setOpen];
}
const groupIds = items => items.flatMap(item => item.kind === 'tools'
  ? item.calls.map(call => `group:tool:${call.id}`) : [`group:${item.key}`]);

const textOf = result => (result?.content ?? []).map(c => c.text ?? '').join('').replace(/\s+$/, '');

const baseOf = path => String(path ?? '').split('/').filter(Boolean).pop() ?? '';
// A command without a description, as a readable line: no leading "cd …;" / exports, no heredoc bodies.
const shortCommand = command => {
  const full = String(command ?? '').trim();
  const parts = full.split(/<<-?\s*['"]?\w+['"]?/);
  let c = parts[0].replace(/\s+/g, ' ').trim();
  if (parts.length > 1) c = c.replace(/\s+-$/, '') + ' script'; // "python3 - <<'EOF' …" reads "python3 script"
  c = c.replace(/^(?:(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)|export\s+[^;&]+|set\s+-\w+)\s*(?:&&|;)\s*)+/, '');
  return c || full;
};
// Text that fades out at the right edge when it does not fit (as in Claude), instead of an ellipsis.
function FadeText({ className = '', children, title }) {
  const ref = useRef(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);
  return <span ref={ref} className={`fade-text ${clipped ? 'clipped' : ''} ${className}`} title={title}>{children}</span>;
}

const urlLabel = url => {
  try {
    const u = new URL(url);
    const tail = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return (u.hostname + tail).slice(0, 96);
  } catch { return String(url ?? '').slice(0, 96); }
};

// How a step reads in a row: an icon, a short sentence, and (for files) the folder in grey.
function describeCall(call) {
  if (call.__trace?.status === 'skipped') return { subject: `${call.name} — not executed`, title: 'Output token limit: incomplete tool arguments were not executed.' };
  const a = call.arguments ?? {};
  const path = a.path ?? a.file_path ?? a.notebook_path ?? '';
  if (call.name?.startsWith('cursor_')) return { subject: a.description || call.name.slice(7), title: path || JSON.stringify(a) };
  if (call.name?.startsWith('mcp__')) {
    const [, server, method] = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(call.name) ?? [null, 'MCP', call.name.slice(5)];
    const hint = Object.values(a).find(v => typeof v === 'string' && v.trim());
    return { verb: `MCP · ${server}`, subject: method, detail: hint ? String(hint).split('\n')[0].slice(0, 64) : '', title: `${server} / ${method}` };
  }
  switch (call.name) {
    case 'subagent': return { verb: 'Subagents', subject: (a.tasks ?? []).map(t => t.name).join(' · '), title: 'Delegated tasks on this session’s machine' };
    case 'subagent_message': return { verb: 'Messaged agent', subject: a.message ?? '', detail: a.id, title: a.message };
    case 'subagent_stop': return { verb: 'Stopped agent', subject: a.id ?? '' };
    case 'Task': return { verb: a.subagent_type ? `Agent · ${a.subagent_type}` : 'Agent', subject: a.description || String(a.prompt ?? '').split('\n')[0].slice(0, 90) || 'Delegated task', title: a.prompt };
    case 'TodoWrite': return { verb: 'Updated tasks', subject: `${(a.todos ?? []).length} ${(a.todos ?? []).length === 1 ? 'item' : 'items'}` };
    case 'WebSearch': return { verb: 'Searched web', subject: a.query ?? '', detail: Array.isArray(a.allowed_domains) && a.allowed_domains[0] ? a.allowed_domains[0] : '' };
    case 'WebFetch': return { verb: 'Fetched', subject: urlLabel(a.url), detail: a.prompt ? String(a.prompt).split('\n')[0].slice(0, 60) : '', title: a.url };
    case 'Skill': return { verb: 'Used skill', subject: a.skill ? `/${String(a.skill).replace(/^\//, '')}` : 'skill', detail: a.args ?? '' };
    case 'Workflow': return { verb: 'Workflow', subject: a.description || a.name || String(a.prompt ?? '').split('\n')[0].slice(0, 80) || 'Run workflow' };
    case 'NotebookEdit': return { verb: 'Edited notebook', subject: baseOf(path), detail: a.edit_mode ?? '', title: path };
    case 'EnterPlanMode': return { verb: 'Entered plan mode', subject: '' };
    case 'ExitPlanMode': return { verb: 'Proposed plan', subject: String(a.plan ?? '').split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '' };
    case 'EnterWorktree': return { verb: 'Entered worktree', subject: a.name ?? a.path ?? '' };
    case 'ExitWorktree': return { verb: 'Exited worktree', subject: a.action ?? '' };
    case 'ToolSearch': return { verb: 'Loaded tools', subject: a.query ?? '' };
    case 'CronCreate': case 'ScheduleWakeup': return { verb: 'Scheduled', subject: String(a.prompt ?? a.reason ?? a.cron ?? '').split('\n')[0].slice(0, 80) };
    case 'CronDelete': return { verb: 'Cancelled schedule', subject: a.id ?? '' };
    case 'CronList': return { verb: 'Listed schedules', subject: '' };
    case 'Monitor': return { verb: 'Monitored', subject: a.description || shortCommand(a.command), title: a.command };
    case 'ListAgents': return { verb: 'Listed agents', subject: '' };
    case 'SendMessage': return { verb: 'Messaged', subject: a.to ?? a.recipient ?? 'agent', detail: String(a.message ?? a.content ?? '').split('\n')[0].slice(0, 60) };
    case 'ReportFindings': return { verb: 'Reported findings', subject: String(a.summary ?? a.findings ?? '').split('\n')[0].slice(0, 80) };
    case 'bash': return a.description?.trim() ? { subject: a.description.trim(), title: a.command } : { subject: shortCommand(a.command), title: a.command, raw: true };
    case 'read': return { verb: 'Read', subject: baseOf(path), title: path };
    case 'write': return { verb: 'Wrote', subject: baseOf(path), title: path };
    case 'edit': return { verb: 'Edited', subject: baseOf(path), title: path };
    case 'grep': return { verb: 'Searched for', subject: a.pattern ?? '', detail: a.path };
    case 'find': return { verb: 'Found files', subject: a.pattern ?? a.path ?? '' };
    case 'ls': return { verb: 'Listed', subject: a.path ?? '.' };
    default: return { verb: call.name, subject: JSON.stringify(a).slice(0, 160), raw: true };
  }
}

const editHunks = args => args?.edits ?? (args?.oldText !== undefined || args?.old_string !== undefined ? [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }] : []);
function EditDiff({ hunks }) {
  if (!hunks.length) return null;
  return (
    <div className="diff">
      {hunks.slice(0, 8).map((h, i) => (
        <div key={i} className="diff-hunk">
          {hunkLines(h).map((l, j) => l.type === 'gap' ? <div key={j} className="diff-line gap">⋯</div>
            : <div key={j} className={`diff-line ${l.type}`}><span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>{l.text}</div>)}
        </div>
      ))}
    </div>
  );
}

// Inline disclosure triangle, right after a row's text (as in Claude).
const Caret = ({ open }) => <Icon name={open ? 'caretDown' : 'caretRight'} size={14} className="step-caret" />;
const outputText = text => text.length > 8000 ? text.slice(0, 8000) + '\n…' : text;

function ToolCall({ call, tool }) {
  const [open, setOpen] = useDisclosure(`tool:${call.id}`);
  const { onOpenFile, sessionId } = useContext(DisclosureContext);
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef], open);
  const trace = call.__trace;
  const { verb, subject, detail, mono, title } = describeCall(call);
  const status = tool?.status ?? 'pending';
  const failed = ['error', 'cancelled', 'timed_out'].includes(status);
  const output = textOf(tool?.result);
  const shownOutput = tool?.fullHistory ? output : outputText(output);
  const filePath = call.__historyTruncated ? null : trace?.path ?? (['read', 'edit', 'write', 'cursor_edit', 'NotebookEdit'].includes(call.name) && !failed ? (call.arguments?.path ?? call.arguments?.file_path ?? call.arguments?.notebook_path) : null);
  const hunks = trace || call.__historyTruncated ? [] : call.name === 'edit' ? editHunks(call.arguments) : call.name === 'write' ? [{ oldText: null, newText: String(call.arguments?.content ?? '') }] : call.name === 'NotebookEdit' && call.arguments?.new_source != null ? [{ oldText: null, newText: String(call.arguments.new_source) }] : [];
  const stats = hunks.length && status !== 'error' ? changeStats({ hunks }) : null;
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path }));
  const a = call.arguments ?? {};
  const isMcp = call.name?.startsWith('mcp__');
  return (
    <div className={`step tool-call ${status} ${open ? 'open' : ''}`} data-tool-id={call.id}>
      <div className="step-head tool-call-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={e => { if ((e.metaKey || e.ctrlKey) && filePath) { openTarget(filePath); return; } setOpen(o => !o); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {status === 'running' && <Spinner size={12} />}
        <FadeText className="step-text" title={title ?? filePath ?? undefined}>
          {verb && <span className="step-verb">{verb}</span>}
          {filePath ? (
            <span className="step-subject file-ref-inline" data-kind={fileBadgeKind(filePath)}>{subject}</span>
          ) : (
            <span className={`step-subject ${mono ? 'mono' : ''}`}>{subject}</span>
          )}
          {detail && <span className="step-dir">{detail}</span>}
        </FadeText>
        {stats && <span className="step-stats">{stats.added > 0 && <span className="plus">+{stats.added}</span>}{stats.removed > 0 && <span className="minus">−{stats.removed}</span>}</span>}
        {trace?.durationMs != null && <span className="step-duration">{trace.durationMs < 1000 ? '<1s' : seconds(trace.durationMs)}</span>}
        {status === 'skipped' && <span className="step-duration">Skipped</span>}
        {failed && <span className="step-failed">{status === 'cancelled' ? 'Cancelled' : status === 'timed_out' ? 'Timed out' : 'Failed'}</span>}
        <Caret open={open} />
      </div>
      {open && (
        <div className="step-detail tool-detail">
          {detailState.pending ? <HistoryLoading {...detailState} /> : <>
          {(tool?.result?.content ?? []).filter(c => c.type === 'image' && c.data).map((image, i) => <ImagePreview key={i} src={`data:${image.mimeType};base64,${image.data}`} alt={`${call.name} image ${i + 1}`} />)}
          {trace && call.name !== 'bash' ? <>
            {trace.input && <pre className="tool-command">{call.name === 'bash' ? '$ ' : ''}{trace.input}</pre>}
            {output && <pre className={`tool-output boxed ${failed ? 'error' : ''}`}>{shownOutput}</pre>}
            {!output && status === 'running' && <div className="tool-running">Running…</div>}
          </> : call.name === 'bash'
            ? <div className={`tool-console ${status === 'error' ? 'error' : ''}`}>
                <pre className="tool-command"><span className="prompt">$</span> {a.command}</pre>
                {output && <pre className="tool-output">{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </div>
            : call.name === 'WebFetch' || call.name === 'WebSearch'
            ? <div className="cc-web-detail">
                {a.url && <button type="button" className="cc-web-link" onClick={() => api('openExternal', a.url)} title={a.url}><Icon name="globe" size={13} /><span>{a.url}</span><Icon name="externalLink" size={12} /></button>}
                {a.query && <div className="cc-meta-line"><span className="cc-meta-key">Query</span><span>{a.query}</span></div>}
                {a.prompt && <div className="cc-meta-line"><span className="cc-meta-key">Prompt</span><span>{a.prompt}</span></div>}
                {output && (status === 'error' ? <pre className="tool-output boxed error">{shownOutput}</pre> : <div className="step-markdown"><Markdown text={shownOutput} sessionId={sessionId} documentPath="" /></div>)}
                {!output && status === 'running' && <div className="tool-running">Fetching…</div>}
              </div>
            : call.name === 'ExitPlanMode' && a.plan
            ? <div className="step-markdown"><Markdown text={String(a.plan)} sessionId={sessionId} documentPath="" /></div>
            : isMcp || call.name === 'Skill' || call.name === 'Workflow'
            ? <div className="cc-structured-detail">
                {Object.keys(a).length > 0 && <pre className="tool-command">{JSON.stringify(a, null, 2)}</pre>}
                {output && <pre className={`tool-output boxed ${status === 'error' ? 'error' : ''}`}>{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </div>
            : <>
                {hunks.length > 0 && <EditDiff hunks={hunks} />}
                {output && call.name !== 'write' && (call.name !== 'edit' || status === 'error') && <pre className={`tool-output boxed ${status === 'error' ? 'error' : ''}`}>{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </>}
          {filePath && <button className="step-open" onClick={() => openTarget(filePath)}>Open {baseOf(filePath)}</button>}
          </>}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ calls, tools, live }) {
  const running = calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const [open, setOpen] = useDisclosure(calls.map(c => `group:tool:${c.id}`));
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(o => !o)}>
        {running && <Spinner size={12} />}
        <span>{toolSummary(calls)}</span>
        {failed > 0 && <span className="tool-failed">{failed} failed</span>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
      </button>
      {open && <div className="tool-group-body">{calls.map(call => <ToolCall key={call.id} call={call} tool={tools[call.id]} />)}</div>}
    </div>
  );
}

function ProgressReport({ call, tool, sessionId, live }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const report = ultraProgress(call, tool);
  if (detailState.pending && !report) return <HistoryLoading {...detailState} />;
  if (!report) return <ToolGroup calls={[call]} tools={{ [call.id]: tool }} live={live} />;
  return (
    <div className="ultra-progress" data-tool-id={call.id} role="group" aria-label="Progress update" title="Progress reported by the agent">
      <div className="ultra-progress-head"><span className="ultra-progress-dot" /><span>Progress</span></div>
      {report.done && <div className="ultra-progress-done"><Markdown text={report.done} sessionId={sessionId} documentPath="" /></div>}
      {(report.next || report.notes) && (
        <div className="ultra-progress-meta">
          {report.next && <div className="ultra-progress-row"><span className="ultra-progress-tag next">Next</span><div className="ultra-progress-cell"><Markdown text={report.next} sessionId={sessionId} documentPath="" /></div></div>}
          {report.notes && <div className="ultra-progress-row"><span className="ultra-progress-tag note">Scope</span><div className="ultra-progress-cell"><Markdown text={report.notes} sessionId={sessionId} documentPath="" /></div></div>}
        </div>
      )}
    </div>
  );
}

// One reasoning step inside a folded group: its first line, opening to the full text.
const firstLine = text => String(text ?? '').split('\n').map(l => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
const thoughtLabel = ms => ms > 800 ? `Thought for ${seconds(ms)}` : 'Thought';
const ReasoningTokens = ({ tokens }) => tokens > 0 ? <span className="reasoning-tokens" title="Reasoning tokens reported by the provider">{formatTokens(tokens)} tokens</span> : null;
function WorkNote({ item }) {
  const [open, setOpen] = useDisclosure(`note:${item.key}`);
  if (item.hidden || item.redacted || !item.text) return <div className="step static"><div className="step-head"><span className="step-text">{thoughtLabel(item.durationMs)}</span><ReasoningTokens tokens={item.tokens} /></div></div>;
  return (
    <div className={`step thought ${open ? 'open' : ''}`}>
      <div className="step-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {item.streaming && <Spinner size={12} />}
        <FadeText className="step-text">{open ? thoughtLabel(item.durationMs) : firstLine(item.text) || 'Thought'}</FadeText>
        <ReasoningTokens tokens={item.tokens} />
        <Caret open={open} />
      </div>
      {open && <div className="step-detail step-markdown"><HistoryContent historyRef={item.historyRef}><Markdown text={item.text} /></HistoryContent></div>}
    </div>
  );
}

// Consecutive steps folded into one line ("Ran 2 commands, edited plan.md (1 failed) +12"), opening to a card
// with one row per step.
function WorkGroup({ items, tools, live }) {
  const [open, setOpen] = useDisclosure(groupIds(items));
  const { onOpenFile, sessionId } = useContext(DisclosureContext);
  const calls = items.flatMap(i => i.kind === 'tools' ? i.calls : []);
  const running = items.some(i => i.streaming) || calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const thinkMs = items.reduce((n, i) => n + (i.kind === 'thinking' ? i.durationMs ?? 0 : 0), 0);
  const groupChanges = useMemo(() => changesOf([{ role: 'assistant', content: calls }], tools), [calls, tools]);
  const edits = useMemo(() => groupChanges.map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }), [groupChanges]);
  const only = calls.length === 1 ? describeCall(calls[0]) : null;
  const onlyCall = calls.length === 1 ? calls[0] : null;
  const onlyFile = onlyCall && !onlyCall.__historyTruncated && ['read', 'edit', 'write', 'cursor_edit', 'NotebookEdit'].includes(onlyCall.name) && tools[onlyCall.id]?.status !== 'error'
    ? (onlyCall.__trace?.path ?? onlyCall.arguments?.path ?? onlyCall.arguments?.file_path ?? onlyCall.arguments?.notebook_path) : null;
  const summary = (only && !only.mono && !only.raw ? [only.verb, only.subject].filter(Boolean).join(' ') : toolSummary(calls)) || (running ? '' : thoughtLabel(thinkMs));
  const latest = items.at(-1);
  const thinkingNow = running && latest?.kind === 'thinking' && latest.streaming;
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path }));
  return (
    <div className={`tool-group work ${open ? 'open' : ''}`}>
      <div className="tool-group-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={e => { if ((e.metaKey || e.ctrlKey) && onlyFile) { openTarget(onlyFile); return; } setOpen(o => !o); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {running && <Spinner size={12} />}
        <FadeText className={`group-summary ${thinkingNow ? 'shimmer' : ''}`}>
          {thinkingNow ? (firstLine(latest.text) || 'Thinking')
            : onlyFile && only?.verb ? <>
                <span>{only.verb} </span>
                <span className="file-ref-inline" data-kind={fileBadgeKind(onlyFile)}>{only.subject}</span>
              </>
            : (summary || 'Working')}
        </FadeText>
        {failed > 0 && <span className="group-failed">({failed} failed)</span>}
        {(edits.added > 0 || edits.removed > 0) && (
          <span className="group-diff-stats">
            {edits.added > 0 && <span className="plus">+{edits.added}</span>}
            {edits.removed > 0 && <span className="minus">−{edits.removed}</span>}
          </span>
        )}
        <Caret open={open} />
      </div>
      {onlyFile && sessionId && (
        <button type="button" className="work-quick-open" onClick={() => openTarget(onlyFile)}
          title={`Open ${onlyFile}`} aria-label={`Open ${only?.subject ?? onlyFile}`}>
          <Icon name="arrowUpRight" size={12} />
        </button>
      )}
      {!onlyFile && sessionId && groupChanges.length > 0 && (
        <button type="button" className="work-quick-open" onClick={() => openChanges(sessionId, groupChanges)}
          title="View changes" aria-label="View changes">
          <Icon name="fileDiff" size={12} />
        </button>
      )}
      {open && <div className="work-body">
        {items.flatMap(item => item.kind === 'tools'
          ? item.calls.map(call => <ToolCall key={call.id} call={call} tool={tools[call.id]} />)
          : [<WorkNote key={item.key} item={item} />])}
      </div>}
    </div>
  );
}

const seconds = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;

// Reasoning comes in four shapes: streamed in full, summarized by the provider, redacted, or hidden
// entirely (billed but never sent). Only the first two have text to open.
function Thinking({ text, streaming, redacted, hidden, durationMs, blockKey, tokens, historyRef }) {
  const [open, setOpen] = useDisclosure([`group:${blockKey}`, `note:${blockKey}`]);
  const label = durationMs > 800 ? `Thought for ${seconds(durationMs)}` : 'Thought';
  if (hidden || redacted || !text) {
    return <div className="thinking"><div className="tool-group-head static">{streaming ? <span className="shimmer">Thinking</span> : <span>{label}</span>}<ReasoningTokens tokens={tokens} /></div></div>;
  }
  const latest = streaming ? text.trim().split('\n').filter(l => l.trim()).at(-1)?.replace(/[*_`#>]/g, '').trim() : null;
  return (
    <div className="thinking">
      <button className="tool-group-head" onClick={() => setOpen(o => !o)}>
        {streaming ? <span className="shimmer thinking-latest">{latest || 'Thinking'}</span> : <span>{label}</span>}
        <ReasoningTokens tokens={tokens} />
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
      </button>
      {open && <div className="thinking-body"><HistoryContent historyRef={historyRef}><Markdown text={text} /></HistoryContent></div>}
    </div>
  );
}

// Claude Code's native subagent card (`Task` tool): live steps, file pills, token count, and final report.
function ClaudeTaskCard({ call, tool, sessionId }) {
  const [open, setOpen] = useDisclosure(`cc-task:${call.id}`);
  const { onOpenFile } = useContext(DisclosureContext);
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef], open);
  const a = call.arguments ?? {};
  const status = tool?.status ?? 'running';
  const running = status === 'running' || status === 'pending';
  const failed = ['error', 'cancelled', 'timed_out'].includes(status);
  const details = tool?.result?.details ?? {};
  const steps = Array.isArray(details.steps) ? details.steps.filter(s => s && (s.type === 'tool' || (s.type === 'text' && s.text?.trim()))) : [];
  const toolStepCount = steps.filter(s => s.type === 'tool').length;
  const stepCount = toolStepCount || details.stepCount || 0;
  const agentRun = details.agentRuns?.[0];
  const agentType = a.subagent_type || 'Agent';
  const title = a.description?.trim() || firstLine(a.prompt) || 'Delegated task';
  const output = textOf(tool?.result);
  const latestStep = steps.at(-1);
  const liveLine = running
    ? (latestStep?.type === 'tool'
        ? (() => { const d = describeCall({ name: latestStep.name, arguments: latestStep.arguments }); return [d.verb, d.subject].filter(Boolean).join(' '); })()
        : firstLine(latestStep?.text || output))
    : '';
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path }));
  return (
    <section className={`cc-task-card ${status} ${open ? 'open' : ''}`} data-tool-id={call.id} aria-label={`Agent task: ${title}`}>
      <button type="button" className="cc-task-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="cc-task-status">
          {running ? <Spinner size={13} /> : failed ? <Icon name="alert" size={14} className="cc-task-err" /> : <Icon name="check" size={14} className="cc-task-ok" />}
        </span>
        <span className="cc-task-badge">{agentType}</span>
        <FadeText className="cc-task-title" title={a.prompt || title}>{title}</FadeText>
        {stepCount > 0 && <span className="cc-task-meta">{stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>}
        {agentRun?.usage?.totalTokens > 0 && <span className="cc-task-meta">{formatTokens(agentRun.usage.totalTokens)} tok</span>}
        {tool?.durationMs != null && <span className="cc-task-meta">{tool.durationMs < 1000 ? '<1s' : seconds(tool.durationMs)}</span>}
        <Caret open={open} />
      </button>
      {running && !open && liveLine && (
        <div className="cc-task-live"><span className="shimmer">{liveLine}</span></div>
      )}
      {open && (
        <div className="cc-task-body">
          {detailState.pending ? <HistoryLoading {...detailState} /> : <>
            {a.prompt && <div className="cc-task-prompt"><span className="cc-meta-key">Brief</span><span>{a.prompt}</span></div>}
            {steps.length > 0 && (
              <div className="cc-task-steps">
                {steps.map((step, idx) => {
                  if (step.type === 'text') {
                    return <div key={idx} className="cc-task-step note"><FadeText>{firstLine(step.text)}</FadeText></div>;
                  }
                  const d = describeCall({ name: step.name, arguments: step.arguments });
                  const stepPath = ['read', 'edit', 'write', 'NotebookEdit'].includes(step.name)
                    ? (step.arguments?.path ?? step.arguments?.file_path ?? step.arguments?.notebook_path)
                    : null;
                  return (
                    <div key={step.id ?? idx} className="cc-task-step">
                      {d.verb && <span className="step-verb">{d.verb}</span>}
                      {stepPath ? (
                        <button type="button" className="file-ref-inline cc-step-file" data-kind={fileBadgeKind(stepPath)} title={stepPath} onClick={() => openTarget(stepPath)}>
                          {d.subject}
                        </button>
                      ) : (
                        <span className="step-subject">{d.subject}</span>
                      )}
                      {d.detail && <span className="step-dir">{d.detail}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {!running && output && (failed
              ? <pre className="tool-output boxed error">{outputText(output)}</pre>
              : <div className="cc-task-report"><Markdown text={output} sessionId={sessionId} documentPath="" /></div>)}
          </>}
        </div>
      )}
    </section>
  );
}

// Claude Code's `TodoWrite` checklist card.
function ClaudeTodoCard({ call, tool, live }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const todos = Array.isArray(call.arguments?.todos) ? call.arguments.todos.filter(Boolean) : [];
  if (detailState.pending && !todos.length) return <HistoryLoading {...detailState} />;
  if (!todos.length) return null;
  const doneCount = todos.filter(t => t.status === 'completed').length;
  const pct = Math.round((doneCount / todos.length) * 100);
  return (
    <section className="cc-todo-card" data-tool-id={call.id} aria-label="Task checklist">
      <div className="cc-todo-head">
        <Icon name="list" size={14} className="cc-todo-icon" />
        <span className="cc-todo-title">Tasks</span>
        <span className="cc-todo-count">{doneCount}/{todos.length}</span>
        <span className="meter"><span style={{ width: `${pct}%` }} /></span>
      </div>
      <ul className="cc-todo-list">
        {todos.map((item, i) => {
          const state = item.status === 'completed' ? 'completed' : item.status === 'in_progress' ? 'in_progress' : 'pending';
          const label = state === 'in_progress' && item.activeForm ? item.activeForm : item.content;
          return (
            <li key={item.id ?? i} className={`cc-todo-item ${state}`}>
              <span className="cc-todo-mark" aria-hidden="true">
                {state === 'completed'
                  ? <Icon name="check" size={12} />
                  : state === 'in_progress'
                    ? (live ? <Spinner size={11} /> : <span className="cc-todo-dot active" />)
                    : <span className="cc-todo-dot" />}
              </span>
              <span className="cc-todo-text">{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A question from Pi or Claude Code (ask_user, AskUserQuestion, ExitPlanMode), answered right in the conversation.
function QuestionCard({ sessionId, question }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(question.prefill ?? '');
  const [selected, setSelected] = useState([]);
  const send = async payload => {
    setBusy(true);
    try { await api('answer', sessionId, question.requestId, payload); } catch (e) { notify(e.message, 'error'); setBusy(false); }
  };
  const options = question.method === 'select' ? question.options ?? [] : [];
  const detailsByLabel = useMemo(() => new Map((question.optionDetails ?? []).map(o => [o.label, o.description])), [question.optionDetails]);
  const multi = question.method === 'select' && !!question.multiSelect;
  const freeText = question.method !== 'confirm';
  const toggleOption = option => setSelected(prev => prev.includes(option) ? prev.filter(x => x !== option) : [...prev, option]);
  const submitMulti = () => {
    const extra = text.trim();
    const values = extra ? [...selected, extra] : selected;
    if (values.length) send({ value: values });
  };
  return (
    <div className="question-card" role="group" aria-label="Question from agent">
      {question.header && <div className="question-header-chip">{question.header}</div>}
      <div className="question-title">{question.title}</div>
      {question.message && (question.method === 'confirm'
        ? <div className="question-message question-plan"><Markdown text={question.message} sessionId={sessionId} documentPath="" /></div>
        : <div className="question-message">{question.message}</div>)}
      {options.length > 0 && <div className="question-options">
        {options.map((option, i) => {
          const desc = detailsByLabel.get(option);
          const checked = multi && selected.includes(option);
          return (
            <button key={option} type="button" className={`question-option ${checked ? 'checked' : ''}`} disabled={busy}
              aria-pressed={multi ? checked : undefined}
              onClick={() => multi ? toggleOption(option) : send({ value: option })}>
              <span className={`question-key ${multi ? 'checkbox' : ''}`}>{multi ? (checked ? <Icon name="check" size={12} /> : '') : i + 1}</span>
              <span className="question-option-body">
                <span className="question-option-label">{option}</span>
                {desc && <span className="question-option-desc">{desc}</span>}
              </span>
            </button>
          );
        })}
      </div>}
      {freeText && <form className="question-input" onSubmit={e => {
        e.preventDefault();
        if (multi) submitMulti();
        else if (text.trim()) send({ value: text.trim() });
      }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={multi ? 'Other (optional)…' : options.length ? 'Something else…' : question.placeholder || 'Type your answer…'} disabled={busy} autoFocus={!options.length} />
        {multi
          ? <button type="submit" className="button primary small" disabled={busy || (!selected.length && !text.trim())}>Submit{selected.length ? ` (${selected.length})` : ''}</button>
          : <button type="submit" className="button primary small" disabled={busy || !text.trim()}>Send</button>}
      </form>}
      <div className="question-actions">
        {question.method === 'confirm'
          ? <><button className="button ghost" disabled={busy} onClick={() => send({ confirmed: false })}>No</button><button className="button primary" disabled={busy} onClick={() => send({ confirmed: true })}>Approve</button></>
          : <button className="button ghost small" disabled={busy} onClick={() => send({ cancelled: true })}>Skip</button>}
      </div>
    </div>
  );
}

// Under each finished reply: copy, and the files this turn changed (opens the change review).
function TurnFooter({ text, changes, sessionId, last }) {
  const [copied, setCopied] = useState(false);
  const totals = useMemo(() => (changes ?? []).map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }), [changes]);
  if (!text && !changes?.length) return null;
  return (
    <div className={`turn-foot ${last ? 'last' : ''}`}>
      {text && <button className="turn-action" aria-label="Copy reply" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /></button>}
      {changes?.length > 0 && <button className="changes-pill" onClick={() => openChanges(sessionId, changes)}>
        <Icon name="fileDiff" size={14} />{changes.length === 1 ? changes[0].path.split('/').pop() : `${changes.length} files changed`}
        <span className="plus">+{totals.added}</span><span className="minus">−{totals.removed}</span>
      </button>}
    </div>
  );
}

// Where /goal set an objective.
function GoalMarker({ objective }) {
  return <div className="goal-marker"><Icon name="target" size={15} /><span className="goal-marker-label">Goal</span><span className="goal-marker-text">{objective}</span></div>;
}

// Your text as typed, with list items ("1. …", "- …") given a hanging indent and @file mentions clickable.
const LIST_ITEM = /^(\s*)(\d+[.)]|[-*\u2022])\s+(.*)$/;
const MENTION_TOKEN = /(^|\s)@([\w./-]+(?:\/[\w./-]*)?)/g;
function renderInlineMentions(str) {
  if (!str || !str.includes('@')) return str;
  const parts = [];
  let last = 0, match;
  MENTION_TOKEN.lastIndex = 0;
  while ((match = MENTION_TOKEN.exec(str)) !== null) {
    const [, lead, candidate] = match;
    const tokenStart = match.index + lead.length;
    if (looksLikePath(candidate)) {
      if (tokenStart > last) parts.push(str.slice(last, tokenStart));
      const partsOfPath = candidate.split('/').filter(Boolean);
      const shortLabel = partsOfPath.length >= 2 && !candidate.endsWith('/') ? partsOfPath.at(-1) : candidate;
      parts.push(
        <span key={tokenStart} className="user-mention" data-kind={fileBadgeKind(candidate)} title={`Open ${candidate}`}
          onClick={() => window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: candidate }))}>@{shortLabel}</span>
      );
      last = tokenStart + 1 + candidate.length;
    }
  }
  if (!parts.length) return str;
  if (last < str.length) parts.push(str.slice(last));
  return parts;
}
function UserText({ text }) {
  const lines = text.split('\n');
  const width = m => m[1].replace(/\t/g, '   ').length;
  const items = lines.map(l => LIST_ITEM.exec(l));
  if (!items.some(Boolean)) return renderInlineMentions(text);
  const base = Math.min(...items.filter(Boolean).map(width)); // the shallowest item is the top level
  return lines.map((line, i) => {
    const m = items[i];
    if (!m) return <div key={i} className="ub-line">{line ? renderInlineMentions(line) : '\u00a0'}</div>;
    const depth = Math.floor((width(m) - base) / 3);
    return <div key={i} className="ub-li" style={{ '--depth': depth }}><span className="ub-marker">{/\d/.test(m[2]) ? m[2] : '•'}</span>{renderInlineMentions(m[3])}</div>;
  });
}

// A message you sent: images and files it carried, and (on hover) copy and edit.
function UserMessage({ block, sessionId, editable }) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  if (editing) {
    return (
      <div className="user-row editing">
        <Composer autoFocus compact initialText={block.text} placeholder="Edit message" onCancel={() => setEditing(false)}
          onSubmit={async (text, attachments) => {
            const images = (block.images ?? []).map(img => ({ kind: 'image', name: 'image', mimeType: img.mimeType, data: img.data }));
            const files = (block.files ?? []).map(path => ({ kind: 'file', name: path.split('/').pop(), path }));
            setEditing(false);
            await editMessage(sessionId, block.entryId ?? block.ordinal, block.text, text, [...images, ...files, ...attachments]);
          }} />
      </div>
    );
  }
  return (
    <div className="user-row">
      <div className="user-stack">
        {block.images?.length > 0 && <div className="user-images">{block.images.map((img, i) => <ImagePreview key={i} src={`data:${img.mimeType};base64,${img.data}`} alt={`Attached image ${i + 1}`} />)}</div>}
        {block.files?.length > 0 && <div className="user-files">{block.files.map(path => <button key={path} className="attachment file" title={path} onClick={() => window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path }))}><Icon name="fileAny" size={15} /><span>{path.split('/').pop()}</span></button>)}</div>}
        {block.text && <div className="user-bubble"><UserText text={block.text} /></div>}
        <div className="user-actions">
          <button className="turn-action" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(block.text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
          {editable && <button className="turn-action" aria-label="Edit message" title="Edit" onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>}
        </div>
      </div>
    </div>
  );
}

// Where Pi summarized the earlier conversation (automatically, on return after the cache expired, or by hand).
function CompactionMarker({ summary, tokensBefore, blockKey, historyRef }) {
  const [open, setOpen] = useDisclosure(`compaction:${blockKey}`);
  return (
    <div className="compaction">
      <button className="compaction-line" onClick={() => setOpen(o => !o)}>
        <span className="compaction-rule" />
        <span className="compaction-label"><Icon name="compact" size={14} /> Conversation compacted{tokensBefore ? ` · ${formatTokens(tokensBefore)} → summary` : ''}<Icon name={open ? 'caretDown' : 'caretRight'} size={13} /></span>
        <span className="compaction-rule" />
      </button>
      {open && <div className="compaction-body"><HistoryContent historyRef={historyRef}><Markdown text={summary ?? ''} /></HistoryContent></div>}
    </div>
  );
}

function AskBlock({ call, tool }) {
  const answer = textOf(tool?.result).replace(/^The user answered: /, '');
  return (
    <div className="ask-block">
      <div className="ask-q"><Icon name="question" size={15} /> {call.arguments?.question}</div>
      <div className="ask-a">{answer}</div>
    </div>
  );
}

// While Pi or Claude Code works: what it is doing, for how long, and how many tokens it has produced this turn.
function WorkingRow({ session, transcript }) {
  const [, tick] = useState(0);
  const envPrep = useStore(s => session?.environmentId ? s.envStatus[session.environmentId] : null);
  const ccPrep = useStore(s => session?.environmentId ? s.claudeStatus[session.environmentId] : null);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  if (session?.status === 'connecting') {
    const isClaude = session.engine === 'claude-code';
    const preparingText = session.statusMessage
      || (isClaude && ccPrep?.status === 'preparing' ? ccPrep.message : null)
      || (envPrep?.status === 'preparing' ? envPrep.message : null)
      || (isClaude ? 'Preparing Claude Code…' : 'Preparing remote environment…');
    const phase = {
      preparing: preparingText,
      starting: isClaude ? 'Starting Claude Code…' : 'Starting Pi…',
      configuring: 'Restoring session…',
    }[session.phase] ?? 'Connecting…';
    return <div className="working"><span className="working-dot" /><span className="shimmer">{phase}</span></div>;
  }
  const messages = transcript.messages;
  let from = messages.length; while (from > 0 && messages[from - 1].role !== 'user') from--;
  const turn = messages.slice(from);
  const startedAt = messages[from - 1]?.timestamp ?? turn[0]?.__timing?.start ?? transcript.live?.__t0;
  const live = transcript.live;
  // Real output tokens of the model calls finished so far this turn (no live estimate).
  const tokens = turn.reduce((n, m) => n + (m.role === 'assistant' ? m.usage?.output ?? 0 : 0), 0);
  const lastBlock = live?.content?.filter(Boolean).at(-1);
  const pending = messages.at(-1)?.__optimistic;
  const state = pending ? 'Interrupting…'
    : session?.compacting || transcript.compacting ? 'Compacting conversation'
    : transcript.retry ? `Reconnecting to model · retry ${transcript.retry.attempt}/${transcript.retry.maxAttempts}`
    : !live || !live.content?.length || lastBlock?.type === 'thinking' ? 'Thinking'
    : lastBlock?.type === 'toolCall' ? 'Working' : 'Writing';
  const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  return (
    <div className="working">
      <span className="working-dot" />
      {elapsed >= 1000 && <span className="working-meta">{seconds(elapsed)}</span>}
      {tokens > 0 && <span className="working-meta">{formatTokens(tokens)} tokens</span>}
      <span className="shimmer">{session?.activityLabel ?? state}</span>
    </div>
  );
}

const NO_QUESTIONS = [];
// Files the agent handed over with present_files: open one in the file pane, or save it to this Mac.
function FileCards({ sessionId, call, tool }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const details = tool?.result?.details;
  const files = details?.kind === 'pidesk-files' && Array.isArray(details.files) ? details.files : null;
  if (tool?.status === 'error') {
    const text = (tool.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return <div className="block-error"><Icon name="alert" size={15} /> {text || 'The files could not be shown.'}</div>;
  }
  // Until the result arrives: the paths the model named, without sizes.
  const shown = files ?? (Array.isArray(call.arguments?.paths) ? call.arguments.paths : []).map(path => ({ path: String(path), name: String(path).split('/').pop(), pending: true }));
  if (detailState.pending) return <HistoryLoading {...detailState} />;
  if (!shown.length) return null;
  return (
    <section className="file-cards" data-call-id={call.id}>
      {details?.caption && <div className="file-cards-caption">{details.caption}</div>}
      {shown.map(file => (
        <div key={file.path} className="file-card">
          {!file.pending && sessionId && iconFor(file.name) === 'fileImage' && <PresentedImage sessionId={sessionId} file={file} />}
          <button className="file-card-main" disabled={file.pending || !sessionId} onClick={() => openFile(sessionId, file.path)} title={file.path}>
            <Icon name={iconFor(file.name)} size={18} className="file-card-icon" />
            <span className="file-card-text"><span className="file-card-name">{file.name}</span><span className="file-card-meta">{file.pending ? 'Preparing…' : sizeLabel(file.size)}</span></span>
          </button>
          {!file.pending && sessionId && <DownloadButton sessionId={sessionId} path={file.path} className="file-card-download" label={<span>Download</span>} />}
        </div>
      ))}
    </section>
  );
}

function useHistoryDetails(refs, enabled = true) {
  const { sessionId } = useContext(DisclosureContext);
  const key = JSON.stringify(refs.filter(Boolean));
  const [error, setError] = useState(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!enabled || !sessionId || key === '[]') return;
    let alive = true;
    setError(null);
    Promise.all(JSON.parse(key).map(ref => loadHistoryEntry(sessionId, ref))).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [sessionId, key, enabled, attempt]);
  return { pending: key !== '[]', error, retry: () => retry(n => n + 1) };
}

function HistoryLoading({ error, retry }) {
  return error ? <button className="history-retry" title={error} onClick={retry}><Icon name="refresh" size={14} /> Retry</button>
    : <span className="history-loading" role="status" aria-label="Loading content"><Spinner /></span>;
}

function HistoryContent({ historyRef, active = true, children }) {
  const detailState = useHistoryDetails([historyRef], active);
  return detailState.pending ? <HistoryLoading {...detailState} /> : children;
}

function PresentedImage({ sessionId, file }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let alive = true;
    api('readFile', sessionId, file.path).then(result => { if (alive) setPreview(result); }, error => { if (alive) setPreview({ error: error.message }); });
    return () => { alive = false; };
  }, [sessionId, file.path]);
  if (!preview) return <Spinner />;
  return preview.dataUrl ? <ImagePreview src={preview.dataUrl} alt={file.name} onOpen={() => openFile(sessionId, file.path)} />
    : <span className="markdown-image-error" title={preview.error ?? 'Image too large to preview'}>Could not load image</span>;
}

export function Transcript({ session, transcript, questions = NO_QUESTIONS, readOnly = false, onOpenFile, renderSubagents, renderAgentReport, copyText }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const scrollIntent = useRef(false);
  const bookmark = useRef([]);
  const previousTop = useRef(0);
  const initialFill = useRef(0);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState({});
  // "Latest" appears only when there is unseen content below — not merely because you opened a step.
  const updateLatest = () => {
    const el = scroller.current;
    if (el) setFollowing(stick.current || el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const pauseFollowing = useCallback(() => {
    stick.current = false;
    scrollIntent.current = false;
    bookmark.current = historyBookmark(scroller.current);
  }, []);
  const followLatest = () => {
    stick.current = true;
    setFollowing(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  };
  const committed = useRef({ sessionId: session?.id, blocks: [] });
  const blocks = useMemo(() => retainWorkKeys(committed.current.sessionId === session?.id ? committed.current.blocks : [], displayBlocks(transcript)), [transcript, session?.id]);
  useLayoutEffect(() => { committed.current = { sessionId: session?.id, blocks }; }, [blocks, session?.id]);
  const earlier = async () => {
    const el = scroller.current;
    if (!el || !transcript.history?.next || transcript.history.loading) return;
    pauseFollowing();
    await loadEarlierHistory(session.id);
  };
  const lastUsage = blocks.findLast(b => b.kind === 'usage');
  const onScroll = e => {
    // Output panes also scroll. Their events must not re-enable transcript auto-follow.
    if (e.target !== scroller.current) return;
    const el = scroller.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const movedUp = el.scrollTop < previousTop.current;
    const moved = Math.abs(el.scrollTop - previousTop.current) > 1;
    previousTop.current = el.scrollTop;
    if (moved) {
      stick.current = atBottom;
      if (!atBottom) bookmark.current = historyBookmark(el);
    }
    if (el.scrollTop < el.clientHeight * 3 && movedUp && scrollIntent.current && transcript.history?.next) earlier();
    scrollIntent.current = false;
    updateLatest();
  };
  const retainPosition = () => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    else restoreHistoryBookmark(scroller.current, bookmark.current);
    if (stick.current) bookmark.current = historyBookmark(scroller.current);
    previousTop.current = scroller.current?.scrollTop ?? 0;
    updateLatest();
  };
  const retainRef = useRef(retainPosition); retainRef.current = retainPosition;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (el.clientHeight) retainRef.current(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(retainPosition, [blocks, questions]);
  useEffect(() => { initialFill.current = 0; setExpanded({}); followLatest(); }, [session?.id]);
  useEffect(() => {
    const el = scroller.current;
    if (readOnly || !session?.id || !transcript.loaded || !transcript.history?.next || transcript.history.loading || transcript.history.error || !stick.current || initialFill.current >= 8) return;
    // A page full of folded tool calls may occupy only a few lines. Fill a useful
    // reading window in the background instead of exposing tiny raw-record pages.
    if (el?.clientHeight > 0 && el.scrollHeight < el.clientHeight * 3) {
      initialFill.current++;
      void loadEarlierHistory(session.id, { background: true });
    }
  }, [blocks, transcript.history, transcript.loaded, session?.id, readOnly]);
  const disclosure = useMemo(() => ({ expanded, setExpanded, pauseFollowing, onOpenFile, sessionId: session?.id }), [expanded, pauseFollowing, onOpenFile, session?.id]);
  const working = session?.streaming || session?.compacting || transcript.compacting || session?.status === 'connecting';
  // Only while there is nothing to show yet: history now comes from the session file while Pi starts, and
  // a new conversation already shows your message.
  const loading = !transcript.error && !transcript.loaded;
  return (
    <DisclosureContext.Provider value={disclosure}>
    <div className="transcript-shell">
    <div className="transcript" ref={scroller} onScroll={onScroll}
      onWheelCapture={e => {
        if (e.target.closest('.tool-output, .tool-command, .diff')) { pauseFollowing(); return; }
        if (e.deltaY < 0) {
          pauseFollowing();
          if (scroller.current && scroller.current.scrollTop < scroller.current.clientHeight * 3) earlier();
        }
        scrollIntent.current = true;
      }}
      onPointerDown={e => { if (e.target === scroller.current) scrollIntent.current = true; }}
      onPointerMove={e => { if (e.buttons && e.target === scroller.current) scrollIntent.current = true; }}
      onKeyDown={e => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) scrollIntent.current = true;
      }}>
      <div className="transcript-inner">
        {transcript.error && (isAbortText(transcript.error)
          ? <div className="block-notice" title="Interrupted"><FadeText>Interrupted</FadeText></div>
          : <div className="block-error"><Icon name="alert" size={15} /> {transcript.error}</div>)}
        {transcript.history?.next && <div className="history-boundary" data-loading={!!transcript.history.loading} aria-busy={!!transcript.history.loading} />}
        {transcript.history?.warning && <div className="block-notice" title={transcript.history.warning}><FadeText>{transcript.history.warning}</FadeText></div>}
        <VirtualHistory items={blocks} scroller={scroller} onMeasure={retainPosition} renderItem={(block, active) => {
          const render = () => {
          switch (block.kind) {
            case 'orphanResult': return <ToolCall key={block.key} call={{ id: block.message.toolCallId, name: block.message.toolName ?? 'tool', arguments: { description: 'Command result' } }} tool={transcript.tools[block.message.toolCallId]} />;
            case 'pendingHistory': return null;
            case 'image': return <ImagePreview key={block.key} src={`data:${block.image.mimeType};base64,${block.image.data}`} alt="Assistant image" />;
            case 'user': return <UserMessage key={block.key} block={block} sessionId={session?.id} editable={!block.truncated && (!transcript.history || !!block.entryId) && !readOnly && session?.engine !== 'cursor' && !!session && !isPendingSession(session.id) && session.status === 'connected' && !session.streaming && !block.text.startsWith('/')} />;
            case 'goal': return <GoalMarker key={block.key} objective={block.objective} />;
            case 'text': return <Markdown key={block.key} text={block.text} streaming={block.streaming} sessionId={session?.id} documentPath="" />;
            case 'usage': return <TurnFooter key={block.key} text={block.text} changes={readOnly ? [] : block.changes} sessionId={session?.id} last={block === lastUsage} />;
            case 'compaction': return <CompactionMarker key={block.key} {...block} blockKey={block.key} />;
            case 'thinking': return <Thinking key={block.key} {...block} blockKey={block.key} />;
            case 'work': return <WorkGroup key={block.key} items={block.items} tools={transcript.tools} live={!!transcript.live} />;
            case 'tools': return <ToolGroup key={block.key} calls={block.calls} tools={transcript.tools} live={!!transcript.live} />;
            case 'subagents': return renderSubagents?.(block);
            case 'ccTask': return <ClaudeTaskCard key={block.key} call={block.call} tool={transcript.tools[block.call.id]} sessionId={session?.id} />;
            case 'ccTodo': return <ClaudeTodoCard key={block.key} call={block.call} tool={transcript.tools[block.call.id]} live={working} />;
            case 'progress': return <ProgressReport key={block.key} call={block.call} tool={transcript.tools[block.call.id]} sessionId={session?.id} live={!!transcript.live} />;
            case 'files': return <FileCards key={block.key} sessionId={readOnly ? null : session?.id} call={block.call} tool={transcript.tools[block.call.id]} />;
            case 'agentReports': return renderAgentReport?.(block) ?? null;
            case 'ask': return transcript.tools[block.call.id]?.status === 'done' ? <AskBlock key={block.key} call={block.call} tool={transcript.tools[block.call.id]} /> : null;
            case 'bash': return <pre key={block.key} className="tool-output">$ {block.message.command}{'\n'}{block.message.output}</pre>;
            case 'error': return <div key={block.key} className="block-error"><Icon name="alert" size={15} /> {block.text}</div>;
            case 'notice': return <div key={block.key} className="block-notice" title={block.text}><FadeText>{block.text}</FadeText></div>;
            default: return null;
          }
          };
          const automatic = ['text', 'user', 'goal', 'bash', 'notice', 'pendingHistory', 'image'].includes(block.kind);
          return <HistoryContent key={block.key} historyRef={automatic ? block.historyRef : null} active={active}>{render()}</HistoryContent>;
        }} />
        {readOnly && copyText && <TurnFooter text={copyText} last />}
        {(transcript.queued ?? []).map(q => (
          <div key={q.id} className="user-row queued" aria-label="Queued message">
            <div className="user-stack">
              {q.images?.length > 0 && <div className="user-images">{q.images.map((img, i) => <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" />)}</div>}
              {q.text && <div className="user-bubble"><UserText text={q.text} /></div>}
            </div>
          </div>
        ))}
        {questions.map(q => <QuestionCard key={q.requestId} sessionId={session.id} question={q} />)}
        {working && !loading && !questions.length && <WorkingRow session={session} transcript={transcript} />}
        <div className="transcript-end" />
      </div>
    </div>
    {!following && <button className="transcript-follow" aria-label="Jump to latest" onClick={followLatest}><Icon name="arrowDown" size={15} /> Latest</button>}
    {loading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><Spinner size={26} /></div>}
    </div>
    </DisclosureContext.Provider>
  );
}
