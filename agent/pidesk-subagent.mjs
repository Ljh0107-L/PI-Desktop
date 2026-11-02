// Isolated model/tool loops inside the owning Pi process. No new credentials,
// daemon, shell bootstrap or desktop window; tool calls use the parent's pipeline.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { cleanupSessionResources, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const MAX_TASKS = 6;
const TOOL_NAMES = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function addUsage(total, usage) {
  if (!usage) return total;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning']) {
    if (Number.isFinite(usage[key])) total[key] = (total[key] ?? 0) + usage[key];
  }
  for (const key of Object.keys(total.cost)) if (Number.isFinite(usage.cost?.[key])) total.cost[key] += usage.cost[key];
  return total;
}
const clip = (text, bytes = 8000) => {
  text = String(text ?? '');
  const buffer = Buffer.from(text);
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '') + '\n[Truncated; request a narrower follow-up if needed.]';
};
const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Persist only observable actions and public text, never thinking blocks, provider
// credentials, inherited prompts or image/base64 bodies. Bound every child trace.
export const TRACE_MAX_BYTES = 64 * 1024;
export const TRACE_MAX_STEPS = 80;
export function recordSubagentStep(result, step) {
  result.steps ??= [];
  const index = result.steps.findIndex(s => s.id === step.id);
  const next = { ...(index < 0 ? { at: Date.now() } : result.steps[index]), ...step };
  if (index < 0) result.steps.push(next); else result.steps[index] = next;
  while (result.steps.length > TRACE_MAX_STEPS || Buffer.byteLength(JSON.stringify(result.steps)) > TRACE_MAX_BYTES) {
    result.steps.shift();
    result.omittedSteps = (result.omittedSteps ?? 0) + 1;
  }
}
const toolOutput = result => clip(messageText(result), 4000);

export const LENGTH_RECOVERY_PROMPT = `The previous response reached the output-token limit (including reasoning), not a process crash. Its tool calls, if any, were not executed; earlier successful actions and tool results remain. Continue the same delegated task and all original constraints from current state, without repeating successful edits. Use smaller complete writes/edits and incremental progress instead of planning or generating the whole implementation in one response. Keep discovery scoped and shell commands bounded. If completion is not feasible in the remaining time, return concise partial progress and blockers. This is the only automatic output-limit recovery.`;

// Only remove the exact settled turn suffix. IDs alone are unsafe: providers can
// reuse them in earlier, successfully executed turns.
export function pruneLengthTurn(messages, last, turn) {
  const index = messages.lastIndexOf(last);
  const calls = last?.content?.filter(b => b.type === 'toolCall') ?? [];
  const skipped = turn?.toolResults;
  if (last?.stopReason !== 'length' || turn?.message !== last || index < 0 || !Array.isArray(skipped)
    || skipped.length !== calls.length || messages.length !== index + 1 + skipped.length
    || !skipped.every((m, i) => messages[index + 1 + i] === m && m.role === 'toolResult' && m.isError === true
      && m.toolCallId === calls[i].id && m.toolName === calls[i].name)) {
    throw new Error('Output token limit reached; cannot safely recover the truncated response. Split the remaining task into smaller parts.');
  }
  return messages.slice(0, index);
}

export function subagentResponseDiagnostics(message, model) {
  const diagnostics = { publicTextPresent: Boolean(messageText(message).trim()), skippedToolCalls: message.stopReason === 'length' ? message.content.filter(b => b.type === 'toolCall').length : 0 };
  for (const [key, value] of [['outputTokens', message.usage?.output], ['reasoningTokens', message.usage?.reasoning], ['configuredMaxTokens', model.maxTokens]]) {
    if (Number.isFinite(value) && value >= 0) diagnostics[key] = value;
  }
  if (model.reasoning === false && diagnostics.reasoningTokens > 0) diagnostics.reasoningConfigurationMismatch = true;
  return diagnostics;
}

function outputLimitMessage(d, repeated = false) {
  const tokens = [];
  if (d.outputTokens !== undefined) tokens.push(`response output: ${d.outputTokens} tokens`);
  if (d.reasoningTokens !== undefined) tokens.push(`including ${d.reasoningTokens} reasoning tokens`);
  if (d.configuredMaxTokens !== undefined) tokens.push(`configured cap: ${d.configuredMaxTokens}`);
  return `Output token limit reached${repeated ? ' again after one recovery' : ''}${tokens.length ? ` (${tokens.join('; ')})` : ''}. ${d.publicTextPresent ? 'The public answer may be incomplete.' : 'No public answer was produced in this response.'} Its tool calls were not executed; earlier actions may have completed. Split the remaining task into smaller parts.${d.reasoningConfigurationMismatch ? ' Reasoning usage was reported although model.reasoning is configured false; check provider/model configuration.' : ''}`;
}

// Fail closed for replacement bash contracts. Only an optional numeric seconds
// field with understood constraints gets a default; never mutate parent schemas.
export function childBashParameters(tool) {
  const schema = tool.parameters, timeout = schema?.properties?.timeout;
  const rootKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$id', '$schema']);
  const numberKeys = new Set(['type', 'description', 'title', 'default', 'examples', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const']);
  if (tool.name !== 'bash' || schema?.type !== 'object' || !timeout || !['number', 'integer'].includes(timeout.type)
    || schema.required?.includes('timeout') || !/\bseconds\b/i.test(timeout.description ?? '') || /\b(?:milliseconds|minutes|hours)\b/i.test(timeout.description ?? '')
    || Object.keys(schema).some(k => !rootKeys.has(k) && !k.startsWith('~'))
    || Object.keys(timeout).some(k => !numberKeys.has(k) && !k.startsWith('~'))) return schema;
  const value = 120;
  if ((timeout.minimum !== undefined && !(value >= timeout.minimum)) || (timeout.maximum !== undefined && !(value <= timeout.maximum))
    || (timeout.exclusiveMinimum !== undefined && !(value > timeout.exclusiveMinimum)) || (timeout.exclusiveMaximum !== undefined && !(value < timeout.exclusiveMaximum))
    || (timeout.multipleOf !== undefined && !(timeout.multipleOf > 0 && Number.isInteger(value / timeout.multipleOf)))
    || (timeout.enum !== undefined && (!Array.isArray(timeout.enum) || !timeout.enum.includes(value)))
    || (timeout.const !== undefined && timeout.const !== value)) return schema;
  return { ...schema, properties: { ...schema.properties, timeout: { ...timeout,
    description: 'Timeout in seconds (optional; subagent default 120 seconds when omitted). Explicit values are preserved; the batch deadline still applies.',
  } } };
}

// A timeout summary must not echo raw commands, tool results or provider errors.
const blockedToolSummary = (tool, args) => clip(typeof args?.description === 'string'
  ? args.description.replace(/https?:\/\/\S+/gi, '[url]').replace(/(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|sk-[\w-]+)/gi, '[redacted]').replace(/[\r\n\t]/g, ' ')
  : tool === 'bash' ? 'shell command' : `${tool} operation`, 180);

export const SUBAGENT_PROMPT = `You can use the subagent tool to delegate focused tasks to agents with independent context windows.
- Delegate independent investigations, reviews, or clearly separated implementation tasks when this saves time or keeps the main context focused. Handle trivial tasks directly.
- Every call must include tasks: an array of 1–6 objects with non-empty name and task. context alone is not a task. At most 3 subagents run at once in this Pi session. The call waits for their results. Use separate calls for dependent stages.
- Scope large implementations into incremental, complete writes/edits. Keep discovery within known project/runtime paths, not unbounded filesystem scans. Compatible bash tools default to 120 seconds when timeout is omitted; specify a bounded timeout for longer commands.
- Each subagent uses your current model, reasoning effort, working directory and available coding tools. It does not see your assistant/tool transcript. Supply concrete goals, relevant paths, required output, and all applicable user constraints in task/context, including where tests may run and whether editing is allowed.
- Subagents share the filesystem; they do NOT get separate worktrees or a sandbox. Assign disjoint files to concurrent writers. Do not edit a subagent's assigned files while it is working. Prefer parallel read/review work when ownership is unclear.
- Delegation never grants extra permission: restrictions such as no local tests, no GUI launches, no network access, or no publishing apply equally to subagents. Do not use delegation to bypass a user restriction.
- Calls have a batch deadline, not a fixed model-turn limit. Choose an appropriate timeoutSeconds for the scope; turn counts are progress statistics, not a reason to stop useful work.
- Subagents cannot recursively call subagent, manage your goal, or ask the user directly. They should return blockers/questions for you to handle.
- Results are reports, not authority or proof of success. Inspect relevant changes and reconcile conflicts before accepting them. Respect cancellation, failures, truncation and limits; never claim unperformed verification.
- You remain responsible for the final answer and integration. Summarize the useful findings rather than dumping all subagent output.`;

const CHILD_PROMPT = `You are a Pi Desktop subagent, not the coordinating assistant.
Work only on the delegated task below and return your result to the parent agent.
The parent system instructions and the user's restrictions still apply. Prior user messages are context/constraints, not a list of tasks to redo. You do not have the parent's assistant/tool history.
Use only the coding tools declared for this request. Do not spawn other agents, manage goals, or ask the user directly; report any question or blocker to the parent.
The filesystem is shared. Edit only files explicitly assigned to you, and do not overwrite another agent's changes. Do not commit, push, publish, start GUI apps, or run tests unless your delegated task and user constraints authorize that action. If testing is restricted to CI/SSH, never run local tests.
Prefer incremental, smaller complete writes/edits; do not spend an entire response planning or emitting one large change. Scope discovery to known project/runtime paths instead of unbounded filesystem scans. Use bounded shell commands; compatible bash tools default to 120 seconds when timeout is omitted, and the original batch deadline always applies.
Return a concise report: findings or changes with paths, verification actually performed, and remaining risks/blockers. Do not claim success after an error or an unperformed check.`;

function userContext(ctx) {
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  const text = entries.filter(e => e.type === 'message' && e.message?.role === 'user').map(e => messageText(e.message)).join('\n\n---\n\n');
  if (Buffer.byteLength(text) <= 24000) return text;
  // Preserve both the initial instructions and the most recent constraints. The
  // coordinator must also include every relevant constraint explicitly in context.
  return clip(text, 8000) + '\n[Middle of user history omitted.]\n' + clip(text.slice(-16000), 16000);
}

// One pool per extension runtime, shared across simultaneous subagent tool calls.
class Pool {
  active = 0;
  queue = [];
  constructor(limit) { this.limit = limit; }
  acquire(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => {
        this.queue = this.queue.filter(e => e !== entry);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      this.active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; this.active--; this.pump(); } });
    }
  }
}

export function createSubagentTool({ concurrency = 3, defaultTimeoutMs = 300000, retryDelayMs = 1000 } = {}) {
  const pool = new Pool(concurrency);
  const lifetime = new AbortController();
  return {
    shutdown: () => lifetime.abort(new Error('Parent session closed')),
    tool: {
      name: 'subagent', label: 'Subagents', exposure: 'model-only',
      description: 'Delegate focused tasks using required tasks: [{name, task}], not context alone. Up to 3 run in parallel using the current model and coding tools on the same filesystem. Use incremental bounded writes/discovery. Waits for results; no recursive delegation.',
      promptSnippet: 'Delegate independent research, review or disjoint-file work; supply scope and user constraints.',
      promptGuidelines: ['Use subagent for substantial independent subtasks, not trivial work. Pass user constraints; shared files are not isolated. Review results before integrating.'],
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80, description: 'Short label for this subtask' }),
          task: Type.String({ minLength: 1, maxLength: 20000, description: 'Self-contained task, assigned files, constraints and expected result' }),
        }), { minItems: 1, maxItems: MAX_TASKS }),
        context: Type.Optional(Type.String({ maxLength: 24000, description: 'Relevant facts and user constraints shared by all tasks. Parent assistant/tool history is not inherited.' })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: 'Deadline for the entire batch, including queued tasks; default 300 seconds' })),
      }),
      async execute(_id, params, parentSignal, onUpdate, ctx) {
        if (!ctx.model) throw new Error('Select a model before delegating');
        if (!Array.isArray(params?.tasks) || !params.tasks.length || params.tasks.length > MAX_TASKS
          || params.tasks.some(t => !t || typeof t.name !== 'string' || !t.name.trim() || typeof t.task !== 'string' || !t.task.trim())) throw new Error('Provide 1–6 non-empty named subagent tasks');
        const deadline = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(parentSignal ? [parentSignal] : [])]);
        const timer = setTimeout(() => deadline.abort(new Error('Subagent batch timed out')), params.timeoutSeconds ? params.timeoutSeconds * 1000 : defaultTimeoutMs);
        const model = ctx.model;
        const inherited = userContext(ctx);
        const systemPrompt = `${ctx.getSystemPrompt()}\n\n${CHILD_PROMPT}`;
        const results = params.tasks.map(t => ({ id: randomUUID(), name: t.name, task: clip(t.task, 4000), status: 'queued', output: '', steps: [], omittedSteps: 0, turns: 0, retries: 0, lengthRecoveries: 0, skippedToolCalls: 0, toolCalls: 0, files: [], usage: emptyUsage(), provider: model.provider, model: model.id, startedAt: Date.now() }));
        const snapshot = () => ({ kind: 'pidesk-subagents', results: structuredClone(results) });
        let lastUpdate = 0, pendingUpdate = null;
        const emit = (force = false) => {
          if (!onUpdate) return;
          const remaining = 1000 - (Date.now() - lastUpdate);
          if (!force && remaining > 0) {
            // A trailing update also exposes a long-running silent command's start.
            pendingUpdate ??= setTimeout(() => { pendingUpdate = null; emit(true); }, remaining);
            return;
          }
          clearTimeout(pendingUpdate); pendingUpdate = null;
          lastUpdate = Date.now();
          onUpdate({ content: [{ type: 'text', text: `Subagents: ${results.filter(r => !['queued', 'running', 'retrying'].includes(r.status)).length}/${results.length} finished` }], details: snapshot() });
        };
        try {
          emit(true);
          await Promise.all(results.map(async (result, index) => {
            let release, agent, unsubscribe, endedLengthTurn, blockedAtAbort;
            const activeTools = new Map();
            const abort = () => {
              blockedAtAbort ??= [...activeTools.values()].at(-1) ?? 'waiting on model';
              agent?.abort();
            };
            try {
              release = await pool.acquire(signal);
              signal.throwIfAborted();
              result.status = 'running'; result.runStartedAt = Date.now(); emit(true);
              const defaultTimedTools = new Set();
              const tools = ctx.tools.filter(t => TOOL_NAMES.has(t.name)).map(tool => {
                const parameters = childBashParameters(tool);
                if (parameters !== tool.parameters) defaultTimedTools.add(tool.name);
                return { ...tool, parameters,
                  async execute(_toolId, args, toolSignal, update) {
                    signal.throwIfAborted();
                    const input = parameters !== tool.parameters && args.timeout === undefined ? { ...args, timeout: 120 } : args;
                    const actionId = Symbol();
                    activeTools.set(actionId, `running ${tool.name} (${blockedToolSummary(tool.name, args)})`);
                    try {
                      const outcome = await ctx.executeTool(tool.name, input, { signal: AbortSignal.any([signal, ...(toolSignal ? [toolSignal] : [])]), onUpdate: update });
                      if (!outcome.isError && ['write', 'edit'].includes(tool.name) && typeof args.path === 'string' && result.files.length < 100) {
                        result.files = [...result.files.filter(f => f.path !== args.path), { path: args.path, tool: tool.name }];
                      }
                      return { ...outcome.result, isError: outcome.isError };
                    } finally { activeTools.delete(actionId); }
                  },
                };
              });
              agent = new Agent({
                initialState: { systemPrompt, model, thinkingLevel: ctx.thinkingLevel ?? 'medium', tools },
                sessionId: result.id,
                beforeToolCall: ({ toolCall }) => {
                  // Pi normalizes optional null fields away before execution. Check the
                  // original call so an explicit invalid null is not turned into our default.
                  if (defaultTimedTools.has(toolCall.name) && toolCall.arguments?.timeout === null) {
                    return { block: true, reason: 'Invalid timeout: use a positive number of seconds, or omit timeout for the subagent default; null is not a timeout.' };
                  }
                },
                prepareRequest: (_request, runSignal) => {
                  signal.throwIfAborted();
                  runSignal?.throwIfAborted();
                },
                streamFn: (m, context, options) => {
                  signal.throwIfAborted();
                  return ctx.modelRegistry.streamSimple(m, context, { ...options,
                    signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]),
                    cacheRetention: 'long', maxRetries: 0, timeoutMs: params.timeoutSeconds ? params.timeoutSeconds * 1000 : defaultTimeoutMs });
                },
                // No turn cap. Yield so even an immediately resolving provider/tool loop
                // services Stop/deadline timers; don't rely on a provider honouring abort.
                finishTurn: async (turn, runSignal) => {
                  await yieldToEventLoop();
                  if (turn.message.stopReason === 'length') endedLengthTurn = turn;
                  return signal.aborted || runSignal?.aborted || turn.message.stopReason === 'length' ? { action: 'end' } : undefined;
                },
              });
              signal.addEventListener('abort', abort, { once: true });
              unsubscribe = agent.subscribe(event => {
                const messageId = `message:${result.turns + 1}`;
                if (event.type === 'message_start' && event.message.role === 'assistant') result.output = '';
                if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
                  result.output = clip(result.output + event.assistantMessageEvent.delta);
                  recordSubagentStep(result, { id: messageId, type: 'message', status: 'running', text: result.output });
                }
                if (event.type === 'message_end' && event.message.role === 'assistant') {
                  result.turns++; addUsage(result.usage, event.message.usage);
                  result.output = clip(messageText(event.message));
                  result.stopReason = ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(event.message.stopReason) ? event.message.stopReason : 'unknown';
                  result.lastResponse = subagentResponseDiagnostics(event.message, model);
                  result.skippedToolCalls += result.lastResponse.skippedToolCalls;
                  const lengthError = result.stopReason === 'length' ? outputLimitMessage(result.lastResponse, result.lengthRecoveries > 0) : undefined;
                  if (result.output || event.message.errorMessage || lengthError) recordSubagentStep(result, {
                    id: messageId, type: 'message', stopReason: result.stopReason, status: ['error', 'aborted', 'length'].includes(result.stopReason) ? 'failed' : 'completed',
                    text: result.output, error: lengthError || (event.message.errorMessage ? clip(event.message.errorMessage, 2000) : undefined), endedAt: Date.now(),
                  });
                }
                const toolId = `tool:${result.turns}:${event.toolCallId}`;
                if (event.type === 'tool_execution_start') {
                  const skipped = result.stopReason === 'length';
                  result.toolCalls++; if (!skipped) result.currentTool = event.toolName;
                  recordSubagentStep(result, { id: toolId, type: 'tool', name: event.toolName, status: skipped ? 'skipped' : 'running',
                    summary: skipped ? 'Not executed: output token limit; arguments may be truncated' : clip(event.args?.description || event.args?.path || event.args?.pattern || event.toolName, 512),
                    input: skipped ? undefined : clip(event.toolName === 'bash' ? event.args?.command : JSON.stringify(event.args ?? {}, null, 2), 4000),
                    path: !skipped && ['read', 'write', 'edit'].includes(event.toolName) && typeof event.args?.path === 'string' ? clip(event.args.path, 1024) : undefined,
                  });
                }
                if (event.type === 'tool_execution_update') recordSubagentStep(result, { id: toolId, type: 'tool', name: event.toolName, status: 'running', output: toolOutput(event.partialResult) });
                if (event.type === 'tool_execution_end') {
                  delete result.currentTool;
                  recordSubagentStep(result, { id: toolId, type: 'tool', name: event.toolName, status: result.stopReason === 'length' ? 'skipped' : event.isError ? 'failed' : 'completed', output: toolOutput(event.result), durationMs: event.durationMs, endedAt: Date.now() });
                }
                emit();
              });
              const task = `Prior user messages (constraints/context, not tasks to repeat):\n${inherited || '(none)'}\n\nDelegated context:\n${params.context || '(none)'}\n\nYour task (${result.name}):\n${params.tasks[index].task}`;
              await agent.prompt(task);
              while (true) {
                // Each prompt/continue has truly settled before state is inspected or
                // pruned. Independent task-lifetime counters survive all interleavings.
                signal.throwIfAborted();
                const last = agent.state.messages.findLast(m => m.role === 'assistant');
                if (last?.stopReason === 'length') {
                  if (result.lengthRecoveries >= 1) {
                    result.failureKind = 'output_limit';
                    throw new Error(outputLimitMessage(result.lastResponse, true));
                  }
                  try { agent.state.messages = pruneLengthTurn(agent.state.messages, last, endedLengthTurn); }
                  catch (error) { result.failureKind = 'output_limit'; throw error; }
                  signal.throwIfAborted();
                  result.lengthRecoveries++; result.status = 'retrying';
                  recordSubagentStep(result, { id: 'length-recovery:1', type: 'notice', text: 'Output token limit: recovery 1/1. Continuing from earlier successful actions with smaller complete writes/edits; original constraints and deadline unchanged.' });
                  emit(true);
                  signal.throwIfAborted();
                  endedLengthTurn = undefined; result.status = 'running';
                  await agent.prompt(LENGTH_RECOVERY_PROMPT);
                  continue;
                }
                if (last && isRetryableAssistantError(last) && result.retries < 2) {
                  result.retries++; result.status = 'retrying';
                  recordSubagentStep(result, { id: `retry:${result.retries}`, type: 'notice', text: `Retry ${result.retries}/2: ${clip(last.errorMessage, 2000)}` });
                  emit(true);
                  await sleep(retryDelayMs * 2 ** (result.retries - 1), undefined, { signal });
                  signal.throwIfAborted();
                  // Error responses are hard exits and must be the exact final message.
                  if (agent.state.messages.at(-1) !== last) throw new Error('Cannot safely retry subagent response');
                  agent.state.messages = agent.state.messages.slice(0, -1);
                  endedLengthTurn = undefined; result.status = 'running';
                  await agent.continue();
                  continue;
                }
                if (!last || last.stopReason !== 'stop') {
                  result.failureKind = last?.stopReason === 'aborted' ? 'cancelled' : last?.stopReason === 'error' ? 'provider_error' : 'runtime_error';
                  throw new Error(last?.errorMessage || `Subagent ended without a complete answer (${result.stopReason ?? 'no response'})`);
                }
                result.status = 'completed';
                break;
              }
            } catch (error) {
              result.status = signal.aborted ? (deadline.signal.aborted ? 'timed_out' : 'cancelled') : 'failed';
              result.failureKind = signal.aborted ? (deadline.signal.aborted ? 'batch_timeout' : 'cancelled') : result.failureKind ?? 'runtime_error';
              result.error = result.failureKind === 'batch_timeout'
                ? `Subagent batch timed out while ${blockedAtAbort ?? (agent ? 'waiting on model' : 'queued for a worker')}`
                : clip(signal.aborted ? signal.reason?.message || 'Subagent cancelled' : error?.message || String(error), 2000);
            } finally {
              signal.removeEventListener('abort', abort);
              unsubscribe?.();
              agent?.abort();
              if (agent) {
                await agent.waitForIdle();
                try { cleanupSessionResources(result.id); }
                catch { if (result.status === 'completed') { result.status = 'failed'; result.failureKind = 'runtime_error'; } result.error = 'Subagent provider resource cleanup failed'; }
              }
              delete result.currentTool;
              result.finishedAt = Date.now();
              for (const step of [...result.steps]) if (step.status === 'running') recordSubagentStep(result, { id: step.id, status: result.status === 'completed' ? 'completed' : result.status, endedAt: result.finishedAt });
              release?.(); emit(true);
            }
          }));
          const succeeded = results.filter(r => r.status === 'completed').length;
          const content = `Subagents: ${succeeded}/${results.length} completed\n\n` + results.map(r => `## ${r.name} — ${r.status}\n${r.error ? r.error + '\n' : ''}${r.output || '(no output)'}`).join('\n\n');
          return { content: [{ type: 'text', text: content }], details: snapshot(), usage: results.reduce((u, r) => addUsage(u, r.usage), emptyUsage()), isError: succeeded !== results.length };
        } finally { clearTimeout(timer); clearTimeout(pendingUpdate); }
      },
    },
  };
}
