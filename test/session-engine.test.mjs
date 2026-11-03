import assert from 'node:assert/strict';
import test from 'node:test';
import { composerEngine } from '../app/renderer/src/session-engine.js';
import { SessionManager } from '../app/main/session-manager.mjs';

test('existing sessions never inherit the new-conversation engine', () => {
  for (const draft of [{ engine: 'cursor' }, { engine: 'pi' }, {}]) {
    assert.equal(composerEngine({ id: 'legacy-pi' }, draft), 'pi');
    assert.equal(composerEngine({ id: 'pi', engine: 'pi' }, draft), 'pi');
    assert.equal(composerEngine({ id: 'cursor', engine: 'cursor' }, draft), 'cursor');
    assert.equal(composerEngine({ model: { provider: 'cursor' } }, draft), 'pi', 'a Pi provider name is not an agent engine');
  }
  assert.equal(composerEngine(null, { engine: 'cursor' }), 'cursor');
  assert.equal(composerEngine(undefined, { engine: 'pi' }), 'pi');
  assert.equal(composerEngine(null, null), 'pi');
});

test('legacy session views advertise Pi without modifying stored records', t => {
  const legacy = { id: 'legacy', model: { provider: 'model_hub', id: 'very-long-model-name' } };
  const cursor = { id: 'cursor', engine: 'cursor' };
  const manager = new SessionManager({ store: { sessions: [legacy, cursor], settings: {} }, environments: () => [], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  assert.deepEqual(manager.list().map(s => s.engine), ['pi', 'cursor']);
  assert.equal(Object.hasOwn(legacy, 'engine'), false);
});

test('idle Cursor conversations outlive idle Pi ones, since restarting Cursor delays the next reply', async t => {
  const pi = { id: 'pi', environmentId: 'local' }, cursor = { id: 'cursor', engine: 'cursor', environmentId: 'local' };
  const manager = new SessionManager({ store: { sessions: [pi, cursor], settings: {} }, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  manager.stopRelay = async () => {};
  const now = Date.now();
  for (const id of ['pi', 'cursor']) manager.runtimes.set(id, { status: 'connected', streaming: false, questions: new Map(), lastUsed: now - 30 * 60 * 1000, session: { stop: async () => {} } });
  assert.deepEqual(await manager.sweep(now), ['pi']);
  manager.runtimes.get('cursor').lastUsed = now - 61 * 60 * 1000;
  assert.deepEqual(await manager.sweep(now), ['cursor']);
});
