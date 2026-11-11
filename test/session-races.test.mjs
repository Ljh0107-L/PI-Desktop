import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../app/main/session-manager.mjs';
import { emptyTranscript } from '../app/renderer/src/transcript.js';

let receive, invoke;
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { pidesk: { subscribe: fn => { receive = fn; }, invoke: (...args) => invoke(...args) } };
const store = await import('../app/renderer/src/store.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = (text, timestamp = 1) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp, stopReason: 'stop' });
const page = (messages = []) => ({ messages, next: null, snapshot: { identity: "test" } });
const event = (id, e) => receive({ channel: 'event', payload: { id, event: e } });
const reset = () => store.set({ activeId: null, view: 'new', transcripts: {}, sessions: [], catalog: [], history: [], future: [],
  draft: { environmentId: 'local', cwd: '/tmp', model: { provider: 'mock', id: 'mock' }, ultra: false } });

for (const inSnapshot of [false, true]) test(`history reload retains a concurrent completed reply exactly once (snapshot includes it: ${inSnapshot})`, async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  const task = store.reloadTranscript('a');
  const message = reply('new reply');
  event('a', { type: 'message_end', message });
  read.resolve(page(inSnapshot ? [message] : [])); await task;
  assert.deepEqual(store.getState().transcripts.a.messages.map(m => m.content[0].text), ['new reply']);
  assert.equal(store.getState().transcripts.a.live, null);
});

test('history reload preserves a reply and tool already streaming when it began', async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  event('a', { type: 'message_start', message: reply('', 2) });
  event('a', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'before ' } });
  event('a', { type: 'tool_execution_start', toolCallId: 'tool', args: {} });
  const task = store.reloadTranscript('a');
  event('a', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'after' } });
  event('a', { type: 'tool_execution_end', toolCallId: 'tool', result: { content: [] } });
  read.resolve(page()); await task;
  assert.equal(store.getState().transcripts.a.live.content[0].text, 'before after');
  assert.equal(store.getState().transcripts.a.tools.tool.status, 'done');
});

test('an older overlapping history request cannot replace a newer result', async () => {
  reset(); const a = deferred(), b = deferred(); let reads = 0;
  invoke = method => method === 'historyPage' ? (++reads === 1 ? a.promise : b.promise) : Promise.resolve(null);
  const first = store.reloadTranscript('a'), second = store.reloadTranscript('a');
  b.resolve(page([reply('new')])); await second; a.resolve(page([reply('old')])); await first;
  assert.equal(store.getState().transcripts.a.messages[0].content[0].text, 'new');
});

test('initial open also reconciles messages arriving during the history request', async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  const open = store.openSession('a');
  event('a', { type: 'message_end', message: reply('arrived') });
  read.resolve(page()); await open;
  assert.equal(store.getState().transcripts.a.messages[0].content[0].text, 'arrived');
});

test('deleting a session invalidates a pending history request', async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  store.set({ sessions: [{ id: 'a' }] });
  const task = store.reloadTranscript('a'); await store.deleteSession('a');
  read.resolve(page([reply('stale')])); await task;
  assert.equal(store.getState().transcripts.a, undefined);
});

for (const fail of [false, true]) test(`slow creation never overrides navigation (failure: ${fail})`, async () => {
  reset(); const created = deferred(); invoke = method => method === 'createSession' ? created.promise : Promise.resolve({});
  const task = store.startSession('first');
  store.set({ activeId: 'other', view: 'session' });
  if (fail) { created.reject(new Error('offline')); await assert.rejects(task, /offline/); }
  else { created.resolve({ id: 'created' }); await task; }
  assert.equal(store.getState().activeId, 'other'); assert.equal(store.getState().view, 'session');
});

test('two pending creations completing out of order retain the selected conversation', async () => {
  reset(); const a = deferred(), b = deferred(); let creates = 0;
  invoke = method => method === 'createSession' ? (++creates === 1 ? a.promise : b.promise) : Promise.resolve({});
  const first = store.startSession('first'), firstId = store.getState().activeId;
  store.newSession(); const second = store.startSession('second');
  assert.notEqual(store.getState().activeId, firstId);
  b.resolve({ id: 'second' }); await second; a.resolve({ id: 'first' }); await first;
  assert.equal(store.getState().activeId, 'second');
  assert.deepEqual(store.getState().sessions.map(s => s.id).sort(), ['first', 'second']);
});

test('failed first prompt does not redirect a different active conversation', async () => {
  reset(); const prompt = deferred();
  invoke = method => method === 'createSession' ? Promise.resolve({ id: 'created' }) : method === 'prompt' ? prompt.promise : Promise.resolve({});
  const task = store.startSession('first'); await Promise.resolve(); await Promise.resolve();
  store.set({ activeId: 'other', view: 'session' }); prompt.reject(new Error('provider down'));
  await assert.rejects(task, /provider down/); assert.equal(store.getState().activeId, 'other');
});

for (const ultra of [true, false]) test(`queued prompt respects Ultra while retaining normal interruption (Ultra: ${ultra})`, async t => {
  const record = { id: 'a', title: 'Existing', ultra };
  const manager = new SessionManager({ store: { sessions: [record], settings: { providers: [], defaults: {} } }, environments: () => [], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  const calls = []; let sent = 0;
  const session = { prompt: async () => { calls.push('prompt'); return { disposition: ++sent === 1 ? 'queued' : 'started' }; },
    abort: async () => { calls.push('abort'); }, abortBash: async () => { calls.push('abortBash'); }, clearQueue: async () => { calls.push('clearQueue'); }, nextSettled: async () => true };
  // Streaming can lag; test the queued fallback as well as Ultra's known active state.
  manager.runtimes.set('a', { session, streaming: ultra, ultra: { task: { status: ultra ? 'active' : 'paused' } },
    providersVersion: manager.providersVersion, configKey: JSON.stringify(manager.bootConfig(record)), applied: {} });
  manager.ensureStarted = async () => session;
  const result = await manager.prompt('a', 'additional instruction', [], { interrupt: true });
  assert.equal(result.interrupted, !ultra);
  assert.deepEqual(calls, ultra ? ['prompt'] : ['prompt', 'abortBash', 'clearQueue', 'abort', 'prompt']);
});

test('a completed history snapshot cannot revive a previously streaming reply', async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  store.set({ transcripts: { a: { ...emptyTranscript(), live: reply('partial', 7) } } });
  const task = store.reloadTranscript('a'); read.resolve(page([reply('finished', 7)])); await task;
  assert.equal(store.getState().transcripts.a.live, null);
  assert.equal(store.getState().transcripts.a.messages[0].content[0].text, 'finished');
});

test('failed superseded history reads cannot overwrite a newer successful view', async () => {
  reset(); const a = deferred(), b = deferred(); let reads = 0;
  invoke = method => method === 'historyPage' ? (++reads === 1 ? a.promise : b.promise) : Promise.resolve(null);
  const first = store.reloadTranscript('a'), second = store.reloadTranscript('a');
  b.resolve(page([reply('new')])); await second; a.reject(new Error('old connection')); await first;
  assert.equal(store.getState().transcripts.a.error, null);
});

test('navigation history adopts the final session ID instead of retaining a pending placeholder', async () => {
  reset(); const created = deferred(); invoke = method => method === 'createSession' ? created.promise : Promise.resolve(null);
  const task = store.startSession('first'); store.newSession();
  assert.ok(store.isPendingSession(store.getState().history.at(-1).activeId));
  created.resolve({ id: 'created' }); await task;
  assert.equal(store.getState().history.at(-1).activeId, 'created');
  store.goBack(); assert.equal(store.getState().activeId, 'created');
});
