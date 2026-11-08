// CI-only headless regressions, including the real bundled Pi and its HTTP tool declarations.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { registerSessionTools, restoredToolNames, toolCheckpoint } from '../agent/pidesk-session-tools.mjs';
import { stageExtensions } from '../app/main/extensions.mjs';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport } from '../core/transports.mjs';
import { startMockLlm } from './mock-llm.mjs';

const coding = ['read', 'bash', 'edit', 'write'];
const declarations = names => names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
const system = (id, parentId, added = [], removed = []) => ({ type: 'message', id, parentId, timestamp: '2026-11-08T00:00:00.000Z',
  message: { role: 'system', content: '', toolsAdded: declarations(added), toolsRemoved: declarations(removed), timestamp: 1 } });
const checkpoint = (tools = [...coding, 'subagent'], id = 'checkpoint', parentId = 'missing') => ({ type: 'compaction', id, parentId,
  timestamp: '2026-11-08T00:00:00.000Z', firstKeptEntryId: id, summary: 'Fixture history only; no work has been verified.', tokensBefore: 100,
  systemMessage: { role: 'system', content: 'Offline tool recovery fixture.', toolsAdded: declarations(tools), timestamp: 1 } });
function fixture(t, { branch = [checkpoint()], active = ['subagent'], registered = [...coding, 'subagent'], argv = [], running = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, 'original session bytes\n');
  const handlers = new Map(), commands = new Map(), notices = [], confirmations = [], changes = [];
  let aborted = false, idle = true, confirm = async () => true;
  const all = registered.map(name => typeof name === 'string' ? { name, exposure: 'direct' } : name);
  const pi = {
    on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); },
    getAllTools: () => all, getActiveTools: () => [...active], setActiveTools(names) { changes.push(names); active = [...names]; },
    appendEntry(customType, data) {
      const entry = { id: 'repair', parentId: branch.at(-1)?.id, type: 'custom', customType, data };
      branch.push(entry);
      writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
    },
  };
  const ctx = { hasUI: true, isIdle: () => idle, abort() { aborted = true; },
    sessionManager: { getBranch: () => branch, getSessionFile: () => file },
    ui: { notify(message, level) { notices.push({ message, level }); }, async confirm(title, message) { confirmations.push({ title, message }); return confirm(); } },
  };
  registerSessionTools(pi, { argv, agentsRunning: () => running });
  return { pi, ctx, file, dir, notices, confirmations, changes,
    start: () => handlers.get('session_start')({}, ctx), tree: () => handlers.get('session_tree')({}, ctx),
    prompt: () => { const event = { systemPromptOptions: { sections: {} } }; handlers.get('before_agent_start')(event, ctx); return event; },
    recover: () => commands.get('pidesk-recover-tools').handler('', ctx),
    get active() { return active; }, get aborted() { return aborted; },
    setIdle(value) { idle = value; }, setConfirm(fn) { confirm = fn; }, setBranch(value) { branch = value; },
  };
}

test('checkpoint replay folds later changes and does not mutate the transcript', () => {
  const branch = [checkpoint(), system('delta', 'checkpoint', ['grep'], ['write'])];
  const before = JSON.stringify(branch);
  assert.deepEqual(toolCheckpoint(branch).tools, ['read', 'bash', 'edit', 'subagent', 'grep']);
  assert.equal(JSON.stringify(branch), before);
  const newer = checkpoint(['read'], 'newer', 'delta');
  assert.deepEqual(toolCheckpoint([...branch, newer]).tools, ['read'], 'latest complete checkpoint wins');
  assert.deepEqual(toolCheckpoint([checkpoint([])]).tools, [], 'empty is a valid intentional loadout');
  assert.equal(toolCheckpoint([{ type: 'compaction' }]), null, 'old compactions without checkpoints are not guessed');
});

test('restoration respects removals, registered/hidden tools and newly registered extensions', () => {
  const cp = toolCheckpoint([checkpoint(), system('delta', 'checkpoint', [], ['write'])]);
  const names = restoredToolNames(cp, ['subagent', 'brand-new', 'grep'], [
    ...declarations(['read', 'bash', 'write', 'subagent', 'brand-new', 'grep']), { name: 'edit', exposure: 'hidden' },
  ]);
  assert.deepEqual(names, ['read', 'bash', 'subagent', 'brand-new']);
  assert.ok(!names.includes('write'), 'a later explicit removal stays removed');
  assert.ok(!names.includes('grep'), 'do not enable absent built-in defaults');
});

test('intact history is untouched; damaged history restores once and warns without rewriting', t => {
  const f = fixture(t, { branch: [checkpoint(coding, 'checkpoint', null)] });
  f.start();
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.notices, []);
  f.setBranch([checkpoint()]);
  f.start(); f.start();
  assert.deepEqual(f.active, [...coding, 'subagent']);
  assert.equal(f.changes.length, 1);
  assert.match(f.notices[0].message, /Missing history was not repaired/);
  assert.equal(readFileSync(f.file, 'utf8'), 'original session bytes\n');
  assert.deepEqual(readdirSync(f.dir), ['session.jsonl']);
  assert.match(f.prompt().systemPromptOptions.sections.session_integrity, /incomplete history chain/);
  f.setBranch([checkpoint(coding, 'intact', null)]); f.tree();
  assert.equal(f.prompt().systemPromptOptions.sections.session_integrity, undefined, 'branch navigation clears the warning');
});

test('without a complete checkpoint a damaged session stops instead of guessing tools', t => {
  const f = fixture(t, { branch: [system('delta', 'missing', ['subagent'])] });
  f.start(); f.prompt();
  assert.equal(f.aborted, true);
  assert.deepEqual(f.changes, []);
  assert.match(f.notices[0].message, /no complete tool checkpoint/);
});

for (const argv of [['--tools', '-write'], ['--tools=read'], ['--no-tools'], ['--exclude-tools', 'bash']]) {
  test(`explicit tool constraints are never overridden: ${argv.join(' ')}`, async t => {
    const f = fixture(t, { argv });
    f.start(); await f.recover();
    assert.deepEqual(f.changes, []);
    assert.equal(f.confirmations.length, 0);
    assert.match(f.notices[0].message, /Explicit tool selection/);
  });
}

test('already persisted removals need explicit recovery, backup and a durable marker', async t => {
  const branch = [checkpoint(), system('bad-delta', 'checkpoint', [], coding)];
  const f = fixture(t, { branch });
  f.start();
  assert.deepEqual(f.active, ['subagent'], 'do not guess whether a persisted removal was intentional');
  const original = readFileSync(f.file);
  await f.recover();
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].message, /even if a later entry disabled them/);
  assert.deepEqual(f.active, ['subagent', ...coding]);
  const repair = branch.at(-1);
  assert.equal(repair.customType, 'pidesk-tool-recovery');
  assert.deepEqual(readFileSync(repair.data.backup), original);
  assert.equal(statSync(repair.data.backup).mode & 0o777, 0o600);
  assert.ok(readFileSync(f.file).subarray(0, original.length).equals(original), 'original bytes remain untouched');
  assert.deepEqual(toolCheckpoint(branch).tools, ['subagent', ...coding], 'restart before the next model request keeps the repair');
  const later = system('intentional-removal', 'repair', [], ['write']);
  assert.ok(!toolCheckpoint([...branch, later]).tools.includes('write'), 'later removals still win');
  f.pi.setActiveTools(['subagent']); f.start();
  assert.deepEqual(f.active, ['subagent', ...coding]);
});

test('recovery cancellation, concurrent work, changed branch and absent files are safe', async t => {
  const branch = () => [checkpoint(), system('bad-delta', 'checkpoint', [], coding)];
  for (const mode of ['cancel', 'busy', 'agents', 'changed', 'missing-file', 'no-ui']) {
    const f = fixture(t, { branch: branch(), running: mode === 'agents' });
    if (mode === 'busy') f.setIdle(false);
    if (mode === 'no-ui') f.ctx.hasUI = false;
    if (mode === 'cancel') f.setConfirm(async () => false);
    if (mode === 'changed') f.setConfirm(async () => { f.setBranch([...branch(), system('new-leaf', 'bad-delta')]); return true; });
    if (mode === 'missing-file') rmSync(f.file);
    await f.recover();
    assert.deepEqual(f.changes, [], mode);
    if (mode !== 'missing-file') assert.deepEqual(readdirSync(f.dir), ['session.jsonl'], mode);
  }
});

test('recovery cannot resurrect unregistered or hidden tools', async t => {
  const f = fixture(t, { branch: [checkpoint(), system('bad', 'checkpoint', [], coding)], registered: ['read', 'subagent', { name: 'bash', exposure: 'hidden' }] });
  await f.recover();
  assert.deepEqual(f.active, ['subagent', 'read']);
});

const ciOnly = { skip: !['1', 'true'].includes(process.env.CI), timeout: 30000 };
async function rpcFixture(t, { removed = false, noCheckpoint = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-tool-rpc-'));
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  const mock = await startMockLlm({ chunkDelay: 0 });
  const file = join(dir, 'broken.jsonl');
  const entries = [
    { type: 'session', version: 3, id: '11111111-1111-4111-8111-111111111111', cwd: dir, timestamp: new Date().toISOString() },
    system('original', null, [...coding, 'subagent']),
  ];
  const cp = checkpoint();
  const tail = noCheckpoint ? [system('delta', 'missing', ['subagent'])]
    : [cp, system('delta', cp.id, [], removed ? coding : ['write'])];
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{"type":"message","id":"missing","partial":' + JSON.stringify({ type: 'custom' }) + '\n' + tail.map(e => JSON.stringify(e)).join('\n') + '\n');
  const bridge = stageExtensions(resolve('agent'), join(dir, 'ext'));
  const boot = { providers: [{ id: 'mock', api: 'openai-completions', baseUrl: mock.baseUrl('mock'), apiKey: 'test-only', models: [{ id: 'model' }] }] };
  const sessions = [];
  t.after(async () => { for (const s of sessions) await s.stop(); await mock.close(); rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    const s = new PiSession({ id: 'recovery', boot, transport: localTransport({ cwd: dir, node: process.execPath,
      piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), agentDir, extensions: [bridge], piArgs: ['--session', file] }) });
    sessions.push(s);
    const notices = [];
    s.on('ui', request => {
      if (request.method === 'notify') notices.push(request.message);
      if (request.method === 'confirm') s.respondUi(request.id, { confirmed: true });
    });
    await s.start(); await s.setModel('mock', 'model');
    return { s, notices };
  };
  const prompt = async (s, text) => { const done = s.nextSettled(15000); await s.prompt(text); await done; };
  return { file, dir, mock, start, prompt };
}

test('bundled Pi: broken JSONL restores real tool schemas, subagent execution and reopen state', ciOnly, async t => {
  const f = await rpcFixture(t);
  let { s, notices } = await f.start();
  assert.ok(notices.some(text => text.includes('missing parent')), JSON.stringify(notices));
  await f.prompt(s, '[[subagents-runtime]]');
  const requests = f.mock.requests;
  assert.ok(requests.some(r => r.subagent));
  for (const r of requests) {
    const names = r.tools.map(tool => tool.name);
    assert.ok(['read', 'bash', 'edit'].every(name => names.includes(name)), JSON.stringify(names));
    assert.ok(!names.includes('write'), 'explicit removal after the checkpoint survives');
  }
  const messages = await s.messages();
  const result = messages.find(m => m.role === 'toolResult' && m.toolName === 'subagent');
  assert.ok(result && !result.isError, JSON.stringify(result));
  assert.ok(result.details.results[0].toolCalls > 0, 'the child actually called a coding tool');
  await s.stop();
  ({ s } = await f.start());
  const mark = requests.length;
  await f.prompt(s, 'hello after reopening');
  assert.ok(requests[mark].tools.some(tool => tool.name === 'bash'));
  assert.ok(!requests[mark].tools.some(tool => tool.name === 'write'));
  assert.ok(readFileSync(f.file, 'utf8').includes('"partial":'), 'bad history is not rewritten');
});

test('bundled Pi: a confirmed repair survives a restart before another model request', ciOnly, async t => {
  const f = await rpcFixture(t, { removed: true });
  let { s } = await f.start();
  const before = readFileSync(f.file);
  await s.prompt('/pidesk-recover-tools');
  const backups = readdirSync(f.dir).filter(name => name.includes('.tools-backup-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(f.dir, backups[0])), before);
  assert.equal(f.mock.requests.length, 0, 'the recovery command never calls a model');
  await s.stop();
  ({ s } = await f.start());
  await f.prompt(s, 'hello after recovery');
  assert.ok(coding.every(name => f.mock.requests[0].tools.some(tool => tool.name === name)));
});

test('bundled Pi: an incomplete history without a checkpoint makes no model request', ciOnly, async t => {
  const f = await rpcFixture(t, { noCheckpoint: true });
  const { s, notices } = await f.start();
  await f.prompt(s, 'do not send this to a model');
  assert.equal(f.mock.requests.length, 0);
  assert.ok(notices.some(text => text.includes('no complete tool checkpoint')));
});
