import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Markdown, Spinner } from './ui.jsx';
import { displayBlocks, formatTokens, toolSummary } from './transcript.js';
import { api, editMessage, notify, openChanges, useStore } from './store.js';
import { changeStats } from './diffs.js';
import { Composer } from './Composer.jsx';

const textOf = result => (result?.content ?? []).map(c => c.text ?? '').join('').replace(/\s+$/, '');

function describeCall(call) {
  const a = call.arguments ?? {};
  switch (call.name) {
    case 'bash': return { verb: 'Ran', subject: a.command ?? '', mono: true };
    case 'read': return { verb: 'Read', subject: a.path ?? a.file_path ?? '', mono: true };
    case 'write': return { verb: 'Wrote', subject: a.path ?? a.file_path ?? '', mono: true };
    case 'edit': return { verb: 'Edited', subject: a.path ?? a.file_path ?? '', mono: true };
    case 'grep': return { verb: 'Searched for', subject: a.pattern ?? '', mono: true };
    case 'find': return { verb: 'Found files', subject: a.pattern ?? a.path ?? '', mono: true };
    case 'ls': return { verb: 'Listed', subject: a.path ?? '.', mono: true };
    default: return { verb: call.name, subject: JSON.stringify(a).slice(0, 120), mono: true };
  }
}

function EditDiff({ args }) {
  const edits = args?.edits ?? (args?.oldText !== undefined || args?.old_string !== undefined ? [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }] : []);
  if (!edits.length) return null;
  return (
    <div className="diff">
      {edits.slice(0, 6).map((e, i) => (
        <div key={i} className="diff-hunk">
          {String(e.oldText ?? '').split('\n').map((l, j) => <div key={'o' + j} className="diff-line del">- {l}</div>)}
          {String(e.newText ?? '').split('\n').map((l, j) => <div key={'n' + j} className="diff-line add">+ {l}</div>)}
        </div>
      ))}
    </div>
  );
}

function ToolCall({ call, tool }) {
  const [open, setOpen] = useState(false);
  const { verb, subject } = describeCall(call);
  const status = tool?.status ?? 'pending';
  const output = textOf(tool?.result);
  const filePath = ['read', 'edit', 'write'].includes(call.name) && status !== 'error' ? (call.arguments?.path ?? call.arguments?.file_path) : null;
  return (
    <div className={`tool-call ${status}`}>
      <button className="tool-call-head" onClick={() => setOpen(o => !o)}>
        <span className="tool-status">{status === 'running' ? <Spinner size={12} /> : status === 'error' ? <Icon name="x" size={13} /> : <Icon name="check" size={13} />}</span>
        <span className="tool-verb">{verb}</span>
        <code className="tool-subject">{subject}</code>
        {filePath && <span role="button" tabIndex={0} className="tool-open" title="Open file" onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: filePath })); }}><Icon name="externalLink" size={13} /></span>}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="tool-caret" />
      </button>
      {open && (
        <div className="tool-detail">
          {call.name === 'bash' && <pre className="tool-command">$ {call.arguments?.command}</pre>}
          {call.name === 'edit' && <EditDiff args={call.arguments} />}
          {call.name === 'write' && <pre className="tool-output">{String(call.arguments?.content ?? '').slice(0, 4000)}</pre>}
          {output && call.name !== 'write' && <pre className={`tool-output ${status === 'error' ? 'error' : ''}`}>{output.length > 8000 ? output.slice(0, 8000) + '\n…' : output}</pre>}
          {!output && status === 'running' && <div className="tool-running">Running…</div>}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ calls, tools, live }) {
  const running = calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const [open, setOpen] = useState(false);
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

// One line of a reply's folded work: a note Pi wrote between steps, or its reasoning.
const firstLine = text => String(text ?? '').split('\n').map(l => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
function WorkNote({ item }) {
  const [open, setOpen] = useState(false);
  const thinking = item.kind === 'thinking';
  const body = item.text;
  if (thinking && (item.hidden || item.redacted || !item.text)) {
    return <div className="work-note static"><span className="work-note-line">{item.durationMs > 800 ? `Thought for ${seconds(item.durationMs)}` : 'Thought'}</span></div>;
  }
  return (
    <div className={`work-note ${thinking ? 'thought' : ''}`}>
      <button className="work-note-head" onClick={() => setOpen(o => !o)}>
        <span className={`work-note-line ${item.streaming ? 'shimmer' : ''}`}>{firstLine(body) || (thinking ? 'Thought' : '')}</span>
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} className="tool-caret" />
      </button>
      {open && <div className="work-note-body"><Markdown text={body} /></div>}
    </div>
  );
}

// Everything a reply did before its answer, folded into one line ("Ran 2 commands, read 1 file").
function WorkGroup({ items, tools, live }) {
  const [open, setOpen] = useState(false);
  const calls = items.flatMap(i => i.kind === 'tools' ? i.calls : []);
  const running = items.some(i => i.streaming) || calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const thinkMs = items.reduce((n, i) => n + (i.kind === 'thinking' ? i.durationMs ?? 0 : 0), 0);
  const summary = toolSummary(calls) || (running ? '' : thinkMs > 800 ? `Thought for ${seconds(thinkMs)}` : 'Thought');
  const latest = items.at(-1);
  const thinkingNow = running && latest?.kind === 'thinking' && latest.streaming;
  return (
    <div className={`tool-group work ${open ? 'open' : ''}`}>
      <button className="tool-group-head" onClick={() => setOpen(o => !o)}>
        {running && !thinkingNow && <Spinner size={12} />}
        {thinkingNow ? <span className="shimmer thinking-latest">{firstLine(latest.text) || 'Thinking'}</span> : <span>{summary || 'Working'}</span>}
        {failed > 0 && <span className="tool-failed">{failed} failed</span>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
      </button>
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
function Thinking({ text, streaming, redacted, hidden, durationMs }) {
  const [open, setOpen] = useState(false);
  const label = durationMs > 800 ? `Thought for ${seconds(durationMs)}` : 'Thought';
  if (hidden || redacted || !text) {
    return <div className="thinking"><div className="tool-group-head static">{streaming ? <span className="shimmer">Thinking</span> : <span>{label}</span>}</div></div>;
  }
  const latest = streaming ? text.trim().split('\n').filter(l => l.trim()).at(-1)?.replace(/[*_`#>]/g, '').trim() : null;
  return (
    <div className="thinking">
      <button className="tool-group-head" onClick={() => setOpen(o => !o)}>
        {streaming ? <span className="shimmer thinking-latest">{latest || 'Thinking'}</span> : <span>{label}</span>}
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
function TurnFooter({ text, changes, sessionId }) {
  const [copied, setCopied] = useState(false);
  const totals = useMemo(() => (changes ?? []).map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }), [changes]);
  if (!text && !changes?.length) return null;
  return (
    <div className="turn-foot">
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
        {block.text && <div className="user-bubble">{block.text}</div>}
        <div className="user-actions">
          <button className="turn-action" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(block.text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
          {editable && <button className="turn-action" aria-label="Edit message" title="Edit" onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>}
        </div>
      </div>
    </div>
  );
}

// Where Pi summarized the earlier conversation (automatically, on return after the cache expired, or by hand).
function CompactionMarker({ summary, tokensBefore }) {
  const [open, setOpen] = useState(false);
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
function WorkingRow({ session, transcript, connectingLabel }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  if (session?.status === 'connecting') return <div className="working"><span className="working-dot" /><span className="shimmer">{connectingLabel}</span></div>;
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
  // While a session starts, say which step it is on (setting up the host, then starting Pi there).
  const prep = useStore(s => s.envStatus[session?.environmentId]);
  const connectingLabel = session?.environmentId && session.environmentId !== 'local'
    ? (prep?.status === 'preparing' ? `${prep.message?.replace(/…$/, '') || 'Setting up'} on ${session.environmentLabel}…` : `Starting Pi on ${session.environmentLabel ?? 'the server'}…`)
    : 'Starting Pi…';
  const scroller = useRef(null);
  const stick = useRef(true);
  const blocks = useMemo(() => displayBlocks(transcript), [transcript]);
  const onScroll = () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => { if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [blocks, questions]);
  useEffect(() => { stick.current = true; if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [session?.id]);
  const working = session?.streaming || session?.compacting || transcript.compacting || session?.status === 'connecting';
  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="transcript-inner">
        {!transcript.loaded && <div className="transcript-loading"><Spinner /> Loading conversation…</div>}
        {transcript.error && <div className="block-error"><Icon name="alert" size={15} /> {transcript.error}</div>}
        {blocks.map(block => {
          switch (block.kind) {
            case 'user': return <UserMessage key={block.key} block={block} sessionId={session?.id} editable={!!session && session.id !== 'pending' && session.status === 'connected' && !block.text.startsWith('/')} />;
            case 'goal': return <GoalMarker key={block.key} objective={block.objective} />;
            case 'text': return <Markdown key={block.key} text={block.text} streaming={block.streaming} />;
            case 'usage': return <TurnFooter key={block.key} text={block.text} changes={block.changes} sessionId={session?.id} />;
            case 'compaction': return <CompactionMarker key={block.key} {...block} />;
            case 'thinking': return <Thinking key={block.key} {...block} />;
            case 'work': return <WorkGroup key={block.key} items={block.items} tools={transcript.tools} live={!!transcript.live} />;
            case 'tools': return <ToolGroup key={block.key} calls={block.calls} tools={transcript.tools} live={!!transcript.live} />;
            case 'ask': return transcript.tools[block.call.id]?.status === 'done' ? <AskBlock key={block.key} call={block.call} tool={transcript.tools[block.call.id]} /> : null;
            case 'bash': return <pre key={block.key} className="tool-output">$ {block.message.command}{'\n'}{block.message.output}</pre>;
            case 'error': return <div key={block.key} className="block-error"><Icon name="alert" size={15} /> {block.text}</div>;
            case 'notice': return <div key={block.key} className="block-notice">{block.text}</div>;
            default: return null;
          }
        })}
        {questions.map(q => <QuestionCard key={q.requestId} sessionId={session.id} question={q} />)}
        {working && !questions.length && <WorkingRow session={session} transcript={transcript} connectingLabel={connectingLabel} />}
        <div className="transcript-end" />
      </div>
    </div>
  );
}
