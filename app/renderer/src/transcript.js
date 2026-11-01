// Turns Pi's AgentMessages (history) and RPC events (live) into one per-session transcript.

// Rough token count of streamed text before the provider reports real usage: CJK characters are about
// one token each, other text about four characters per token. Calibrated against real counts later.
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
export const estimateTokens = text => { const cjk = (text.match(CJK) ?? []).length; return cjk + (text.length - cjk) / 4; };

export const emptyTranscript = () => ({ messages: [], live: null, tools: {}, loaded: false, error: null });

function toolsFromMessages(messages) {
  const tools = {};
  for (const message of messages) {
    if (message.role === 'toolResult') tools[message.toolCallId] = { status: message.isError ? 'error' : 'done', result: { content: message.content, details: message.details } };
  }
  return tools;
}

// `timings`: generation timing saved when replies streamed (Pi's history has token counts but no timing).
export function fromHistory(messages, timings = {}) {
  const withTiming = messages.map(m => m.role === 'assistant' && timings[m.timestamp] ? { ...m, __timing: timings[m.timestamp] } : m);
  return { messages: withTiming, live: null, tools: toolsFromMessages(messages), loaded: true, error: null };
}

// ---------------------------------------------------------------- usage & speed
// Pi's usage: input = uncached prompt tokens, cacheRead / cacheWrite = cached prompt tokens, output
// (which already includes `reasoning` when the provider reports it).
//
// TPS is the generation-phase rate: output tokens ÷ (last streamed token - first streamed token).
// `__timing` comes from the live stream and is persisted per message. When it is missing, fall back
// to Pi's durationMs (full API call, including first-token latency and queueing). A very dense burst
// (e.g. a relay replaying a buffered response) is not a generation window, so it also falls back to
// durationMs instead of reporting an artificial 10k tok/s.
// A user-initiated stop sometimes arrives as an ordinary error message ("This
// operation was aborted") instead of stopReason "aborted". Treat both as an
// interruption notice, not as a provider failure in a red error box.
const ABORT_TEXT = /^(?:error:\s*)?(?:this |the )?(?:operation|request)(?: was)? (?:aborted|cancelled|canceled)\b|^(?:aborted|cancelled|canceled|aborterror)\b/i;
export const isAbortText = text => ABORT_TEXT.test(String(text ?? '').trim());
export const isAbortMessage = m => m?.stopReason === 'aborted' || isAbortText(m?.errorMessage);

const textOfMessage = m => typeof m.content === 'string'
  ? m.content
  : (m.content ?? []).filter(b => b?.type === 'text' || b?.type === 'thinking').map(b => b.text ?? b.thinking ?? '').join('\n');
function generation(m) {
  const reported = m.usage?.output;
  const t = m.__timing;
  const visible = estimateTokens(textOfMessage(m));
  // Prefer first→last from the stream; keep full API duration for replay/burst,
  // hidden reasoning with no streamed text, or untimed history.
  const coversOutput = visible >= Math.max(20, (Number.isFinite(reported) ? reported : 0) * 0.25);
  let ms = m.durationMs;
  if (t?.first && t?.last && t.last > t.first && (t.chars ?? 0) >= 20 && coversOutput) {
    const window = t.last - t.first;
    const chars = t.chars ?? 0;
    if (chars / window <= 20) ms = window;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Some gateways (notably Cursor's Gemini path) report a token count that is
  // far below the visible answer. Use the visible-text estimate only when the
  // reported count is implausible, and mark the speed as estimated.
  let out = reported, estimated = false;
  if ((!Number.isFinite(out) || out <= 0) && visible > 0) { out = visible; estimated = true; }
  else if (visible >= 20 && Number.isFinite(out) && out < visible * 0.6) { out = visible; estimated = true; }
  if (!Number.isFinite(out) || out <= 0) return null;
  return { ms, out, reported: Number.isFinite(reported) ? reported : null, estimated, hiddenWork: (m.usage.reasoning ?? 0) > 0 };
}
export function usageOf(messages) {
  const u = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, reasoningReported: false, cost: 0, genMs: 0, genOut: 0, speedEstimated: false, hiddenWork: false, start: null, end: null, calls: 0 };
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    u.calls += 1;
    u.input += m.usage.input ?? 0; u.cacheRead += m.usage.cacheRead ?? 0; u.cacheWrite += m.usage.cacheWrite ?? 0; u.output += m.usage.output ?? 0;
    if (m.usage.reasoning != null) { u.reasoningReported = true; u.reasoning += m.usage.reasoning; }
    u.cost += m.usage.cost?.total ?? 0;
    const g = generation(m);
    if (g) { u.genMs += g.ms; u.genOut += g.out; u.speedEstimated ||= g.estimated; u.hiddenWork ||= g.hiddenWork; }
    const t = m.__timing;
    if (t?.start && t.end) { u.start = Math.min(u.start ?? t.start, t.start); u.end = Math.max(u.end ?? t.end, t.end); }
  }
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return { ...u, prompt, cacheHit: prompt ? u.cacheRead / prompt : null, tps: u.genMs ? u.genOut / (u.genMs / 1000) : null, durationMs: u.start && u.end ? u.end - u.start : null };
}
// Usage per finished turn (user message → the replies that followed), oldest first.
export function turnUsages(messages) {
  const turns = []; let current = [];
  for (const m of messages) {
    if (m.role === 'user') { if (current.length) turns.push(usageOf(current)); current = []; }
    else if (m.role === 'assistant') current.push(m);
  }
  if (current.length) turns.push(usageOf(current));
  return turns.filter(t => t.calls);
}
export const formatTokens = n => n == null ? '—' : n < 1000 ? String(n) : n < 100000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}K` : n < 1e6 ? `${Math.round(n / 1000)}K` : `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;

function updateBlock(live, index, update) {
  const content = live.content.slice();
  content[index] = update(content[index]);
  return { ...live, content };
}

export function applyEvent(t, event) {
  switch (event.type) {
    case 'message_start':
      if (event.message?.role === 'assistant') return { ...t, live: { ...event.message, content: [], stopReason: 'pending', __t0: Date.now(), __chars: 0 } };
      return t;
    case 'message_update': {
      // Attached mid-reply (e.g. after an app restart): start a live message from the deltas we do get.
      if (!t.live) t = { ...t, live: { role: 'assistant', content: [], stopReason: 'pending' } };
      const e = event.assistantMessageEvent ?? {};
      // Speed: time from the first generated token, and characters streamed so far (for a live estimate).
      if (typeof e.delta === 'string' && e.type?.endsWith('_delta')) {
        const now = Date.now(), L = t.live, thinking = e.type === 'thinking_delta';
        t = { ...t, live: { ...L, __tFirst: L.__tFirst ?? now, __tLast: now, __chars: (L.__chars ?? 0) + e.delta.length, __est: (L.__est ?? 0) + estimateTokens(e.delta),
          __thinkStart: thinking ? L.__thinkStart ?? now : L.__thinkStart, __thinkEnd: !thinking && L.__thinkStart && !L.__thinkEnd ? now : L.__thinkEnd } };
      }
      const i = e.contentIndex;
      switch (e.type) {
        case 'text_start': return { ...t, live: updateBlock(t.live, i, () => ({ type: 'text', text: '' })) };
        case 'text_delta': return { ...t, live: updateBlock(t.live, i, b => ({ type: 'text', text: (b?.text ?? '') + e.delta })) };
        case 'text_end': return { ...t, live: updateBlock(t.live, i, () => ({ type: 'text', text: e.content })) };
        case 'thinking_start': return { ...t, live: updateBlock(t.live, i, () => ({ type: 'thinking', thinking: '' })) };
        case 'thinking_delta': return { ...t, live: updateBlock(t.live, i, b => ({ type: 'thinking', thinking: (b?.thinking ?? '') + e.delta })) };
        case 'thinking_end': return { ...t, live: updateBlock(t.live, i, () => ({ type: 'thinking', thinking: e.content })) };
        case 'toolcall_start': return { ...t, live: updateBlock(t.live, i, () => ({ type: 'toolCall', id: e.id, name: e.toolName, arguments: {}, argsText: '' })) };
        case 'toolcall_delta': return { ...t, live: updateBlock(t.live, i, b => {
          const argsText = (b?.argsText ?? '') + e.delta;
          let args = b?.arguments ?? {};
          try { args = JSON.parse(argsText); } catch { /* partial JSON */ }
          return { ...b, argsText, arguments: args };
        }) };
        case 'toolcall_end': return { ...t, live: updateBlock(t.live, i, () => e.toolCall) };
        default: return t;
      }
    }
    case 'message_end': {
      const message = event.message;
      if (!message) return t;
      if (message.role === 'assistant') {
        const now = Date.now();
        const timing = t.live?.__t0 ? { start: t.live.__t0, first: t.live.__tFirst ?? null, end: now, last: t.live.__tLast ?? null, chars: t.live.__chars ?? 0, est: t.live.__est ?? null, think: t.live.__thinkStart ? (t.live.__thinkEnd ?? now) - t.live.__thinkStart : null } : null;
        return { ...t, live: null, messages: [...t.messages, timing ? { ...message, __timing: timing } : message] };
      }
      // Your message arrived from Pi: it replaces the optimistic copy shown while editing, and the dimmed
      // copy of a message sent while Pi was working.
      if (message.role === 'user') {
        const sent = userText(message);
        const queued = t.queued ?? [];
        const i = queued.findIndex(q => sent === q.text || sent.startsWith(q.text));
        return { ...t, queued: i < 0 ? queued : queued.filter((_, j) => j !== i), messages: [...t.messages.filter(m => !m.__optimistic), message] };
      }
      return { ...t, messages: [...t.messages, message] };
    }
    case 'compaction_start': return { ...t, compacting: true };
    case 'compaction_end': return { ...t, compacting: false };
    case 'tool_execution_start':
      return { ...t, tools: { ...t.tools, [event.toolCallId]: { status: 'running', args: event.args } } };
    case 'tool_execution_update':
      return { ...t, tools: { ...t.tools, [event.toolCallId]: { ...t.tools[event.toolCallId], status: 'running', result: event.partialResult } } };
    case 'tool_execution_end':
      return { ...t, tools: { ...t.tools, [event.toolCallId]: { status: event.isError ? 'error' : 'done', result: event.result, durationMs: event.durationMs } } };
    default:
      return t;
  }
}

// Display blocks: user bubbles, assistant text/thinking, and groups of consecutive tool calls.
export function displayBlocks(t) {
  const blocks = [];
  const all = t.live ? [...t.messages, t.live] : t.messages;
  let group = null;
  const flush = () => { if (group) { blocks.push(group); group = null; } };
  let turn = [], turnKey = 'start';
  const closeTurn = () => {
    if (turn.length) {
      const usage = usageOf(turn);
      const text = turn.flatMap(m => (m.content ?? []).filter(c => c?.type === 'text').map(c => c.text)).join('\n\n').trim();
      const changes = changesOf(turn, t.tools);
      // Keep this footer mounted while the next API call is streaming. Its stable key follows the user
      // prompt, not the changing index at the end of the transcript.
      if (usage.calls || changes.length) blocks.push({ kind: 'usage', key: `usage:${turnKey}`, usage, text, changes });
    }
    turn = [];
  };
  let ordinal = 0;
  all.forEach((message, mi) => {
    if (message.role === 'assistant') turn.push(message);
    if (message.role === 'user') {
      flush();
      closeTurn();
      turnKey = message.timestamp ?? `u${mi}`;
      const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
      let text = stripImageNotes(parts.filter(c => c.type === 'text').map(c => c.text).join('\n'));
      if (text.startsWith('/pidesk-')) return;
      // Attached files travel as a trailing list of paths (see SessionManager.prompt).
      let files = [];
      const att = /(?:^|\n\n)Attached files:\n((?:- .+(?:\n|$))+)$/.exec(text);
      if (att) { files = att[1].trim().split('\n').map(l => l.replace(/^- /, '')); text = text.slice(0, att.index); }
      const images = parts.filter(c => c.type === 'image');
      blocks.push({ kind: 'user', key: `u${mi}`, text, files, images, ordinal: ordinal++ });
      return;
    }
    // A goal started with /goal (the bridge's hidden prompt): show what was set.
    if (message.role === 'custom' && message.customType === 'pidesk-goal') {
      const objective = /^The user set a goal[\s\S]*?<objective>\n([\s\S]*?)\n<\/objective>/.exec(typeof message.content === 'string' ? message.content : '')?.[1];
      if (objective) { flush(); closeTurn(); turnKey = `goal:${mi}`; blocks.push({ kind: 'goal', key: `g${mi}`, objective }); }
      // A goal continuation is a new prompt: the reply before it is an answer, not folded work.
      else { flush(); blocks.push({ kind: 'break', key: `x${mi}` }); }
      return;
    }
    if (message.role === 'bashExecution') { flush(); blocks.push({ kind: 'bash', key: `b${mi}`, message }); return; }
    if (message.role === 'compactionSummary') { flush(); blocks.push({ kind: 'compaction', key: `c${mi}`, summary: message.summary, tokensBefore: message.tokensBefore }); return; }
    if (message.role !== 'assistant') return;
    const reasoning = message.usage?.reasoning ?? 0;
    let sawThinking = false;
    const firstBlock = blocks.length;
    (message.content ?? []).forEach((block, bi) => {
      if (!block) return;
      if (block.type === 'toolCall' && block.name === 'ask_user') { flush(); blocks.push({ kind: 'ask', key: `q${mi}-${bi}`, call: block }); return; }
      if (block.type === 'toolCall') {
        if (!group) group = { kind: 'tools', key: `g${mi}-${bi}`, calls: [] };
        group.calls.push(block);
        return;
      }
      if (block.type === 'text' && !block.text?.trim()) return;
      flush();
      if (block.type === 'text') blocks.push({ kind: 'text', key: `t${mi}-${bi}`, text: block.text, streaming: message === t.live });
      if (block.type === 'thinking' && block.redacted) { sawThinking = true; blocks.push({ kind: 'thinking', key: `k${mi}-${bi}`, redacted: true, tokens: reasoning }); }
      else if (block.type === 'thinking' && block.thinking?.trim()) {
        sawThinking = true;
        // Far fewer characters than reasoning tokens: the provider sent a summary, not the full reasoning.
        const summary = reasoning > 0 && block.thinking.length / 4 < reasoning * 0.5;
        blocks.push({ kind: 'thinking', key: `k${mi}-${bi}`, text: block.thinking, streaming: message === t.live, summary, tokens: reasoning, durationMs: message.__timing?.think ?? null });
      }
    });
    // Reasoning that was billed but never shown (OpenAI o-series, hidden thinking): say so.
    if (!sawThinking && reasoning > 0 && message !== t.live) {
      const tm = message.__timing;
      blocks.splice(firstBlock, 0, { kind: 'thinking', key: `h${mi}`, hidden: true, tokens: reasoning, durationMs: tm?.first && tm.start ? tm.first - tm.start : null });
    }
    const aborted = isAbortMessage(message);
    if (message.errorMessage && !aborted) { flush(); blocks.push({ kind: 'error', key: `e${mi}`, text: message.errorMessage }); }
    if (aborted) { flush(); blocks.push({ kind: 'notice', key: `a${mi}`, text: 'Interrupted' }); }
  });
  flush();
  closeTurn();
  return collapseWork(blocks);
}

// Claude-style: consecutive steps (reasoning and tool calls) fold into one expandable line. Text Pi writes
// to you is never folded: it stays in the conversation between the groups. A lone reasoning block keeps
// its plain "Thought" row.
const STEP = new Set(['thinking', 'tools']);
export function collapseWork(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length;) {
    if (!STEP.has(blocks[i].kind)) { out.push(blocks[i++]); continue; }
    let j = i;
    while (j < blocks.length && STEP.has(blocks[j].kind)) j++;
    const run = blocks.slice(i, j);
    // Keep the group identity when hidden reasoning is inserted before its first call on message_end.
    const firstCall = run.find(b => b.kind === 'tools')?.calls[0];
    if (run.length > 1 || run[0].kind === 'tools') out.push({ kind: 'work', key: firstCall?.id ? `work:${firstCall.id}` : run[0].key, items: run });
    else out.push(run[0]);
    i = j;
  }
  return out;
}

// Files the agent wrote or edited, most recent first.
export function outputs(t) {
  const seen = new Map();
  const all = t.live ? [...t.messages, t.live] : t.messages;
  for (const message of all) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block?.type !== 'toolCall' || !['write', 'edit'].includes(block.name)) continue;
      const path = block.arguments?.path ?? block.arguments?.file_path;
      if (!path) continue;
      const status = t.tools[block.id]?.status;
      if (status === 'error') continue;
      seen.delete(path);
      seen.set(path, { path, tool: block.name });
    }
  }
  return [...seen.values()].reverse();
}

export function toolSummary(calls) {
  const counts = {};
  for (const call of calls) counts[call.name] = (counts[call.name] ?? 0) + 1;
  const parts = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (counts.bash) parts.push(`Ran ${plural(counts.bash, 'command', 'commands')}`);
  const edited = (counts.edit ?? 0) + (counts.write ?? 0);
  const editedPaths = [...new Set(calls.filter(c => c.name === 'edit' || c.name === 'write').map(c => c.arguments?.path ?? c.arguments?.file_path).filter(Boolean))];
  const editedLabel = editedPaths.length === 1 ? editedPaths[0].split('/').pop() : plural(edited, 'file', 'files');
  if (edited) parts.push(`${parts.length ? 'edited' : 'Edited'} ${editedLabel}`);
  const readPaths = [...new Set(calls.filter(c => c.name === 'read').map(c => c.arguments?.path ?? c.arguments?.file_path).filter(Boolean))];
  if (counts.read) parts.push(`${parts.length ? 'read' : 'Read'} ${readPaths.length === 1 ? readPaths[0].split('/').pop() : plural(counts.read, 'file', 'files')}`);
  const searched = (counts.grep ?? 0) + (counts.find ?? 0) + (counts.ls ?? 0);
  if (searched) parts.push(`${parts.length ? 'searched' : 'Searched'} ${plural(searched, 'time', 'times')}`);
  const other = calls.length - (counts.bash ?? 0) - edited - (counts.read ?? 0) - searched;
  if (other) parts.push(`${parts.length ? 'used' : 'Used'} ${plural(other, 'tool', 'tools')}`);
  return parts.join(', ');
}

// Files changed by one turn's successful edit/write calls, merged per path in order.
export function changesOf(messages, tools = {}) {
  const byPath = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.content ?? []) {
      if (c?.type !== 'toolCall' || !['edit', 'write'].includes(c.name)) continue;
      if (tools[c.id]?.status !== 'done') continue;
      const a = c.arguments ?? {};
      const path = a.path ?? a.file_path;
      if (!path) continue;
      const entry = byPath.get(path) ?? { path, hunks: [] };
      if (c.name === 'write') entry.hunks = [{ oldText: null, newText: String(a.content ?? '') }];
      else for (const e of a.edits ?? [{ oldText: a.oldText ?? a.old_string, newText: a.newText ?? a.new_string }]) entry.hunks.push({ oldText: String(e.oldText ?? ''), newText: String(e.newText ?? '') });
      byPath.set(path, entry);
    }
  }
  return [...byPath.values()];
}

// Pi adds a note for the model after each resized image ("[Image: original 3768x1800, displayed at …]").
// It stays in what the model reads; the conversation never shows it.
export const IMAGE_NOTE = /\n*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/g;
export const stripImageNotes = text => String(text ?? '').replace(IMAGE_NOTE, '').replace(/\s+$/, '');
const userText = m => stripImageNotes(typeof m.content === 'string' ? m.content : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
// Editing your ordinal-th message: keep everything before it and show the new text in its place at once,
// so the conversation never blanks while Pi branches and reloads.
export function rewindTo(t, ordinal, text, images = []) {
  let seen = 0, cut = -1;
  t.messages.forEach((m, i) => {
    if (cut !== -1 || m.role !== 'user' || userText(m).startsWith('/pidesk-')) return;
    if (seen++ === ordinal) cut = i;
  });
  if (cut === -1) return t;
  const content = [{ type: 'text', text }, ...images.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType }))];
  return { ...t, live: null, rewinding: true, messages: [...t.messages.slice(0, cut), { role: 'user', content, timestamp: Date.now(), __optimistic: true }] };
}
