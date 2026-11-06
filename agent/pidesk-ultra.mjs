// Ultra mode: hand Pi a request and walk away. It works on the request on its own until it is done,
// for as long as that takes, with the user's full trust: no questions, no early stops, retries
// through provider outages, and an independent review before it may finish. /goal is unchanged
// (Codex's model).
//
// While Ultra is on, a message from the user starts a task, or joins the task in progress:
//   - when a run ends with the task unfinished, the next run starts by itself;
//   - ask_user answers that nobody is there, so the model decides and notes its assumptions;
//   - a run that ended in a provider or network error is retried after a growing pause (30 s, up
//     to 10 min) for as long as it takes; an error retrying can't fix stops the task after 3 runs;
//   - report_progress keeps a short log (done, next, assumptions), shown on the desktop and carried
//     into every continuation, so the task survives the context being compacted;
//   - finish_task first asks for an audit against the request; a second call in a later turn has an
//     independent reviewer (a fresh agent that can run checks but not edit) check the work. Gaps send
//     the model back to work; after 3 reviews the task finishes with what is still open;
//   - runs that keep making no progress (no tool calls) get a nudge, then stop the task as stalled.
// Stopping the run (the desktop's Stop) pauses the task; Ultra off stops continuing it. A Pi that
// restarts with a task in progress picks it up again.
import { isRetryableAssistantError } from '@earendil-works/pi-ai';

export const BACKOFF_MS = [30e3, 60e3, 120e3, 240e3, 480e3, 600e3];
export const NUDGE_TURNS = 3;
export const STALL_TURNS = 6;
export const MAX_REVIEWS = 3;
const MAX_FATAL_ERRORS = 3;
const MAX_PROGRESS = 12;
const MAX_INSTRUCTIONS = 20;
export const ULTRA_TOOLS = ['report_progress', 'finish_task'];

export const ULTRA_PROMPT = `Ultra mode is on: the user handed you this work and is away until it is done, for hours if it takes that. You have their full trust for it: work entirely on your own.
- Nobody will answer questions or approve plans. Decide yourself: take the most reasonable option, note the assumption, and keep going. Never stop to ask, to offer choices, or to wait for confirmation.
- Do whatever the work needs without asking: read, change, install, run and test what it takes, and commit, push or publish when the request calls for it. Follow the user's instructions and the project's rules as always.
- Tokens are no concern; finishing the work well is. When an approach fails, find out why and try another. Break large work into steps and keep moving. End a turn only after making progress, never with just a status update.
- After each meaningful step, call report_progress: what is done, what comes next, and any assumption you made. The user sees it, and it reminds you where you are after the context is compacted.
- When everything the request asks for is done and verified, call finish_task with a summary for the user: what you did, how you verified it, the assumptions you made, and what is still open. An independent reviewer then checks the work; fix whatever it finds.`;

export const AWAY_ANSWER = 'Nobody will answer: Ultra mode is on and the user is away. Decide yourself — choose the most reasonable option, note the assumption with report_progress and in your final summary, and keep working.';

const AUDIT = `Before finishing, audit the work against the request. Go through every part of it and check each against current evidence: run the checks, read the results, look at the changed files. Fix whatever is missing or failing. Then, in a later turn, call finish_task again with the final summary; an independent reviewer will check the work.`;

const clip = (value, max) => { const text = String(value ?? '').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const lastAssistant = messages => [...(messages ?? [])].reverse().find(m => m?.role === 'assistant');
const toolCallsIn = messages => (messages ?? []).reduce((n, m) => n + (m?.role === 'assistant' ? (m.content ?? []).filter(c => c?.type === 'toolCall').length : 0), 0);
const minutesAgo = (at, now) => { const m = Math.max(0, Math.round((now - at) / 60000)); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : `${m} minutes ago`; };

const requestBlock = task => `<request>
${task.objective}
</request>${task.instructions?.length ? `\n\nThe user added later:\n${task.instructions.map(line => `- ${line}`).join('\n')}` : ''}`;

function continuation(task, now) {
  const last = task.progress?.at(-1);
  const progress = last ? `\n\nYour last progress report (${minutesAgo(last.at, now)}):\n- Done: ${last.done || '—'}\n- Next: ${last.next || '—'}${last.notes ? `\n- Assumptions: ${last.notes}` : ''}` : '';
  const step = task.review?.verdict === 'gaps' || task.review?.verdict === 'error'
    ? task.review.verdict === 'gaps' ? `- An independent review found gaps:\n<review>\n${task.review.text}\n</review>\n  Fix them, verify, then call finish_task again.` : '- Finish what is left and verify it, then call finish_task again.'
    : task.audit != null && task.audit !== 'done'
      ? '- You are auditing the work before finishing: check every part of the request against current evidence and fix what is missing or failing; then call finish_task again.'
      : (task.idleTurns ?? 0) >= NUDGE_TURNS
        ? '- The last turns made no progress. Do something different: run a check, look into the failure, or try another approach. If everything is done and verified, call finish_task.'
        : '- When everything is done and verified, call finish_task.';
  return `Ultra mode: continue the task on your own. This is an automated message from Pi Desktop, not from the user.

${requestBlock(task)}${progress}

- Check the current state (files, command output, test results) and take the next concrete step toward finishing the request.
- Don't restate status or ask anything: nobody is there to answer.
${step}`;
}

// The reviewer's brief: the request, the user's later instructions and the agent's own summary, to be
// checked against evidence rather than trusted.
export function reviewBrief(task, summary) {
  return `Another agent worked on the request below unattended and says it is finished. Check that independently, against current evidence; don't take its summary on trust.

${requestBlock(task)}

The agent's summary:
<summary>
${summary || '(none)'}
</summary>

- Go through every part of the request. For each, find the evidence: read the changed files (git status and git diff help), run the builds, tests or commands that show it works, and look at the results.
- Don't fix anything and don't change files: report what you find.
- End your reply with one line: "VERDICT: PASS" when every part of the request is done and works, or "VERDICT: GAPS" after a list of each gap with its evidence (paths, commands, output) when something is missing, wrong or unverified.`;
}
// No verdict line counts as gaps: the reviewer didn't confirm the work.
export function parseVerdict(text) {
  const matches = [...String(text ?? '').matchAll(/VERDICT:\s*\**\s*(PASS|GAPS)\b/gi)];
  return matches.at(-1)?.[1]?.toUpperCase() === 'PASS' ? 'pass' : 'gaps';
}

// pi: { sendMessage, appendEntry, getActiveTools, setActiveTools }. review(task, summary, toolContext)
// resolves to { verdict: 'pass' | 'gaps' | 'error', text, details }. Timers are injectable for tests.
export function createUltra(pi, { enabled: initial = false, review = null, schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
  let enabled = !!initial, task = null, ui = null, lastRun = null, retryTimer = null;
  const view = () => task && {
    objective: task.objective, status: task.status, turns: task.turns ?? 0, startedAt: task.startedAt, updatedAt: task.updatedAt,
    finishedAt: task.finishedAt, reason: task.reason, lastError: task.lastError, retryAt: task.retryAt, reviewing: !!task.reviewing,
    reviews: task.reviews ?? 0, progress: task.progress?.at(-1) ?? null, instructions: task.instructions?.length ?? 0,
  };
  const snapshot = () => ({ enabled, task: view() });
  const publish = () => ui?.setStatus?.('pidesk-ultra', JSON.stringify(snapshot()));
  const save = () => { try { pi.appendEntry('pidesk-ultra', { task }); } catch { /* not in a session yet */ } publish(); };
  const update = patch => { task = { ...task, ...patch, updatedAt: now() }; save(); };
  const activeTools = () => {
    try {
      const active = pi.getActiveTools();
      const want = enabled ? [...new Set([...active, ...ULTRA_TOOLS])] : active.filter(name => !ULTRA_TOOLS.includes(name));
      if (want.length !== active.length) pi.setActiveTools(want);
    } catch { /* applied when the session starts */ }
  };
  const clearRetry = () => { if (retryTimer) { cancel(retryTimer); retryTimer = null; } };
  const next = () => pi.sendMessage({ customType: 'pidesk-ultra', content: continuation(task, now()), display: false }, { triggerTurn: true, deliverAs: 'followUp' });
  const later = ms => {
    clearRetry();
    retryTimer = schedule(() => { retryTimer = null; if (enabled && task?.status === 'active') next(); }, ms);
  };
  const start = objective => {
    clearRetry();
    task = { objective: clip(objective, 20000), instructions: [], status: 'active', turns: 0, idleTurns: 0, errors: 0, fatalErrors: 0, reviews: 0, progress: [], startedAt: now(), updatedAt: now() };
    save();
  };

  return {
    get enabled() { return enabled; },
    get task() { return task; },
    // Ultra, not /goal, keeps the conversation going while a task is in progress.
    get drives() { return enabled && task?.status === 'active'; },
    snapshot,
    attach(ctx) { ui = ctx?.ui ?? ui; },
    // The session's last saved task. A Pi that restarted with one in progress continues it; a fork is a
    // new conversation and starts without one.
    restore(branch, { reason, ui: nextUi } = {}) {
      ui = nextUi ?? ui;
      clearRetry();
      task = null;
      for (const entry of branch ?? []) if (entry.type === 'custom' && entry.customType === 'pidesk-ultra') task = entry.data?.task ?? null;
      if (reason === 'fork') { if (task) { task = null; save(); } }
      else if (task?.status === 'active') {
        if (enabled && ['startup', 'reload'].includes(reason)) { update({ reviewing: false, reason: 'Continued after Pi restarted' }); later(1500); }
        // Not saved: a Pi switching files (to fork a conversation) is visiting a file another Pi owns.
        else task = { ...task, status: 'paused', reviewing: false, reason: 'Pi restarted' };
      }
      activeTools(); publish();
    },
    // Ultra on while the user's request is running: the task is that request.
    setEnabled(on, { running = false, request = '' } = {}) {
      on = !!on;
      if (on === enabled) { activeTools(); publish(); return; }
      enabled = on;
      if (!enabled) {
        clearRetry();
        if (task?.status === 'active') task = { ...task, status: 'paused', reason: 'Ultra turned off', updatedAt: now() };
      } else if (running && task?.status !== 'active' && String(request).trim() && !String(request).trim().startsWith('/')) {
        start(request);
      }
      activeTools(); save();
    },
    promptSection: () => enabled ? ULTRA_PROMPT : null,
    // What the user typed: a new task, or more instructions for the one in progress.
    onInput(text) {
      const value = String(text ?? '').trim();
      if (!enabled || !value || value.startsWith('/')) return;
      if (task?.status === 'active') { clearRetry(); update({ instructions: [...(task.instructions ?? []), clip(value, 4000)].slice(-MAX_INSTRUCTIONS) }); return; }
      start(value);
    },
    onRunEnd(messages) {
      const last = lastAssistant(messages);
      lastRun = { error: last?.stopReason === 'error', retryable: last?.stopReason === 'error' && isRetryableAssistantError(last), errorMessage: last?.errorMessage, toolCalls: toolCallsIn(messages) };
    },
    // A run settled: start the next one, after a pause when it failed. Returns whether Ultra drove it.
    onSettled({ aborted } = {}, ctx) {
      ui = ctx?.ui ?? ui;
      const run = lastRun; lastRun = null;
      if (!enabled || task?.status !== 'active') return false;
      if (aborted) { clearRetry(); update({ status: 'paused', reason: 'Stopped' }); return true; }
      if (run?.error) {
        const errors = (task.errors ?? 0) + 1, fatalErrors = run.retryable ? 0 : (task.fatalErrors ?? 0) + 1;
        const lastError = clip(run.errorMessage ?? 'Model request failed', 500);
        if (fatalErrors >= MAX_FATAL_ERRORS) { clearRetry(); update({ status: 'stalled', errors, fatalErrors, lastError, retryAt: undefined, reason: `The same kind of error ${MAX_FATAL_ERRORS} times in a row` }); return true; }
        const wait = BACKOFF_MS[Math.min(errors, BACKOFF_MS.length) - 1];
        update({ errors, fatalErrors, lastError, retryAt: now() + wait });
        later(wait);
        return true;
      }
      const idleTurns = run?.toolCalls ? 0 : (task.idleTurns ?? 0) + 1;
      if (idleTurns >= STALL_TURNS) { update({ status: 'stalled', idleTurns, reason: `No progress in ${STALL_TURNS} turns in a row` }); return true; }
      update({ turns: (task.turns ?? 0) + 1, idleTurns, errors: 0, fatalErrors: 0, lastError: undefined, retryAt: undefined });
      next();
      return true;
    },
    resume() {
      if (!enabled || !task || ['active', 'complete'].includes(task.status)) return false;
      update({ status: 'active', idleTurns: 0, errors: 0, fatalErrors: 0, reason: undefined, lastError: undefined, retryAt: undefined });
      next();
      return true;
    },
    pause() {
      clearRetry();
      if (task?.status === 'active') update({ status: 'paused', reason: 'Paused' });
    },
    dismiss() { clearRetry(); if (task && task.status !== 'active') { task = null; save(); } },
    progress(params) {
      if (!enabled || task?.status !== 'active') return 'Ultra mode has no task in progress.';
      const entry = { at: now(), done: clip(params?.done, 1200), next: clip(params?.next, 600), notes: clip(params?.assumptions, 600) };
      update({ progress: [...(task.progress ?? []), entry].slice(-MAX_PROGRESS) });
      return 'Progress noted. Keep going.';
    },
    // The audit, then the independent review. Returns { text, details? } for the tool result.
    async finish(params, toolContext = {}) {
      if (!enabled || task?.status !== 'active') return { text: 'Ultra mode has no task in progress; nothing to finish.' };
      const summary = clip(params?.summary, 8000);
      if (task.audit == null || (task.audit !== 'done' && task.audit >= (task.turns ?? 0))) {
        if (task.audit == null) update({ audit: task.turns ?? 0 });
        return { text: AUDIT };
      }
      const done = (open = '') => {
        clearRetry();
        update({ status: 'complete', summary: summary + open, finishedAt: now(), reviewing: false });
      };
      if (!review) { done(); return { text: 'The task is finished. End your turn with the summary for the user.' }; }
      update({ audit: 'done', reviewing: true });
      let outcome;
      try { outcome = await review(task, summary, toolContext); }
      catch (error) { outcome = { verdict: 'error', text: error?.message ?? String(error) }; }
      if (task?.status !== 'active' || toolContext.signal?.aborted) {
        if (task?.reviewing) update({ reviewing: false, audit: 'done' });
        return { text: 'The task was stopped during the review.', details: outcome?.details };
      }
      const reviews = (task.reviews ?? 0) + 1;
      const text = clip(outcome?.text, 8000);
      if (outcome?.verdict === 'pass') {
        update({ reviews, review: { verdict: 'pass', at: now() } });
        done();
        return { text: 'An independent review confirmed the work. The task is finished: end your turn with the summary for the user.', details: outcome.details };
      }
      if (reviews >= MAX_REVIEWS) {
        update({ reviews, review: { verdict: outcome?.verdict ?? 'gaps', text, at: now() } });
        done(outcome?.verdict === 'error' ? '' : `\n\nStill open after ${reviews} reviews:\n${text}`);
        return { text: `${outcome?.verdict === 'error' ? `The review couldn't run (${text}).` : `After ${reviews} reviews the reviewer still finds gaps:\n\n${text}\n\n`} The task finishes here: end your turn with the summary for the user, including what is still open.`, details: outcome?.details };
      }
      update({ reviews, review: { verdict: outcome?.verdict ?? 'gaps', text, at: now() } });
      return {
        text: outcome?.verdict === 'error'
          ? `The independent review couldn't run (${text}). Finish anything left and verify it, then call finish_task again in a later turn.`
          : `An independent review found gaps:\n\n${text}\n\nFix them, verify, then call finish_task again.`,
        details: outcome?.details,
      };
    },
    shutdown: clearRetry,
  };
}
