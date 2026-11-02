import { isSubagentActive } from './subagent-state.js';
import { isAbortText } from './transcript.js';

const text = value => typeof value === 'string' ? value : '';
const timestamp = value => Number.isFinite(value) ? value : null;
const TOOL_STATUSES = new Map([['completed', 'done'], ['done', 'done'], ['failed', 'error'], ['error', 'error'], ['cancelled', 'cancelled'], ['timed_out', 'timed_out'], ['skipped', 'skipped']]);
const toolStatus = status => TOOL_STATUSES.get(status) ?? 'running';

function argumentsOf(step) {
  if (step.name === 'bash') return {
    command: text(step.input),
    ...(text(step.summary) && step.summary !== step.name ? { description: step.summary } : {}),
  };
  try {
    const parsed = JSON.parse(step.input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Bounded trace input may be incomplete; never repair or invent arguments. */ }
  return typeof step.path === 'string' ? { path: step.path } : {};
}

// A display-only projection of the sanitized public trace, NOT provider/model history.
// Never reconstruct thinking, missing tool calls, full arguments or file diffs here.
export function subagentTranscript(task = {}) {
  task ??= {};
  const messages = [], tools = {};
  const active = isSubagentActive(task);
  const key = task.key ?? task.id ?? 'task';
  const id = part => `subagent:${JSON.stringify([key, part])}`;
  const recorded = new Set();
  const remember = value => { if (text(value).trim()) recorded.add(value.trim()); };
  const alreadyRecorded = value => recorded.has(text(value).trim());
  const notice = (part, content, at = null) => {
    if (!content) return;
    messages.push({ id: id(part), role: 'custom', customType: 'pidesk-subagent-notice', content, timestamp: timestamp(at) });
    remember(content);
  };
  const assistant = (part, content, at, error, running = false) => {
    messages.push({ id: id(part), role: 'assistant', content, timestamp: timestamp(at),
      stopReason: error ? 'error' : running ? 'pending' : 'stop', ...(error ? { errorMessage: error } : {}) });
  };
  const errorMessage = (part, error, at, cancelled = false) => {
    if (!error) return;
    if (cancelled || isAbortText(error)) notice(part, error, at);
    else assistant(part, [], at, error);
    remember(error);
  };

  messages.push({ id: id('assignment'), role: 'user', content: text(task.task), timestamp: timestamp(task.startedAt) });
  const hasTrace = Array.isArray(task.steps);
  const steps = hasTrace ? task.steps : [];
  const omitted = Number.isFinite(task.omittedSteps) && task.omittedSteps > 0 ? Math.floor(task.omittedSteps) : 0;
  if (!hasTrace) notice('no-trace', active ? 'Waiting for live execution details…' : 'This older task saved only its result, not a detailed execution trace.');
  if (omitted) notice('omitted', `${omitted} earlier record${omitted === 1 ? '' : 's'} omitted to keep the activity log bounded.`);
  if (hasTrace && !steps.length) notice('empty', task.status === 'queued' ? 'Waiting for an available subagent slot…' : active ? 'Waiting for the first action…' : 'No execution steps were recorded.');

  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    // Recorded IDs survive updates and bounded-history eviction. The ordinal fallback is
    // only for malformed/older steps without IDs; it never depends on changing text/time.
    const part = `step:${step.id ?? `ordinal:${omitted + index}`}`;
    if (step.type === 'notice') { notice(part, text(step.text), step.at); return; }
    if (step.type === 'message') {
      const body = text(step.text), error = text(step.error);
      const recoveredLimit = task.status === 'completed' && task.lengthRecoveries > 0 && step.stopReason === 'length';
      const neutral = recoveredLimit || step.status === 'cancelled' || isAbortText(error) ||
        (task.status === 'cancelled' && error.trim() === text(task.error).trim());
      if (body || (error && !neutral)) assistant(part, body ? [{ type: 'text', text: body }] : [], step.at, neutral ? '' : error, active && step.status === 'running');
      if (error && neutral) notice(`${part}:error`, recoveredLimit ? `Recovered from an earlier output limit: ${error}` : error, step.at);
      remember(body); remember(error);
      return;
    }
    if (step.type !== 'tool') return;
    const call = {
      type: 'toolCall', id: id(part), name: text(step.name), arguments: argumentsOf(step),
      __trace: { input: text(step.input), status: step.status, durationMs: step.durationMs, path: step.path },
    };
    assistant(part, [call], step.at);
    tools[call.id] = {
      status: toolStatus(step.status), args: call.arguments, durationMs: step.durationMs,
      result: { content: typeof step.output === 'string' ? [{ type: 'text', text: step.output }] : [] },
    };
    remember(step.output);
    errorMessage(`${part}:error`, text(step.error), step.at, step.status === 'cancelled');
  });

  // A legacy result, or a final message evicted from the bounded trace, is still public
  // output. Keep it before the terminal error, without duplicating an observed record.
  if (text(task.output) && !alreadyRecorded(task.output)) {
    assistant('output', [{ type: 'text', text: task.output }], null, '', active);
    remember(task.output);
  }
  if (text(task.error) && !alreadyRecorded(task.error)) errorMessage('error', task.error, task.finishedAt, task.status === 'cancelled');
  else if (!text(task.error) && ['failed', 'timed_out', 'cancelled'].includes(task.status)) {
    // No fabricated tool result: these describe only the task's recorded terminal status.
    const terminal = { failed: 'Subagent failed.', timed_out: 'Subagent timed out.', cancelled: 'Subagent cancelled.' }[task.status];
    if (!alreadyRecorded(terminal)) {
      if (task.status === 'cancelled') notice('status', terminal, task.finishedAt);
      else if (!messages.some(message => message.errorMessage)) errorMessage('status', terminal, task.finishedAt);
    }
  }

  // Only the last publicly streaming assistant message is live. Earlier messages and
  // tool updates stay in place; do not reorder the trace or synthesize a model request.
  const last = messages.at(-1);
  const live = active && last?.role === 'assistant' && last.stopReason === 'pending' ? messages.pop() : null;
  return { messages, live, tools, loaded: true, error: null };
}
