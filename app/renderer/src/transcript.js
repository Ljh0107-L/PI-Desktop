// Turns Pi's AgentMessages (history) and RPC events (live) into one per-session transcript.

// Rough token count for speed ONLY when usage is missing or a gateway sends a placeholder.
// Never use this estimate to rewrite provider-reported token totals.
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
  const withTiming = messages.map(m => m.role === 'assistant' && !m.__timing && timings[m.timestamp] ? { ...m, __timing: timings[m.timestamp] } : m);
  return { messages: withTiming, live: null, tools: toolsFromMessages(messages), loaded: true, error: null };
}

// ---------------------------------------------------------------- usage & speed
// Pi's usage: input = uncached prompt tokens, cacheRead / cacheWrite = cached prompt tokens, output
// (which already includes `reasoning` when the provider reports it).
//
// Only source-observed generation windows contribute to TPS. Renderer receipt timestamps include
// SSH buffering/replay; durationMs includes TTFT and is NEVER a generation-speed denominator.
// First-chunk content is excluded from the numerator because it predates the measured window.
// A user-initiated stop sometimes arrives as an ordinary error message ("This
// operation was aborted") instead of stopReason "aborted". Treat both as an
// interruption notice, not as a provider failure in a red error box.
const ABORT_TEXT = /^(?:error:\s*)?(?:this |the )?(?:operation|request)(?: was)? (?:aborted|cancelled|canceled)\b|^(?:aborted|cancelled|canceled|aborterror)\b/i;
export const isAbortText = text => ABORT_TEXT.test(String(text ?? '').trim());
export const isAbortMessage = m => m?.stopReason === 'aborted' || isAbortText(m?.errorMessage);
const isStreamInterruption = text => /\bterminated\b|stream (?:ended|disconnected|was interrupted)|socket hang up|other side closed/i.test(String(text ?? ''));
const failureText = text => isStreamInterruption(text) ? `Model connection interrupted (${text}). Please retry if it does not recover.` : text;

const nonnegative = n => Number.isFinite(n) && n >= 0 ? n : 0;
const positive = n => Number.isFinite(n) && n > 0;
function generation(m) {
  if (['pending', 'deferred', 'error', 'aborted'].includes(m.stopReason) || isAbortMessage(m)) return null;
  const t = m.__timing;
  // Captured in Pi before RPC/SSH delivery, not reconstructed from desktop receipt times. Older
  // records without first-chunk weights cannot establish a matching token/time sample.
  if (!['agent', 'relay'].includes(t?.source) || t.complete !== true ||
      ![t.start, t.first, t.last, t.end].every(n => Number.isFinite(n) && n >= 0) ||
      !(t.start <= t.first && t.first < t.last && t.last <= t.end)) return null;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const answer = typeof m.content === 'string' ? m.content : blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');
  const thinking = blocks.filter(b => b?.type === 'thinking').map(b => b.thinking ?? '').join('\n');
  const tools = blocks.filter(b => b?.type === 'toolCall').map(b => `${b.name ?? ''} ${JSON.stringify(b.arguments ?? {})}`).join('\n');
  const visible = [answer, thinking, tools].filter(Boolean).join('\n');
  const visibleOutput = estimateTokens(visible);
  const answerText = [answer, tools].filter(Boolean).join('\n');
  const reported = m.usage?.output;
  const reasoning = nonnegative(m.usage?.reasoning);
  // A one-token placeholder is common in gateways. A character heuristic cannot prove any other
  // positive provider count wrong, especially for highly compressible text or tool JSON.
  const inferTokens = !positive(reported) || (reported === 1 && visibleOutput >= 20);
  let estimated = inferTokens || m.__usageProvenance?.source === 'estimated';
  let out = inferTokens ? estimateTokens(answerText) + (reasoning || estimateTokens(thinking)) : reported;
  // Nothing hidden when the model didn't reason at all: no thinking block and a reported count of 0
  // (an Anthropic request asks for summarized thinking, but a short reply often has none).
  const noReasoning = m.usage?.reasoning === 0 && !blocks.some(b => b?.type === 'thinking');
  const coversReasoning = noReasoning || m.__usageProvenance?.thinking !== 'summary' &&
    !blocks.some(b => b?.type === 'thinking' && b.redacted) &&
    (!thinking || (Number.isFinite(t.thinkingChars) && t.thinkingChars >= thinking.length * 0.8)) &&
    (!reasoning || estimateTokens(thinking) >= reasoning * 0.5);
  const scope = coversReasoning ? 'all' : 'answer';
  const sample = coversReasoning ? t : t.answer;
  const content = coversReasoning ? visible : answerText;
  if (!coversReasoning) {
    // Hidden/summary reasoning is NOT generated inside the answer window. Subtract it when its
    // count is known; otherwise estimate visible answer/tool output, never unknown hidden work.
    if (!inferTokens && Number.isFinite(m.usage?.reasoning) && m.usage.reasoning >= 0) out = reported - reasoning;
    else { out = estimateTokens(answerText); estimated = true; }
  }
  if (!positive(out) || !sample || sample.interrupted === true || !Number.isInteger(sample.deltas) || sample.deltas < 2 ||
      ![sample.first, sample.last, sample.chars, sample.weight, sample.firstWeight].every(Number.isFinite) ||
      !(t.first <= sample.first && sample.first < sample.last && sample.last <= t.last) ||
      !(sample.firstWeight > 0 && sample.firstWeight < sample.weight)) return null;
  const ms = sample.last - sample.first;
  // Tiny replies, one-chunk tool JSON and dense upstream bursts cannot establish a useful decode
  // window. Unknown is preferable to a request average or fabricated high TPS. Keep usage intact.
  // A short reply from a fast model (40 tokens in 150 ms at Fast) can still be timed when it came in
  // many chunks at a believable density; a relay's buffered burst is far denser.
  const shortWindow = ms >= 50 && sample.deltas >= 8 && sample.chars / ms <= 4;
  if ((ms < 200 && !shortWindow) || sample.chars / ms > 20 || sample.chars < content.length * 0.8 ||
      estimateTokens(content) < Math.max(20, out * 0.5)) return null;
  // Deltas are chunks, not single tokens. Allocate reported tokens by observed token weights and
  // remove the entire first chunk (including same-timestamp deltas), not merely one token.
  out *= (sample.weight - sample.firstWeight) / sample.weight;
  return positive(out) ? { ms, out, estimated, scope, hiddenWork: reasoning > 0 } : null;
}
// When no clean source window exists (one burst from a buffering relay, a single chunk, older or
// receipt-only timing, hidden reasoning), estimate generation speed from the reply instead of showing
// nothing: output tokens (reported, else counted from the visible output) over the observed output
// window when it is long enough to measure, else over the whole response time. That time includes
// time to first token, so the estimate errs low. Always marked as an estimate.
const MIN_WINDOW_MS = 200, MIN_RESPONSE_MS = 50;
function estimatedGeneration(m) {
  if (['pending', 'deferred', 'error', 'aborted'].includes(m.stopReason) || isAbortMessage(m)) return null;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const visible = typeof m.content === 'string' ? m.content : blocks.map(b => b?.type === 'text' ? b.text ?? ''
    : b?.type === 'thinking' ? b.thinking ?? '' : b?.type === 'toolCall' ? `${b.name ?? ''} ${JSON.stringify(b.arguments ?? {})}` : '').filter(Boolean).join('\n');
  const reported = m.usage?.output, counted = estimateTokens(visible);
  const inferTokens = !positive(reported) || (reported === 1 && counted >= 20);
  const out = inferTokens ? counted : reported;
  if (!positive(out)) return null;
  const t = m.__timing ?? {};
  const time = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  // Hidden, summarized or redacted reasoning was generated before the visible output: only the whole
  // response covers it.
  const reasoning = nonnegative(m.usage?.reasoning);
  const thinking = blocks.filter(b => b?.type === 'thinking').map(b => b.thinking ?? '').join('\n');
  const hiddenReasoning = reasoning > 0 && (m.__usageProvenance?.thinking === 'summary' || blocks.some(b => b?.type === 'thinking' && b.redacted) || estimateTokens(thinking) < reasoning * 0.5);
  // Reasoning not seen as it was generated, but the provider marked when its output began (the
  // bridge's genStart: OpenAI's first output item, Anthropic's first content block): every output
  // token came after it. That span also holds reading the prompt and summarizing the reasoning
  // (measured: about half the answer's rate at standard speed, a seventh at Ultrafast), so this errs
  // low; still closer than the whole response. A relay's single burst is not a span of generation.
  if ((hiddenReasoning || m.__usageProvenance?.thinking === 'summary') && time(t.genStart) && time(t.start) && time(t.first) && time(t.last) &&
      t.start <= t.genStart && t.genStart <= t.first && t.last - t.genStart >= MIN_WINDOW_MS && !(t.chars / (t.last - t.genStart) > 20)) {
    return { ms: t.last - t.genStart, out, estimated: inferTokens, scope: 'all', fallback: 'start', hiddenWork: false };
  }
  if (!hiddenReasoning && time(t.first) && time(t.last) && t.last - t.first >= MIN_WINDOW_MS) {
    const firstShare = positive(t.weight) && positive(t.firstWeight) && t.firstWeight < t.weight ? t.firstWeight / t.weight
      : Number.isInteger(t.deltas) && t.deltas > 1 ? 1 / t.deltas : 0;
    return { ms: t.last - t.first, out: out * (1 - firstShare), estimated: inferTokens, scope: 'all', fallback: 'window', hiddenWork: false };
  }
  // Pi's request duration covers the whole call; a relay replaying a buffered reply can make the
  // stream's own start→end far shorter than the generation took.
  const ms = Math.max(time(m.durationMs) ? m.durationMs : 0, time(t.start) && time(t.end) ? t.end - t.start : 0);
  return ms >= MIN_RESPONSE_MS ? { ms, out, estimated: inferTokens, scope: 'all', fallback: 'response', hiddenWork: hiddenReasoning } : null;
}
export function usageOf(messages) {
  const u = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, reasoningReported: false, cost: 0, genMs: 0, genOut: 0, speedEstimated: false, speedTokensEstimated: false, speedBasis: null, speedScope: null, speedPartial: false, hiddenWork: false, start: null, end: null, calls: 0 };
  const speeds = [];
  let speedCalls = 0;
  for (const m of messages) {
    if (Array.isArray(m.details?.agentRuns)) {
      // Agent runs add usage, not main-model generation time/TPS. Each run is reported by exactly one
      // message: the call that waited for it, a subagent_message reply, or the agent's report.
      for (const run of m.details.agentRuns) {
        const r = run?.usage;
        if (!r) continue;
        u.input += nonnegative(r.input); u.cacheRead += nonnegative(r.cacheRead); u.cacheWrite += nonnegative(r.cacheWrite);
        u.output += nonnegative(r.output); u.cost += nonnegative(r.cost?.total);
        if (Number.isFinite(r.reasoning) && r.reasoning >= 0) { u.reasoningReported = true; u.reasoning += r.reasoning; }
        u.calls += nonnegative(run.turns);
      }
      continue;
    }
    if (m.role === 'toolResult' && m.toolName === 'subagent' && m.usage) {
      // Parallel child calls add usage, not main-model generation time/TPS.
      u.input += nonnegative(m.usage.input); u.cacheRead += nonnegative(m.usage.cacheRead); u.cacheWrite += nonnegative(m.usage.cacheWrite);
      u.output += nonnegative(m.usage.output); u.cost += nonnegative(m.usage.cost?.total);
      if (Number.isFinite(m.usage.reasoning) && m.usage.reasoning >= 0) { u.reasoningReported = true; u.reasoning += m.usage.reasoning; }
      u.calls += (m.details?.results ?? []).reduce((n, r) => n + nonnegative(r.turns), 0);
      continue;
    }
    if (m.role !== 'assistant' || !m.usage) continue;
    u.calls += 1;
    u.input += nonnegative(m.usage.input); u.cacheRead += nonnegative(m.usage.cacheRead); u.cacheWrite += nonnegative(m.usage.cacheWrite);
    if (Number.isFinite(m.usage.reasoning) && m.usage.reasoning >= 0) { u.reasoningReported = true; u.reasoning += m.usage.reasoning; }
    u.cost += nonnegative(m.usage.cost?.total);
    // Usage is authoritative even when speed requires a clearly marked token estimate.
    u.output += nonnegative(m.usage.output);
    u.usageEstimated ||= m.__usageProvenance?.source === 'estimated';
    u.cacheUnknown ||= m.__usageProvenance?.cache === 'unknown';
    if (!['pending', 'deferred', 'error', 'aborted'].includes(m.stopReason) && !isAbortMessage(m)) speedCalls += 1;
    const g = generation(m) ?? estimatedGeneration(m);
    if (g) speeds.push(g);
    const t = m.__timing;
    if (Number.isFinite(t?.start) && Number.isFinite(t?.end) && t.end >= t.start) {
      u.start = Math.min(u.start ?? t.start, t.start); u.end = Math.max(u.end ?? t.end, t.end);
    }
  }
  // Sum matching generation samples, never averages of per-call TPS. Measured samples take precedence
  // over estimates; answer-only samples are not mixed with full streamed reasoning+answer samples.
  const measured = speeds.filter(g => !g.fallback);
  const pool = measured.length ? measured : speeds;
  const scope = pool.at(-1)?.scope;
  const samples = pool.filter(g => g.scope === scope);
  if (samples.length) {
    u.speedBasis = measured.length ? 'generation' : samples.some(g => g.fallback === 'response') ? 'response' : samples.some(g => g.fallback === 'start') ? 'start' : 'window'; u.speedScope = scope;
    u.speedPartial = samples.length < speedCalls;
    for (const g of samples) {
      u.genMs += g.ms; u.genOut += g.out;
      u.speedTokensEstimated ||= g.estimated; u.hiddenWork ||= g.hiddenWork;
    }
    u.speedEstimated = true; // source-observed chunk timing/first-chunk allocation is approximate
  }
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return { ...u, prompt, cacheHit: u.cacheUnknown ? null : prompt ? u.cacheRead / prompt : null, tps: u.genMs ? u.genOut / (u.genMs / 1000) : null, durationMs: u.start != null && u.end != null ? u.end - u.start : null };
}

// earlier: the speed comes from an earlier reply, because the last one was too short to time.
export function speedDisplay(usage, { earlier = false } = {}) {
  const from = earlier ? ' From an earlier reply of this model: the last one was too short, or arrived in bursts, to time.' : '';
  if (!Number.isFinite(usage.tps)) return { value: '—', label: 'Speed unavailable', title: 'This reply has no output or timing to estimate its speed from.' };
  if (['response', 'start', 'window'].includes(usage.speedBasis)) {
    const basis = usage.speedBasis === 'response'
      ? 'Estimated: output tokens ÷ the whole response time, because the output arrived in one burst or a single chunk (a buffering relay) or its reasoning was hidden. That time includes time to first token, so the real generation speed is at least this.'
      : usage.speedBasis === 'start'
        ? 'Estimated: output tokens, reasoning included, ÷ the time from when the provider began its output to the last token, because the answer was too short to time on its own. That time also holds reading the prompt and summarizing the hidden reasoning, so the real generation speed is higher.'
        : 'Estimated: output tokens after the first chunk ÷ the first→last output time seen by the desktop.';
    return {
      value: `~${usage.tps >= 100 ? Math.round(usage.tps) : usage.tps.toFixed(1)}`,
      label: 'Generation (estimated)',
      title: basis + (usage.speedTokensEstimated ? ' Token counts are estimated from the visible output; provider token totals remain unchanged.' : ' Uses provider-reported output counts.') + from,
    };
  }
  const answer = usage.speedScope === 'answer';
  const title = 'Generation tokens after the first chunk ÷ first→last source-observed generation time. Excludes TTFT, tool execution and completion trailers. First-chunk tokens are allocated by text weights and excluded. Approximate, not server decode-only TPS; upstream buffering can affect it.';
  const scope = answer ? ' Measured on the answer and tool output: hidden or summarized reasoning is generated at the same speed but cannot be timed (the wait before the answer also holds reading the prompt and summarizing it), so its tokens and time are left out.' : ' Includes fully streamed reasoning once, not in addition to output.';
  const estimate = usage.speedTokensEstimated ? ' Token counts are estimated by the bridge or from visible text/tool arguments and reported or visible reasoning. Provider token totals remain unchanged.' : ' Uses provider-reported output counts; provider token totals remain unchanged.';
  return {
    value: `${usage.speedEstimated ? '~' : ''}${usage.tps >= 100 ? Math.round(usage.tps) : usage.tps.toFixed(1)}`,
    label: answer ? 'Answer generation' : 'Generation',
    title: title + scope + estimate + (usage.speedPartial ? ' Only calls with usable timing and the same generation scope are included.' : '') + from,
  };
}

// A reply shorter than this (a "done" after a tool call) is one or two chunks: its speed is noise.
export const MIN_TIMED_TOKENS = 16;
// An estimate (no measurable window) stands in for a reply only when the reply is at least this long.
export const MIN_SPEED_TOKENS = 64;

// The processing speed a reply ran at (the composer's Speed; the bridge records what was asked for,
// sent and reported in __speed). Null for standard-speed replies that asked for nothing faster.
const TIER = { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' };
export function speedTier(m) {
  const s = m?.__speed;
  if (!s || !TIER[s.requested]) return null;
  const ran = TIER[s.used] ? s.used : s.sent;
  const label = TIER[ran] ?? ran, asked = TIER[s.requested];
  if (ran === s.requested) return ran === 'standard' ? null : { label, slower: false, title: `This reply ran at ${label} speed, billed at ${label} rates.` };
  const why = s.sent !== s.requested
    ? s.reason === 'resting' ? `${asked} was rate limited or at capacity a moment ago, so requests go at ${TIER[s.sent]} speed for a few minutes.` : `This model doesn't offer ${asked}.`
    : `The provider ran it at ${label} speed, billed at ${label} rates.`;
  return { label, slower: true, title: `Asked for ${asked}. ${why}` };
}
// The reply whose speed the Usage card shows, so it changes with every reply: the last one when its
// generation was measured; else (too short or too coarse to time) the latest measured reply of the
// same model, then the latest estimate of a reply long enough, then the last reply. A burst of
// tool-call arguments after a tool result is an estimate; the generation before it was measured.
export const timedReply = m => (m?.usage?.output ?? 0) >= MIN_TIMED_TOKENS && usageOf([m]).speedBasis === 'generation';
export function speedReply(replies) {
  const last = replies.at(-1);
  if (!last || timedReply(last)) return last;
  const model = m => `${m.provider}\n${m.responseModel ?? m.model}`;
  const same = replies.filter(m => model(m) === model(last)).reverse();
  return same.find(timedReply) ?? same.find(m => (m.usage?.output ?? 0) >= MIN_SPEED_TOKENS && usageOf([m]).tps != null) ?? last;
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
    case 'auto_retry_start': {
      const index = t.messages.findLastIndex(m => m.role === 'assistant' && m.stopReason === 'error');
      return { ...t, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
        messages: t.messages.map((m, i) => i === index ? { ...m, __retryOmitted: true } : m) };
    }
    case 'auto_retry_end':
      return { ...t, retry: null };
    case 'agent_settled':
      return { ...t, retry: null };
    case 'message_start':
      if (event.message?.role === 'assistant') return { ...t, live: { ...event.message, content: [], stopReason: 'pending', __t0: Date.now(), __chars: 0, __deltas: 0, __thinkingChars: 0 } };
      return t;
    case 'message_update': {
      // Attached mid-reply (e.g. after an app restart): start a live message from the deltas we do get.
      if (!t.live) t = { ...t, live: { role: 'assistant', content: [], stopReason: 'pending' } };
      const e = event.assistantMessageEvent ?? {};
      // Receipt timing is useful for activity display, but is never used as generation TPS.
      if (typeof e.delta === 'string' && e.delta.length > 0 && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(e.type)) {
        const now = Date.now(), L = t.live, thinking = e.type === 'thinking_delta';
        t = { ...t, live: { ...L, __tFirst: L.__tFirst ?? now, __tLast: now, __chars: (L.__chars ?? 0) + e.delta.length, __est: (L.__est ?? 0) + estimateTokens(e.delta),
          __deltas: (L.__deltas ?? 0) + 1, __thinkingChars: (L.__thinkingChars ?? 0) + (thinking ? e.delta.length : 0),
          __thinkStart: thinking ? L.__thinkStart ?? now : L.__thinkStart, __thinkEnd: !thinking && L.__thinkStart != null && L.__thinkEnd == null ? now : L.__thinkEnd } };
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
        // A relay may attach timing gathered on the host before any replay. Never overwrite it with
        // receipt-time measurements, including when we attached in the middle of a response.
        const timing = message.__timing ?? (t.live?.__t0 != null ? { source: 'renderer', complete: true, start: t.live.__t0, first: t.live.__tFirst ?? null, end: now, last: t.live.__tLast ?? null, chars: t.live.__chars ?? 0, est: t.live.__est ?? null, deltas: t.live.__deltas ?? 0, thinkingChars: t.live.__thinkingChars ?? 0, think: t.live.__thinkStart != null ? (t.live.__thinkEnd ?? now) - t.live.__thinkStart : null } : null);
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
    // A background agent's report: a compact row; the reply that follows answers it.
    if (message.role === 'custom' && message.customType === 'pidesk-agent') {
      const key = message.details?.key ?? mi;
      flush(); closeTurn(); turnKey = `agent:${key}`;
      blocks.push({ kind: 'agentReport', key: `agent-report:${key}`, agent: message.details?.agent ?? null });
      return;
    }
    if (message.role === 'custom' && message.customType === 'pidesk-subagent-notice') {
      flush(); blocks.push({ kind: 'notice', key: message.id ?? `notice:${mi}`, text: String(message.content ?? '') }); return;
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
      if (block.type === 'toolCall' && block.name === 'subagent') { flush(); blocks.push({ kind: 'subagents', key: `subagents:${block.id}`, call: block }); return; }
      // Files handed to the user are cards in the conversation, not a folded tool step.
      if (block.type === 'toolCall' && block.name === 'present_files') { flush(); blocks.push({ kind: 'files', key: `files:${block.id}`, call: block }); return; }
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
    if (message.errorMessage && !aborted) {
      flush();
      // Only Pi-confirmed recovery attempts are demoted. Do not infer recovery merely
      // because the user sent another message; a final failed attempt remains an error.
      let recovered = false;
      if (message.__retryOmitted) {
        for (let j = mi + 1; j < all.length && all[j].role !== 'user'; j++) {
          const next = all[j];
          if (next.role === 'assistant' && ['stop', 'toolUse', 'length'].includes(next.stopReason)) { recovered = true; break; }
        }
      }
      const text = recovered ? `Recovered automatically after: ${message.errorMessage}`
        : message.__retryOmitted ? `${t.retry ? 'Retrying model request' : 'Model request was retried'} after: ${message.errorMessage}` : failureText(message.errorMessage);
      blocks.push({ kind: message.__retryOmitted ? 'notice' : 'error', key: `e${mi}`, text });
    }
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
    // Files that agents wrote: from the call that waited for them, or from their later reports.
    const agents = message.role === 'toolResult' && message.toolName === 'subagent' ? message.details?.results ?? []
      : (message.role === 'custom' && message.customType === 'pidesk-agent') || (message.role === 'toolResult' && message.toolName === 'subagent_message') ? [message.details?.agent].filter(Boolean) : null;
    if (agents) {
      for (const r of agents) for (const f of r.files ?? []) {
        if (typeof f.path === 'string') { seen.delete(f.path); seen.set(f.path, { path: f.path, tool: f.tool }); }
      }
      continue;
    }
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
  const skipped = calls.filter(call => call.__trace?.status === 'skipped').length;
  calls = calls.filter(call => call.__trace?.status !== 'skipped');
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
  if (counts.subagent) parts.push(`Delegated ${plural(calls.filter(c => c.name === 'subagent').reduce((n, c) => n + (c.arguments?.tasks?.length ?? 0), 0), 'subtask', 'subtasks')}`);
  const other = calls.length - (counts.bash ?? 0) - edited - (counts.read ?? 0) - searched - (counts.subagent ?? 0);
  if (other) parts.push(`${parts.length ? 'used' : 'Used'} ${plural(other, 'tool', 'tools')}`);
  if (skipped) parts.push(`${plural(skipped, 'tool call', 'tool calls')} not executed`);
  return parts.join(', ');
}

// Files changed by one turn's successful edit/write calls, merged per path in order.
export function changesOf(messages, tools = {}) {
  const byPath = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.content ?? []) {
      if (c?.type !== 'toolCall' || c.__trace || !['edit', 'write'].includes(c.name)) continue;
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
