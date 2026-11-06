// Ultra mode: Pi works on a request on its own until it is done, with no questions, retries through
// outages, a nudge and then a stop when it makes no progress, and an audit plus an independent review
// before it may finish. The module, its wiring in the bridge, and the desktop's side.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { AWAY_ANSWER, BACKOFF_MS, MAX_REVIEWS, STALL_TURNS, createUltra, parseVerdict, reviewBrief } from '../agent/pidesk-ultra.mjs';
import { createSubagentTool } from '../agent/pidesk-subagent.mjs';
import pideskBridge from '../agent/pidesk-bridge.js';
import { SessionManager } from '../app/main/session-manager.mjs';

function harness({ enabled = true, review = null } = {}) {
  const sent = [], entries = [], timers = [], statuses = [];
  let active = ['read', 'bash', 'report_progress', 'finish_task'], clock = 1000;
  const pi = {
    sendMessage: (message, options) => sent.push({ message, options }),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; },
  };
  const ultra = createUltra(pi, { enabled, review, now: () => clock, schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, cancel: t => { t.cancelled = true; } });
  ultra.attach({ ui: { setStatus: (key, value) => statuses.push([key, JSON.parse(value)]) } });
  const run = (messages, aborted = false) => { ultra.onRunEnd(messages); return ultra.onSettled({ aborted }); };
  const withTools = [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }];
  const talk = [{ role: 'assistant', content: [{ type: 'text', text: 'Thinking about it.' }], stopReason: 'stop' }];
  return { ultra, sent, entries, timers, statuses, run, withTools, talk, active: () => active, tick: ms => { clock += ms; } };
}

test('a message starts a task, and a run that ends unfinished starts the next one', () => {
  const h = harness();
  h.ultra.onInput('Make the TP4 experiment run end to end and write the report');
  assert.equal(h.ultra.task.status, 'active');
  assert.equal(h.run(h.withTools), true, 'Ultra drove it');
  assert.equal(h.sent.length, 1);
  const { message, options } = h.sent[0];
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(message.display, false);
  assert.match(message.content, /<request>\nMake the TP4 experiment run end to end/);
  assert.match(message.content, /not from the user/);
  assert.equal(h.ultra.task.turns, 1);
  assert.equal(h.entries.at(-1).customType, 'pidesk-ultra', 'saved in the session');
  assert.equal(h.statuses.at(-1)[1].task.status, 'active', 'published for the desktop');
  // The user adds an instruction while it works; a slash command is not one.
  h.ultra.onInput('Also keep the old flags working');
  h.ultra.onInput('/compact');
  h.run(h.withTools);
  assert.match(h.sent[1].message.content, /The user added later:\n- Also keep the old flags working/);
  assert.equal(h.ultra.task.instructions.length, 1);
});

test('progress reports reach the desktop and every continuation, so compaction loses nothing', () => {
  const h = harness();
  h.ultra.onInput('Port the parser');
  assert.match(h.ultra.progress({ done: 'Lexer ported, 40 tests pass', next: 'Port the grammar', assumptions: 'Kept the old token names' }), /noted/);
  h.tick(5 * 60000);
  h.run(h.withTools);
  assert.match(h.sent[0].message.content, /Your last progress report \(5 minutes ago\):\n- Done: Lexer ported, 40 tests pass\n- Next: Port the grammar\n- Assumptions: Kept the old token names/);
  assert.equal(h.statuses.at(-1)[1].task.progress.next, 'Port the grammar');
  assert.match(createUltra({}, { enabled: false }).progress({ done: 'x', next: 'y' }), /no task/);
});

test('provider errors wait longer each time and never end the task; an unfixable one stops it', () => {
  const h = harness();
  h.ultra.onInput('Run the suite');
  const failed = message => [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: message }];
  h.run(failed('429 rate limit exceeded'));
  h.run(failed('upstream connect error or disconnect/reset before headers'));
  assert.deepEqual(h.timers.map(t => t.ms), [BACKOFF_MS[0], BACKOFF_MS[1]]);
  assert.equal(h.sent.length, 0, 'no tight loop');
  assert.ok(h.timers[0].cancelled, 'one pending retry at a time');
  h.timers.at(-1).fn();
  assert.equal(h.sent.length, 1, 'the retry starts the next run');
  for (let i = 0; i < 10; i++) h.run(failed('overloaded_error'));
  assert.equal(h.timers.at(-1).ms, BACKOFF_MS.at(-1), 'capped at 10 minutes, still retrying');
  assert.equal(h.ultra.task.status, 'active');
  h.run(h.withTools);
  assert.equal(h.ultra.task.errors, 0, 'a good run resets the pause');
  for (let i = 0; i < 3; i++) h.run(failed('400 invalid_request_error: messages.3.content: image exceeds 5 MB'));
  assert.equal(h.ultra.task.status, 'stalled');
  assert.match(h.ultra.task.reason, /same kind of error 3 times/);
});

test('runs without progress get a nudge, then the task stops as stalled', () => {
  const h = harness();
  h.ultra.onInput('Fix the flaky test');
  for (let i = 0; i < 3; i++) h.run(h.talk);
  assert.match(h.sent.at(-1).message.content, /The last turns made no progress\. Do something different/);
  for (let i = 3; i < STALL_TURNS; i++) h.run(h.talk);
  assert.equal(h.ultra.task.status, 'stalled');
  assert.equal(h.sent.length, STALL_TURNS - 1, 'no continuation after stalling');
  assert.equal(h.ultra.resume(), true, 'the user can resume it');
  assert.equal(h.ultra.task.status, 'active');
});

test('finishing takes an audit in a later turn, then an independent review; gaps send it back', async () => {
  const reviews = [];
  const verdicts = [{ verdict: 'gaps', text: '- tests/test_parser.py fails: 2 errors' }, { verdict: 'pass', text: 'All parts verified.' }];
  const h = harness({ review: async (task, summary, context) => { reviews.push({ task: task.objective, summary, context }); return verdicts.shift(); } });
  h.ultra.onInput('Port the parser');
  const first = await h.ultra.finish({ summary: 'Done' });
  assert.match(first.text, /audit the work against the request/);
  assert.match((await h.ultra.finish({ summary: 'Done' })).text, /audit/, 'not twice in the same turn');
  assert.equal(reviews.length, 0);
  h.run(h.withTools);
  assert.match(h.sent.at(-1).message.content, /You are auditing the work/);
  const gaps = await h.ultra.finish({ summary: 'Ported, tests pass' }, { toolCallId: 'call-1' });
  assert.match(gaps.text, /An independent review found gaps:\n\n- tests\/test_parser\.py fails/);
  assert.deepEqual(reviews[0], { task: 'Port the parser', summary: 'Ported, tests pass', context: { toolCallId: 'call-1' } });
  assert.equal(h.ultra.task.status, 'active');
  h.run(h.withTools);
  assert.match(h.sent.at(-1).message.content, /<review>\n- tests\/test_parser\.py fails/);
  const pass = await h.ultra.finish({ summary: 'Ported; fixed the two errors' });
  assert.match(pass.text, /confirmed the work/);
  assert.equal(h.ultra.task.status, 'complete');
  assert.equal(h.ultra.task.summary, 'Ported; fixed the two errors');
  assert.equal(h.run(h.talk), false, 'a finished task starts nothing');
});

test('after the last review the task finishes with what is still open', async () => {
  const h = harness({ review: async () => ({ verdict: 'gaps', text: '- the report has no plots' }) });
  h.ultra.onInput('Write the report');
  await h.ultra.finish({ summary: 'Report written' });
  h.run(h.withTools);
  for (let i = 1; i < MAX_REVIEWS; i++) assert.match((await h.ultra.finish({ summary: 'Report written' })).text, /found gaps/);
  const last = await h.ultra.finish({ summary: 'Report written' });
  assert.match(last.text, /still finds gaps/);
  assert.equal(h.ultra.task.status, 'complete');
  assert.match(h.ultra.task.summary, /Still open after 3 reviews:\n- the report has no plots/);
  // A review that can't run doesn't hide that: it is retried, and counted.
  const broken = harness({ review: async () => { throw new Error('no model'); } });
  broken.ultra.onInput('x');
  await broken.ultra.finish({});
  broken.run(broken.withTools);
  assert.match((await broken.ultra.finish({})).text, /couldn't run \(no model\)/);
});

test('Stop pauses the task, Ultra off stops continuing, and both can be undone', () => {
  const h = harness();
  h.ultra.onInput('Refactor');
  h.run(h.withTools, true);
  assert.equal(h.ultra.task.status, 'paused');
  assert.equal(h.sent.length, 0);
  h.ultra.resume();
  assert.equal(h.sent.length, 1);
  h.ultra.setEnabled(false);
  assert.equal(h.ultra.task.status, 'paused');
  assert.deepEqual(h.active(), ['read', 'bash'], 'report_progress and finish_task are gone');
  assert.equal(h.ultra.resume(), false, 'nothing resumes while Ultra is off');
  h.ultra.onInput('ignored while off');
  assert.equal(h.ultra.task.objective, 'Refactor');
  // Ultra on while a request runs: that request is the task.
  h.ultra.dismiss();
  h.ultra.setEnabled(true, { running: true, request: 'Migrate the build to Vite' });
  assert.equal(h.ultra.task.objective, 'Migrate the build to Vite');
  assert.ok(['report_progress', 'finish_task'].every(name => h.active().includes(name)));
});

test('a Pi that restarts continues the task; a fork starts without it; a visited file is not written', () => {
  const saved = [{ type: 'custom', customType: 'pidesk-ultra', data: { task: { objective: 'Long job', status: 'active', turns: 12, startedAt: 1 } } }];
  const h = harness();
  h.ultra.restore(saved, { reason: 'startup' });
  assert.equal(h.ultra.task.status, 'active');
  assert.equal(h.timers.length, 1, 'continues by itself');
  h.timers[0].fn();
  assert.match(h.sent[0].message.content, /Long job/);
  const forked = harness();
  forked.ultra.restore(saved, { reason: 'fork' });
  assert.equal(forked.ultra.task, null);
  assert.equal(forked.entries.at(-1).data.task, null, 'cleared in the fork, so a later restart does not pick it up');
  const visiting = harness();
  visiting.ultra.restore(saved, { reason: 'resume' });
  assert.equal(visiting.ultra.task.status, 'paused');
  assert.equal(visiting.entries.length, 0);
  const off = harness({ enabled: false });
  off.ultra.restore(saved, { reason: 'startup' });
  assert.equal(off.ultra.task.status, 'paused'); assert.equal(off.timers.length, 0);
});

test('the review brief and its verdict', () => {
  const brief = reviewBrief({ objective: 'Add dark mode', instructions: ['Keep the light theme default'] }, 'Added a toggle');
  assert.match(brief, /<request>\nAdd dark mode\n<\/request>\n\nThe user added later:\n- Keep the light theme default/);
  assert.match(brief, /<summary>\nAdded a toggle\n<\/summary>/);
  assert.match(brief, /Don't fix anything and don't change files/);
  assert.equal(parseVerdict('Checked everything.\nVERDICT: PASS'), 'pass');
  assert.equal(parseVerdict('**VERDICT: PASS**'), 'pass');
  assert.equal(parseVerdict('VERDICT: PASS would need tests\n...\nVERDICT: GAPS'), 'gaps', 'the last verdict counts');
  assert.equal(parseVerdict('Looks fine to me.'), 'gaps', 'no verdict is no confirmation');
});

// ---------------------------------------------------------------- in the bridge
function fakePi() {
  const handlers = new Map(), commands = new Map(), tools = new Map(), sent = [];
  let active = [];
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); }, registerProvider() {}, registerCommand(name, command) { commands.set(name, command); },
    getActiveTools: () => [...active], setActiveTools(names) { active = [...names]; }, getAllTools: () => [...tools.values()],
    sendMessage: (message, options) => sent.push({ message, options }), appendEntry() {},
  };
  const emit = (name, event, ctx) => (handlers.get(name) ?? []).map(h => h(event, ctx));
  const config = (value, ctx) => commands.get('pidesk-config').handler(Buffer.from(JSON.stringify(value)).toString('base64'), ctx);
  return { pi, emit, config, tools, sent, active: () => active };
}
const reply = (model, text) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' });

test('in the bridge: unattended answers, its own continuation over /goal, and a real review agent', async t => {
  process.env.PIDESK_BOOT = JSON.stringify({ providers: [], config: { subagents: 'off', ultra: false } });
  const f = fakePi();
  pideskBridge(f.pi);
  const ui = { setStatus() {}, notify() {} };
  const branch = [];
  const ctx = { ui, hasUI: true, cwd: '/workspace', sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({ messages: [] }) } };
  f.emit('session_start', { reason: 'startup' }, ctx);
  assert.ok(!f.active().includes('finish_task'), 'Ultra tools only while Ultra is on');
  await f.config({ subagents: 'off', ultra: true }, ctx);
  assert.ok(f.active().includes('finish_task') && f.active().includes('report_progress'));
  const ask = await f.tools.get('ask_user').execute('q1', { question: 'Which database?' }, undefined, undefined, ctx);
  assert.equal(ask.content[0].text, AWAY_ANSWER);
  const sections = {};
  f.emit('before_agent_start', { messageType: 'user', prompt: 'x', systemPromptOptions: { cwd: '/workspace', sections } }, ctx);
  assert.match(sections.ultra, /Ultra mode is on/);
  // A goal is set too: Ultra, not /goal, continues while its task runs.
  await (await import('node:util')).promisify(setImmediate)();
  f.emit('input', { text: 'Ship the importer', source: 'rpc' }, ctx);
  f.emit('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' }] }, ctx);
  f.emit('agent_settled', { aborted: false }, ctx);
  assert.equal(f.sent.filter(s => s.message.customType === 'pidesk-ultra').length, 1);
  assert.equal(f.sent.filter(s => s.message.customType === 'pidesk-goal').length, 0);
  // finish_task: the audit, then a review agent (a fresh agent, no edit tools) whose verdict decides.
  const model = { id: 'm', provider: 'mock', api: 'openai-completions', name: 'M', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const seenTools = [];
  const reviewCtx = { ...ctx, model, thinkingLevel: 'medium', getSystemPrompt: () => 'PARENT',
    tools: ['read', 'write', 'edit', 'bash', 'grep'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}) })),
    modelRegistry: { streamSimple(m, context) {
      seenTools.push(...(context.messages.find(m => m.role === 'system')?.toolsAdded ?? []).map(tool => tool.name));
      const s = new AssistantMessageEventStream();
      queueMicrotask(() => { s.push({ type: 'done', reason: 'stop', message: reply(m, 'Every part checked: the importer runs and its tests pass.\nVERDICT: PASS') }); s.end(); });
      return s;
    } },
    executeTool: async () => ({ result: { content: [{ type: 'text', text: 'ok' }], details: {} }, isError: false }) };
  const finish = f.tools.get('finish_task');
  assert.match((await finish.execute('f1', { summary: 'Importer shipped' }, undefined, undefined, reviewCtx)).content[0].text, /audit/);
  f.emit('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }], stopReason: 'toolUse' }] }, ctx);
  f.emit('agent_settled', { aborted: false }, ctx);
  const done = await finish.execute('f2', { summary: 'Importer shipped, tests pass' }, undefined, undefined, reviewCtx);
  assert.match(done.content[0].text, /independent review confirmed the work/);
  assert.equal(done.details.kind, 'pidesk-ultra-review');
  assert.equal(done.details.agent.type, 'review');
  assert.ok(Array.isArray(done.details.agentRuns) && done.details.agentRuns.length === 1, 'its usage is counted like any agent run');
  assert.ok(seenTools.includes('bash') && !seenTools.includes('write') && !seenTools.includes('edit'), `the reviewer can run checks but not edit: ${seenTools}`);
  await f.config({ subagents: 'off', ultra: false }, ctx);
  assert.ok(!f.active().includes('finish_task'));
  t.after(() => f.emit('session_shutdown', {}, ctx));
});

test('the review agent is Pi Desktop\'s own: the model cannot start one, and no limit applies', async t => {
  const c = createSubagentTool({ notify() {}, publish() {}, isIdle: () => false, agentLimit: 0 });
  t.after(() => c.shutdown());
  const model = { id: 'm', provider: 'mock', api: 'openai-completions', name: 'M', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = { cwd: '/workspace', model, thinkingLevel: 'medium', getSystemPrompt: () => 'P', sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) },
    tools: ['read', 'bash'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}) })),
    modelRegistry: { streamSimple(m) { const s = new AssistantMessageEventStream(); queueMicrotask(() => { s.push({ type: 'done', reason: 'stop', message: reply(m, 'VERDICT: GAPS\n- no tests') }); s.end(); }); return s; } },
    executeTool: async () => ({ result: { content: [{ type: 'text', text: 'ok' }], details: {} }, isError: false }) };
  const refused = await c.tool.execute('c1', { tasks: [{ name: 'Review it', task: 'Review', type: 'review' }] }, undefined, undefined, { ...ctx });
  assert.equal(refused.isError, true, 'limit 0 refuses any request from the model');
  await assert.rejects(createSubagentTool({ agentLimit: 5 }).tool.execute('c2', { tasks: [{ name: 'Review it', task: 'Review', type: 'review' }] }, undefined, undefined, ctx), /Unknown agent type "review"/);
  const result = await c.review({ callId: 'f1', brief: 'Check it', ctx });
  assert.equal(result.status, 'completed');
  assert.match(result.output, /VERDICT: GAPS/);
});

// ---------------------------------------------------------------- on the desktop
test('the desktop: Ultra is a per-conversation setting its Pi gets', async () => {
  const record = { id: 's1', title: 'T', environmentId: 'local', cwd: '/w' };
  const store = { settings: { providers: [], defaults: { subagents: 'limited' } }, sessions: [record], saveSessions() {}, getKey: () => null };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  assert.equal(manager.bootConfig(record).ultra, false);
  const sent = [];
  manager.runtimes.set('s1', { status: 'connected', configKey: JSON.stringify(manager.bootConfig(record)), questions: new Map(), session: { prompt: async line => { sent.push(line); } } });
  await manager.setUltra('s1', true);
  assert.equal(record.ultra, true);
  assert.equal(JSON.parse(Buffer.from(sent[0].split(' ')[1], 'base64').toString('utf8')).ultra, true);
  await manager.setUltra('s1', false);
  assert.ok(!Object.hasOwn(record, 'ultra'));
});
