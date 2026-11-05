// The desktop's side of background agents: history, the idle sweep, usage, and the merged view.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { branchMessages, SessionManager } from '../app/main/session-manager.mjs';
import { UsageLedger } from '../app/main/usage.mjs';
import { displayBlocks, outputs, usageOf } from '../app/renderer/src/transcript.js';
import { agentSnapshots, subagentBatches } from '../app/renderer/src/subagent-state.js';

const usage = output => ({ input: 10, output, cacheRead: 2, cacheWrite: 0, totalTokens: 12 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } });
const run = (id, n, output = 5) => ({ key: `pidesk-agent:${id}:${n}`, provider: 'mock', model: 'm', usage: usage(output), turns: 2, at: 1000 + n });
const agent = (id, status, updatedAt, extra = {}) => ({ id, name: 'Survey', type: 'explore', status, updatedAt, callId: 'call-1', index: 0, steps: [], ...extra });
const report = (a, runs = []) => ({ role: 'custom', customType: 'pidesk-agent', content: 'Automated message…', display: true, timestamp: 5, details: { kind: 'pidesk-agent', key: `${a.id}:1`, agent: a, agentRuns: runs } });

test('history includes extension messages such as agent reports, as Pi gives them to the model', () => {
  const entries = [
    { type: 'message', id: '1', parentId: null, message: { role: 'user', content: 'start', timestamp: 1 } },
    { type: 'custom_message', id: '2', parentId: '1', customType: 'pidesk-agent', content: 'report', display: true, details: { key: 'a:1' }, timestamp: '2026-11-05T00:00:00.000Z' },
    { type: 'custom', id: '3', parentId: '2', customType: 'pidesk-goal', data: {} },
  ];
  const messages = branchMessages(entries, '3');
  assert.deepEqual(messages.map(m => m.role), ['user', 'custom']);
  assert.deepEqual({ ...messages[1], timestamp: undefined }, { role: 'custom', customType: 'pidesk-agent', content: 'report', display: true, details: { key: 'a:1' }, timestamp: undefined });
  assert.equal(messages[1].timestamp, Date.parse('2026-11-05T00:00:00.000Z'));
});

test('the idle sweep never stops a Pi whose agents are still working', async () => {
  const record = { id: 's1', environmentId: 'local', cwd: '/tmp' };
  const store = { sessions: [record], settings: { providers: [], environments: {} }, saveSessions() {}, touchRecent() {} };
  const manager = new SessionManager({ store, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  const stopped = [];
  const runtime = { status: 'connected', streaming: false, starting: null, questions: new Map(), lastUsed: 0,
    session: { stop: async () => { stopped.push('s1'); } }, agents: new Map([['agent-1', agent('agent-1', 'running', 1)]]) };
  manager.runtimes.set('s1', runtime);
  assert.deepEqual(await manager.sweep(Date.now()), [], 'a background agent keeps the session busy');
  assert.deepEqual(manager.agents('s1').map(a => a.id), ['agent-1']);
  runtime.agents.set('agent-1', agent('agent-1', 'completed', 2));
  assert.deepEqual(await manager.sweep(Date.now()), ['s1'], 'idle once its agents are done');
  await assert.rejects(manager.stopAgent('s1', 'agent-1'), /not running/);
});

test('the ledger records each agent run once, wherever it is reported', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-agent-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger({ path: join(dir, 'ledger.jsonl'), sessionsDir: join(dir, 'sessions') });
  const launched = { role: 'toolResult', toolName: 'subagent', details: { kind: 'pidesk-subagents', background: true, results: [agent('a', 'running', 1, { usage: usage(3) })] } };
  ledger.record(launched); // background launch: its usage arrives with the report
  ledger.record(report(agent('a', 'completed', 2), [run('a', 1)]));
  ledger.record(report(agent('a', 'completed', 2), [run('a', 1)])); // replayed after a reconnect
  ledger.record({ role: 'toolResult', toolName: 'subagent_message', details: { kind: 'pidesk-agent-message', agent: agent('a', 'completed', 3), agentRuns: [run('a', 2, 7)] } });
  const summary = await ledger.summary();
  assert.equal(summary.totals.tokens, (12 + 5) + (12 + 7));
  assert.equal(summary.totals.calls, 4, 'two turns per run');

  const sessions = join(dir, 'sessions');
  rmSync(join(dir, 'ledger.jsonl'), { force: true });
  const scanned = new UsageLedger({ path: join(dir, 'other.jsonl'), sessionsDir: sessions });
  (await import('node:fs')).mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 's.jsonl'), JSON.stringify({ type: 'custom_message', customType: 'pidesk-agent', details: { agentRuns: [run('b', 1, 9)] } }) + '\n');
  assert.equal((await scanned.summary()).totals.tokens, 21, 'reports in Pi\'s session files count too');
});

test('usage counts each reported run, never a waited call twice', () => {
  const waited = { role: 'toolResult', toolName: 'subagent', usage: usage(5), details: { kind: 'pidesk-subagents', results: [], agentRuns: [run('a', 1)] } };
  const later = report(agent('a', 'completed', 2), [run('a', 2, 7)]);
  const u = usageOf([waited, later]);
  assert.equal(u.output, 12);
  assert.equal(u.input, 20);
  assert.equal(u.calls, 4);
  assert.equal(u.tps, null, 'agent tokens never feed main TPS');
  const legacy = { role: 'toolResult', toolName: 'subagent', usage: usage(5), details: { kind: 'pidesk-subagents', results: [{ turns: 3 }] } };
  assert.equal(usageOf([legacy]).output, 5, 'older results keep counting as before');
});

test('the delegation card shows the newest state: launch, report, then live', () => {
  const call = { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { tasks: [{ name: 'Survey', task: 'Find it', type: 'explore' }] } };
  const transcript = { tools: {}, messages: [
    { role: 'assistant', content: [call] },
    { role: 'toolResult', toolName: 'subagent', toolCallId: 'call-1', details: { kind: 'pidesk-subagents', background: true, results: [agent('a', 'running', 1)] } },
    report(agent('a', 'completed', 5, { output: 'found' })),
  ] };
  let [batch] = subagentBatches(transcript);
  assert.equal(batch.background, true);
  assert.equal(batch.tasks[0].status, 'completed');
  assert.equal(batch.tasks[0].output, 'found');
  assert.equal(batch.tasks[0].task, 'Find it', 'the brief stays the one the call gave');
  [batch] = subagentBatches(transcript, { a: agent('a', 'running', 9, { runs: 2 }) });
  assert.equal(batch.tasks[0].status, 'running', 'a follow-up run, live from Pi, is newer than the report');
  [batch] = subagentBatches(transcript, { a: agent('a', 'running', 3) });
  assert.equal(batch.tasks[0].status, 'completed', 'a stale live line never resurrects a finished run');
  assert.equal(agentSnapshots({ messages: [{ role: 'toolResult', toolName: 'subagent_stop', details: { agent: agent('z', 'cancelled', 1) } }] }).get('z').status, 'cancelled');
});

test('a report is one row in the conversation, and its files count as outputs', () => {
  const a = agent('a', 'completed', 2, { files: [{ path: '/w/notes.md', tool: 'write' }] });
  const t = { tools: {}, messages: [{ role: 'user', content: 'go', timestamp: 1 }, report(a), { role: 'assistant', content: [{ type: 'text', text: 'Thanks' }], timestamp: 6 }] };
  const blocks = displayBlocks(t);
  const row = blocks.find(b => b.kind === 'agentReport');
  assert.equal(row.agent.id, 'a');
  assert.ok(blocks.indexOf(row) < blocks.findIndex(b => b.kind === 'text' || b.kind === 'markdown' || b.kind === 'assistant'), 'the reply follows the report');
  assert.deepEqual(outputs(t).map(f => f.path), ['/w/notes.md']);
});
