import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Markdown, Spinner } from './ui.jsx';
import { changesOf, displayBlocks, formatTokens, toolSummary } from './transcript.js';
import { api, editMessage, notify, openChanges } from './store.js';
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

// How a step reads in a row: an icon, a short sentence, and (for files) the folder in grey.
function describeCall(call) {
  const a = call.arguments ?? {};
  const path = a.path ?? a.file_path ?? '';
  switch (call.name) {
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
  const { verb, subject, detail, mono, title } = describeCall(call);
  const status = tool?.status ?? 'pending';
  const output = textOf(tool?.result);
  const filePath = ['read', 'edit', 'write'].includes(call.name) && status !== 'error' ? (call.arguments?.path ?? call.arguments?.file_path) : null;
  const hunks = call.name === 'edit' ? editHunks(call.arguments) : call.name === 'write' ? [{ oldText: null, newText: String(call.arguments?.content ?? '') }] : [];
  const stats = hunks.length && status !== 'error' ? changeStats({ hunks }) : null;
  return (
    <div className={`step tool-call ${status} ${open ? 'open' : ''}`} data-tool-id={call.id}>
      <div className="step-head tool-call-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {status === 'running' && <Spinner size={12} />}
        <FadeText className="step-text" title={title ?? filePath ?? undefined}>
          {verb && <span className="step-verb">{verb}</span>}
          <span className={`step-subject ${mono ? 'mono' : ''}`}>{subject}</span>
          {detail && <span className="step-dir">{detail}</span>}
        </FadeText>
        {stats && <span className="step-stats">{stats.added > 0 && <span className="plus">+{stats.added}</span>}{stats.removed > 0 && <span className="minus">−{stats.removed}</span>}</span>}
        {status === 'error' && <span className="step-failed">Failed</span>}
        <Caret open={open} />
      </div>
      {open && (
        <div className="step-detail tool-detail">
          {call.name === 'bash'
            ? <div className={`tool-console ${status === 'error' ? 'error' : ''}`}>
                <pre className="tool-command"><span className="prompt">$</span> {call.arguments?.command}</pre>
                {output && <pre className="tool-output">{outputText(output)}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </div>
            : <>
                {hunks.length > 0 && <EditDiff hunks={hunks} />}
                {output && call.name !== 'write' && (call.name !== 'edit' || status === 'error') && <pre className={`tool-output boxed ${status === 'error' ? 'error' : ''}`}>{outputText(output)}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </>}
          {filePath && <button className="step-open" onClick={() => window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: filePath }))}>Open {baseOf(filePath)}</button>}
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
      {open && <div className="step-detail step-markdown"><Markdown text={item.text} /></div>}
    </div>
  );
}

// Consecutive steps folded into one line ("Ran 2 commands, edited plan.md (1 failed) +12"), opening to a card
// with one row per step.
function WorkGroup({ items, tools, live }) {
  const [open, setOpen] = useDisclosure(groupIds(items));
  const calls = items.flatMap(i => i.kind === 'tools' ? i.calls : []);
  const running = items.some(i => i.streaming) || calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const thinkMs = items.reduce((n, i) => n + (i.kind === 'thinking' ? i.durationMs ?? 0 : 0), 0);
  const edits = changesOf([{ role: 'assistant', content: calls }], tools).map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 });
  const only = calls.length === 1 ? describeCall(calls[0]) : null;
  const summary = (only && !only.mono && !only.raw ? [only.verb, only.subject].filter(Boolean).join(' ') : toolSummary(calls)) || (running ? '' : thoughtLabel(thinkMs));
  const latest = items.at(-1);
  const thinkingNow = running && latest?.kind === 'thinking' && latest.streaming;
  return (
    <div className={`tool-group work ${open ? 'open' : ''}`}>
      <div className="tool-group-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {running && <Spinner size={12} />}
        <FadeText className={`group-summary ${thinkingNow ? 'shimmer' : ''}`}>{thinkingNow ? firstLine(latest.text) || 'Thinking' : summary || 'Working'}</FadeText>
        {failed > 0 && <span className="group-failed">({failed} failed)</span>}
        {edits.added > 0 && <span className="plus">+{edits.added}</span>}
        {edits.removed > 0 && <span className="minus">−{edits.removed}</span>}
        <Caret open={open} />
      </div>
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
function Thinking({ text, streaming, redacted, hidden, durationMs, blockKey, tokens }) {
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
      {open && <div className="thinking-body"><Markdown text={text} /></div>}
    </div>
  );
}

// A question from Pi (ask_user or another extension dialog), answered right in the conversation.
function QuestionCard({ sessionId, question }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(question.prefill ?? '');
  const send = async payload => {
    setBusy(true);
    try { await api('answer', sessionId, question.requestId, payload); } catch (e) { notify(e.message, 'error'); setBusy(false); }
  };
  const options = question.method === 'select' ? question.options ?? [] : [];
  const freeText = question.method !== 'confirm';
  return (
    <div className="question-card" role="group" aria-label="Question from Pi">
      <div className="question-title">{question.title}</div>
      {question.method === 'confirm' && question.message && <div className="question-message">{question.message}</div>}
      {options.length > 0 && <div className="question-options">
        {options.map((option, i) => (
          <button key={option} className="question-option" disabled={busy} onClick={() => send({ value: option })}>
            <span className="question-key">{i + 1}</span><span>{option}</span>
          </button>
        ))}
      </div>}
      {freeText && <form className="question-input" onSubmit={e => { e.preventDefault(); if (text.trim()) send({ value: text.trim() }); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={options.length ? 'Something else…' : question.placeholder || 'Type your answer…'} disabled={busy} autoFocus={!options.length} />
        <button type="submit" className="button primary small" disabled={busy || !text.trim()}>Send</button>
      </form>}
      <div className="question-actions">
        {question.method === 'confirm'
          ? <><button className="button ghost" disabled={busy} onClick={() => send({ confirmed: false })}>No</button><button className="button primary" disabled={busy} onClick={() => send({ confirmed: true })}>Yes</button></>
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

// Your text as typed, with list items ("1. …", "- …") given a hanging indent per nesting level.
const LIST_ITEM = /^(\s*)(\d+[.)]|[-*\u2022])\s+(.*)$/;
function UserText({ text }) {
  const lines = text.split('\n');
  const width = m => m[1].replace(/\t/g, '   ').length;
  const items = lines.map(l => LIST_ITEM.exec(l));
  if (!items.some(Boolean)) return text;
  const base = Math.min(...items.filter(Boolean).map(width)); // the shallowest item is the top level
  return lines.map((line, i) => {
    const m = items[i];
    if (!m) return <div key={i} className="ub-line">{line || '\u00a0'}</div>;
    const depth = Math.floor((width(m) - base) / 3);
    return <div key={i} className="ub-li" style={{ '--depth': depth }}><span className="ub-marker">{/\d/.test(m[2]) ? m[2] : '•'}</span>{m[3]}</div>;
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
            await editMessage(sessionId, block.ordinal, block.text, text, [...images, ...files, ...attachments]);
          }} />
      </div>
    );
  }
  return (
    <div className="user-row">
      <div className="user-stack">
        {block.images?.length > 0 && <div className="user-images">{block.images.map((img, i) => <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" />)}</div>}
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
function CompactionMarker({ summary, tokensBefore, blockKey }) {
  const [open, setOpen] = useDisclosure(`compaction:${blockKey}`);
  return (
    <div className="compaction">
      <button className="compaction-line" onClick={() => setOpen(o => !o)}>
        <span className="compaction-rule" />
        <span className="compaction-label"><Icon name="compact" size={14} /> Conversation compacted{tokensBefore ? ` · ${formatTokens(tokensBefore)} → summary` : ''}<Icon name={open ? 'caretDown' : 'caretRight'} size={13} /></span>
        <span className="compaction-rule" />
      </button>
      {open && <div className="compaction-body"><Markdown text={summary ?? ''} /></div>}
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

// While Pi works: what it is doing, for how long, and how many tokens it has produced this turn.
function WorkingRow({ session, transcript }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  if (session?.status === 'connecting') return null;
  const messages = transcript.messages;
  let from = messages.length; while (from > 0 && messages[from - 1].role !== 'user') from--;
  const turn = messages.slice(from);
  const startedAt = messages[from - 1]?.timestamp ?? turn[0]?.__timing?.start ?? transcript.live?.__t0;
  const live = transcript.live;
  // Real output tokens of the model calls finished so far this turn (no live estimate).
  const tokens = turn.reduce((n, m) => n + (m.role === 'assistant' ? m.usage?.output ?? 0 : 0), 0);
  const lastBlock = live?.content?.filter(Boolean).at(-1);
  const state = session?.compacting || transcript.compacting ? 'Compacting conversation' : !live || !live.content?.length || lastBlock?.type === 'thinking' ? 'Thinking' : lastBlock?.type === 'toolCall' ? 'Working' : 'Writing';
  const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  return (
    <div className="working">
      <span className="working-dot" />
      {elapsed >= 1000 && <span className="working-meta">{seconds(elapsed)}</span>}
      {tokens > 0 && <span className="working-meta">{formatTokens(tokens)} tokens</span>}
      <span className="shimmer">{state}</span>
    </div>
  );
}

export function Transcript({ session, transcript, questions }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const scrollIntent = useRef(false);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState({});
  const pauseFollowing = useCallback(() => {
    stick.current = false;
    scrollIntent.current = false;
    setFollowing(false);
  }, []);
  const followLatest = () => {
    stick.current = true;
    setFollowing(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  };
  const blocks = useMemo(() => displayBlocks(transcript), [transcript]);
  const lastUsage = blocks.findLast(b => b.kind === 'usage');
  const onScroll = e => {
    // Output panes also scroll. Their events must not re-enable transcript auto-follow.
    if (e.target !== scroller.current) return;
    const el = scroller.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) { stick.current = false; setFollowing(false); }
    else if (scrollIntent.current) { stick.current = true; setFollowing(true); }
    scrollIntent.current = false;
  };
  useLayoutEffect(() => { if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [blocks, questions]);
  useEffect(() => { setExpanded({}); followLatest(); }, [session?.id]);
  const disclosure = useMemo(() => ({ expanded, setExpanded, pauseFollowing }), [expanded, pauseFollowing]);
  const working = session?.streaming || session?.compacting || transcript.compacting || session?.status === 'connecting';
  const loading = !transcript.error && !['error', 'disconnected'].includes(session?.status) && !transcript.live && (!transcript.loaded || session?.status === 'connecting');
  return (
    <DisclosureContext.Provider value={disclosure}>
    <div className="transcript-shell">
    <div className="transcript" ref={scroller} onScroll={onScroll}
      onWheelCapture={e => {
        if (e.target.closest('.tool-output, .tool-command, .diff')) { pauseFollowing(); return; }
        if (e.deltaY < 0) pauseFollowing();
        scrollIntent.current = true;
      }}
      onPointerDown={e => { if (e.target === scroller.current) scrollIntent.current = true; }}
      onKeyDown={e => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) scrollIntent.current = true;
      }}>
      <div className="transcript-inner">
        {transcript.error && <div className="block-error"><Icon name="alert" size={15} /> {transcript.error}</div>}
        {blocks.map(block => {
          switch (block.kind) {
            case 'user': return <UserMessage key={block.key} block={block} sessionId={session?.id} editable={!!session && session.id !== 'pending' && session.status === 'connected' && !block.text.startsWith('/')} />;
            case 'goal': return <GoalMarker key={block.key} objective={block.objective} />;
            case 'text': return <Markdown key={block.key} text={block.text} streaming={block.streaming} />;
            case 'usage': return <TurnFooter key={block.key} text={block.text} changes={block.changes} sessionId={session?.id} last={block === lastUsage} />;
            case 'compaction': return <CompactionMarker key={block.key} {...block} blockKey={block.key} />;
            case 'thinking': return <Thinking key={block.key} {...block} blockKey={block.key} />;
            case 'work': return <WorkGroup key={block.key} items={block.items} tools={transcript.tools} live={!!transcript.live} />;
            case 'tools': return <ToolGroup key={block.key} calls={block.calls} tools={transcript.tools} live={!!transcript.live} />;
            case 'ask': return transcript.tools[block.call.id]?.status === 'done' ? <AskBlock key={block.key} call={block.call} tool={transcript.tools[block.call.id]} /> : null;
            case 'bash': return <pre key={block.key} className="tool-output">$ {block.message.command}{'\n'}{block.message.output}</pre>;
            case 'error': return <div key={block.key} className="block-error"><Icon name="alert" size={15} /> {block.text}</div>;
            case 'notice': return <div key={block.key} className="block-notice">{block.text}</div>;
            default: return null;
          }
        })}
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
      {!following && <div className="transcript-follow"><button aria-label="Jump to latest" onClick={followLatest}><Icon name="arrowDown" size={16} /> Latest</button></div>}
    </div>
    {loading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><Spinner size={26} /></div>}
    </div>
    </DisclosureContext.Provider>
  );
}
