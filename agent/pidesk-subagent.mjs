// Agents that run inside the owning Pi process, each in its own context window, and report back to
// the coordinating agent instead of filling its context. No new credentials, daemon, shell bootstrap
// or desktop window; tool calls go through the parent's pipeline.
//
// Kinds: general (coding tools), explore (read-only), fork (a copy of the parent with the whole
// conversation, sharing its prompt cache) and custom agents defined in .pi/agents or .claude/agents.
// Agents run in the background by default: the call returns at once and each report arrives later as
// a message to the parent. A finished agent is kept for follow-up messages; stopping one is final.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { cleanupSessionResources, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const MAX_TASKS = 8;
const CODING_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const EXPLORE_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];
// The parent's own tools: a fork keeps their declarations (so its requests share the parent's prompt
// cache) but cannot use them.
const PARENT_ONLY = new Set(['subagent', 'subagent_message', 'subagent_stop', 'ask_user', 'get_goal', 'update_goal', 'present_files']);
const BUILT_IN_TYPES = new Set(['general', 'explore', 'fork']);
const ACTIVE = new Set(['queued', 'running', 'retrying']);
export const isActiveAgent = agent => ACTIVE.has(agent?.status);

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
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8').replace(/�$/, '') + '\n[Truncated; ask the agent a narrower follow-up if you need more.]';
};
const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const userMessage = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });

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

export const LENGTH_RECOVERY_PROMPT = `The previous response reached the output-token limit (including reasoning), not a process crash. Its tool calls, if any, were not executed; earlier successful actions and tool results remain. Continue the same delegated task and all original constraints from current state, without repeating successful edits. Use smaller complete writes/edits and incremental progress instead of planning or generating the whole implementation in one response. Keep discovery scoped and shell commands bounded. If completion is not feasible, return concise partial progress and blockers. This is the only automatic output-limit recovery.`;

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
    description: 'Timeout in seconds (optional; default 120 seconds for agents when omitted). Explicit values are preserved.',
  } } };
}

// A stop or stall summary must not echo raw commands, tool results or provider errors.
const blockedToolSummary = (tool, args) => clip(typeof args?.description === 'string'
  ? args.description.replace(/https?:\/\/\S+/gi, '[url]').replace(/(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|sk-[\w-]+)/gi, '[redacted]').replace(/[\r\n\t]/g, ' ')
  : tool === 'bash' ? 'shell command' : `${tool} operation`, 180);

// ---------------------------------------------------------------- guidance
export const SUBAGENT_PROMPT = `The subagent tool starts agents that work in their own context windows and report back to you. Delegating keeps this conversation's context on what matters and lets independent work run in parallel. It also costs time and tokens, so use it where it pays.

When to delegate
- A question that needs searching or reading across many files: an explore agent (read-only) does the reading and returns the answer with paths, so only the conclusion enters this conversation.
- Independent pieces of work that can run at the same time, each with its own files.
- A side task that needs what this conversation has already established: a fork sees the whole conversation, so its brief can be just the task.
- Do the work yourself when it takes a few tool calls, when you already know which file to open, when the steps depend closely on each other, or when it needs back-and-forth with the user.

Writing the brief (general, explore and custom agents see nothing of this conversation)
- Say what to find out or change and what done looks like; what you already know or have ruled out; the files and paths involved; what it may change and what it must leave alone; every user instruction that applies to it (for example "don't run tests locally", "no commits"); and what its report should contain.
- For an independent review, hand over the code or diff to examine, not your conclusion: an agent given a hypothesis tends to confirm it.

While agents run
- By default agents run in the background: the call returns at once and each agent's report arrives later as a message. Meanwhile work on something that doesn't depend on them, or end your turn. Don't redo delegated work, and don't guess at results that haven't arrived.
- Set background to false only when you can't continue without the results and the work is short. If the wait runs out, the agents keep going and report later.
- Several tasks in one call run in parallel. Agents share the working tree unless a task sets isolation to "worktree": a separate git checkout of the last commit, on its own branch. Give concurrent writers separate files or worktrees.
- subagent_message continues an agent with its context intact: a follow-up question, a correction, the next step. subagent_stop cancels an agent that is going the wrong way.

Using the reports
- A report is the agent's claim, not proof. Check what matters before relying on it (read the changed files, run the check) and tell the user what you verified.
- The user doesn't see agent reports in full: relay what matters in your own words.
- Delegation grants no extra permission: the user's restrictions apply to agents too.`;

const MARKER = 'You are a Pi Desktop subagent, not the coordinating assistant.';
const CHILD_BASE = `${MARKER}
The coordinating agent gave you the task below and acts on your report. It sees only your final message, not your tool calls, so put everything it needs there.
- Work only on your task, within the files and scope it names. Other agents may be working in the same project.
- The user's instructions below, if any, and the restrictions in your task apply to you. Don't commit, push, publish, start GUI apps or run tests unless your task says so.
- You can't ask the user or start agents. When something blocks you or needs a decision, say so in your report.
- Keep edits incremental and complete, searches scoped to the project, and shell commands bounded.
- End with a concise report: what you found or changed (with paths), what you verified and how, and what is still open. Don't claim a check you didn't run, or success after an error.`;
const TYPE_PROMPTS = {
  general: 'You are a general-purpose agent: you can read, search, edit files and run commands.',
  explore: `You are an explore agent: you search and read; you never change anything.
- Don't create, edit or delete files. Use bash only for read-only commands (git log, git diff, ls, wc and the like); never install, build, write files or run tests.
- Locate before reading: grep and find first, then read the relevant parts.
- Answer the question you were asked with evidence: file paths with line numbers and the key lines. Say what you didn't find or couldn't confirm.`,
};
const forkDirective = (name, task) => `You are a fork of the agent in this conversation, started for one task. You have the whole conversation above, but the main agent carries on without you: do only this task, then end with a report for the main agent. It sees only your final message, not your tool calls.
Starting agents, asking the user, managing the goal and presenting files aren't available to you: put questions, blockers and the paths of files for the user in your report.

Your task (${name}):
${task}`;
const FORK_PLACEHOLDER = '(Handled by the main agent; not part of this fork.)';

// ---------------------------------------------------------------- custom agents
// Markdown files with YAML frontmatter, as Claude Code's agents: name, description, tools, model,
// effort, isolation; the body is the agent's prompt. Project definitions win over the user's.
const TOOL_ALIASES = { read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', bash: 'bash', grep: 'grep', glob: 'find', find: 'find', ls: 'ls' };
const EFFORTS = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };
const unquote = value => { const v = String(value).trim(); return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v; };
const listOf = value => (Array.isArray(value) ? value : String(value ?? '').replace(/^\[|\]$/g, '').split(',')).map(unquote).map(s => s.trim()).filter(Boolean);
const toolsOf = value => [...new Set(listOf(value).map(name => TOOL_ALIASES[name.replace(/\(.*\)$/, '').toLowerCase()]).filter(Boolean))];

export function parseAgentDefinition(text, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(String(text ?? ''));
  if (!match) return null;
  const meta = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { meta[listKey].push(item[1]); continue; }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    listKey = pair[2].trim() === '' ? pair[1] : null;
    meta[pair[1]] = listKey ? [] : unquote(pair[2]);
  }
  const name = String(meta.name ?? '').trim(), description = String(meta.description ?? '').trim();
  if (!/^[\w.-]{1,64}$/.test(name) || BUILT_IN_TYPES.has(name) || !description) return null;
  const denied = new Set(toolsOf(meta.disallowedTools));
  const tools = (meta.tools === undefined ? CODING_TOOLS : toolsOf(meta.tools)).filter(t => !denied.has(t));
  const model = typeof meta.model === 'string' && meta.model.trim() && meta.model.trim() !== 'inherit' ? meta.model.trim() : undefined;
  return {
    name, description: description.replace(/\s+/g, ' ').slice(0, 300), tools, model,
    effort: EFFORTS[String(meta.effort ?? meta.thinking ?? '').toLowerCase()],
    isolation: String(meta.isolation ?? '').toLowerCase() === 'worktree' ? 'worktree' : undefined,
    omitProjectContext: ['true', 'yes'].includes(String(meta.omitClaudeMd ?? meta.omitProjectContext ?? '').toLowerCase()),
    prompt: match[2].trim(), source,
  };
}

export function findGitRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export function loadAgentDefinitions(cwd, { home = homedir() } = {}) {
  const roots = [cwd, findGitRoot(cwd ?? '.'), home].filter(Boolean);
  const dirs = [...new Set(roots.flatMap(root => [join(root, '.pi', 'agents'), join(root, '.claude', 'agents')]))];
  const found = new Map();
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { continue; }
    for (const file of files) {
      try {
        const path = join(dir, file);
        if (!statSync(path).isFile()) continue;
        const definition = parseAgentDefinition(readFileSync(path, 'utf8'), path);
        if (definition && !found.has(definition.name)) found.set(definition.name, definition);
      } catch { /* unreadable definition */ }
    }
  }
  return [...found.values()];
}

export function agentTypesSection(definitions = []) {
  const lines = [
    'Agent types (a task\'s type):',
    '- general (default): coding tools: read, write, edit, bash, grep, find, ls.',
    '- explore: read-only searching and reading (read, grep, find, ls, and bash for read-only commands). It skips project instruction files: put what it needs in the brief.',
    '- fork: a copy of you with this whole conversation, your tools and model. It can\'t start agents or ask the user.',
    ...definitions.map(d => `- ${d.name}: ${d.description} (tools: ${d.tools.join(', ') || 'none'}${d.isolation ? '; own worktree' : ''})`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- worktrees
const git = (cwd, args) => new Promise((ok, fail) => execFile('git', args, { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
  error ? fail(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim().split('\n')[0]}`)) : ok(String(stdout))));
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const inside = (child, parent) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
// The real path, also for a file not created yet: its nearest existing folder resolved (macOS /var is /private/var).
function realPath(path) {
  const rest = [];
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try { return join(realpathSync(dir), ...rest.reverse()); } catch { /* not there yet */ }
    if (dirname(dir) === dir) return resolve(path);
    rest.push(relative(dirname(dir), dir));
  }
}

export async function createWorktree(cwd, id) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const common = resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim());
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const path = join(common, 'pi-worktrees', id), branch = `pi-agent/${id}`;
  await git(root, ['worktree', 'add', '-q', '-b', branch, path, base]);
  const sub = relative(realPath(root), realPath(cwd));
  return { root: realPath(root), common: realPath(common), path: realPath(path), branch, base, cwd: sub && !sub.startsWith('..') && !isAbsolute(sub) ? join(realPath(path), sub) : realPath(path) };
}
export async function worktreeChanges(worktree) {
  const status = (await git(worktree.path, ['status', '--porcelain'])).split('\n').filter(Boolean);
  const commits = Number((await git(worktree.path, ['rev-list', '--count', `${worktree.base}..HEAD`])).trim()) || 0;
  return { files: status.length, commits, changed: status.length > 0 || commits > 0 };
}
export async function removeWorktree(worktree) {
  await git(worktree.root, ['worktree', 'remove', '--force', worktree.path]).catch(() => {});
  await git(worktree.root, ['branch', '-D', worktree.branch]).catch(() => {});
}
// Paths in the main checkout (or relative to it) point into the worktree instead; the worktree itself,
// .git internals and paths outside the checkout are left alone.
export function worktreePath(path, worktree) {
  if (typeof path !== 'string' || !path || path.startsWith('~')) return path;
  const absolute = realPath(isAbsolute(path) ? path : resolve(worktree.cwd, path));
  if (inside(absolute, worktree.path) || inside(absolute, worktree.common) || !inside(absolute, worktree.root)) return absolute;
  return join(worktree.path, relative(worktree.root, absolute));
}
export function worktreeArgs(name, args, worktree) {
  if (!worktree || !args || typeof args !== 'object') return args;
  if (name === 'bash' && typeof args.command === 'string') return { ...args, command: `cd ${shellQuote(worktree.cwd)} && ${args.command}` };
  if (['read', 'write', 'edit'].includes(name)) return { ...args, ...(args.path !== undefined ? { path: worktreePath(args.path, worktree) } : {}), ...(args.file_path !== undefined ? { file_path: worktreePath(args.file_path, worktree) } : {}) };
  if (['grep', 'find', 'ls'].includes(name)) return { ...args, path: args.path ? worktreePath(args.path, worktree) : worktree.cwd };
  return args;
}
const worktreeSummary = (w, c) => c?.changed
  ? `Worktree: ${w.path} (branch ${w.branch}, from ${w.base.slice(0, 7)}): ${c.files} changed file${c.files === 1 ? '' : 's'}, ${c.commits} commit${c.commits === 1 ? '' : 's'}. Review with \`git -C ${shellQuote(w.path)} status\` and \`git -C ${shellQuote(w.path)} diff ${w.base.slice(0, 7)}\`, then merge the branch or copy the changes; remove it with \`git worktree remove ${shellQuote(w.path)}\`.`
  : 'Worktree: no changes, removed.';

// ---------------------------------------------------------------- scheduling
// One pool per extension runtime, shared by every agent this Pi starts.
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

const newId = taken => { let id; do id = `agent-${randomBytes(4).toString('hex')}`; while (taken.has(id)); return id; };
const statusWord = agent => agent.status === 'completed' ? 'finished' : agent.status === 'cancelled' ? 'was stopped' : agent.status === 'failed' ? 'failed' : agent.status;
const describeAgent = agent => `${agent.name} (id ${agent.id}, ${agent.type}${agent.worktree ? ', worktree' : ''})`;

export function createSubagentTool({
  concurrency = 5, retryDelayMs = 1000, stallMs = 10 * 60 * 1000, maxRetained = 24, defaultWaitSeconds = 600, heartbeatMs = 30000,
  notify, publish, isIdle, parentTools, home,
} = {}) {
  const pool = new Pool(concurrency);
  const lifetime = new AbortController();
  const entries = new Map();           // id -> { record, agent, ... }; finished ones stay for follow-ups
  const departed = new Map();          // evicted records, until their last state is published
  let promptOptions = {};               // project context, captured before each parent run
  let definitions = [];                 // custom agents for the current working directory
  let definitionsCwd = null;

  // ---- publishing live state (throttled) to the desktop
  const changed = new Set();
  let publishTimer = null, lastPublish = 0;
  const snapshot = record => structuredClone(record);
  function flushPublish(all = false) {
    clearTimeout(publishTimer); publishTimer = null; lastPublish = Date.now();
    const ids = new Set(all ? entries.keys() : changed);
    changed.clear();
    for (const entry of entries.values()) if (isActiveAgent(entry.record)) ids.add(entry.record.id);
    const agents = [...ids].map(id => entries.get(id)?.record ?? departed.get(id)).filter(Boolean).map(snapshot);
    departed.clear();
    if (agents.length) try { publish?.(JSON.stringify({ agents })); } catch { /* the desktop catches up on the next change */ }
  }
  // force: a status change, shown at once instead of with the next throttled update.
  function touch(record, force = false) {
    record.updatedAt = Date.now();
    changed.add(record.id);
    for (const listener of entries.get(record.id)?.listeners ?? []) listener(force);
    if (!publish || publishTimer) return;
    publishTimer = setTimeout(() => flushPublish(), Math.max(0, 1000 - (Date.now() - lastPublish)));
    publishTimer.unref?.();
  }

  // ---- reports to the parent: sent when it is idle, never left in Pi's queue (Stop clears it)
  const pending = [];
  const sent = new Map();               // key -> { notice, attempts }, until it is seen in the session
  function flushNotices({ trigger }) {
    if (!notify || !pending.length || lifetime.signal.aborted) return;
    const batch = pending.splice(0);
    batch.forEach((notice, i) => {
      const last = i === batch.length - 1;
      sent.set(notice.details.key, { notice, attempts: (sent.get(notice.details.key)?.attempts ?? 0) + 1 });
      try { notify(notice, trigger && last ? { triggerTurn: true, deliverAs: 'followUp' } : {}); }
      catch { pending.push(notice); }
    });
  }
  function report(entry, run) {
    // After this session closed, Pi's messages go to whichever session replaced it: not ours.
    if (lifetime.signal.aborted) return;
    const record = entry.record;
    const content = [
      'Automated message from Pi Desktop, not from the user: a background agent you started has ' + (record.status === 'completed' ? 'finished.' : record.status === 'cancelled' ? 'stopped.' : 'failed.'),
      `Agent: ${describeAgent(record)}`,
      `Status: ${record.status}${record.error ? ` — ${record.error}` : ''}`,
      `Report:\n${record.output || '(no report)'}`,
      record.worktree?.summary,
      record.status === 'cancelled' ? null : `To continue this agent with its context, use subagent_message with id ${record.id}.`,
    ].filter(Boolean).join('\n\n');
    pending.push({ customType: 'pidesk-agent', content, display: true,
      details: { kind: 'pidesk-agent', key: `${record.id}:${run.run}`, agent: snapshot(record), run: run.run, agentRuns: [run.record] } });
    if (isIdle?.() !== false) flushNotices({ trigger: true });
  }

  // ---- building a child
  function definitionFor(type, cwd) {
    if (definitionsCwd !== cwd) { definitions = loadAgentDefinitions(cwd, { home }); definitionsCwd = cwd; }
    return definitions.find(d => d.name === type);
  }
  function resolveModel(ctx, wanted) {
    if (!wanted) return { model: ctx.model };
    const slash = wanted.indexOf('/');
    const found = slash > 0 ? ctx.modelRegistry?.find?.(wanted.slice(0, slash), wanted.slice(slash + 1))
      : (ctx.modelRegistry?.getAvailable?.() ?? []).filter(m => m.id === wanted).sort((a, b) => (b.provider === ctx.model?.provider) - (a.provider === ctx.model?.provider))[0];
    return found ? { model: found } : { model: ctx.model, note: `Model ${wanted} isn't configured; using the current model.` };
  }
  function freshPrompt(type, cwd, definition) {
    const parts = [CHILD_BASE, definition?.prompt || TYPE_PROMPTS[type] || TYPE_PROMPTS.general];
    if (promptOptions.appendSystemPrompt) parts.push(`<user_instructions>\n${promptOptions.appendSystemPrompt}\n</user_instructions>`);
    // The session's own notes (the runtime, a No-folder workspace), not the coordinator's delegation guidance.
    for (const [tag, text] of Object.entries(promptOptions.sections ?? {})) if (tag !== 'subagents' && text) parts.push(`<${tag}>\n${text}\n</${tag}>`);
    if (type !== 'explore' && !definition?.omitProjectContext) {
      for (const file of promptOptions.contextFiles ?? []) parts.push(`<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`);
    }
    parts.push(`Working directory: ${cwd}\nToday's date: ${new Date().toDateString()}\nPlatform: ${process.platform}`);
    return parts.join('\n\n');
  }
  // keepSchema: a fork declares the parent's tools unchanged, so its requests match the parent's.
  function wrapTool(entry, tool, ctx, { keepSchema = false } = {}) {
    const parameters = keepSchema ? tool.parameters : childBashParameters(tool);
    return { ...tool, label: tool.label ?? tool.name, parameters,
      async execute(_toolId, args, toolSignal, update) {
        const state = entry.current;
        state?.signal.throwIfAborted();
        if (PARENT_ONLY.has(tool.name)) {
          return { content: [{ type: 'text', text: `${tool.name} isn't available to agents: put questions, blockers and the paths of files for the user in your report instead.` }], details: {}, isError: true };
        }
        // Apply the default after Pi's normal validation (which treats a null optional,
        // non-nullable field as omitted). Explicit numeric values survive.
        let input = parameters !== tool.parameters && args?.timeout === undefined ? { ...args, timeout: 120 } : args;
        input = worktreeArgs(tool.name, input, entry.worktree);
        const actionId = Symbol();
        state?.activeTools.set(actionId, `running ${tool.name} (${blockedToolSummary(tool.name, args)})`);
        try {
          const outcome = await ctx.executeTool(tool.name, input, { signal: AbortSignal.any([state?.signal ?? lifetime.signal, ...(toolSignal ? [toolSignal] : [])]), onUpdate: update });
          const record = entry.record;
          if (!outcome.isError && ['write', 'edit'].includes(tool.name) && typeof input?.path === 'string' && record.files.length < 100) {
            record.files = [...record.files.filter(f => f.path !== input.path), { path: input.path, tool: tool.name }];
          }
          return { ...outcome.result, isError: outcome.isError };
        } finally { state?.activeTools.delete(actionId); }
      },
    };
  }
  function childTools(entry, ctx, names) {
    const available = new Map((ctx.tools ?? []).map(t => [t.name, t]));
    return names.filter(name => available.has(name)).map(name => wrapTool(entry, available.get(name), ctx));
  }
  function forkSetup(entry, ctx, callId, name, task) {
    // The parent's declared tools in its order, so the fork's requests reuse the parent's prompt cache.
    const declared = parentTools?.() ?? ctx.tools ?? [];
    const tools = declared.map(tool => wrapTool(entry, tool, ctx, { keepSchema: true }));
    let messages = [];
    try { messages = [...(ctx.sessionManager?.buildSessionProjection?.().messages ?? [])]; } catch { messages = []; }
    // The parent's message that started this fork: answer each of its tool calls that has no result
    // yet (calls running in parallel may have finished first), this one with the fork's task.
    const at = messages.findLastIndex(m => m.role === 'assistant' && (m.content ?? []).some(b => b?.type === 'toolCall' && b.id === callId));
    if (at >= 0) {
      const answered = new Set(messages.slice(at + 1).filter(m => m.role === 'toolResult').map(m => m.toolCallId));
      for (const call of messages[at].content.filter(b => b?.type === 'toolCall' && !answered.has(b.id))) {
        messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false, timestamp: Date.now(),
          content: [{ type: 'text', text: call.id === callId ? forkDirective(name, task) : FORK_PLACEHOLDER }] });
      }
      return { tools, messages, start: { kind: 'continue' } };
    }
    return { tools, messages, start: { kind: 'prompt', message: forkDirective(name, task) } };
  }

  function createEntry({ ctx, callId, index, task, context, background, cwd }) {
    const type = task.type?.trim() || 'general';
    const definition = BUILT_IN_TYPES.has(type) ? undefined : definitionFor(type, cwd);
    if (!BUILT_IN_TYPES.has(type) && !definition) {
      const names = ['general', 'explore', 'fork', ...definitions.map(d => d.name)];
      throw new Error(`Unknown agent type "${type}". Available: ${names.join(', ')}`);
    }
    if (definition && !definition.tools.length) throw new Error(`Agent type "${type}" has no usable tools (${definition.source})`);
    const id = newId(new Set([...entries.keys(), ...departed.keys()]));
    const { model, note } = resolveModel(ctx, definition?.model);
    const record = {
      id, name: task.name.trim(), type, task: clip(task.task, 4000), status: 'queued', background, callId, index,
      output: '', steps: [], omittedSteps: 0, turns: 0, runs: 0, retries: 0, lengthRecoveries: 0, skippedToolCalls: 0, toolCalls: 0, files: [],
      usage: emptyUsage(), provider: model.provider, model: model.id, startedAt: Date.now(), updatedAt: Date.now(), retained: true,
    };
    if (note) recordSubagentStep(record, { id: 'model-note', type: 'notice', text: note });
    const entry = { record, ctx, model, cwd, listeners: new Set(), stop: new AbortController(), inputs: [],
      isolation: task.isolation === 'worktree' || definition?.isolation === 'worktree' ? 'worktree' : undefined,
      thinkingLevel: definition?.effort ?? ctx.thinkingLevel ?? 'medium' };
    if (type === 'fork') {
      const fork = forkSetup(entry, ctx, callId, record.name, task.task);
      Object.assign(entry, { systemPrompt: ctx.getSystemPrompt(), tools: fork.tools, messages: fork.messages, start: fork.start });
    } else {
      const names = definition?.tools ?? (type === 'explore' ? EXPLORE_TOOLS : CODING_TOOLS);
      Object.assign(entry, { systemPrompt: freshPrompt(type, cwd, definition), tools: childTools(entry, ctx, names), messages: [],
        start: { kind: 'prompt', message: `Context from the coordinating agent:\n${context?.trim() || '(none)'}\n\nYour task (${record.name}):\n${task.task}` } });
    }
    entries.set(id, entry);
    return entry;
  }

  function createAgent(entry) {
    return new Agent({
      initialState: { systemPrompt: entry.systemPrompt, model: entry.model, thinkingLevel: entry.thinkingLevel, tools: entry.tools, messages: entry.messages },
      sessionId: entry.record.id,
      convertToLlm,
      prepareRequest: (_request, runSignal) => {
        entry.current?.signal.throwIfAborted();
        runSignal?.throwIfAborted();
      },
      streamFn: (m, context, options) => {
        const signal = entry.current?.signal ?? lifetime.signal;
        signal.throwIfAborted();
        return entry.ctx.modelRegistry.streamSimple(m, context, { ...options,
          signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]), cacheRetention: 'long', maxRetries: 0 });
      },
      // No turn cap. Yield so even an immediately resolving provider/tool loop services
      // Stop timers; don't rely on a provider honouring abort.
      finishTurn: async (turn, runSignal) => {
        await yieldToEventLoop();
        const state = entry.current;
        if (turn.message.stopReason === 'length' && state) state.endedLengthTurn = turn;
        return state?.signal.aborted || runSignal?.aborted || turn.message.stopReason === 'length' ? { action: 'end' } : undefined;
      },
    });
  }

  function onAgentEvent(entry, state, event) {
    const record = entry.record;
    state.lastProgress = Date.now();
    const messageId = `message:${record.turns + 1}`;
    if (event.type === 'message_start' && event.message.role === 'assistant') record.output = '';
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      record.output = clip(record.output + event.assistantMessageEvent.delta);
      recordSubagentStep(record, { id: messageId, type: 'message', status: 'running', text: record.output });
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      record.turns++; state.turns++;
      addUsage(record.usage, event.message.usage); addUsage(state.usage, event.message.usage);
      record.output = clip(messageText(event.message));
      record.stopReason = ['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(event.message.stopReason) ? event.message.stopReason : 'unknown';
      record.lastResponse = subagentResponseDiagnostics(event.message, entry.model);
      record.skippedToolCalls += record.lastResponse.skippedToolCalls;
      const lengthError = record.stopReason === 'length' ? outputLimitMessage(record.lastResponse, state.lengthRecoveries > 0) : undefined;
      if (record.output || event.message.errorMessage || lengthError) recordSubagentStep(record, {
        id: messageId, type: 'message', stopReason: record.stopReason, status: ['error', 'aborted', 'length'].includes(record.stopReason) ? 'failed' : 'completed',
        text: record.output, error: lengthError || (event.message.errorMessage ? clip(event.message.errorMessage, 2000) : undefined), endedAt: Date.now(),
      });
    }
    const toolId = `tool:${record.turns}:${event.toolCallId}`;
    if (event.type === 'tool_execution_start') {
      const skipped = record.stopReason === 'length';
      record.toolCalls++; if (!skipped) record.currentTool = event.toolName;
      recordSubagentStep(record, { id: toolId, type: 'tool', name: event.toolName, status: skipped ? 'skipped' : 'running',
        summary: skipped ? 'Not executed: output token limit; arguments may be truncated' : clip(event.args?.description || event.args?.path || event.args?.pattern || event.toolName, 512),
        input: skipped ? undefined : clip(event.toolName === 'bash' ? event.args?.command : JSON.stringify(event.args ?? {}, null, 2), 4000),
        path: !skipped && ['read', 'write', 'edit'].includes(event.toolName) && typeof event.args?.path === 'string' ? clip(event.args.path, 1024) : undefined,
      });
    }
    if (event.type === 'tool_execution_update') recordSubagentStep(record, { id: toolId, type: 'tool', name: event.toolName, status: 'running', output: toolOutput(event.partialResult) });
    if (event.type === 'tool_execution_end') {
      delete record.currentTool;
      recordSubagentStep(record, { id: toolId, type: 'tool', name: event.toolName, status: record.stopReason === 'length' ? 'skipped' : event.isError ? 'failed' : 'completed', output: toolOutput(event.result), durationMs: event.durationMs, endedAt: Date.now() });
    }
    touch(record);
  }

  // One run: the first task, or one follow-up message. Resolves with the run's usage record.
  async function runOnce(entry, start, control) {
    const record = entry.record;
    const run = ++record.runs;
    const state = { signal: AbortSignal.any([lifetime.signal, entry.stop.signal]), activeTools: new Map(), lastProgress: Date.now(),
      usage: emptyUsage(), turns: 0, lengthRecoveries: 0, retries: 0 };
    entry.current = state;
    let release, unsubscribe, watchdog;
    const abort = () => {
      state.blockedAt ??= [...state.activeTools.values()].at(-1) ?? 'waiting on model';
      entry.agent?.abort();
    };
    Object.assign(record, { status: 'queued' });
    delete record.error; delete record.failureKind; delete record.finishedAt;
    touch(record, true);
    try {
      release = await pool.acquire(state.signal);
      state.signal.throwIfAborted();
      if (entry.isolation === 'worktree' && !entry.worktree) {
        entry.worktree = await createWorktree(entry.cwd, record.id);
        record.worktree = { path: entry.worktree.path, branch: entry.worktree.branch, base: entry.worktree.base };
      }
      entry.agent ??= createAgent(entry);
      Object.assign(record, { status: 'running', runStartedAt: Date.now() });
      touch(record, true);
      state.signal.addEventListener('abort', abort, { once: true });
      unsubscribe = entry.agent.subscribe(event => onAgentEvent(entry, state, event));
      // A model that stops answering is stopped; a long tool has its own timeout.
      watchdog = setInterval(() => {
        if (!state.activeTools.size && Date.now() - state.lastProgress > stallMs) { state.stalled = true; abort(); }
      }, Math.max(10, Math.min(stallMs / 4, 30000)));
      watchdog.unref?.();
      for (const message of entry.inputs.splice(0)) entry.agent.followUp(message);
      if (start.kind === 'continue') await entry.agent.continue(); else await entry.agent.prompt(start.message);
      while (true) {
        // Each prompt/continue has truly settled before state is inspected or pruned.
        state.signal.throwIfAborted();
        if (state.stalled) throw new Error('stalled');
        const last = entry.agent.state.messages.findLast(m => m.role === 'assistant');
        if (last?.stopReason === 'length') {
          if (state.lengthRecoveries >= 1) {
            record.failureKind = 'output_limit';
            throw new Error(outputLimitMessage(record.lastResponse, true));
          }
          try { entry.agent.state.messages = pruneLengthTurn(entry.agent.state.messages, last, state.endedLengthTurn); }
          catch (error) { record.failureKind = 'output_limit'; throw error; }
          state.signal.throwIfAborted();
          state.lengthRecoveries++; record.lengthRecoveries++; record.status = 'retrying';
          recordSubagentStep(record, { id: `length-recovery:${run}`, type: 'notice', text: 'Output token limit: recovery 1/1. Continuing from earlier successful actions with smaller complete writes/edits; original constraints unchanged.' });
          touch(record, true);
          state.signal.throwIfAborted();
          state.endedLengthTurn = undefined; record.status = 'running';
          await entry.agent.prompt(LENGTH_RECOVERY_PROMPT);
          continue;
        }
        if (last && isRetryableAssistantError(last) && state.retries < 2) {
          state.retries++; record.retries++; record.status = 'retrying';
          recordSubagentStep(record, { id: `retry:${run}:${state.retries}`, type: 'notice', text: `Retry ${state.retries}/2: ${clip(last.errorMessage, 2000)}` });
          touch(record, true);
          await sleep(retryDelayMs * 2 ** (state.retries - 1), undefined, { signal: state.signal });
          state.signal.throwIfAborted();
          // Error responses are hard exits and must be the exact final message.
          if (entry.agent.state.messages.at(-1) !== last) throw new Error('Cannot safely retry agent response');
          entry.agent.state.messages = entry.agent.state.messages.slice(0, -1);
          state.endedLengthTurn = undefined; record.status = 'running';
          await entry.agent.continue();
          continue;
        }
        if (!last || last.stopReason !== 'stop') {
          record.failureKind = last?.stopReason === 'aborted' ? 'cancelled' : last?.stopReason === 'error' ? 'provider_error' : 'runtime_error';
          throw new Error(last?.errorMessage || `Agent ended without a complete answer (${record.stopReason ?? 'no response'})`);
        }
        // A message that arrived as the agent was answering is part of this run.
        if (entry.agent.hasQueuedMessages?.()) { await entry.agent.continue(); continue; }
        record.status = 'completed';
        break;
      }
    } catch (error) {
      if (state.stalled && !entry.stop.signal.aborted) {
        Object.assign(record, { status: 'failed', failureKind: 'stalled', error: `No response from the model for ${Math.round(stallMs / 60000) || 1} minutes; stopped.` });
      } else if (state.signal.aborted) {
        const reason = state.signal.reason?.message || 'Stopped';
        Object.assign(record, { status: 'cancelled', failureKind: 'cancelled', error: clip(state.blockedAt ? `${reason} while ${state.blockedAt}` : reason, 2000) });
      } else {
        Object.assign(record, { status: 'failed', failureKind: record.failureKind ?? 'runtime_error', error: clip(error?.message || String(error), 2000) });
      }
    } finally {
      state.finishing = true;
      state.signal.removeEventListener('abort', abort);
      clearInterval(watchdog);
      unsubscribe?.();
      if (entry.agent) {
        entry.agent.abort();
        await entry.agent.waitForIdle();
        try { cleanupSessionResources(record.id); }
        catch { if (record.status === 'completed') Object.assign(record, { status: 'failed', failureKind: 'runtime_error' }); record.error = 'Agent provider resource cleanup failed'; }
      }
      if (entry.worktree) {
        const changes = await worktreeChanges(entry.worktree).catch(() => ({ changed: true, files: 0, commits: 0 }));
        record.worktree = { ...record.worktree, ...changes, summary: worktreeSummary(entry.worktree, changes) };
        if (!changes.changed) { await removeWorktree(entry.worktree); entry.worktree = null; }
      }
      delete record.currentTool;
      record.finishedAt = Date.now();
      for (const step of [...record.steps]) if (step.status === 'running') recordSubagentStep(record, { id: step.id, status: record.status === 'completed' ? 'completed' : record.status, endedAt: record.finishedAt });
      entry.current = null;
      release?.();
      touch(record, true);
    }
    const result = { run, record: { key: `pidesk-agent:${record.id}:${run}`, provider: record.provider, model: record.model, usage: state.usage, turns: state.turns, at: record.runStartedAt ?? record.startedAt } };
    if (control.notify) report(entry, result);
    retain();
    return result;
  }

  // While agents work, their state is resent now and then, so a desktop that reattached (or missed
  // an update) never sees a working agent as gone, even during a long silent command.
  let heartbeat = null;
  function startRun(entry, start, control) {
    entry.running = runOnce(entry, start, control).finally(() => { entry.running = null; });
    if (publish && !heartbeat) {
      heartbeat = setInterval(() => {
        if ([...entries.values()].some(e => e.running)) flushPublish(true);
        else { clearInterval(heartbeat); heartbeat = null; }
      }, heartbeatMs);
      heartbeat.unref?.();
    }
    return entry.running;
  }

  // Finished agents stay available for follow-ups; the oldest go first beyond the cap.
  function retain() {
    const finished = [...entries.values()].filter(e => !isActiveAgent(e.record) && !e.running).sort((a, b) => (a.record.finishedAt ?? 0) - (b.record.finishedAt ?? 0));
    for (const entry of finished.slice(0, Math.max(0, finished.length - maxRetained))) {
      entries.delete(entry.record.id);
      entry.agent = null;
      entry.record.retained = false;
      departed.set(entry.record.id, entry.record);
      touch(entry.record);
    }
  }

  // Wait for runs up to a deadline; whatever is still running then reports in the background.
  async function waitFor(runs, waitSeconds) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), waitSeconds * 1000); timer.unref?.(); });
    const all = Promise.all(runs.map(r => r.promise.then(value => { r.done = value; }, error => { r.error = error; })));
    const outcome = await Promise.race([all.then(() => 'done'), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') for (const r of runs) if (!r.done && !r.error) r.control.notify = true;
    const failed = runs.find(r => r.error);
    if (failed) throw failed.error;
    return runs;
  }

  function batchContent(entries_, detached) {
    const done = entries_.filter(e => !detached.has(e.record.id));
    const succeeded = done.filter(e => e.record.status === 'completed').length;
    return [`Subagents: ${succeeded}/${entries_.length} completed`,
      ...entries_.map(e => detached.has(e.record.id)
        ? `## ${e.record.name} — still running in the background (id ${e.record.id})\nIts report arrives as a message when it finishes.`
        : `## ${e.record.name} — ${e.record.status}\n${e.record.error ? e.record.error + '\n' : ''}${e.record.output || '(no output)'}${e.record.worktree?.summary ? `\n\n${e.record.worktree.summary}` : ''}`),
    ].join('\n\n');
  }
  const sumUsage = runs => runs.reduce((u, r) => addUsage(u, r.usage), emptyUsage());

  function liveUpdates(list, onUpdate) {
    if (!onUpdate) return () => {};
    let last = 0, timer = null;
    const emit = () => {
      clearTimeout(timer); timer = null; last = Date.now();
      const finished = list.filter(e => !isActiveAgent(e.record)).length;
      onUpdate({ content: [{ type: 'text', text: `Subagents: ${finished}/${list.length} finished` }], details: { kind: 'pidesk-subagents', results: list.map(e => snapshot(e.record)) } });
    };
    const listener = force => {
      const remaining = 1000 - (Date.now() - last);
      if (force || remaining <= 0) emit();
      // A trailing update also exposes a long-running silent command's start.
      else timer ??= setTimeout(emit, remaining);
    };
    for (const entry of list) entry.listeners.add(listener);
    emit();
    return () => { clearTimeout(timer); for (const entry of list) entry.listeners.delete(listener); };
  }

  // ---------------------------------------------------------------- tools
  const tool = {
    name: 'subagent', label: 'Subagents', exposure: 'model-only',
    description: 'Start agents that work in their own context windows and report back: tasks [{name, task, type?, isolation?}]. Types: general (default), explore (read-only), fork (a copy of you with this conversation), or a custom type from your instructions. Runs in the background by default; each report arrives as a message.',
    promptSnippet: 'Start agents for searches (explore), parallel independent work, or context-heavy side tasks (fork).',
    promptGuidelines: ['Brief fresh agents fully (goal, paths, scope, user instructions, what to report). Background agents report later as messages: do not redo their work or guess results. Verify reports before relying on them.'],
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 80, description: 'Short label for this agent' }),
        task: Type.String({ minLength: 1, maxLength: 20000, description: 'The brief: goal, what you know or ruled out, paths, scope, applicable user instructions, and what to report' }),
        type: Type.Optional(Type.String({ maxLength: 64, description: 'general (default), explore, fork, or a custom agent type listed in your instructions' })),
        isolation: Type.Optional(Type.Literal('worktree', { description: 'Work in a separate git worktree on its own branch, starting from the last commit' })),
      }), { minItems: 1, maxItems: MAX_TASKS }),
      context: Type.Optional(Type.String({ maxLength: 24000, description: 'Facts and user instructions shared by every brief (a fork already has the conversation)' })),
      background: Type.Optional(Type.Boolean({ description: 'Default true: return at once and receive each report as a message. false: wait for the reports, up to waitSeconds' })),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: `With background false: how long to wait before the agents carry on in the background (default ${defaultWaitSeconds})` })),
    }),
    async execute(callId, params, parentSignal, onUpdate, ctx) {
      if (!ctx?.model) throw new Error('Select a model before delegating');
      if (!Array.isArray(params?.tasks) || !params.tasks.length || params.tasks.length > MAX_TASKS
        || params.tasks.some(t => !t || typeof t.name !== 'string' || !t.name.trim() || typeof t.task !== 'string' || !t.task.trim())) throw new Error(`Provide 1–${MAX_TASKS} non-empty named subagent tasks`);
      const background = params.background !== false;
      const cwd = ctx.cwd ?? promptOptions.cwd ?? process.cwd();
      const created = [];
      try { params.tasks.forEach((task, index) => created.push(createEntry({ ctx, callId, index, task, context: params.context, background, cwd }))); }
      catch (error) { for (const entry of created) entries.delete(entry.record.id); throw error; }
      const controls = created.map(() => ({ notify: background }));
      // A stop of the parent's run cancels only agents it is still waiting for.
      const onParentAbort = () => created.forEach((entry, i) => { if (!controls[i].notify) entry.stop.abort(parentSignal.reason ?? new Error('Cancelled')); });
      if (!background && parentSignal) {
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
      const runs = created.map((entry, i) => ({ entry, control: controls[i], promise: startRun(entry, entry.start, controls[i]) }));
      if (background) {
        const text = [`Started ${created.length} agent${created.length === 1 ? '' : 's'} in the background:`,
          ...created.map(e => `- ${describeAgent(e.record)}`),
          'Each report arrives as a separate message when that agent finishes. Until then work on something that doesn\'t depend on them, or end your turn; don\'t redo their work or guess their results. subagent_message sends an agent more instructions; subagent_stop cancels it.'].join('\n');
        // No runs are reported here: each agent's usage comes with its report.
        return { content: [{ type: 'text', text }], details: { kind: 'pidesk-subagents', background: true, results: created.map(e => snapshot(e.record)), agentRuns: [] } };
      }
      const stopUpdates = liveUpdates(created, onUpdate);
      try {
        await waitFor(runs, params.waitSeconds ?? defaultWaitSeconds);
      } finally { stopUpdates(); parentSignal?.removeEventListener('abort', onParentAbort); }
      const detached = new Set(runs.filter(r => !r.done).map(r => r.entry.record.id));
      const finished = runs.filter(r => r.done).map(r => r.done.record);
      return {
        content: [{ type: 'text', text: batchContent(created, detached) }],
        details: { kind: 'pidesk-subagents', results: created.map(e => ({ ...snapshot(e.record), ...(detached.has(e.record.id) ? { detached: true } : {}) })), agentRuns: finished },
        usage: sumUsage(finished),
        isError: runs.some(r => r.done && r.entry.record.status !== 'completed'),
      };
    },
  };

  // A message to an agent: queued while it works, otherwise the start of another run.
  function message(id, text, { from = 'parent', background = true } = {}) {
    const entry = entries.get(id);
    if (!entry) throw new Error(departed.has(id) || !id ? `Agent ${id} is no longer available. Start a new agent with what it needs.` : `No agent with id ${id} in this session (agents don't survive a restart of Pi). Start a new agent with what it needs.`);
    if (entry.record.status === 'cancelled' || entry.stop.signal.aborted) throw new Error(`Agent ${entry.record.name} was stopped; start a new agent instead.`);
    const body = from === 'user' ? `Message from the user, sent to you directly:\n${text}` : text;
    recordSubagentStep(entry.record, { id: `input:${entry.record.runs}:${entry.record.steps.length}:${Date.now()}`, type: 'input', from, text: clip(text, 8000) });
    touch(entry.record);
    if (entry.running && !entry.current?.finishing) {
      if (entry.agent) entry.agent.followUp(userMessage(body)); else entry.inputs.push(userMessage(body));
      return { entry, queued: true, promise: entry.running };
    }
    // Idle, or wrapping up its last run: the message starts the next run.
    const control = { notify: background };
    const promise = (entry.running ?? Promise.resolve()).catch(() => {}).then(() => entry.stop.signal.aborted
      ? Promise.reject(new Error(`Agent ${entry.record.name} was stopped.`)) : startRun(entry, { kind: 'prompt', message: body }, control));
    return { entry, queued: false, control, promise };
  }

  const messageTool = {
    name: 'subagent_message', label: 'Message agent', exposure: 'model-only',
    description: 'Send more instructions to an agent you started (by id). It continues with its context intact. Runs in the background by default; the reply arrives as a message.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: 'The agent id from its start or report' }),
      message: Type.String({ minLength: 1, maxLength: 20000, description: 'What to do next: a follow-up question, a correction, the next step' }),
      background: Type.Optional(Type.Boolean({ description: 'Default true. false: wait for the reply, up to waitSeconds' })),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    }),
    async execute(_id, params, parentSignal) {
      const background = params.background !== false;
      const sent_ = message(params.id, params.message, { background });
      const { entry } = sent_;
      // A message joining a run in progress is answered by that run's own report (or by the call
      // waiting for it), so it is never waited for twice.
      if (background || sent_.queued) {
        return { content: [{ type: 'text', text: sent_.queued
          ? `Queued for ${describeAgent(entry.record)}: it reads your message after its current step, and its report arrives as a message.`
          : `Sent to ${describeAgent(entry.record)}. Its reply arrives as a message.` }], details: { kind: 'pidesk-agent-message', agent: snapshot(entry.record) } };
      }
      const control = sent_.control;
      const onAbort = () => { if (!control.notify) entry.stop.abort(parentSignal.reason ?? new Error('Cancelled')); };
      parentSignal?.addEventListener('abort', onAbort, { once: true });
      const [r] = await waitFor([{ entry, control, promise: sent_.promise }], params.waitSeconds ?? defaultWaitSeconds).finally(() => parentSignal?.removeEventListener('abort', onAbort));
      if (!r.done) return { content: [{ type: 'text', text: `${describeAgent(entry.record)} is still working; its reply arrives as a message.` }], details: { kind: 'pidesk-agent-message', agent: snapshot(entry.record) } };
      const record = entry.record;
      return {
        content: [{ type: 'text', text: `## ${record.name} — ${record.status}\n${record.error ? record.error + '\n' : ''}${record.output || '(no output)'}${record.worktree?.summary ? `\n\n${record.worktree.summary}` : ''}` }],
        details: { kind: 'pidesk-agent-message', agent: snapshot(record), agentRuns: [r.done.record] },
        usage: r.done.record.usage,
        isError: record.status !== 'completed',
      };
    },
  };

  function stop(id, reason = 'Stopped by the main agent') {
    const entry = entries.get(id);
    if (!entry) return null;
    entry.stop.abort(new Error(reason));
    if (!entry.running) {
      Object.assign(entry.record, { status: 'cancelled', failureKind: 'cancelled', error: reason, finishedAt: entry.record.finishedAt ?? Date.now() });
      touch(entry.record);
    }
    return entry;
  }
  const stopTool = {
    name: 'subagent_stop', label: 'Stop agent', exposure: 'model-only',
    description: 'Stop an agent you started (by id), for example one going the wrong way. A stopped agent cannot be continued.',
    parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64, description: 'The agent id' }) }),
    async execute(_id, params) {
      const entry = stop(params.id);
      if (!entry) throw new Error(`No agent with id ${params.id} in this session.`);
      await entry.running?.catch(() => {});
      return { content: [{ type: 'text', text: `Stopped ${describeAgent(entry.record)}.` }], details: { kind: 'pidesk-agent-stop', agent: snapshot(entry.record) } };
    },
  };

  return {
    tool, messageTool, stopTool,
    shutdown: () => { lifetime.abort(new Error('Parent session closed')); clearInterval(heartbeat); heartbeat = null; flushPublish(); },
    setPromptOptions(options) { promptOptions = options ?? {}; },
    promptSection(cwd) {
      if (cwd && definitionsCwd !== cwd) { definitions = loadAgentDefinitions(cwd, { home }); definitionsCwd = cwd; }
      return `${SUBAGENT_PROMPT}\n\n${agentTypesSection(definitions)}`;
    },
    stop: (id, reason) => !!stop(id, reason),
    message: (id, text, options) => message(id, text, { background: true, ...options }),
    sync: () => flushPublish(true),
    agents: () => [...entries.values()].map(e => snapshot(e.record)),
    // The parent's run ended: send reports that waited for it, and re-send any that never reached the
    // session (a Stop clears Pi's queue). After a Stop they are recorded without starting a turn.
    onSettled({ aborted = false, branch } = {}) {
      if (branch && sent.size) {
        const seen = new Set(branch.filter(e => e.type === 'custom_message' && e.customType === 'pidesk-agent').map(e => e.details?.key));
        for (const [key, { notice, attempts }] of sent) {
          sent.delete(key);
          if (!seen.has(key) && attempts < 3 && !pending.some(p => p.details.key === key)) pending.unshift(notice);
        }
      }
      flushNotices({ trigger: !aborted });
    },
    // A session file with agents that were still running when their Pi ended: record that they stopped.
    restore(branch = []) {
      const last = new Map();
      for (const e of branch) {
        const message = e.type === 'message' ? e.message : null;
        if (message?.role === 'toolResult' && message.toolName === 'subagent' && message.details?.kind === 'pidesk-subagents') {
          for (const r of message.details.results ?? []) if (r?.id) last.set(r.id, r);
        }
        if (message?.role === 'toolResult' && ['subagent_message', 'subagent_stop'].includes(message.toolName) && message.details?.agent?.id) last.set(message.details.agent.id, message.details.agent);
        if (e.type === 'custom_message' && e.customType === 'pidesk-agent' && e.details?.agent?.id) last.set(e.details.agent.id, e.details.agent);
      }
      const orphans = [...last.values()].filter(a => isActiveAgent(a) && !entries.has(a.id));
      for (const agent of orphans) {
        const record = { ...agent, status: 'cancelled', failureKind: 'interrupted', error: 'Stopped: its Pi session ended before it finished.', retained: false, finishedAt: Date.now(), updatedAt: Date.now() };
        try {
          notify?.({ customType: 'pidesk-agent', display: true,
            content: `Automated message from Pi Desktop, not from the user: agent ${describeAgent(record)} stopped because its Pi session ended before it finished. Its work may be incomplete; it can't be continued.`,
            details: { kind: 'pidesk-agent', key: `${agent.id}:interrupted`, agent: record, run: agent.runs ?? 0, agentRuns: [] } }, {});
        } catch { /* best effort */ }
      }
      return orphans.length;
    },
  };
}
