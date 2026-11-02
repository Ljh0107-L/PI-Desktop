// Presentation metadata only: no model, relay, SSH, or application process is needed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../app/main/session-manager.mjs';
import { Store } from '../app/main/store.mjs';
import { PiSession } from '../core/pi-session.mjs';

function fixture(t, records) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-subagent-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, null, { insecureTestStorage: true });
  store.sessions = records;
  store.saveSessions();
  const forbidden = () => assert.fail('Clearing display history must not access a runtime or environment');
  const manager = new SessionManager({ store, environments: forbidden, local: {}, remoteSetup: forbidden });
  clearInterval(manager.sweeper);
  for (const name of ['ensureStarted', 'messages', 'prepare', 'env', 'relaySessions', 'stopRelay', 'close', 'abort']) t.mock.method(manager, name, forbidden);
  t.mock.method(PiSession.prototype, 'start', forbidden);
  let events = 0;
  manager.on('sessions', () => { events++; });
  const saves = t.mock.method(store, 'saveSessions');
  return { dir, store, manager, saves, events: () => events };
}

const record = (id, extra = {}) => ({
  id, environmentId: 'offline-ssh', cwd: '/unavailable/project', sessionFile: '/unavailable/history.jsonl',
  title: 'Keep main conversation', updatedAt: 123, createdAt: 100,
  usage: { input: 1234, output: 456, cost: 0.04 }, files: ['outputs/result.txt'], ...extra,
});

test('cleared display IDs merge persistently, idempotently, and only within their session', t => {
  const first = record('one', { clearedSubagentIds: ['old'] });
  const second = record('two', { clearedSubagentIds: ['other'] });
  const original = structuredClone([first, second]);
  const f = fixture(t, [first, second]);
  const eventsOnDisk = [];
  f.manager.on('sessions', () => eventsOnDisk.push(JSON.parse(readFileSync(join(f.dir, 'sessions.json'), 'utf8'))));

  const result = f.manager.clearSubagentHistory('one', ['new', 'old', 'new']);
  assert.deepEqual(result, { clearedSubagentIds: ['old', 'new'] });
  assert.deepEqual(f.store.sessions, [{ ...original[0], clearedSubagentIds: ['old', 'new'] }, original[1]]);
  assert.equal(f.saves.mock.callCount(), 1);
  assert.equal(f.events(), 1);
  assert.deepEqual(eventsOnDisk[0], f.store.sessions, 'event follows durable save');
  result.clearedSubagentIds.push('caller-mutation');
  assert.deepEqual(first.clearedSubagentIds, ['old', 'new'], 'result must not alias persisted metadata');

  assert.deepEqual(f.manager.clearSubagentHistory('one', ['new', 'old']), { clearedSubagentIds: ['old', 'new'] });
  assert.deepEqual(f.manager.clearSubagentHistory('one', []), { clearedSubagentIds: ['old', 'new'] });
  assert.equal(f.saves.mock.callCount(), 1);
  assert.equal(f.events(), 1);
  const reloaded = new Store(f.dir, null, { insecureTestStorage: true });
  assert.deepEqual(reloaded.sessions, f.store.sessions);
  assert.deepEqual(f.manager.list()[0].clearedSubagentIds, ['old', 'new']);
});

test('request bounds do not evict IDs accumulated across earlier clears', t => {
  const f = fixture(t, [record('one')]);
  const ids = Array.from({ length: 10000 }, (_, i) => `task-${i}`);
  f.manager.clearSubagentHistory('one', ids);
  const result = f.manager.clearSubagentHistory('one', ['next', 'x'.repeat(1024)]);
  assert.deepEqual(result.clearedSubagentIds, [...ids, 'next', 'x'.repeat(1024)]);
  assert.deepEqual(new Store(f.dir, null, { insecureTestStorage: true }).sessions[0].clearedSubagentIds, result.clearedSubagentIds);
});

test('invalid identifiers fail before any record changes or persistence', t => {
  const f = fixture(t, [record('one')]);
  const before = structuredClone(f.store.sessions);
  const invalid = [undefined, null, {}, 'task', 42, [null], [12], [false], [{}], [''], [' \n '], ['x'.repeat(1025)], new Array(1), Array(10001).fill('task'), ['valid', '']];
  for (const ids of invalid) assert.throws(() => f.manager.clearSubagentHistory('one', ids), /Subagent history identifiers/);
  for (const id of [null, 42, '', '  ', 'x'.repeat(1025)]) assert.throws(() => f.manager.clearSubagentHistory(id, ['task']), /Invalid session identifier/);
  assert.throws(() => f.manager.clearSubagentHistory('missing', ['task']), /Unknown session/);
  assert.throws(() => f.manager.clearSubagentHistory('missing', []), /Unknown session/);
  assert.deepEqual(f.manager.clearSubagentHistory('one', []), { clearedSubagentIds: [] });
  assert.deepEqual(f.store.sessions, before);
  assert.equal(f.saves.mock.callCount(), 0);
  assert.equal(f.events(), 0);
});

test('malformed saved metadata is rejected instead of silently discarded', t => {
  const f = fixture(t, [record('one', { clearedSubagentIds: 'old' })]);
  assert.throws(() => f.manager.clearSubagentHistory('one', ['new']), /Invalid saved subagent history metadata/);
  assert.equal(f.store.sessions[0].clearedSubagentIds, 'old');
  assert.equal(f.saves.mock.callCount(), 0);
  assert.equal(f.events(), 0);
});

for (const withPrevious of [false, true]) {
  test(`failed durable save restores ${withPrevious ? 'existing' : 'absent'} metadata without emitting`, t => {
    const entry = record('one', withPrevious ? { clearedSubagentIds: ['old'] } : {});
    const f = fixture(t, [entry]);
    const original = structuredClone(entry);
    const previous = entry.clearedSubagentIds;
    const path = join(f.dir, 'sessions.json');
    const diskBefore = readFileSync(path, 'utf8');
    // Force the real Store's synchronous write to fail, without changing the old sessions.json.
    mkdirSync(path + '.tmp');
    assert.throws(() => f.manager.clearSubagentHistory('one', ['new']));
    assert.deepEqual(entry, original);
    assert.equal(entry.clearedSubagentIds, previous, 'previous array identity is restored');
    assert.equal(Object.hasOwn(entry, 'clearedSubagentIds'), withPrevious);
    assert.equal(readFileSync(path, 'utf8'), diskBefore);
    assert.equal(f.events(), 0);
    rmSync(path + '.tmp', { recursive: true });
    assert.deepEqual(f.manager.clearSubagentHistory('one', ['new']), { clearedSubagentIds: withPrevious ? ['old', 'new'] : ['new'] });
    assert.equal(f.events(), 1, 'retry can succeed after a failed save');
  });
}

test('clearing display history leaves transcript, usage, files, and active tasks untouched', t => {
  const entry = record('one');
  const f = fixture(t, [entry]);
  const history = join(f.dir, 'conversation.jsonl');
  const output = join(f.dir, 'result.txt');
  const transcript = '{"type":"message","message":{"role":"user","content":"keep me"}}\n';
  writeFileSync(history, transcript);
  writeFileSync(output, 'keep output');
  entry.sessionFile = history;
  entry.files = [output];
  f.store.saveSessions();
  const before = structuredClone(entry);
  const runtime = { status: 'connected', streaming: true, questions: new Map(), session: { abort: () => assert.fail('Task interrupted') } };
  f.manager.runtimes.set('one', runtime);
  const runtimeBefore = { ...runtime };

  f.manager.clearSubagentHistory('one', ['completed-task', 'active-task']);
  assert.deepEqual(entry, { ...before, clearedSubagentIds: ['completed-task', 'active-task'] });
  assert.equal(f.manager.runtimes.get('one'), runtime);
  assert.deepEqual(runtime, runtimeBefore);
  assert.equal(f.manager.runtimes.size, 1);
  assert.equal(f.manager.list()[0].streaming, true);
  assert.equal(readFileSync(history, 'utf8'), transcript);
  assert.equal(readFileSync(output, 'utf8'), 'keep output');
  // Active-task tombstones are harmless metadata: renderer is responsible for keeping active tasks visible.
});
