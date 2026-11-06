// Headless unit regressions; run only in CI. Uses the actual Agent loop with fake streams.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { AssistantMessageEventStream, registerSessionResourceCleanup } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createSubagentTool, recordSubagentStep, SUBAGENT_PROMPT, TRACE_MAX_BYTES, TRACE_MAX_STEPS } from '../agent/pidesk-subagent.mjs';
import { outputs, usageOf } from '../app/renderer/src/transcript.js';
import { UsageLedger } from '../app/main/usage.mjs';

const model = { id: 'test-model', provider: 'mock', api: 'openai-completions', name: 'Test', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const reply = (text = 'done', extra = {}) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text }], usage: structuredClone(usage), stopReason: 'stop', ...extra });
const toolReply = (name = 'read') => reply('', { content: [{ type: 'toolCall', id: 'call-' + Math.random(), name, arguments: { path: 'owned.txt' } }], stopReason: 'toolUse' });
function context(produce = async () => reply()) {
  const requests = [], toolCalls = [];
  let active = 0, peak = 0;
  const ctx = {
    cwd: '/workspace', model, thinkingLevel: 'high',
    getSystemPrompt: () => 'Parent system constraints: do not launch GUI applications.',
    sessionManager: { getBranch: () => [
      { type: 'message', message: { role: 'user', content: 'Do not run local tests. Use CI only.' } },
      { type: 'message', message: { role: 'assistant', content: 'PRIVATE_PARENT_ASSISTANT_HISTORY' } },
    ] },
    tools: ['read', 'write', 'bash', 'subagent', 'ask_user', 'update_goal'].map(name => ({ name, label: name, description: name, parameters: Type.Object({ path: Type.String() }) })),
    executeTool: async (name, args, options) => { toolCalls.push({ name, args, options }); return { result: { content: [{ type: 'text', text: 'tool result' }], details: {} }, isError: false }; },
    modelRegistry: { streamSimple(m, transcript, options) {
      const stream = new AssistantMessageEventStream();
      const request = { model: m, transcript, options }; requests.push(request);
      active++; peak = Math.max(active, peak);
      Promise.resolve().then(() => produce(request, requests.length)).then(message => {
        stream.push(message.stopReason === 'error' || message.stopReason === 'aborted' ? { type: 'error', reason: message.stopReason, error: message } : { type: 'done', reason: message.stopReason, message });
      }, error => stream.push({ type: 'error', reason: 'aborted', error: reply('', { stopReason: 'aborted', errorMessage: error.message }) }))
        .finally(() => { active--; stream.end(); });
      return stream;
    } },
  };
  return { ctx, requests, toolCalls, peak: () => peak };
}
const tasks = n => Array.from({ length: n }, (_, i) => ({ name: `task-${i}`, task: `Inspect assigned part ${i}; no edits or tests.` }));
const run = (controller, c, taskList = tasks(1), signal, update, extra = {}) => controller.tool.execute('parent-tool', { tasks: taskList, context: 'Only work in the assigned scope.', background: false, ...extra }, signal, update, c.ctx);

test('fresh agents get their brief, project instructions, model and effort, not the parent conversation', async () => {
  const c = context();
  const controller = createSubagentTool();
  controller.setPromptOptions({ appendSystemPrompt: 'User rule: never push.', contextFiles: [{ path: '/workspace/AGENTS.md', content: 'Project rule: CI only.' }],
    sections: { runtime: 'Runtime availability is not permission to run tests.', subagents: 'COORDINATOR-ONLY GUIDANCE' } });
  const result = await run(controller, c, tasks(2));
  assert.equal(result.isError, false);
  assert.equal(result.details.results.length, 2);
  assert.notEqual(c.requests[0].options.sessionId, c.requests[1].options.sessionId);
  for (const request of c.requests) {
    assert.equal(request.model.id, model.id);
    assert.equal(request.options.reasoning, 'high');
    const text = JSON.stringify(request.transcript);
    assert.ok(text.includes('Only work in the assigned scope.'), 'the shared context of the brief');
    assert.ok(text.includes('User rule: never push.') && text.includes('Project rule: CI only.'), 'user and project instructions');
    assert.ok(text.includes('<runtime>') && text.includes('Runtime availability is not permission'), 'the session\'s runtime note');
    assert.ok(!text.includes('COORDINATOR-ONLY GUIDANCE'), 'delegation guidance is for the coordinator');
    assert.ok(text.includes('You are a Pi Desktop subagent, not the coordinating assistant.'));
    for (const parent of ['Do not run local tests', 'do not launch GUI', 'PRIVATE_PARENT_ASSISTANT_HISTORY']) assert.ok(!text.includes(parent), `${parent} is the parent's, not the agent's`);
    const names = request.transcript.messages[0].toolsAdded.map(t => t.name);
    assert.deepEqual(names.sort(), ['bash', 'read', 'write']);
  }
  assert.equal(result.usage.totalTokens, 36);
  assert.ok(SUBAGENT_PROMPT.includes('every user instruction that applies'));
  assert.ok(SUBAGENT_PROMPT.includes('isolation to "worktree"'));
});

test('one concurrency pool applies across simultaneous batches; results retain task order', async () => {
  const c = context(async () => { await sleep(25); return reply(); });
  const controller = createSubagentTool({ concurrency: 3, agentLimit: Infinity });
  const [a, b] = await Promise.all([run(controller, c, tasks(6)), run(controller, c, tasks(4))]);
  assert.equal(c.peak(), 3);
  assert.ok([...a.details.results, ...b.details.results].every(r => r.status === 'completed'));
  assert.deepEqual(a.details.results.map(r => r.name), tasks(6).map(t => t.name));
});

test('provider session resources are cleaned up for each child, not the parent', async () => {
  const ids = [];
  const unregister = registerSessionResourceCleanup(id => ids.push(id));
  try {
    const result = await run(createSubagentTool(), context(), tasks(2));
    assert.deepEqual(ids.sort(), result.details.results.map(r => r.id).sort());
  } finally { unregister(); }
});

test('coding calls go through the parent pipeline and report successful file outputs', async () => {
  const c = context(async request => request.transcript.messages.at(-1).role === 'user' ? toolReply('write') : reply('changed owned.txt'));
  const result = await run(createSubagentTool(), c);
  assert.equal(c.toolCalls.length, 1);
  assert.equal(c.toolCalls[0].name, 'write');
  assert.ok(c.toolCalls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result.details.results[0].files, [{ path: 'owned.txt', tool: 'write' }]);
  assert.equal(result.details.results[0].turns, 2);
  const step = result.details.results[0].steps.find(s => s.type === 'tool');
  assert.equal(step.name, 'write');
  assert.equal(step.status, 'completed');
  assert.match(step.input, /owned.txt/);
  assert.equal(step.output, 'tool result');
  assert.ok(step.endedAt >= step.at);
  assert.ok(result.details.results[0].finishedAt >= result.details.results[0].runStartedAt);
});

test('execution trace excludes hidden thinking, image bodies and inherited prompts', async () => {
  const c = context(async request => request.transcript.messages.at(-1).role === 'user' ? toolReply() : reply('', { content: [{ type: 'thinking', thinking: 'HIDDEN_THINKING', thinkingSignature: 'PRIVATE_SIGNATURE' }, { type: 'text', text: 'Public conclusion' }] }));
  c.ctx.executeTool = async () => ({ result: { content: [{ type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' }, { type: 'text', text: 'Visible tool output' }], details: {} }, isError: false });
  const result = await run(createSubagentTool(), c);
  const trace = JSON.stringify(result.details.results[0].steps);
  assert.ok(trace.includes('Public conclusion'));
  for (const hidden of ['HIDDEN_THINKING', 'PRIVATE_SIGNATURE', 'PRIVATE_IMAGE', 'Do not run local tests', 'PRIVATE_PARENT_ASSISTANT_HISTORY']) assert.ok(!trace.includes(hidden));
});

test('execution trace replaces updates and bounds retained steps/bytes with an explicit omission count', () => {
  const result = { steps: [], omittedSteps: 0 };
  recordSubagentStep(result, { id: 'tool:1', type: 'tool', status: 'running', input: 'pwd' });
  recordSubagentStep(result, { id: 'tool:1', output: 'partial' });
  recordSubagentStep(result, { id: 'tool:1', status: 'completed', output: '/workspace' });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].input, 'pwd');
  assert.equal(result.steps[0].output, '/workspace');
  for (let i = 0; i < 200; i++) recordSubagentStep(result, { id: `step:${i}`, type: 'message', text: '界'.repeat(1300) });
  assert.ok(result.steps.length <= TRACE_MAX_STEPS);
  assert.ok(Buffer.byteLength(JSON.stringify(result.steps)) <= TRACE_MAX_BYTES);
  assert.ok(result.omittedSteps > 0);
  assert.equal(result.steps.at(-1).id, 'step:199');
});

test('a silent delegated tool publishes its running trace before it completes', async () => {
  const c = context(async request => request.transcript.messages.at(-1).role === 'user' ? toolReply() : reply('done'));
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  c.ctx.executeTool = async () => { await held; return { result: { content: [{ type: 'text', text: 'finished output' }], details: {} }, isError: false }; };
  const updates = [];
  const pending = run(createSubagentTool(), c, tasks(1), undefined, update => updates.push(update));
  try {
    await sleep(1200);
    assert.ok(updates.some(u => u.details.results[0].steps.some(s => s.type === 'tool' && s.status === 'running')));
  } finally { finish(); await pending; }
});

test('retry repeats only a failed model response, not a completed tool', async () => {
  const c = context(async (_request, n) => n === 1 ? toolReply() : n === 2 ? reply('', { stopReason: 'error', errorMessage: 'terminated' }) : reply('recovered'));
  const result = await run(createSubagentTool({ retryDelayMs: 1 }), c);
  assert.equal(result.isError, false);
  assert.equal(c.requests.length, 3);
  assert.equal(c.toolCalls.length, 1);
  assert.equal(result.details.results[0].retries, 1);
  assert.equal(result.usage.totalTokens, 54);
});

test('authentication failures and repeated output limits remain failures, not successful summaries', async () => {
  for (const failure of [{ stopReason: 'error', errorMessage: '401 invalid API key' }, { stopReason: 'length' }]) {
    const c = context(async () => reply('partial', failure));
    const result = await run(createSubagentTool(), c);
    assert.equal(result.isError, true);
    assert.equal(result.details.results[0].status, 'failed');
    assert.equal(c.requests.length, failure.stopReason === 'length' ? 2 : 1);
    assert.equal(result.details.results[0].failureKind, failure.stopReason === 'length' ? 'output_limit' : 'provider_error');
    if (failure.stopReason === 'length') assert.match(result.details.results[0].error, /Output token limit reached again after one recovery/);
  }
});

test('useful work continues beyond twelve turns until the final report', async () => {
  const c = context(async (_request, n) => n <= 25 ? toolReply() : reply('Finished all 25 steps'));
  const result = await run(createSubagentTool(), c);
  assert.equal(c.requests.length, 26);
  assert.equal(c.toolCalls.length, 25);
  assert.equal(result.isError, false);
  const child = result.details.results[0];
  assert.equal(child.status, 'completed');
  assert.equal(child.turns, 26, 'turn count remains a statistic');
  assert.equal(child.output, 'Finished all 25 steps');
  assert.equal(child.usage.totalTokens, 26 * usage.totalTokens);
  assert.equal(child.steps.filter(s => s.type === 'tool' && s.status === 'completed').length, 25);
});

test('a late transient failure still retries without replaying completed tools', async () => {
  const c = context(async (_request, n) => n <= 15 ? toolReply() : n === 16
    ? reply('', { stopReason: 'error', errorMessage: 'terminated' }) : reply('Recovered after long task'));
  const result = await run(createSubagentTool({ retryDelayMs: 1 }), c);
  assert.equal(result.isError, false);
  assert.equal(c.requests.length, 17);
  assert.equal(c.toolCalls.length, 15);
  assert.equal(result.details.results[0].retries, 1);
});

test('a wait that runs out hands the agent to the background instead of killing it', async () => {
  const notices = [];
  const c = context(async request => { await sleep(1, undefined, { signal: request.options.signal }); return toolReply(); });
  const controller = createSubagentTool({ notify: (message, options) => notices.push({ message, options }) });
  const result = await run(controller, c, tasks(1), undefined, undefined, { waitSeconds: 0.05 });
  const child = result.details.results[0];
  assert.equal(child.detached, true);
  assert.ok(['queued', 'running', 'retrying'].includes(child.status));
  assert.match(result.content[0].text, /still running in the background/);
  assert.deepEqual(result.details.agentRuns, [], 'its usage is reported with its own report, not twice');
  const before = c.requests.length;
  await sleep(30);
  assert.ok(c.requests.length > before, 'the agent keeps working after the wait');
  assert.equal(controller.stop(child.id, 'Stopped by the user'), true);
  for (let i = 0; i < 100 && !notices.length; i++) await sleep(10);
  assert.equal(notices.length, 1, 'a detached agent reports when it ends');
  assert.equal(notices[0].message.details.agent.status, 'cancelled');
  assert.match(notices[0].message.details.agent.error, /Stopped by the user/);
});

test('user stop still cancels a task after more than twelve turns', async () => {
  const parent = new AbortController();
  const c = context(async (_request, n) => {
    if (n > 20) throw new Error('Unexpected model request after cancellation');
    if (n === 20) parent.abort(new Error('User stopped long task'));
    return toolReply();
  });
  const result = await run(createSubagentTool(), c, tasks(1), parent.signal);
  assert.equal(c.requests.length, 20);
  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, 'cancelled');
  assert.match(result.details.results[0].error, /User stopped long task/);
});

for (const reason of ['parent', 'shutdown']) test(`${reason} cancels active and queued subagents it waits for`, async () => {
  const c = context(async request => { await sleep(10000, undefined, { signal: request.options.signal }); return reply(); });
  const controller = createSubagentTool({ concurrency: 3, agentLimit: Infinity });
  const parent = new AbortController();
  const updates = [];
  const promise = run(controller, c, tasks(6), parent.signal, value => updates.push(value));
  await sleep(10);
  if (reason === 'parent') parent.abort(new Error('User stopped'));
  if (reason === 'shutdown') controller.shutdown();
  const result = await promise;
  assert.equal(result.isError, true);
  assert.equal(c.requests.length, 3, 'queued work must not start after cancellation');
  assert.ok(result.details.results.every(r => r.status === 'cancelled'));
  assert.equal(updates[0].details.results[0].status, 'queued', 'published snapshots must not mutate');
});

test('pre-aborted work never starts; invalid batches fail before invoking a model', async () => {
  const c = context(), controller = createSubagentTool(), parent = new AbortController(); parent.abort();
  const result = await run(controller, c, tasks(2), parent.signal);
  assert.ok(result.details.results.every(r => r.status === 'cancelled'));
  assert.equal(c.requests.length, 0);
  await assert.rejects(run(controller, c, []), /1–8/);
  await assert.rejects(run(controller, c, tasks(9)), /1–8/);
  for (const params of [undefined, null, {}, { context: 'not a task' }, { tasks: [null] }, { tasks: [{ name: ' ', task: 'work' }] }]) {
    await assert.rejects(controller.tool.execute('invalid', params, undefined, undefined, c.ctx), /1–8/);
  }
  assert.equal(c.requests.length, 0);
});

test('subagent output is bounded; tool usage and file outputs survive history reload/dedup', async t => {
  const c = context(async () => reply('界'.repeat(10000)));
  const result = await run(createSubagentTool(), c);
  assert.ok(Buffer.byteLength(result.details.results[0].output) < 8200);
  assert.match(result.details.results[0].output, /Truncated/);
  result.details.results[0].files = [{ path: '/workspace/owned.txt', tool: 'write' }];
  const message = { role: 'toolResult', toolName: 'subagent', toolCallId: 'delegation', ...result };
  assert.equal(usageOf([message]).output, 5);
  assert.equal(usageOf([message]).tps, null, 'parallel child tokens must not inflate main TPS');
  assert.equal(outputs({ messages: [message], tools: {} })[0].path, '/workspace/owned.txt');
  const dir = mkdtempSync(join(tmpdir(), 'pd-sub-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger({ path: join(dir, 'ledger.jsonl'), sessionsDir: dir });
  ledger.record(message); ledger.record(message);
  writeFileSync(join(dir, 'history.jsonl'), JSON.stringify({ type: 'message', message }) + '\n');
  const summary = await ledger.summary();
  assert.equal(summary.totals.tokens, 18);
  assert.equal(summary.totals.calls, 1);
  assert.equal(summary.models[0].model, model.id);
});
