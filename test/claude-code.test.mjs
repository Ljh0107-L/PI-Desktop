// Claude Code engine: adapter (Pi RPC ⇄ Claude Code stream-json), installer and SessionManager wiring.
// Offline: a fake Claude Code binary (test/fixtures/fake-claude.mjs) stands in for the native one.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { ClaudeAdapter, Transcript, claudeEnv, normalizeToolCall, piUsage, toolResultContent } from '../agent/pidesk-claude.mjs';
import { CLAUDE_CODE_VERSION, CLAUDE_CODE_INTEGRITY, claudeEffort, claudeLayout, claudePlatform, claudeTarballUrl, downloadClaudeTarball, ensureLocalClaude, isClaudeCodeModel, prepareRemoteClaude, remoteClaudeProbeScript } from '../app/main/claude-code.mjs';
import { EXTENSION_FILES } from '../app/main/extensions.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { readHistory } from '../agent/pidesk-history.mjs';
import { UsageLedger } from '../app/main/usage.mjs';

const exec = promisify(execFile);
const fake = resolve('test/fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
const waitFor = async (predicate, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await sleep(20); }
  assert.fail('condition timed out');
};
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'pd-cc-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

// ------------------------------------------------------------------ pure helpers
test('Claude Code core tools take Pi tool names and shapes; others keep their own', () => {
  assert.deepEqual(normalizeToolCall('t1', 'Edit', { file_path: '/a.js', old_string: 'x', new_string: 'y' }),
    { type: 'toolCall', id: 't1', name: 'edit', arguments: { path: '/a.js', edits: [{ oldText: 'x', newText: 'y' }] }, ccName: 'Edit', ccInput: { file_path: '/a.js', old_string: 'x', new_string: 'y' } });
  assert.equal(normalizeToolCall('t', 'MultiEdit', { file_path: '/b', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).arguments.edits.length, 2);
  assert.deepEqual(normalizeToolCall('t', 'Read', { file_path: '/r', offset: 3 }).arguments, { path: '/r', offset: 3 });
  assert.deepEqual(normalizeToolCall('t', 'Write', { file_path: '/w', content: 'c' }).arguments, { path: '/w', content: 'c' });
  assert.deepEqual(normalizeToolCall('t', 'Bash', { command: 'ls', description: 'List' }).arguments, { command: 'ls', description: 'List' });
  assert.equal(normalizeToolCall('t', 'Glob', { pattern: '*.js' }).name, 'find');
  const task = normalizeToolCall('t', 'Task', { prompt: 'p' });
  assert.equal(task.name, 'Task'); assert.equal(task.ccName, undefined);
  assert.deepEqual(toolResultContent([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }]), [{ type: 'text', text: 'a' }, { type: 'image', data: 'AA', mimeType: 'image/png' }]);
});

test('usage is Pi-shaped and priced with the model rates', () => {
  const u = piUsage({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  assert.equal(u.totalTokens, 3600);
  assert.ok(Math.abs(u.cost.total - (0.003 + 0.0075 + 0.0006 + 0.000375)) < 1e-12);
  assert.equal(piUsage({}).cost.total, 0);
});

test('Claude Code gets only its own credentials and a private config directory', () => {
  const env = claudeEnv({ PATH: '/bin', HOME: '/h', PIDESK_BOOT: '{"secret":1}', OPENAI_API_KEY: 'x', HTTPS_PROXY: 'http://127.0.0.1:9' },
    { configDir: '/cfg', provider: { id: 'gw', apiKey: 'sk-1', baseUrl: 'https://gw.example', headers: { 'X-Team': 'a' } }, model: { id: 'gw-model', maxTokens: 64000 } });
  assert.equal(env.PIDESK_BOOT, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-Team: a');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gw-model', 'a custom endpoint serves its own models for background work');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9', 'egress through the desktop still works');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  const official = claudeEnv({}, { configDir: '/c', provider: { id: 'anthropic', apiKey: 'sk-a' }, model: { id: 'claude-x' } });
  assert.equal(official.ANTHROPIC_BASE_URL, undefined);
  assert.equal(official.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, "Anthropic's API keeps Claude Code's own aliases");
});

test('only Anthropic Messages models run Claude Code; Pi thinking levels map to its effort', () => {
  assert.equal(isClaudeCodeModel({ api: 'anthropic-messages' }), true);
  assert.equal(isClaudeCodeModel({ api: 'openai-completions' }), false);
  assert.equal(claudeEffort('xhigh'), 'xhigh');
  assert.equal(claudeEffort('minimal'), 'low');
  assert.equal(claudeEffort('bogus'), null);
});

test('the session file is a Pi tree: branch, resume position and copies', t => {
  const dir = tmp(t);
  const tr = Transcript.create(join(dir, 'sessions'), '/work/project');
  const u1 = tr.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } });
  tr.append({ type: 'message', message: { role: 'assistant', content: [] }, cc: { sessionId: 's1', uuid: 'a1' } });
  const u2 = tr.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } });
  tr.append({ type: 'message', message: { role: 'assistant', content: [] }, cc: { sessionId: 's1', uuid: 'a2' } });
  assert.deepEqual(tr.claudePosition(), { sessionId: 's1', uuid: 'a2' });
  assert.deepEqual(tr.claudePosition(u2.parentId), { sessionId: 's1', uuid: 'a1' });
  const reread = new Transcript(tr.file);
  assert.equal(reread.messages().length, 4);
  assert.equal(reread.header.engine, 'claude-code');
  const copy = tr.copyBranch(join(dir, 'sessions'), u2.parentId);
  assert.notEqual(copy.file, tr.file);
  assert.equal(copy.messages().length, 2);
  assert.equal(new Transcript(copy.file).leafId, u2.parentId);
  assert.equal(tr.branch(u1.id).length, 1);
});

// ------------------------------------------------------------------ adapter against the fake binary
function adapterFixture(t, { env = {}, config = {} } = {}) {
  const dir = tmp(t);
  const work = join(dir, 'work'); mkdirSync(work);
  writeFileSync(join(work, 'hello.txt'), 'hello world\n');
  const log = join(dir, 'claude.log');
  const events = [];
  const waiters = [];
  const write = record => { events.push(record); for (const w of [...waiters]) if (w.pred(record)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(record); } };
  const boot = { claudeCode: {
    bin: fake, configDir: join(dir, 'config'), sessionsDir: join(dir, 'sessions'), cwd: work,
    provider: { id: 'gw', kind: 'custom', api: 'anthropic-messages', apiKey: 'sk-gw', baseUrl: 'https://gw.example', headers: { 'X-Team': 't' } },
    model: { provider: 'gw', id: 'gw-claude', contextWindow: 200000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    ...config,
  } };
  boot.claudeCode.env = { FAKE_CLAUDE_LOG: log, ...env };
  const adapter = new ClaudeAdapter({ boot, write, env: process.env });
  t.after(() => adapter.child?.kill('SIGKILL'));
  let n = 0;
  const request = (type, payload = {}) => {
    const id = `r${++n}`;
    const response = new Promise(resolve => waiters.push({ pred: r => r.type === 'response' && r.id === id, resolve }));
    adapter.handle({ type, id, ...payload });
    return response.then(r => { if (!r.success) throw new Error(r.error); return r.data; });
  };
  const next = pred => new Promise(resolve => waiters.push({ pred, resolve }));
  const turn = async message => { const settled = next(r => r.type === 'agent_settled'); const sent = await request('prompt', { message }); await settled; return sent; };
  const starts = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.args) : [];
  const applied = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.applied).map(l => l.applied) : [];
  return { dir, work, adapter, events, request, next, turn, starts, applied };
}

test('a reply streams as Pi events with usage, cost and request timing, and is saved as Pi history', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  const state = await f.request('get_state');
  assert.ok(state.sessionFile, 'the session file exists from the start');
  assert.equal(state.engine, 'claude-code');
  assert.deepEqual(await f.turn('Hello [[think]]'), { disposition: 'started' });
  const types = f.events.map(e => e.type);
  assert.ok(types.indexOf('agent_start') < types.indexOf('message_start'));
  assert.ok(types.includes('message_update'));
  assert.equal(types.at(-1), 'agent_settled');
  const reply = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').at(-1).message;
  assert.deepEqual(reply.content.map(b => b.type), ['thinking', 'text']);
  assert.match(reply.content[1].text, /^echo: Hello/);
  assert.equal(reply.provider, 'gw');
  assert.equal(reply.stopReason, 'stop');
  assert.equal(reply.usage.input, 100); assert.equal(reply.usage.cacheRead, 20); assert.equal(reply.usage.cacheWrite, 5);
  assert.ok(reply.usage.output > 1, 'final output count comes from message_delta');
  assert.ok(reply.usage.cost.total > 0);
  const timing = reply.__timing;
  assert.equal(timing.source, 'agent'); assert.equal(timing.complete, true);
  assert.ok(timing.requestStart <= timing.start && timing.start <= timing.end, 'request start precedes the stream, for Request TPS');
  // History pages and the Usage ledger read the same file.
  const page = await readHistory(state.sessionFile, {});
  assert.deepEqual(page.messages.map(m => m.role), ['user', 'assistant']);
  assert.ok(page.messages[1].__timing && page.messages[1].usage);
  const start = f.starts()[0];
  assert.equal(start.env.ANTHROPIC_API_KEY, 'sk-gw');
  assert.equal(start.env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(start.env.CLAUDE_CONFIG_DIR, join(f.dir, 'config'));
  assert.equal(start.env.PIDESK_BOOT, undefined);
  assert.ok(start.args.includes('--permission-prompt-tool') && start.args.includes('stdio'));
  assert.deepEqual(start.args.slice(start.args.indexOf('--model'), start.args.indexOf('--model') + 2), ['--model', 'gw-claude']);
  const stats = await f.request('get_session_stats');
  assert.deepEqual(stats.contextUsage, { tokens: 1234, contextWindow: 200000, percent: 0.617 });
});

test('tools: Bash and Edit run with Pi names, results and file changes; prompts are auto-approved', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  await f.turn('please [[bash:ls -la]]');
  const call = f.events.find(e => e.type === 'tool_execution_start');
  assert.deepEqual([call.toolName, call.args.command], ['bash', 'ls -la']);
  const end = f.events.find(e => e.type === 'tool_execution_end');
  assert.equal(end.isError, false);
  assert.equal(end.result.content[0].text, 'ran: ls -la');
  assert.equal(end.result.details.claude.stdout, 'ran: ls -la');
  const file = join(f.work, 'hello.txt');
  await f.turn(`[[edit:${file}|hello|goodbye]]`);
  assert.equal(readFileSync(file, 'utf8'), 'goodbye world\n');
  const edit = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').flatMap(e => e.message.content).find(b => b.name === 'edit');
  assert.deepEqual(edit.arguments, { path: file, edits: [{ oldText: 'hello', newText: 'goodbye' }] });
  const messages = (await f.request('get_messages')).messages;
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant', 'toolResult', 'assistant']);
  assert.equal(messages[2].toolName, 'bash');
});

test('AskUserQuestion becomes a question card and its answer goes back to Claude Code', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  const settled = f.next(r => r.type === 'agent_settled');
  const question = f.next(r => r.type === 'extension_ui_request' && r.method === 'select');
  await f.request('prompt', { message: 'pick [[ask]]' });
  const q = await question;
  assert.equal(q.title, 'Which color?');
  assert.deepEqual(q.options, ['Red', 'Blue']);
  f.adapter.handle({ type: 'extension_ui_response', id: q.id, value: 'Blue' });
  await settled;
  const reply = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').at(-1).message;
  assert.equal(reply.content[0].text, 'You chose Blue');
});

test("Claude Code's agents fold into the Task call, with their usage counted once", { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  await f.turn('[[task]]');
  const update = f.events.find(e => e.type === 'tool_execution_update');
  assert.equal(update.partialResult.details.kind, 'claude-code-agent');
  const result = f.events.find(e => e.type === 'message_end' && e.message.role === 'toolResult').message;
  assert.equal(result.toolName, 'Task');
  assert.deepEqual(result.details.steps.map(s => s.type), ['tool', 'result', 'text']);
  assert.equal(result.details.steps[0].name, 'find');
  const [run] = result.details.agentRuns;
  assert.equal(run.usage.input, 110); assert.equal(run.usage.output, 15); assert.equal(run.turns, 2);
  // The Usage ledger takes agent runs from the tool result, as for Pi's own agents.
  const dir = tmp(t);
  const ledger = new UsageLedger({ path: join(dir, 'usage.jsonl'), sessionsDir: join(dir, 'none') });
  for (const e of f.events) if (e.type === 'message_end') ledger.record(e.message);
  const summary = await ledger.summary();
  assert.equal(summary.totals.calls, 2 + 2, 'two main replies plus the agent run (2 turns)');
});

test('Stop interrupts the reply without an error; an API error is shown as one', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  const settled = f.next(r => r.type === 'agent_settled');
  await f.request('prompt', { message: 'go [[slow]]' });
  await f.next(r => r.type === 'message_update');
  await f.request('abort');
  await settled;
  const replies = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').map(e => e.message);
  assert.equal(replies.at(-1).stopReason, 'aborted');
  assert.ok(!replies.some(m => m.stopReason === 'error'), 'a Stop is not a failure');
  await f.turn('[[error]]');
  const error = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').at(-1).message;
  assert.equal(error.stopReason, 'error');
  assert.match(error.errorMessage, /401/);
});

test("Claude Code's slash commands: listed, run, and their output shown; /compact leaves a summary", { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  await f.turn('hello');
  const { commands } = await f.request('get_commands');
  assert.deepEqual(commands.map(c => c.name), ['compact', 'review', 'goal'], 'internal commands are hidden; /goal is Claude Code’s own');
  assert.equal(commands[1].argumentHint, '[target]');
  await f.turn('/context');
  const local = f.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').at(-1).message;
  assert.match(local.content[0].text, /Context Usage/);
  assert.equal(local.__localCommand, true);
  const compacted = await f.request('compact');
  assert.deepEqual(compacted, { compacted: true });
  assert.ok(f.events.some(e => e.type === 'compaction_start') && f.events.some(e => e.type === 'compaction_end'));
  const state = await f.request('get_state');
  const page = await readHistory(state.sessionFile, {});
  assert.equal(page.messages.at(-1).role, 'compactionSummary');
  assert.match(page.messages.at(-1).summary, /fake work so far/);
  assert.equal(page.messages.at(-1).tokensBefore, 5000);
});

test('model, effort and Ultracode reach a running Claude Code; another key restarts it, resumed', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  await f.turn('first');
  const first = (await f.request('get_state')).claudeSessionId;
  await f.request('claude_configure', { effort: 'high', ultracode: true });
  assert.deepEqual(f.applied(), [{ effortLevel: 'high', ultracode: true }]);
  assert.equal(f.starts().length, 1, 'no restart for settings Claude Code applies itself');
  // On a custom endpoint the model also names Claude Code's background models: a new process, resumed.
  await f.request('claude_configure', { model: { provider: 'gw', id: 'gw-claude-2' } });
  await f.turn('with the second model');
  assert.equal(f.starts().length, 2);
  assert.equal(f.starts()[1].env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gw-claude-2');
  assert.equal(f.starts()[1].args[f.starts()[1].args.indexOf('--model') + 1], 'gw-claude-2');
  await f.request('claude_configure', { provider: { id: 'gw', apiKey: 'sk-rotated', baseUrl: 'https://gw.example' } });
  await f.turn('second');
  const starts = f.starts();
  assert.equal(starts.length, 3);
  assert.equal(starts[2].env.ANTHROPIC_API_KEY, 'sk-rotated');
  assert.deepEqual(starts[2].args.slice(starts[2].args.indexOf('--resume'), starts[2].args.indexOf('--resume') + 2), ['--resume', first]);
  assert.ok(starts[2].args.includes('--effort') && starts[2].args.includes('high'));
  assert.ok(starts[2].args.includes('--settings') && JSON.parse(starts[2].args[starts[2].args.indexOf('--settings') + 1]).ultracode);
  // On Anthropic's own API a model switch reaches the running process.
  const g = adapterFixture(t, { config: { provider: { id: 'anthropic', kind: 'builtin', apiKey: 'sk-ant' }, model: { provider: 'anthropic', id: 'claude-a' } } });
  await g.turn('hi');
  await g.request('claude_configure', { model: { provider: 'anthropic', id: 'claude-b' } });
  assert.deepEqual(g.applied(), [{ model: 'claude-b' }]);
  assert.equal(g.starts().length, 1);
});

test('Ultracode that the model does not offer is turned off with a notice', { timeout: 20000 }, async t => {
  const f = adapterFixture(t, { env: { FAKE_NO_ULTRACODE: '1' } });
  await f.turn('hello');
  const result = await f.request('claude_configure', { ultracode: true });
  assert.equal(result.ultracode, false);
  const notice = f.events.find(e => e.type === 'extension_ui_request' && e.method === 'notify');
  assert.match(notice.message, /ultracode is not available/i);
});

test('fork and edit continue Claude Code as a fork, at the message before the edited one', { timeout: 20000 }, async t => {
  const f = adapterFixture(t);
  await f.turn('one');
  await f.turn('two');
  const source = await f.request('get_state');
  const forks = (await f.request('get_fork_messages')).messages;
  assert.deepEqual(forks.map(m => m.text), ['one', 'two']);
  const entries = (await f.request('get_entries')).entries;
  const firstReply = entries.find(e => e.message?.role === 'assistant');
  await f.request('fork', { entryId: forks[1].entryId });
  await f.turn('two, edited');
  const after = await f.request('get_state');
  assert.notEqual(after.sessionFile, source.sessionFile, 'a new session file, as Pi’s fork');
  assert.deepEqual((await f.request('get_messages')).messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['one', 'two, edited']);
  const start = f.starts().at(-1);
  assert.equal(start.args[start.args.indexOf('--resume') + 1], source.claudeSessionId);
  assert.ok(start.args.includes('--fork-session'));
  assert.equal(start.args[start.args.indexOf('--resume-session-at') + 1], firstReply.cc.uuid);
  // The original conversation is untouched.
  assert.equal(new Transcript(source.sessionFile).messages().length, 4);
  // Clone (Fork conversation) copies the whole branch and forks the Claude Code session.
  await f.request('clone');
  const cloned = await f.request('get_state');
  assert.notEqual(cloned.sessionFile, after.sessionFile);
  await f.turn('in the clone');
  const cloneStart = f.starts().at(-1);
  assert.ok(cloneStart.args.includes('--fork-session'));
  assert.ok(!cloneStart.args.includes('--resume-session-at'));
});

test('a machine Claude subscription is never used', { timeout: 20000 }, async t => {
  const f = adapterFixture(t, { env: { FAKE_CLAUDE_OAUTH: '1' } });
  await assert.rejects(f.request('prompt', { message: 'hello' }), /did not use the API key/);
  const g = adapterFixture(t, { config: { provider: { id: 'anthropic', apiKey: '' } } });
  await assert.rejects(g.request('prompt', { message: 'hello' }), /API key/);
  assert.equal(g.starts().length, 0, 'never started without a key from Settings');
});

// ------------------------------------------------------------------ installer
test('platform packages and layout', () => {
  assert.equal(claudePlatform('Linux', 'x86_64'), 'linux-x64');
  assert.equal(claudePlatform('Linux', 'aarch64', true), 'linux-arm64-musl');
  assert.equal(claudePlatform('Darwin', 'arm64'), 'darwin-arm64');
  assert.equal(claudePlatform('FreeBSD', 'x86_64'), null);
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl']) assert.match(CLAUDE_CODE_INTEGRITY[platform], /^sha512-/);
  assert.equal(claudeTarballUrl('https://registry.npmjs.org/', 'linux-x64'), `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz`);
  assert.deepEqual(claudeLayout('/home/u/.pidesk'), { dir: `/home/u/.pidesk/claude-code/${CLAUDE_CODE_VERSION}`, bin: `/home/u/.pidesk/claude-code/${CLAUDE_CODE_VERSION}/claude`, configDir: '/home/u/.pidesk/claude-code/config' });
  assert.ok(EXTENSION_FILES.includes('pidesk-claude.mjs'), 'the adapter is staged and uploaded with the bridge');
  assert.match(remoteClaudeProbeScript('/r'), /ld-musl/);
});

async function fakeTarball(dir) {
  const pkg = join(dir, 'pkg', 'package'); mkdirSync(pkg, { recursive: true });
  copyFileSync(fake, join(pkg, 'claude'));
  const file = join(dir, 'fake.tgz');
  await exec('tar', ['-czf', file, '-C', join(dir, 'pkg'), 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const data = readFileSync(file);
  return { data, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` };
}
const fetchServing = (data, calls = []) => async url => { calls.push(url); return new Response(data, { status: 200, headers: { 'content-length': String(data.length) } }); };

test('downloads are verified against the pinned checksum, with a mirror after a failure', { timeout: 20000 }, async t => {
  const dir = tmp(t);
  const { data, integrity } = await fakeTarball(dir);
  const calls = [];
  const flaky = async url => { calls.push(url); if (url.startsWith('https://first.example')) return new Response('nope', { status: 503 }); return new Response(data, { status: 200 }); };
  const out = await downloadClaudeTarball('linux-x64', join(dir, 'cache'), { fetchImpl: flaky, registries: ['https://first.example', 'https://mirror.example'], integrities: { 'linux-x64': integrity } });
  assert.deepEqual(readFileSync(out), data);
  assert.equal(calls.length, 2);
  await assert.rejects(downloadClaudeTarball('linux-arm64', join(dir, 'cache2'), { fetchImpl: fetchServing(data), registries: ['https://x.example'], integrities: { 'linux-arm64': 'sha512-AAAA' } }), /checksum/);
  assert.ok(!existsSync(join(dir, 'cache2', `claude-code-linux-arm64-${CLAUDE_CODE_VERSION}.tgz`)), 'nothing unverified is kept');
});

test('this Mac installs its own copy in the app data folder, once', { timeout: 20000 }, async t => {
  const dir = tmp(t);
  const { data, integrity } = await fakeTarball(dir);
  const calls = [];
  const layout = await ensureLocalClaude({ root: join(dir, 'userData'), cacheDir: join(dir, 'cache'), platform: 'darwin-arm64', fetchImpl: fetchServing(data, calls), registries: ['https://r.example'], integrities: { 'darwin-arm64': integrity } });
  assert.equal(layout.bin, join(dir, 'userData', 'claude-code', CLAUDE_CODE_VERSION, 'claude'));
  assert.match((await exec(layout.bin, ['--version'])).stdout, new RegExp(CLAUDE_CODE_VERSION));
  assert.ok(existsSync(layout.configDir));
  await ensureLocalClaude({ root: join(dir, 'userData'), cacheDir: join(dir, 'cache'), platform: 'darwin-arm64', fetchImpl: fetchServing(data, calls) });
  assert.equal(calls.length, 1, 'installed once');
});

test('an SSH host downloads Claude Code itself, or gets it uploaded when it has no internet', { timeout: 20000 }, async t => {
  const dir = tmp(t);
  const { data, integrity } = await fakeTarball(dir);
  const env = { id: 'ssh:h', host: 'h', label: 'Host' };
  const facts = { root: '/srv/.pidesk' };
  const scripts = [];
  const sshWith = ({ installed = '', curl = true, curlWorks = true } = {}) => async (_env, script, options = {}) => {
    scripts.push({ script, input: options.input });
    if (script.includes("printf 'os=%s")) return `os=Linux\narch=x86_64\n${installed ? `installed=${installed}\n` : ''}${curl ? 'curl=1\nsha=sha512sum\n' : ''}`;
    if (script.includes('curl -fsS -m 8') && !curlWorks) throw new Error('curl: (6) Could not resolve host');
    return '';
  };
  const options = { cacheDir: join(dir, 'cache'), fetchImpl: fetchServing(data), registries: ['https://r.example'], integrities: { 'linux-x64': integrity } };
  // Already installed: nothing to do.
  await prepareRemoteClaude(env, facts, { ...options, runSsh: sshWith({ installed: `${CLAUDE_CODE_VERSION} (Claude Code)` }) });
  assert.ok(!scripts.some(s => s.script.includes('tar -xzf')));
  // The host can reach the registry: it downloads and checks the checksum itself.
  scripts.length = 0;
  const layout = await prepareRemoteClaude(env, facts, { ...options, runSsh: sshWith() });
  assert.equal(layout.bin, `/srv/.pidesk/claude-code/${CLAUDE_CODE_VERSION}/claude`);
  const hex = Buffer.from(integrity.slice(7), 'base64').toString('hex');
  const download = scripts.find(s => s.script.includes('curl -fsSL'));
  assert.ok(download.script.includes(hex), 'the pinned checksum is verified on the host');
  assert.ok(!scripts.some(s => s.input), 'nothing uploaded');
  // No internet on the host: this Mac downloads, verifies and uploads it.
  scripts.length = 0;
  const progress = [];
  await prepareRemoteClaude(env, facts, { ...options, runSsh: sshWith({ curlWorks: false }), onProgress: m => progress.push(m) });
  const upload = scripts.find(s => s.input);
  assert.deepEqual(upload.input, data);
  assert.match(upload.script, /tar -xzf - -C/);
  assert.ok(progress.some(m => /Uploading Claude Code from this Mac/.test(m)));
  // No curl at all: straight to the upload.
  scripts.length = 0;
  await prepareRemoteClaude(env, facts, { ...options, runSsh: sshWith({ curl: false }) });
  assert.ok(scripts.some(s => s.input) && !scripts.some(s => s.script.includes('curl -fsSL')));
});

// The install scripts themselves, run by a real POSIX shell against a real HTTP registry: download with
// curl and a checksum check on the "host", and the upload path through stdin.
test('the host install scripts download, verify and extract with a real shell', { timeout: 30000 }, async t => {
  const dir = tmp(t);
  const { data, integrity } = await fakeTarball(dir);
  const http = await import('node:http');
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-length': data.length }); res.end(data); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const shell = async (_env, script, { input } = {}) => new Promise((resolveRun, reject) => {
    const child = spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => code === 0 ? resolveRun(stdout) : reject(new Error(stderr || `exit ${code}`)));
    child.stdin.end(input ?? '');
  });
  const integrities = Object.fromEntries(Object.keys(CLAUDE_CODE_INTEGRITY).map(k => [k, integrity]));
  const hasCurl = await exec('sh', ['-c', 'command -v curl']).then(() => true, () => false);
  const root = join(dir, 'host-root');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  const layout = await prepareRemoteClaude({ host: 'h' }, { root }, { runSsh: shell, cacheDir: join(dir, 'cache'), registries: [registry], integrities, fetchImpl: fetchServing(data) });
  assert.match((await exec(layout.bin, ['--version'])).stdout, new RegExp(CLAUDE_CODE_VERSION));
  if (hasCurl) assert.ok(hits.length >= 1, 'the host fetched it itself');
  // Installed: the next preparation only checks the version.
  const before = hits.length;
  await prepareRemoteClaude({ host: 'h' }, { root }, { runSsh: shell, cacheDir: join(dir, 'cache'), registries: [registry], integrities });
  assert.equal(hits.length, before);
  // Upload path (a host without internet).
  const root2 = join(dir, 'offline-root');
  const layout2 = await prepareRemoteClaude({ host: 'h' }, { root: root2 }, { runSsh: shell, cacheDir: join(dir, 'cache'), registries: [registry], integrities, fetchImpl: fetchServing(data), forceUpload: true });
  assert.match((await exec(layout2.bin, ['--version'])).stdout, new RegExp(CLAUDE_CODE_VERSION));
  assert.ok(existsSync(layout2.configDir));
});

// ------------------------------------------------------------------ SessionManager + relay
async function managerFixture(t) {
  const dir = tmp(t);
  const runDir = join(dir, 'run'); mkdirSync(runDir);
  const ext = join(dir, 'ext'); mkdirSync(ext);
  copyFileSync(resolve('agent/pidesk-claude.mjs'), join(ext, 'pidesk-claude.mjs'));
  const relayPath = join(dir, 'relay.mjs'); copyFileSync(resolve('agent/pidesk-relay.mjs'), relayPath);
  const work = join(dir, 'work'); mkdirSync(work);
  const log = join(dir, 'claude.log');
  const keys = { gw: 'sk-gateway', anthropic: 'sk-ant' };
  const store = {
    sessions: [], settings: { providers: [{ id: 'gw', name: 'Gateway', kind: 'custom', api: 'anthropic-messages', baseUrl: 'https://gw.example/v1', headers: { 'X-Team': 'pd' }, models: [{ id: 'gw-claude' }] }, { id: 'openai', kind: 'builtin' }], environments: {}, defaults: {} },
    saveSessions() {}, saveSettings() {}, touchRecent() {}, getKey: id => keys[id] ?? null,
  };
  const manager = new SessionManager({
    store, environments: () => [{ id: 'local', kind: 'local', label: 'Local' }],
    local: { node: process.execPath, piCli: '/nonexistent', agentDir: join(dir, 'agent'), runDir, extraEnv: {}, claudeRoot: dir },
    relayPath, bridgePath: join(ext, 'pidesk-bridge.js'), cacheDir: join(dir, 'cache'),
    claudeLocal: async () => ({ bin: fake, configDir: join(dir, 'claude-config') }),
    claudeEnv: { FAKE_CLAUDE_LOG: log },
  });
  manager.catalog = async () => [
    { provider: 'gw', id: 'gw-claude', name: 'GW Claude', api: 'anthropic-messages', contextWindow: 200000, maxTokens: 32000, baseUrl: 'https://gw.example/v1', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    { provider: 'gw', id: 'gw-claude-2', name: 'GW Claude 2', api: 'anthropic-messages', contextWindow: 200000, baseUrl: 'https://gw.example/v1' },
    { provider: 'openai', id: 'gpt-x', name: 'GPT X', api: 'openai-responses' },
  ];
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    await exec('pkill', ['-f', `${relayPath} daemon`]).catch(() => {});
  });
  const events = [];
  manager.on('event', e => events.push(e));
  const starts = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.args) : [];
  return { dir, work, manager, store, events, starts, keys };
}

test('a Claude Code conversation runs through the relay with the Models settings', { timeout: 30000 }, async t => {
  const f = await managerFixture(t);
  await assert.rejects(f.manager.create({ environmentId: 'local', cwd: f.work, model: { provider: 'openai', id: 'gpt-x' }, engine: 'claude-code' }), /Anthropic Messages/);
  await assert.rejects(f.manager.create({ environmentId: 'local', cwd: f.work, model: { provider: 'gw', id: 'gw-claude' }, engine: 'claude-code', ultra: true }), /Ultracode/);
  const view = await f.manager.create({ environmentId: 'local', cwd: f.work, model: { provider: 'gw', id: 'gw-claude' }, engine: 'claude-code', effort: 'high' });
  assert.equal(view.engine, 'claude-code');
  assert.equal(view.status, 'connected');
  const record = f.store.sessions[0];
  assert.ok(record.piSessionFile, 'history file known before the first message');
  await f.manager.prompt(view.id, 'Hello from the desktop');
  await waitFor(() => f.events.some(e => e.id === view.id && e.event.type === 'agent_settled'));
  const start = f.starts()[0];
  assert.equal(start.env.ANTHROPIC_API_KEY, 'sk-gateway');
  assert.equal(start.env.ANTHROPIC_BASE_URL, 'https://gw.example', 'an Anthropic base URL never ends in /v1');
  assert.equal(start.env.ANTHROPIC_CUSTOM_HEADERS, 'X-Team: pd');
  assert.equal(start.env.CLAUDE_CONFIG_DIR, join(f.dir, 'claude-config'));
  assert.ok(start.args.includes('--effort') && start.args.includes('high'));
  const page = await f.manager.historyPage(view.id, {});
  assert.deepEqual(page.messages.map(m => m.role), ['user', 'assistant']);
  assert.match(page.messages[1].content[0].text, /echo: Hello from the desktop/);
  const stats = await f.manager.stats(view.id);
  assert.equal(stats.contextUsage.contextWindow, 200000);
  const commands = await f.manager.commands(view.id);
  assert.ok(commands.some(c => c.name === 'goal' && c.source === 'claude-code'));
  // Pi-only settings stay out of Claude Code conversations.
  await assert.rejects(f.manager.setUltra(view.id, true), /Ultracode/);
  // Model switches stay within Anthropic Messages models; effort and Ultracode reach Claude Code at once.
  await assert.rejects(f.manager.setModel(view.id, 'openai', 'gpt-x'), /Anthropic Messages/);
  await f.manager.setEffort(view.id, 'max');
  assert.equal(f.store.sessions[0].effort, 'max');
  assert.deepEqual(await f.manager.setUltracode(view.id, true), { ultracode: true });
  await f.manager.prompt(view.id, 'again');
  await waitFor(() => f.events.filter(e => e.id === view.id && e.event.type === 'agent_settled').length >= 2);
  assert.equal(f.starts().length, 1, 'still the first Claude Code process');
  await f.manager.setModel(view.id, 'gw', 'gw-claude-2');
  // A rotated key restarts Claude Code, resumed.
  f.keys.gw = 'sk-rotated';
  f.manager.providersChanged();
  await waitFor(() => f.manager.runtimes.get(view.id)?.claudeKey?.includes('sk-rotated'));
  await f.manager.prompt(view.id, 'after rotation');
  await waitFor(() => f.events.filter(e => e.id === view.id && e.event.type === 'agent_settled').length >= 3);
  const restarted = f.starts().at(-1);
  assert.equal(f.starts().length, 2);
  assert.equal(restarted.env.ANTHROPIC_API_KEY, 'sk-rotated');
  assert.equal(restarted.args[restarted.args.indexOf('--model') + 1], 'gw-claude-2');
  assert.ok(restarted.args.includes('--resume'));
  // Fork keeps the engine and its own history.
  const forked = await f.manager.fork(view.id);
  assert.equal(forked.engine, 'claude-code');
  assert.notEqual(forked.piSessionFile, record.piSessionFile);
  assert.equal(forked.effort, 'max');
});

// The real native binary against a local Anthropic Messages mock. Opt-in: PIDESK_REAL_CLAUDE=<path to claude>.
test('the real Claude Code binary runs a conversation end to end', { skip: !process.env.PIDESK_REAL_CLAUDE, timeout: 120000 }, async t => {
  const { startMockAnthropic } = await import('./mock-anthropic.mjs');
  const mock = await startMockAnthropic();
  t.after(() => mock.close());
  const f = await managerFixture(t);
  f.manager.claudeLocal = async () => ({ bin: process.env.PIDESK_REAL_CLAUDE, configDir: join(f.dir, 'claude-config') });
  f.store.settings.providers[0].baseUrl = mock.url;
  const catalog = await f.manager.catalog();
  f.manager.catalog = async () => catalog.map(m => m.provider === 'gw' ? { ...m, id: 'mock-claude', baseUrl: mock.url } : m);
  writeFileSync(join(f.work, 'hello.txt'), 'hello world\n');
  const view = await f.manager.create({ environmentId: 'local', cwd: f.work, model: { provider: 'gw', id: 'mock-claude' }, engine: 'claude-code' });
  const settled = n => waitFor(() => f.events.filter(e => e.id === view.id && e.event.type === 'agent_settled').length >= n, 60000);
  await f.manager.prompt(view.id, 'Hello real binary');
  await settled(1);
  await f.manager.prompt(view.id, 'Run [[bash:cat hello.txt]]');
  await settled(2);
  await f.manager.prompt(view.id, `[[edit:${join(f.work, 'hello.txt')}|hello|goodbye]]`);
  await settled(3);
  assert.equal(readFileSync(join(f.work, 'hello.txt'), 'utf8'), 'goodbye world\n');
  const page = await f.manager.historyPage(view.id, {});
  assert.deepEqual(page.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant', 'toolResult', 'assistant']);
  assert.ok(mock.requests.every(r => r.apiKey === 'sk-gateway' && r.custom === '' || r.apiKey === 'sk-gateway'), 'only the key from Models reaches the endpoint');
  assert.ok(mock.requests.every(r => r.model === 'mock-claude'), 'background work uses the conversation model on a custom endpoint');
  const replies = page.messages.filter(m => m.role === 'assistant');
  assert.ok(replies.every(m => m.usage?.output > 0 && m.__timing?.requestStart <= m.__timing?.end));
});
