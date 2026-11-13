import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { PAGE_BYTES, PAGE_MESSAGES, projectEntry, readHistory } from '../agent/pidesk-history.mjs';
import { historyKey, mergeHistory, retainLoadedContent, mergeReloadedHistory } from '../app/renderer/src/history.js';
import { displayBlocks, fromHistory, retainWorkKeys, rewindTo } from '../app/renderer/src/transcript.js';
import { SessionManager } from '../app/main/session-manager.mjs';
import { historyEvent } from '../core/history-view.mjs';
import { HistoryBuffer, prepareHistoryPage } from '../app/renderer/src/history-buffer.js';

const entry = (i, parentId = i ? `e${i - 1}` : null, message = {}) => ({ type: 'message', id: `e${i}`, parentId,
  message: { role: i % 2 ? 'assistant' : 'user', timestamp: i + 1, content: [{ type: 'text', text: `message ${i}` }], ...message } });
function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, entries.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  return file;
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('tool-heavy pages contain useful context instead of stopping after eighty hidden results', async t => {
  const rows = [entry(0, null, { role: 'user', content: [{ type: 'text', text: 'The task that started this work' }] })];
  for (let i = 1; i < 241; i++) rows.push(entry(i, `e${i - 1}`, i % 2
    ? { role: 'assistant', content: [{ type: 'toolCall', id: `call-${i}`, name: 'bash', arguments: { command: 'true' } }] }
    : { role: 'toolResult', toolName: 'bash', toolCallId: `call-${i - 1}`, content: [{ type: 'text', text: 'hidden output '.repeat(3000) }] }));
  const page = await readHistory(fixture(t, rows));
  assert.equal(page.messages[0].__entryId, 'e0');
  assert.equal(page.messages.length, 241);
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= PAGE_BYTES);
  const prose = 'normal visible reply '.repeat(500);
  assert.equal(projectEntry(entry(1, null, { content: [{ type: 'text', text: prose }] }), {}).content[0].text, prose);
});

test('prefetch keeps two pages ready, coalesces readers and discards obsolete generations', async () => {
  const calls = [], finish = new Map();
  const buffer = new HistoryBuffer(cursor => { calls.push(cursor); return new Promise(resolve => finish.set(cursor, resolve)); });
  const warming = buffer.prefetch('a');
  await Promise.resolve();
  const foreground = buffer.get('a');
  assert.deepEqual(calls, ['a']);
  finish.get('a')({ messages: [], next: 'b' });
  await foreground;
  assert.ok(buffer.peek('a'));
  for (let i = 0; i < 8 && !finish.has('b'); i++) await Promise.resolve();
  finish.get('b')({ messages: [], next: 'c' });
  await warming;
  assert.deepEqual(calls, ['a', 'b']);
  assert.ok(buffer.peek('b'));
  buffer.consume('a');
  assert.equal(buffer.peek('a'), undefined);
  const stale = buffer.get('c');
  await Promise.resolve();
  buffer.clear();
  finish.get('c')({ messages: [], next: 'd' });
  await stale;
  assert.equal(buffer.peek('c'), undefined);
});

test('prefetch prepares long visible prose but not folded tool results', async () => {
  const text = 'visible '.repeat(10000);
  const full = entry(1, null, { content: [{ type: 'text', text }] });
  const ref = { id: 'e1', length: 100000 };
  const page = { messages: [projectEntry(full, ref), projectEntry(entry(2, 'e1', { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text }] }), { id: 'e2', length: 100000 })], next: null };
  const seen = [];
  const ready = await prepareHistoryPage(page, async ref => { seen.push(ref.id); return projectEntry(full, ref, { preview: false }); });
  assert.deepEqual(seen, ['e1']);
  assert.equal(ready.messages[0].content[0].text, text);
  assert.equal(ready.messages[1].__history.truncated, true);
});

test('speculative history reads do not change focus or start a Pi', async t => {
  const file = fixture(t, [entry(0), entry(1)]);
  const manager = new SessionManager({ store: { settings: {}, sessions: [{ id: 's', environmentId: 'local', piSessionFile: file }] }, environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  manager.focus = () => assert.fail('prefetch changed focus');
  manager.ensureStarted = () => assert.fail('prefetch started Pi');
  assert.equal((await manager.historyPage('s', { prefetch: true })).messages.length, 2);
});

test('CLI history entrypoint works through symlinked deployment paths', { skip: !process.env.CI }, t => {
  const file = fixture(t, [entry(0), entry(1)]);
  const alias = join(dirname(file), 'reader-link.mjs');
  symlinkSync(resolve('agent/pidesk-history.mjs'), alias);
  const output = execFileSync(process.execPath, [alias, file, '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(output).messages.map(m => m.__entryId), ['e0', 'e1']);
});

test('refresh preserves already received text and images without keeping hidden signatures', () => {
  const original = { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'answer'.repeat(2000), textSignature: 'PRIVATE' }, { type: 'image', data: 'image'.repeat(2000), mimeType: 'image/png' }] };
  const projected = projectEntry(entry(0, null, original), {});
  assert.equal(projected.__history.truncated, true);
  const retained = retainLoadedContent([projected], [original])[0];
  assert.equal(retained.content[0].text, original.content[0].text);
  assert.equal(retained.content[1].data, original.content[1].data);
  assert.equal(retained.__history.truncated, false);
  assert.ok(!JSON.stringify(retained).includes('PRIVATE'));
  assert.equal(retainLoadedContent([projected], [])[0], projected, 'cold history remains bounded');
  assert.equal(retainLoadedContent([projected], [{ ...original, __entryId: 'different-entry' }])[0], projected);
});

test('live UI events omit replay signatures and redundant partial snapshots without changing Pi messages', () => {
  const message = { role: 'assistant', usage: { output: 5 }, content: [{ type: 'thinking', thinking: '', thinkingSignature: 'PRIVATE' }, { type: 'text', text: 'visible' }] };
  const original = JSON.stringify(message);
  const delta = historyEvent({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'visible', partial: message } });
  assert.deepEqual(delta, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'visible' } });
  const end = historyEvent({ type: 'message_end', message });
  assert.deepEqual(end.message.usage, message.usage);
  assert.equal(end.message.content[1].text, 'visible');
  assert.ok(!JSON.stringify(end).includes('PRIVATE'));
  assert.equal(historyEvent({ type: 'message_end', message: { role: 'system', content: 'prompt' } }), null);
  assert.deepEqual(historyEvent({ type: 'agent_end', messages: [message] }), { type: 'agent_end' });
  assert.deepEqual(historyEvent({ type: 'turn_end', message, toolResults: [] }), { type: 'turn_end' });
  assert.equal(JSON.stringify(message), original);
});

test('large signed history reads only a tail page and never transmits signatures or edits the file', async t => {
  const rows = Array.from({ length: 1600 }, (_, i) => entry(i, i ? `e${i - 1}` : null,
    i % 2 ? { content: [{ type: 'thinking', thinking: '', thinkingSignature: 'PRIVATE_SIGNATURE'.repeat(2000) }, { type: 'text', text: `message ${i}` }] } : {}));
  const file = fixture(t, rows), before = hash(file), size = statSync(file).size;
  const page = await readHistory(file);
  assert.ok(page.messages.length <= PAGE_MESSAGES);
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= PAGE_BYTES);
  assert.ok(page.scannedBytes < size / 8, `${page.scannedBytes} / ${size}`);
  assert.equal(page.messages.at(-1).__entryId, 'e1599');
  assert.ok(page.next);
  assert.ok(!JSON.stringify(page).includes('PRIVATE_SIGNATURE'));
  assert.equal(hash(file), before);
  console.log(`History fixture: ${size} bytes on disk, ${page.scannedBytes} scanned, ${Buffer.byteLength(JSON.stringify(page))} transmitted`);
});

test('paging follows parent links, skips abandoned branches and freezes against appends', async t => {
  const rows = Array.from({ length: 300 }, (_, i) => entry(i));
  rows.push(entry(300, 'e20'), entry(301));
  const file = fixture(t, rows);
  const first = await readHistory(file);
  assert.deepEqual(first.messages.slice(-2).map(m => m.__entryId), ['e300', 'e301']);
  assert.ok(!first.messages.some(m => m.__entryId === 'e299'));
  assert.equal(first.next, null);
  const linear = fixture(t, Array.from({ length: 301 }, (_, i) => entry(i)));
  let page = await readHistory(linear), all = page.messages;
  appendFileSync(linear, JSON.stringify(entry(301)) + '\n');
  while (page.next) { page = await readHistory(linear, { cursor: page.next }); all = [...page.messages, ...all]; }
  assert.deepEqual(all.map(m => m.__entryId), Array.from({ length: 301 }, (_, i) => `e${i}`));
  assert.equal((await readHistory(linear)).messages.at(-1).__entryId, 'e301');
});

test('oversized text, tool arguments, images and agent traces are lazy, with exact visible detail', async t => {
  const message = { role: 'assistant', timestamp: 1, usage: { input: 100, output: 20, cost: { total: 0.2 } }, content: [
    { type: 'thinking', thinking: 'visible reasoning', thinkingSignature: 'HIDDEN' },
    { type: 'text', text: '界🙂'.repeat(20000) },
    { type: 'toolCall', name: 'write', id: 'call', arguments: { path: 'owned.txt', content: 'source'.repeat(20000) }, thoughtSignature: 'HIDDEN' },
    { type: 'image', mimeType: 'image/png', data: 'ATTACHMENT'.repeat(10000) },
  ] };
  const file = fixture(t, [entry(0, null, message)]);
  const page = await readHistory(file), preview = page.messages[0];
  assert.ok(preview.__history.truncated);
  assert.deepEqual(preview.usage, message.usage);
  assert.ok(!JSON.stringify(preview).includes('ATTACHMENT'));
  const full = await readHistory(file, { ref: preview.__history.ref });
  assert.equal(full.content[1].text, message.content[1].text);
  assert.equal(full.content[2].arguments.content, message.content[2].arguments.content);
  assert.equal(full.content[3].data, message.content[3].data);
  assert.ok(!JSON.stringify(full).includes('HIDDEN'));
  assert.equal(full.__history.truncated, false);
  const trace = projectEntry(entry(2, null, { role: 'toolResult', details: { agent: { steps: [{ output: 'long trace' }] } } }), {});
  assert.equal(trace.details.agent.steps, undefined);
  assert.equal(trace.__history.truncated, true);
});

test('JSONL respects UTF-8 and Unicode separators, skips torn tails and reports broken parents', async t => {
  const text = '中🙂\u2028\u2029'.repeat(12000);
  const file = fixture(t, [entry(0, null, { content: [{ type: 'text', text }] }), entry(1)]);
  appendFileSync(file, '{"type":"message","unfinished":');
  const page = await readHistory(file);
  assert.equal(page.warning, null);
  assert.equal(page.messages.length, 2);
  const full = await readHistory(file, { ref: page.messages[0].__history.ref });
  assert.equal(full.content[0].text, text);
  const broken = fixture(t, [entry(0), '{invalid json}', entry(2, 'missing'), entry(3)]);
  const result = await readHistory(broken);
  assert.deepEqual(result.messages.map(m => m.__entryId), ['e2', 'e3']);
  assert.match(result.warning, /missing parent/);
});

test('context-edit retry omissions survive page boundaries and compactions remain visible markers', async t => {
  const rows = Array.from({ length: 130 }, (_, i) => entry(i));
  rows[1].message.stopReason = 'error'; rows[1].message.errorMessage = 'interrupted response';
  rows.push({ type: 'compaction', id: 'cp', parentId: 'e129', summary: 'Earlier work', tokensBefore: 10000 },
    { type: 'context_edit', id: 'omit', parentId: 'cp', targetId: 'e1', replacement: null });
  const file = fixture(t, rows);
  let page = await readHistory(file), messages = page.messages;
  while (page.next) { page = await readHistory(file, { cursor: page.next }); messages = [...page.messages, ...messages]; }
  assert.ok(messages.find(m => m.__entryId === 'e1').__retryOmitted);
  assert.equal(messages.at(-1).role, 'compactionSummary');
});

test('invalid or stale references never access a different file or silently read replacement history', async t => {
  const file = fixture(t, Array.from({ length: 100 }, (_, i) => entry(i)));
  const page = await readHistory(file), ref = page.messages[0].__history.ref;
  await assert.rejects(readHistory(file, { ref: { ...ref, offset: -1 } }), /Invalid history/);
  await assert.rejects(readHistory(file, { ref: { ...ref, id: 'different' } }), /History changed/);
  await assert.rejects(readHistory(file, { cursor: { ...page.next, offset: 'not a number' } }), /Invalid history/);
  writeFileSync(file, JSON.stringify(entry(0)) + '\n');
  await assert.rejects(readHistory(file, { ref }), /History changed/);
});

test('page merging preserves live output and persisted identity; prepending keeps display keys stable', () => {
  const rows = [entry(10, null), entry(11)];
  const messages = rows.map(r => projectEntry(r, {}));
  const live = { ...messages[1], content: [{ type: 'text', text: 'updated output' }] }; delete live.__entryId; delete live.__history;
  const merged = mergeHistory(messages, [live]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].__entryId, 'e11');
  assert.equal(merged[1].content[0].text, 'updated output');
  const keys = displayBlocks(fromHistory(messages)).map(b => b.key);
  const prepended = displayBlocks(fromHistory([projectEntry(entry(0), {}), ...messages])).map(b => b.key);
  assert.ok(keys.every(k => prepended.includes(k)));
  const rewound = rewindTo(fromHistory([projectEntry(entry(0), {}), ...messages]), 'e10', 'edited');
  assert.equal(rewound.messages.length, 2);
  assert.equal(rewound.messages.at(-1).__optimistic, true);
  assert.notEqual(historyKey(messages[0]), historyKey(messages[1]));
});

test('a page beginning with a tool result remains inspectable without its earlier call', async t => {
  const file = fixture(t, [entry(0, null, { role: 'toolResult', toolCallId: 'older-call', toolName: 'bash', content: [{ type: 'text', text: 'result '.repeat(5000) }] })]);
  const page = await readHistory(file);
  const blocks = displayBlocks(fromHistory(page.messages));
  assert.ok(blocks.some(block => block.kind === 'orphanResult'));
  assert.ok(!blocks.some(block => block.kind === 'deferred'));
  const full = await readHistory(file, { ref: page.messages[0].__history.ref });
  assert.equal(fromHistory([full]).tools['older-call'].fullHistory, true);
  assert.equal(full.content[0].text, 'result '.repeat(5000));
});

test('deferred tool details do not split a continuous work group or hide complete prose', () => {
  const rows = [entry(0, null, { role: 'assistant', content: [{ type: 'text', text: 'Complete answer' }, { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(10000) } }] }),
    entry(1, 'e0', { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'result'.repeat(10000) }] }),
    entry(2, 'e1', { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'a.txt' } }] })];
  const messages = rows.map(row => projectEntry(row, { id: row.id }));
  assert.deepEqual(messages[0].__history.deferredContent, [1]);
  const blocks = displayBlocks(fromHistory(messages));
  assert.equal(blocks.filter(b => b.kind === 'work').length, 1);
  assert.equal(blocks.find(b => b.kind === 'text').historyRef, null);
  assert.equal(blocks.some(b => b.kind === 'deferred'), false);
  assert.equal(fromHistory(messages).tools.c1.historyRef.id, 'e1');
});

test('tail refresh keeps the loaded reading window and never replaces full content with excerpts', () => {
  const rows = Array.from({ length: 100 }, (_, i) => projectEntry(entry(i), { id: `e${i}` }));
  const current = { messages: rows, history: { snapshot: { identity: 'same-file' }, next: { id: 'older' }, viewingOlder: true } };
  const page = { messages: rows.slice(-40), snapshot: { identity: 'same-file' }, next: { id: 'e59' } };
  const merged = mergeReloadedHistory(page, current);
  assert.equal(merged.messages.length, 100);
  assert.equal(merged.history.next.id, 'older');
  assert.equal(merged.history.viewingOlder, true);
  const temporary = { role: 'user', timestamp: 1000, content: [{ type: 'text', text: 'temporary UI fixture' }] };
  assert.equal(mergeReloadedHistory(page, { ...current, messages: [...rows, temporary] }).messages.length, 100);
  assert.equal(mergeReloadedHistory({ ...page, snapshot: { identity: 'other-file' } }, current).messages.length, 40);
});

test('a prepended tool page retains the existing work group identity', () => {
  const make = ids => displayBlocks(fromHistory(ids.map(id => ({ role: 'assistant', timestamp: id, content: [{ type: 'toolCall', name: 'read', id: `call-${id}`, arguments: { path: 'file' } }] }))));
  const previous = make([3, 4]), next = retainWorkKeys(previous, make([1, 2, 3, 4]));
  assert.equal(next.find(b => b.kind === 'work').key, previous.find(b => b.kind === 'work').key);
});

test('assistant image blocks survive history projection as displayable content', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'small-base64' };
  const blocks = displayBlocks(fromHistory([projectEntry(entry(1, null, { content: [image] }), {})]));
  assert.deepEqual(blocks.find(b => b.kind === 'image').image, image);
});

test('editing a paged message uses its id, not the ordinal or a later duplicate text', async () => {
  const record = { id: 's', cwd: '/workspace' };
  const store = { settings: {}, sessions: [record], saveSessions() {} };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  const calls = [];
  const session = { request: async (type, args) => {
    calls.push({ type, args });
    if (type === 'get_fork_messages') return { messages: [{ entryId: 'older', text: 'same text' }, { entryId: 'newer', text: 'same text' }] };
    return {};
  }, state: async () => ({ sessionFile: '/session', sessionId: 'fork' }) };
  manager.ensureStarted = async () => session; manager.prompt = async () => {};
  manager.runtimes.set('s', { streaming: false });
  await manager.editMessage('s', 'older', 'same text', 'replacement');
  assert.equal(calls.find(c => c.type === 'fork').args.entryId, 'older');
  await assert.rejects(manager.editMessage('s', 'gone', 'same text', 'replacement'), /no longer be edited/);
});

test('opening a local page does not wait for Pi startup or request get_entries', async t => {
  const file = fixture(t, Array.from({ length: 200 }, (_, i) => entry(i)));
  const manager = new SessionManager({ store: { settings: {}, sessions: [{ id: 's', environmentId: 'local', piSessionFile: file }] },
    environments: () => [{ id: 'local', kind: 'local' }], local: {} });
  manager.ensureStarted = () => new Promise(() => {});
  const page = await manager.historyPage('s');
  assert.ok(page.messages.length <= PAGE_MESSAGES);
  assert.ok(page.next);
});

test('tail refresh preserves earlier live-streamed messages from the current turn before page start', () => {
  const reloadedPrev = projectEntry(entry(0), { id: 'e0' });
  const liveTurnStart = entry(1, 'e0', { role: 'user', content: [{ type: 'text', text: 'turn 2 prompt' }] }).message;
  const liveCall = entry(2, 'e1', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.js' } }] }).message;
  const liveResult = entry(3, 'e2', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] }).message;
  const current = {
    messages: [reloadedPrev, liveTurnStart, liveCall, liveResult],
    history: { snapshot: { identity: 'same-file' }, next: null },
  };
  const page = {
    messages: [projectEntry(entry(3, 'e2', liveResult), { id: 'e3' })],
    snapshot: { identity: 'same-file' },
    next: { id: 'e2' },
  };
  const merged = mergeReloadedHistory(page, current);
  assert.equal(merged.messages.length, 4);
  const blocks = displayBlocks(fromHistory(merged.messages));
  assert.equal(blocks.some(b => b.kind === 'orphanResult'), false);
  assert.equal(blocks.filter(b => b.kind === 'user').length, 2);
});

test('readHistory never splits an assistant tool call from its tool results across a page boundary', async t => {
  const rows = [entry(0, null, { role: 'user', content: [{ type: 'text', text: 'start' }] })];
  for (let i = 1; i <= 100; i += 2) {
    rows.push(entry(i, `e${i - 1}`, { role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, { type: 'toolCall', id: `call-${i}`, name: 'read', arguments: { path: `f${i}.js` } }] }));
    rows.push(entry(i + 1, `e${i}`, { role: 'toolResult', toolCallId: `call-${i}`, toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(200) }] }));
  }
  const file = fixture(t, rows);
  const page1 = await readHistory(file);
  assert.ok(page1.next);
  assert.equal(displayBlocks(fromHistory(page1.messages)).some(b => b.kind === 'orphanResult'), false);
  const page2 = await readHistory(file, { cursor: page1.next });
  assert.equal(displayBlocks(fromHistory(mergeHistory(page2.messages, page1.messages))).some(b => b.kind === 'orphanResult'), false);
});
