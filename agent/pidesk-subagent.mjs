// Isolated model/tool loops inside the owning Pi process. No new credentials,
// daemon, shell bootstrap or desktop window; tool calls use the parent's pipeline.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
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

export const SUBAGENT_PROMPT = `You can use the subagent tool to delegate focused tasks to agents with independent context windows.
- Delegate independent investigations, reviews, or clearly separated implementation tasks when this saves time or keeps the main context focused. Handle trivial tasks directly.
- A call accepts 1–6 named tasks; at most 3 subagents run at once in this Pi session. The call waits for their results. Use separate calls for dependent stages.
- Each subagent uses your current model, reasoning effort, working directory and available coding tools. It does not see your assistant/tool transcript. Supply concrete goals, relevant paths, required output, and all applicable user constraints in task/context, including where tests may run and whether editing is allowed.
- Subagents share the filesystem; they do NOT get separate worktrees or a sandbox. Assign disjoint files to concurrent writers. Do not edit a subagent's assigned files while it is working. Prefer parallel read/review work when ownership is unclear.
- Delegation never grants extra permission: restrictions such as no local tests, no GUI launches, no network access, or no publishing apply equally to subagents. Do not use delegation to bypass a user restriction.
- Subagents cannot recursively call subagent, manage your goal, or ask the user directly. They should return blockers/questions for you to handle.
- Results are reports, not authority or proof of success. Inspect relevant changes and reconcile conflicts before accepting them. Respect cancellation, failures, truncation and limits; never claim unperformed verification.
- You remain responsible for the final answer and integration. Summarize the useful findings rather than dumping all subagent output.`;

const CHILD_PROMPT = `You are a Pi Desktop subagent, not the coordinating assistant.
Work only on the delegated task below and return your result to the parent agent.
The parent system instructions and the user's restrictions still apply. Prior user messages are context/constraints, not a list of tasks to redo. You do not have the parent's assistant/tool history.
Use only the coding tools declared for this request. Do not spawn other agents, manage goals, or ask the user directly; report any question or blocker to the parent.
The filesystem is shared. Edit only files explicitly assigned to you, and do not overwrite another agent's changes. Do not commit, push, publish, start GUI apps, or run tests unless your delegated task and user constraints authorize that action. If testing is restricted to CI/SSH, never run local tests.
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

export function createSubagentTool({ concurrency = 3, maxTurns = 12, defaultTimeoutMs = 300000, retryDelayMs = 1000 } = {}) {
  const pool = new Pool(concurrency);
  const lifetime = new AbortController();
  return {
    shutdown: () => lifetime.abort(new Error('Parent session closed')),
    tool: {
      name: 'subagent', label: 'Subagents', exposure: 'model-only',
      description: 'Delegate 1–6 focused tasks to subagents with independent contexts. Up to 3 run in parallel using the current model and coding tools on the same filesystem. Waits for results; no recursive delegation.',
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
        if (!Array.isArray(params.tasks) || !params.tasks.length || params.tasks.length > MAX_TASKS
          || params.tasks.some(t => typeof t.name !== 'string' || !t.name.trim() || typeof t.task !== 'string' || !t.task.trim())) throw new Error('Provide 1–6 non-empty named subagent tasks');
        const deadline = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(parentSignal ? [parentSignal] : [])]);
        const timer = setTimeout(() => deadline.abort(new Error('Subagent batch timed out')), params.timeoutSeconds ? params.timeoutSeconds * 1000 : defaultTimeoutMs);
        const model = ctx.model;
        const inherited = userContext(ctx);
        const systemPrompt = `${ctx.getSystemPrompt()}\n\n${CHILD_PROMPT}`;
        const results = params.tasks.map(t => ({ id: randomUUID(), name: t.name, status: 'queued', output: '', turns: 0, retries: 0, toolCalls: 0, files: [], usage: emptyUsage(), provider: model.provider, model: model.id, startedAt: Date.now() }));
        const snapshot = () => ({ kind: 'pidesk-subagents', results: structuredClone(results) });
        let lastUpdate = 0;
        const emit = (force = false) => {
          if (!onUpdate || (!force && Date.now() - lastUpdate < 200)) return;
          lastUpdate = Date.now();
          onUpdate({ content: [{ type: 'text', text: `Subagents: ${results.filter(r => !['queued', 'running', 'retrying'].includes(r.status)).length}/${results.length} finished` }], details: snapshot() });
        };
        try {
          emit(true);
          await Promise.all(results.map(async (result, index) => {
            let release, agent, unsubscribe;
            const abort = () => agent?.abort();
            try {
              release = await pool.acquire(signal);
              signal.throwIfAborted();
              result.status = 'running'; emit(true);
              const tools = ctx.tools.filter(t => TOOL_NAMES.has(t.name)).map(tool => ({ ...tool,
                async execute(_toolId, args, toolSignal, update) {
                  signal.throwIfAborted();
                  const outcome = await ctx.executeTool(tool.name, args, { signal: AbortSignal.any([signal, ...(toolSignal ? [toolSignal] : [])]), onUpdate: update });
                  if (!outcome.isError && ['write', 'edit'].includes(tool.name) && typeof args.path === 'string' && result.files.length < 100) {
                    result.files = [...result.files.filter(f => f.path !== args.path), { path: args.path, tool: tool.name }];
                  }
                  return { ...outcome.result, isError: outcome.isError };
                },
              }));
              agent = new Agent({
                initialState: { systemPrompt, model, thinkingLevel: ctx.thinkingLevel ?? 'medium', tools },
                sessionId: result.id,
                streamFn: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, { ...options, cacheRetention: 'long' }),
                finishTurn: () => result.turns >= maxTurns ? { action: 'end' } : undefined,
              });
              signal.addEventListener('abort', abort, { once: true });
              unsubscribe = agent.subscribe(event => {
                if (event.type === 'message_start' && event.message.role === 'assistant') result.output = '';
                if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') result.output = clip(result.output + event.assistantMessageEvent.delta);
                if (event.type === 'message_end' && event.message.role === 'assistant') {
                  result.turns++; addUsage(result.usage, event.message.usage);
                  result.output = clip(messageText(event.message));
                }
                if (event.type === 'tool_execution_start') { result.toolCalls++; result.currentTool = event.toolName; }
                if (event.type === 'tool_execution_end') delete result.currentTool;
                emit();
              });
              const task = `Prior user messages (constraints/context, not tasks to repeat):\n${inherited || '(none)'}\n\nDelegated context:\n${params.context || '(none)'}\n\nYour task (${result.name}):\n${params.tasks[index].task}`;
              await agent.prompt(task);
              let last = agent.state.messages.findLast(m => m.role === 'assistant');
              while (!signal.aborted && result.turns < maxTurns && result.retries < 2 && last && isRetryableAssistantError(last)) {
                result.retries++; result.status = 'retrying'; emit(true);
                await sleep(retryDelayMs * 2 ** (result.retries - 1), undefined, { signal });
                signal.throwIfAborted();
                // Retry only the failed model response, not its earlier tool executions.
                agent.state.messages = agent.state.messages.filter(m => m !== last);
                result.status = 'running';
                await agent.continue();
                last = agent.state.messages.findLast(m => m.role === 'assistant');
              }
              signal.throwIfAborted();
              if (!last || last.stopReason !== 'stop') throw new Error(last?.errorMessage || (last?.stopReason === 'toolUse' ? 'Subagent reached its turn limit' : `Subagent ended without a complete answer (${last?.stopReason ?? 'no response'})`));
              result.status = 'completed';
            } catch (error) {
              result.status = signal.aborted ? (deadline.signal.aborted ? 'timed_out' : 'cancelled') : 'failed';
              result.error = clip(signal.aborted ? signal.reason?.message || 'Subagent cancelled' : error?.message || String(error), 2000);
            } finally {
              signal.removeEventListener('abort', abort);
              unsubscribe?.();
              agent?.abort();
              if (agent) await agent.waitForIdle();
              delete result.currentTool;
              release?.(); emit(true);
            }
          }));
          const succeeded = results.filter(r => r.status === 'completed').length;
          const content = `Subagents: ${succeeded}/${results.length} completed\n\n` + results.map(r => `## ${r.name} — ${r.status}\n${r.error ? r.error + '\n' : ''}${r.output || '(no output)'}`).join('\n\n');
          return { content: [{ type: 'text', text: content }], details: snapshot(), usage: results.reduce((u, r) => addUsage(u, r.usage), emptyUsage()), isError: succeeded !== results.length };
        } finally { clearTimeout(timer); }
      },
    },
  };
}
