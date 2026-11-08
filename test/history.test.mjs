import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { PAGE_BYTES, PAGE_MESSAGES, projectEntry, readHistory } from '../agent/pidesk-history.mjs';
import { historyKey, mergeHistory, retainLoadedContent } from '../app/renderer/src/history.js';
import { displayBlocks, fromHistory, rewindTo } from '../app/renderer/src/transcript.js';
import { SessionManager } from '../app/main/session-manager.mjs';

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
  assert.ok(blocks.some(block => block.kind === 'deferred'));
  const full = await readHistory(file, { ref: page.messages[0].__history.ref });
  assert.equal(fromHistory([full]).tools['older-call'].fullHistory, true);
  assert.equal(full.content[0].text, 'result '.repeat(5000));
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
