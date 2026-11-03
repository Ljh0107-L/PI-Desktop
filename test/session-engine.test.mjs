import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../app/main/session-manager.mjs';

test('legacy session views advertise Pi without modifying stored records', t => {
  const legacy = { id: 'legacy', model: { provider: 'model_hub', id: 'very-long-model-name' } };
  const cursor = { id: 'cursor', engine: 'cursor' };
  const manager = new SessionManager({ store: { sessions: [legacy, cursor], settings: {} }, environments: () => [], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  assert.deepEqual(manager.list().map(s => s.engine), ['pi', 'cursor']);
  assert.equal(Object.hasOwn(legacy, 'engine'), false);
});

// Cursor CLI was removed: its conversations stay readable from their history file, never start a process,
// and refuse new messages with an explanation instead of a connection error.
test('conversations from the removed Cursor engine are read-only history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-cursor-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.jsonl');
  const user = { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1 };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }], timestamp: 2 };
  writeFileSync(file, [{ type: 'session', version: 3, id: 'h', cwd: dir }, { type: 'message', id: 'a', parentId: 'h', message: user }, { type: 'message', id: 'b', parentId: 'a', message: reply }].map(e => JSON.stringify(e)).join('\n') + '\n');
  const record = { id: 'cursor', engine: 'cursor', environmentId: 'local', cwd: dir, piSessionFile: file, title: 'Hello' };
  const manager = new SessionManager({ store: { sessions: [record], settings: { providers: [] } }, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  const statuses = []; manager.on('status', s => statuses.push(s));
  assert.deepEqual(await manager.messages('cursor'), [user, reply]);
  await assert.rejects(manager.ensureStarted('cursor'), /Cursor CLI was removed/);
  await assert.rejects(manager.prompt('cursor', 'more'), /read-only/);
  await assert.rejects(manager.fork('cursor'), /read-only/);
  assert.equal(manager.warm('cursor'), true);
  assert.equal(manager.runtimes.size, 0, 'no process or connection state is created');
  assert.deepEqual(statuses, [], 'opening it never flashes a connection error');
});
