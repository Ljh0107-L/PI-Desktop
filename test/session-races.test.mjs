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
const reset = () => store.set({ activeId: null, view: 'new', pendingSessions: {}, antigravityReadiness: {}, transcripts: {}, sessions: [], catalog: [], history: [], future: [],
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

test('Antigravity keeps a first draft awaiting sign-in without sending to any Pi provider', async () => {
  reset();
  const piModel = { provider: 'mock', id: 'mock' };
  store.set({ composerDrafts: {}, catalog: [piModel], settings: { defaults: { model: piModel } },
    draft: { environmentId: 'local', cwd: '/tmp', engine: 'pi', model: piModel, ultra: true, speed: 'ultrafast' } });
  store.setDraft({ engine: 'antigravity' });
  assert.equal(store.getState().draft.model, null);
  const calls = [];
  const session = { id: 'agy', engine: 'antigravity', antigravity: { authRequired: true } };
  invoke = (method, ...args) => { calls.push([method, ...args]); return Promise.resolve(method === 'createSession' ? session : { defaults: { model: piModel } }); };
  const att = { kind: 'image', mimeType: 'image/png', data: 'aW1hZ2U=', name: 'image.png' };
  const sending = store.startSession('draft for later', [att]);
  const pendingId = store.getState().activeId;
  await sending;
  assert.equal(store.getState().activeId, session.id);
  assert.equal(store.getState().composerDrafts.agy.text, 'draft for later');
  assert.equal(store.getState().composerDrafts.agy.attachments[0].data, att.data);
  assert.deepEqual(calls, [['createSession', { engine: 'antigravity', environmentId: 'local', cwd: '/tmp', prompt: 'draft for later', creationId: pendingId }],
    ['focusSession', session.id], ['updateDefaults', { environmentId: 'local', engine: 'antigravity' }]]);
  store.setDraft({ environmentId: 'ssh:host' });
  assert.equal(store.getState().draft.engine, 'antigravity');
  assert.equal(store.getState().draft.model, null);
  store.setDraft({ cwd: '/remote/work' });
  const remote = { id: 'agy-ssh', engine: 'antigravity', antigravity: { authRequired: true, canSignIn: false } };
  invoke = (method, ...args) => { calls.push([method, ...args]); return Promise.resolve(method === 'createSession' ? remote : { defaults: { model: piModel } }); };
  const sendingRemote = store.startSession('draft for the SSH host');
  const pendingRemote = store.getState().activeId;
  await sendingRemote;
  assert.equal(store.getState().composerDrafts[remote.id].text, 'draft for the SSH host');
  assert.deepEqual(calls.find(([method, args]) => method === 'createSession' && args.environmentId === 'ssh:host')[1],
    { engine: 'antigravity', environmentId: 'ssh:host', cwd: '/remote/work', prompt: 'draft for the SSH host', creationId: pendingRemote });
  store.setDraft({ engine: 'pi' });
  assert.deepEqual(store.getState().draft.model, piModel);
  store.set({ questions: { [session.id]: [{ method: 'select', requestId: 'permission', options: ['Allow once'] }] } });
  await assert.rejects(store.sendPrompt(session.id, 'Allow once'), /Choose a permission option/);
  assert.ok(calls.every(([method]) => method !== 'answer' && method !== 'prompt'));
});

test('Antigravity startup progress and failure stay with the saved conversation and its draft', async () => {
  reset();
  const created = deferred(), calls = [];
  store.set({ composerDrafts: {}, notices: [], environments: [{ id: 'ssh:host', label: 'Dev host' }] });
  store.setDraft({ engine: 'antigravity', environmentId: 'ssh:host', cwd: '/work' });
  invoke = (method, ...args) => { calls.push([method, ...args]); return method === 'createSession' ? created.promise : Promise.resolve(null); };
  const file = { kind: 'file', name: 'readme.txt', data: 'aW1hZ2U=' };
  const task = store.startSession('first draft', [file]);
  const creationId = store.getState().activeId;
  assert.equal(store.getState().pendingSessions[creationId].phase, 'preparing');
  assert.equal(store.getState().pendingSessions[creationId].environmentLabel, 'Dev host');
  store.setDraft({ environmentId: 'local' });
  receive({ channel: 'status', payload: { id: 'saved', creationId, status: 'connecting', phase: 'opening' } });
  assert.equal(store.getState().pendingSessions[creationId].phase, 'opening');
  assert.equal(store.getState().pendingSessions[creationId].environmentId, 'ssh:host');
  receive({ channel: 'status', payload: { id: 'saved', creationId, status: 'error', message: 'Could not open Antigravity' } });
  created.resolve({ id: 'saved', engine: 'antigravity', status: 'error', statusMessage: 'Could not open Antigravity' });
  await task;
  assert.equal(store.getState().activeId, 'saved');
  assert.deepEqual(store.getState().pendingSessions, {});
  assert.deepEqual(store.getState().sessions.map(s => s.status), ['error']);
  assert.deepEqual(store.getState().notices, [], 'the error is shown on the conversation, not duplicated in a toast');
  assert.equal(store.getState().composerDrafts.saved.text, 'first draft');
  assert.equal(store.getState().composerDrafts.saved.attachments[0].data, file.data);
  await store.api('reconnect', 'saved');
  receive({ channel: 'status', payload: { id: 'saved', status: 'connected', phase: null } });
  assert.ok(!calls.some(([method]) => method === 'prompt'), 'reconnect must not send a draft');
  await store.sendPrompt('saved', 'first draft', [file]);
  assert.deepEqual(calls.at(-1), ['prompt', 'saved', 'first draft', [file]]);
  assert.equal(calls.filter(([method]) => method === 'createSession').length, 1);
});

test('background readiness blocks only a known failure on the selected machine', async () => {
  reset();
  const local = deferred(), remote = deferred(), calls = [];
  store.setDraft({ engine: 'antigravity' });
  invoke = (method, ...args) => {
    calls.push([method, ...args]);
    return method === 'antigravityReadiness' ? (args[0] === 'local' ? local.promise : remote.promise)
      : Promise.resolve(method === 'createSession' ? { id: 'ready', engine: 'antigravity', status: 'connected' } : null);
  };
  const checkingLocal = store.refreshAntigravityReadiness('local');
  assert.equal(store.refreshAntigravityReadiness('local'), checkingLocal);
  const checkingRemote = store.refreshAntigravityReadiness('ssh:host');
  remote.resolve('unreachable');
  await checkingRemote;
  await store.startSession('while the local check is still running');
  assert.deepEqual(calls.find(([method]) => method === 'prompt'), ['prompt', 'ready', 'while the local check is still running', []]);
  local.resolve('signedOut');
  await checkingLocal;
  await assert.rejects(store.startSession('local draft'), /Sign in to Antigravity/);
  store.setDraft({ environmentId: 'ssh:host' });
  await assert.rejects(store.startSession('remote draft'), /Can’t reach/);
  assert.equal(calls.filter(([method]) => method === 'createSession').length, 1);
});

test('completing sign-in in Settings supersedes a stale background check', async () => {
  reset();
  const oldCheck = deferred(), newCheck = deferred();
  let probes = 0;
  invoke = () => (++probes === 1 ? oldCheck.promise : newCheck.promise);
  const old = store.refreshAntigravityReadiness('local');
  store.reportAntigravityAccount('local', { installed: true, signedIn: true });
  assert.equal(store.getState().antigravityReadiness.local, 'ready');
  const current = store.refreshAntigravityReadiness('local');
  oldCheck.resolve('signedOut');
  await old;
  assert.equal(store.getState().antigravityReadiness.local, 'ready');
  assert.equal(store.refreshAntigravityReadiness('local'), current);
  newCheck.resolve('ready');
  await current;
});

test('a rejected first Antigravity prompt does not overwrite a newer draft', async () => {
  reset();
  store.set({ composerDrafts: {}, notices: [] });
  store.setDraft({ engine: 'antigravity' });
  const sending = deferred(), reachedPrompt = deferred();
  invoke = method => {
    if (method === 'prompt') { reachedPrompt.resolve(); return sending.promise; }
    return Promise.resolve(method === 'createSession' ? { id: 'agy', engine: 'antigravity', status: 'connected' } : null);
  };
  const task = store.startSession('original', [{ kind: 'file', name: 'original.txt', data: 'AA==' }]);
  await reachedPrompt.promise;
  store.setComposerDraft('agy', 'text', 'newer');
  sending.reject(new Error('Connection lost'));
  await task;
  const draft = store.getState().composerDrafts.agy;
  assert.equal(draft.text, 'newer');
  assert.deepEqual(draft.attachments, []);
  assert.equal(draft.recoveries[0].text, 'original');
  assert.equal(draft.recoveries[0].attachments[0].name, 'original.txt');
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
  store.set({ transcripts: { a: { ...emptyTranscript(), live: reply('fin', 7) } } });
  const message = reply('finished', 7);
  const task = store.reloadTranscript('a'); read.resolve(page([{ ...message, __entryId: 'finished' }])); await task;
  assert.equal(store.getState().transcripts.a.live, null);
  assert.equal(store.getState().transcripts.a.messages[0].content[0].text, 'finished');
  const key = store.getState().transcripts.a.messages[0].__liveKey;
  event('a', { type: 'message_end', message });
  assert.equal(store.getState().transcripts.a.messages.length, 1, 'the late end event is the same completed reply');
  assert.equal(store.getState().transcripts.a.messages[0].__liveKey, key);
});

for (const sameText of [false, true]) test(`a new reply does not reuse an existing entry at the same timestamp (same text: ${sameText})`, async () => {
  reset(); const read = deferred(); let pending;
  const first = { ...reply('First answer', 7), __entryId: 'first' };
  const second = reply(sameText ? 'First answer' : 'Second answer', 7);
  invoke = method => Promise.resolve(method === 'historyPage' ? pending : null);
  pending = page([first]); await store.reloadTranscript('a');
  pending = read.promise;
  const task = store.reloadTranscript('a');
  event('a', { type: 'message_end', message: second });
  read.resolve(page([first])); await task;
  const messages = () => store.getState().transcripts.a.messages;
  assert.deepEqual(messages().map(m => m.content[0].text), ['First answer', second.content[0].text]);
  assert.deepEqual(messages().map(m => m.__entryId), ['first', undefined]);
  pending = page([first, { ...second, __entryId: 'second' }]); await store.reloadTranscript('a');
  assert.deepEqual(messages().map(m => m.__entryId), ['first', 'second']);
});

test('a saved earlier reply with the same timestamp does not dismiss the currently streaming reply', async () => {
  reset(); const read = deferred(); invoke = method => method === 'historyPage' ? read.promise : Promise.resolve(null);
  const previous = reply('Same opening of the first answer', 7);
  event('a', { type: 'message_end', message: previous });
  event('a', { type: 'message_start', message: reply('', 7) });
  event('a', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Same opening' } });
  const task = store.reloadTranscript('a'); read.resolve(page([{ ...previous, __entryId: 'first' }])); await task;
  assert.equal(store.getState().transcripts.a.live.content[0].text, 'Same opening');
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

for (const aborted of [false, true]) test(`compaction failures are visible unless cancelled (aborted: ${aborted})`, async () => {
  reset(); store.set({ notices: [] });
  invoke = method => Promise.resolve(method === 'historyPage' ? page() : null);
  event('a', { type: 'compaction_start', reason: 'threshold' });
  assert.equal(store.getState().transcripts.a.compacting, true);
  event('a', { type: 'compaction_end', reason: 'threshold', aborted, errorMessage: 'Auto-compaction failed: empty response' });
  assert.equal(store.getState().transcripts.a.compacting, false);
  assert.deepEqual(store.getState().notices.map(n => [n.level, n.message]), aborted ? [] : [['error', 'Auto-compaction failed: empty response']]);
  await new Promise(resolve => setImmediate(resolve));
});
