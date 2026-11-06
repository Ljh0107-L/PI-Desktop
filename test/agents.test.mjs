// Background agents, follow-ups, stop, fork, explore, custom types and worktree isolation. Uses the
// actual Agent loop with fake streams; the worktree test uses a throwaway git repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { agentTypesSection, createSubagentTool, loadAgentDefinitions, parseAgentDefinition, worktreePath } from '../agent/pidesk-subagent.mjs';

const model = { id: 'test-model', provider: 'mock', api: 'openai-completions', name: 'Test', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const reply = (text = 'done', extra = {}) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text }], usage: structuredClone(usage), stopReason: 'stop', ...extra });
const toolReply = (name, args) => reply('', { content: [{ type: 'toolCall', id: 'call-' + Math.random(), name, arguments: args }], stopReason: 'toolUse' });
const text = m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const lastUserText = request => text(request.transcript.messages.findLast(m => m.role === 'user' || m.role === 'toolResult'));
const schema = Type.Object({ path: Type.Optional(Type.String()), command: Type.Optional(Type.String()), content: Type.Optional(Type.String()) });
const tool = name => ({ name, label: name, description: `${name} tool`, parameters: schema });

function context(produce = async () => reply(), { names = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'], cwd = '/workspace' } = {}) {
  const requests = [], toolCalls = [];
  const ctx = {
    cwd, model, thinkingLevel: 'high',
    getSystemPrompt: () => 'PARENT SYSTEM PROMPT',
    sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) },
    tools: names.map(tool),
    modelRegistry: {
      find: (provider, id) => provider === 'other' && id === 'small' ? { ...model, provider: 'other', id: 'small' } : undefined,
      getAvailable: () => [model, { ...model, provider: 'other', id: 'small' }],
      streamSimple(m, transcript, options) {
        const stream = new AssistantMessageEventStream();
        const request = { model: m, transcript: { ...transcript, messages: [...transcript.messages] }, options };
        requests.push(request);
        Promise.resolve().then(() => produce(request, requests.length)).then(message => {
          stream.push(['error', 'aborted'].includes(message.stopReason) ? { type: 'error', reason: message.stopReason, error: message } : { type: 'done', reason: message.stopReason, message });
        }, error => stream.push({ type: 'error', reason: 'aborted', error: reply('', { stopReason: 'aborted', errorMessage: error.message }) })).finally(() => stream.end());
        return stream;
      },
    },
    executeTool: async (name, args, options) => { toolCalls.push({ name, args, options }); return { result: { content: [{ type: 'text', text: `${name} ok` }], details: {} }, isError: false }; },
  };
  return { ctx, requests, toolCalls };
}
const notifier = () => {
  const notices = [];
  const notify = (message, options) => notices.push({ message, options });
  return { notices, notify };
};
const until = async (check, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (check()) return true; throw new Error('timed out waiting'); };
const start = (controller, c, tasks, extra = {}) => controller.tool.execute('call-1', { tasks, ...extra }, undefined, undefined, c.ctx);

test('background agents return at once and report to an idle parent with a turn', async () => {
  const { notices, notify } = notifier();
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const c = context(async () => { await held; return reply('Found it in src/a.js:12'); });
  const controller = createSubagentTool({ notify, isIdle: () => true });
  const result = await start(controller, c, [{ name: 'Find the parser', task: 'Where is the parser?', type: 'explore' }]);
  assert.match(result.content[0].text, /Started 1 agent in the background/);
  assert.equal(result.details.background, true);
  const [launched] = result.details.results;
  assert.match(launched.id, /^agent-[0-9a-f]{8}$/);
  assert.ok(['queued', 'running'].includes(launched.status));
  assert.equal(result.usage, undefined, 'usage comes with the report');
  assert.equal(notices.length, 0);
  finish();
  await until(() => notices.length === 1);
  const [{ message, options }] = notices;
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(message.customType, 'pidesk-agent');
  assert.equal(message.display, true);
  assert.match(message.content, /^Automated message from Pi Desktop, not from the user/);
  assert.match(message.content, /Found it in src\/a.js:12/);
  assert.match(message.content, new RegExp(`subagent_message with id ${launched.id}`));
  assert.equal(message.details.key, `${launched.id}:1`);
  assert.equal(message.details.agent.status, 'completed');
  assert.equal(message.details.agent.callId, 'call-1');
  assert.equal(message.details.agent.index, 0);
  assert.deepEqual(message.details.agentRuns.map(r => [r.key, r.usage.totalTokens]), [[`pidesk-agent:${launched.id}:1`, 18]]);
});

test('a busy parent gets each report after its current step, and a stopped run records them without a new turn', async () => {
  const { notices, notify } = notifier();
  let idle = false;
  const c = context(async () => reply('report'));
  const controller = createSubagentTool({ notify, isIdle: () => idle });
  await start(controller, c, [{ name: 'a', task: 'a' }, { name: 'b', task: 'b' }]);
  await until(() => notices.length === 2);
  assert.ok(notices.every(n => n.options.deliverAs === 'steer' && n.options.triggerTurn), 'handed over during the turn, not held until it ends');
  // Stop cleared Pi's queue before the parent read them: kept in the session, starting nothing.
  idle = true;
  controller.onSettled({ aborted: true, branch: [] });
  assert.equal(notices.length, 4);
  assert.deepEqual(notices.slice(2).map(n => n.message.details.key).sort(), notices.slice(0, 2).map(n => n.message.details.key).sort());
  assert.ok(notices.slice(2).every(n => !n.options.triggerTurn), 'after Stop, reports are recorded but start nothing');
  // Read during the run: in the session already, so nothing is sent again.
  const { notices: read, notify: notifyRead } = notifier();
  idle = false;
  const other = createSubagentTool({ notify: notifyRead, isIdle: () => idle });
  await start(other, context(async () => reply('report')), [{ name: 'c', task: 'c' }]);
  await until(() => read.length === 1);
  idle = true;
  other.onSettled({ aborted: false, branch: [{ type: 'custom_message', customType: 'pidesk-agent', details: { key: read[0].message.details.key } }] });
  assert.equal(read.length, 1);
});

test('a report that never reached the session is sent again, at most three times', async () => {
  const { notices, notify } = notifier();
  const c = context(async () => reply('report'));
  const controller = createSubagentTool({ notify, isIdle: () => true });
  await start(controller, c, [{ name: 'a', task: 'a' }]);
  await until(() => notices.length === 1);
  const key = notices[0].message.details.key;
  controller.onSettled({ aborted: false, branch: [] }); // Stop cleared Pi's queue
  assert.equal(notices.length, 2);
  assert.equal(notices[1].message.details.key, key);
  assert.equal(notices[1].options.triggerTurn, true);
  controller.onSettled({ aborted: false, branch: [{ type: 'custom_message', customType: 'pidesk-agent', details: { key } }] });
  assert.equal(notices.length, 2, 'delivered: not sent again');
  controller.onSettled({ branch: [] });
  assert.equal(notices.length, 2);
});

test('a finished agent continues with its context; a running one reads the message within its run', async () => {
  const c = context(async request => reply(`answer to: ${lastUserText(request).split('\n').at(-1)}`));
  const controller = createSubagentTool({ notify: () => {}, isIdle: () => true });
  const first = await start(controller, c, [{ name: 'Reader', task: 'Read the config' }], { background: false });
  const id = first.details.results[0].id;
  assert.equal(first.details.agentRuns[0].key, `pidesk-agent:${id}:1`);
  const follow = await controller.messageTool.execute('m1', { id, message: 'Now check the tests', background: false }, undefined);
  assert.match(follow.content[0].text, /answer to: Now check the tests/);
  assert.equal(follow.details.agentRuns[0].key, `pidesk-agent:${id}:2`);
  assert.equal(follow.usage.totalTokens, 18);
  const second = c.requests.at(-1).transcript.messages.map(text).join('\n');
  assert.match(second, /Read the config/, 'the follow-up keeps the first task in context');
  assert.match(second, /answer to: Read the config/);
  const agent = controller.agents().find(a => a.id === id);
  assert.equal(agent.runs, 2);
  assert.ok(agent.steps.some(s => s.type === 'input' && s.from === 'parent' && s.text === 'Now check the tests'));

  // While it works, a message joins the current run instead of starting another.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busy = context(async (request, n) => { if (n === 1) await gate; return reply(`seen: ${lastUserText(request).split('\n').at(-1)}`); });
  const worker = createSubagentTool({ notify: () => {}, isIdle: () => true });
  const launched = await start(worker, busy, [{ name: 'Worker', task: 'Start' }]);
  const workerId = launched.details.results[0].id;
  await until(() => worker.agents()[0].status === 'running');
  const queued = await worker.messageTool.execute('m2', { id: workerId, message: 'Also do X' }, undefined);
  assert.match(queued.content[0].text, /Queued for Worker/);
  release();
  await until(() => worker.agents()[0].status === 'completed');
  assert.equal(worker.agents()[0].runs, 1);
  assert.match(worker.agents()[0].output, /seen: Also do X/);
});

test('stopping is final: the agent is cancelled and refuses further messages', async () => {
  const { notices, notify } = notifier();
  const c = context(async request => { await sleep(10000, undefined, { signal: request.options.signal }); return reply(); });
  const controller = createSubagentTool({ notify, isIdle: () => true });
  const result = await start(controller, c, [{ name: 'Long', task: 'Work' }]);
  const id = result.details.results[0].id;
  await until(() => controller.agents()[0].status === 'running');
  const stopped = await controller.stopTool.execute('s1', { id }, undefined);
  assert.match(stopped.content[0].text, /Stopped Long/);
  assert.equal(stopped.details.agent.status, 'cancelled');
  await until(() => notices.length === 1);
  assert.equal(notices[0].message.details.agent.status, 'cancelled');
  await assert.rejects(controller.messageTool.execute('m', { id, message: 'go on' }, undefined), /was stopped/);
  await assert.rejects(controller.stopTool.execute('s2', { id: 'agent-00000000' }, undefined), /No agent/);
});

test('agents cancelled because their session closed send no report into the next session', async () => {
  const { notices, notify } = notifier();
  const c = context(async request => { await sleep(10000, undefined, { signal: request.options.signal }); return reply(); });
  const controller = createSubagentTool({ notify, isIdle: () => true });
  await start(controller, c, [{ name: 'Long', task: 'Work' }]);
  await until(() => controller.agents()[0].status === 'running');
  controller.shutdown();
  await until(() => controller.agents()[0].status === 'cancelled');
  await sleep(10);
  assert.equal(notices.length, 0);
});

test('a fork continues the parent conversation with its prompt, tools and history', async () => {
  const bashWithTimeout = { ...tool('bash'), parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })) }) };
  const parentTools = [tool('read'), bashWithTimeout, tool('subagent'), tool('ask_user')];
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'We decided to use the v2 parser.' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }, { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: {} }, { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'x' } }, { type: 'toolCall', id: 'call-3', name: 'read', arguments: { path: 'y' } }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: 2 },
    // A parallel call that finished before the fork started already has its result.
    { role: 'toolResult', toolCallId: 'call-3', toolName: 'read', isError: false, content: [{ type: 'text', text: 'y contents' }], timestamp: 3 },
  ];
  const c = context(async (_request, n) => n === 1 ? toolReply('ask_user', {}) : reply('fork report'));
  c.ctx.sessionManager.buildSessionProjection = () => ({ messages: history });
  const controller = createSubagentTool({ parentTools: () => parentTools });
  const result = await start(controller, c, [{ name: 'Draft tests', task: 'Draft tests for the v2 parser', type: 'fork' }], { background: false });
  assert.equal(result.details.results[0].status, 'completed');
  const [first] = c.requests;
  const system = first.transcript.messages[0];
  assert.equal(system.role, 'system');
  assert.equal(system.content, 'PARENT SYSTEM PROMPT', 'the same prompt, for the parent\'s prompt cache');
  assert.deepEqual(system.toolsAdded.map(t => t.name), ['read', 'bash', 'subagent', 'ask_user'], 'the parent\'s declared tools, in order');
  assert.deepEqual(system.toolsAdded[1].parameters, bashWithTimeout.parameters, 'declarations unchanged, bash included');
  assert.ok(!first.transcript.messages.slice(1).some(m => m.role === 'system'), 'no tool delta: the prefix matches the parent');
  const results = first.transcript.messages.filter(m => m.role === 'toolResult');
  assert.deepEqual(results.map(m => m.toolCallId), ['call-3', 'call-1', 'call-2'], 'every call answered once');
  assert.match(text(results[1]), /You are a fork[\s\S]*Your task \(Draft tests\):\nDraft tests for the v2 parser/);
  assert.match(text(results[2]), /not part of this fork/);
  assert.match(first.transcript.messages.map(text).join('\n'), /We decided to use the v2 parser/);
  assert.equal(c.toolCalls.length, 0, 'ask_user is not available to a fork');
  const blocked = c.requests[1].transcript.messages.findLast(m => m.role === 'toolResult');
  assert.match(text(blocked), /isn't available to agents/);
});

test('explore agents get read-only tools; unknown types are refused with the available ones', async () => {
  const c = context();
  const controller = createSubagentTool();
  await start(controller, c, [{ name: 'Look', task: 'Find it', type: 'explore' }], { background: false });
  const system = c.requests[0].transcript.messages[0];
  assert.deepEqual(system.toolsAdded.map(t => t.name), ['read', 'grep', 'find', 'ls', 'bash']);
  assert.match(system.content, /You are an explore agent/);
  await assert.rejects(start(controller, c, [{ name: 'x', task: 'y', type: 'nonexistent' }]), /Unknown agent type "nonexistent". Available: general, explore, fork/);
});

test('custom agents come from .pi/agents and .claude/agents, project first', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-agents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  const write = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
  write(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs for bugs. Use proactively.\ntools: Read, Grep, Glob\nmodel: other/small\neffort: max\n---\nYou review code. List bugs by severity.\n');
  write(join(project, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: The project .pi definition wins\ntools:\n  - Read\n  - Bash\nisolation: worktree\n---\nProject reviewer prompt.\n');
  write(join(home, '.claude', 'agents', 'writer.md'), '---\nname: writer\ndescription: "Writes docs"\ndisallowedTools: Bash\nmodel: sonnet\n---\nWrite docs.\n');
  write(join(home, '.claude', 'agents', 'broken.md'), 'no frontmatter here');
  write(join(home, '.pi', 'agents', 'explore.md'), '---\nname: explore\ndescription: cannot shadow a built-in\n---\nx\n');

  const parsed = parseAgentDefinition(readFileSync(join(project, '.claude', 'agents', 'reviewer.md'), 'utf8'), 'x');
  assert.deepEqual([parsed.tools, parsed.model, parsed.effort], [['read', 'grep', 'find'], 'other/small', 'xhigh']);
  const defs = loadAgentDefinitions(join(project), { home });
  assert.deepEqual(defs.map(d => d.name), ['reviewer', 'writer']);
  assert.equal(defs[0].description, 'The project .pi definition wins');
  assert.deepEqual(defs[0].tools, ['read', 'bash']);
  assert.equal(defs[0].isolation, 'worktree');
  assert.deepEqual(defs[1].tools, ['read', 'write', 'edit', 'grep', 'find', 'ls'], 'disallowedTools removes bash');
  assert.match(agentTypesSection(defs), /- writer: Writes docs \(tools: read, write, edit, grep, find, ls\)/);

  const c = context(async () => reply('docs written'), { cwd: project });
  const controller = createSubagentTool({ home });
  assert.match(controller.promptSection(project), /- reviewer: The project \.pi definition wins/);
  const result = await start(controller, c, [{ name: 'Docs', task: 'Write the README section', type: 'writer' }], { background: false });
  const agent = result.details.results[0];
  assert.equal(agent.type, 'writer');
  assert.equal(agent.model, model.id, 'an unknown model alias falls back to the current model');
  assert.ok(agent.steps.some(s => s.type === 'notice' && /Model sonnet isn't configured/.test(s.text)));
  const system = c.requests[0].transcript.messages[0];
  assert.match(system.content, /Write docs\./);
  assert.deepEqual(system.toolsAdded.map(t => t.name), ['read', 'write', 'edit', 'grep', 'find', 'ls']);
});

test('worktree isolation maps paths into its own checkout and removes it when nothing changed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-worktree-')); // under /var on macOS: a symlink to /private/var
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'src', 'a.txt'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'base');

  // The agent writes src/a.txt by a relative path; the tool pipeline really writes the mapped path.
  const c = context(async (_request, n) => n === 1 ? toolReply('write', { path: 'a.txt', content: 'changed\n' }) : reply('wrote a.txt'), { cwd: join(repo, 'src') });
  c.ctx.executeTool = async (name, args) => { c.toolCalls.push({ name, args }); if (name === 'write') writeFileSync(args.path, args.content); return { result: { content: [{ type: 'text', text: 'ok' }], details: {} }, isError: false }; };
  const controller = createSubagentTool();
  const result = await start(controller, c, [{ name: 'Edit', task: 'Change a.txt', isolation: 'worktree' }], { background: false });
  const agent = result.details.results[0];
  assert.equal(agent.status, 'completed', agent.error);
  assert.match(agent.worktree.path, /pi-worktrees[\\/]agent-/);
  assert.equal(agent.worktree.branch, `pi-agent/${agent.id}`);
  assert.equal(c.toolCalls[0].args.path, join(agent.worktree.path, 'src', 'a.txt'));
  assert.equal(agent.worktree.path, join(realpathSync(repo), '.git', 'pi-worktrees', agent.id));
  assert.equal(readFileSync(join(repo, 'src', 'a.txt'), 'utf8'), 'original\n', 'the main checkout is untouched');
  assert.equal(readFileSync(join(agent.worktree.path, 'src', 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(agent.worktree.files, 1);
  assert.match(result.content[0].text, /Worktree: .*1 changed file, 0 commits/);
  assert.match(git('branch', '--list', 'pi-agent/*'), new RegExp(agent.id));

  const quiet = context(async () => reply('nothing to change'), { cwd: repo });
  const clean = await start(createSubagentTool(), quiet, [{ name: 'Look', task: 'Look only', isolation: 'worktree' }], { background: false });
  const cleanAgent = clean.details.results[0];
  assert.match(cleanAgent.worktree.summary, /no changes, removed/);
  assert.equal(existsSync(cleanAgent.worktree.path), false);
  assert.doesNotMatch(git('branch', '--list', 'pi-agent/*'), new RegExp(cleanAgent.id));

  const real = realpathSync(repo);
  const wt = { root: real, common: join(real, '.git'), path: join(real, '.git', 'pi-worktrees', 'x'), cwd: join(real, '.git', 'pi-worktrees', 'x') };
  assert.equal(worktreePath(join(repo, 'src', 'a.txt'), wt), join(wt.path, 'src', 'a.txt'), 'the checkout through its symlinked path too');
  assert.equal(worktreePath(join(repo, 'src', 'new', 'b.txt'), wt), join(wt.path, 'src', 'new', 'b.txt'), 'a file not created yet');
  assert.equal(worktreePath('/usr/share', wt), realpathSync('/usr/share'), 'outside the checkout');
  assert.equal(worktreePath(join(repo, '.git', 'config'), wt), join(real, '.git', 'config'), 'git internals');
  assert.equal(worktreePath('~/notes.txt', wt), '~/notes.txt');
});

test('agents still running when their Pi ended are recorded as stopped, once', () => {
  const { notices, notify } = notifier();
  const controller = createSubagentTool({ notify });
  const running = { id: 'agent-aaaaaaaa', name: 'Survey', type: 'explore', status: 'running', runs: 1, callId: 'c', index: 0 };
  const branch = [
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', details: { kind: 'pidesk-subagents', background: true, results: [running, { ...running, id: 'agent-bbbbbbbb', status: 'running' }] } } },
    { type: 'custom_message', customType: 'pidesk-agent', details: { agent: { ...running, id: 'agent-bbbbbbbb', status: 'completed' } } },
  ];
  assert.equal(controller.restore(branch), 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message.details.agent.id, 'agent-aaaaaaaa');
  assert.equal(notices[0].message.details.agent.status, 'cancelled');
  assert.equal(notices[0].message.details.key, 'agent-aaaaaaaa:interrupted');
  assert.deepEqual(notices[0].options, {}, 'recorded without starting a turn');
  assert.equal(controller.restore([...branch, { type: 'custom_message', customType: 'pidesk-agent', details: notices[0].message.details }]), 0);
});

test('live state is published, throttled, with a full resync on request', async () => {
  const published = [];
  const c = context(async () => { await sleep(30); return reply('ok'); });
  const controller = createSubagentTool({ publish: payload => published.push(JSON.parse(payload)), notify: () => {}, isIdle: () => true });
  await start(controller, c, [{ name: 'a', task: 'a' }]);
  await until(() => published.some(p => p.agents.some(a => a.status === 'completed')), 4000);
  assert.ok(published.length <= 4, `throttled (${published.length} updates)`);
  const before = published.length;
  controller.sync();
  assert.equal(published.length, before + 1);
  assert.equal(published.at(-1).agents[0].retained, true);
});
