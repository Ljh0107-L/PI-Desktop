// Progress is model-authored visible content, not an extra assistant message or a folded command.
import assert from 'node:assert/strict';
import test from 'node:test';
import { displayBlocks, fromHistory, ultraProgress, usageOf } from '../app/renderer/src/transcript.js';
import { projectEntry } from '../agent/pidesk-history.mjs';

const call = { type: 'toolCall', id: 'progress-1', name: 'report_progress', arguments: { done: 'Checked the parser', next: 'Run the tests', assumptions: 'Keep the format' } };
const report = { at: 10, done: 'Checked the parser', next: 'Run the tests', notes: 'Keep the format' };
const assistant = { role: 'assistant', provider: 'fixture', model: 'model', api: 'openai-completions', timestamp: 1, stopReason: 'toolUse',
  usage: { input: 20, output: 30 }, content: [{ type: 'thinking', thinking: 'fixture thought' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'parser.js' } }, call] };
const result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'Progress noted and shown to the user.' }], details: { kind: 'pidesk-ultra-progress', progress: report }, timestamp: 2 };

test('successful reports have their own visible block and preserve original messages and usage', () => {
  const messages = [assistant, result], original = JSON.stringify(messages);
  const transcript = fromHistory(messages), blocks = displayBlocks(transcript);
  assert.deepEqual(blocks.map(b => b.kind), ['work', 'progress', 'usage']);
  assert.equal(blocks[0].items.flatMap(i => i.calls ?? []).some(c => c.name === 'report_progress'), false);
  assert.equal(blocks[1].key, 'progress:progress-1');
  assert.deepEqual(ultraProgress(call, transcript.tools[call.id]), { done: report.done, next: report.next, notes: report.notes });
  assert.equal(usageOf(messages).output, 30); assert.equal(usageOf(messages).calls, 1);
  assert.equal(JSON.stringify(messages), original);
});

test('streaming, rejected and failed reports never masquerade as completed milestones', () => {
  const tool = { status: 'done', result: { content: result.content, details: result.details } };
  for (const status of ['pending', 'running', 'error', 'cancelled', 'timed_out']) assert.equal(ultraProgress(call, { ...tool, status }), null);
  assert.equal(ultraProgress({ ...call, __trace: { status: 'skipped' } }, tool), null);
  assert.equal(ultraProgress(call, { status: 'done', result: { content: [{ type: 'text', text: 'Ultra mode has no task in progress.' }] } }), null);
  assert.deepEqual(ultraProgress({ ...call, arguments: { done: 'Not the recorded value' } }, tool), { done: report.done, next: report.next, notes: report.notes });
});

test('older progress tool results remain readable and bounded without rewriting history', () => {
  const legacy = { status: 'done', result: { content: [{ type: 'text', text: 'Progress noted. Keep going.' }] } };
  assert.deepEqual(ultraProgress(call, legacy), { done: report.done, next: report.next, notes: report.notes });
  const long = ultraProgress({ ...call, arguments: { done: 'x'.repeat(3000), next: 'y'.repeat(3000), assumptions: 'z'.repeat(3000) } }, legacy);
  assert.equal(long.done.length, 1200); assert.equal(long.next.length, 600); assert.equal(long.notes.length, 600);
});

test('a projected result shows its saved checkpoint across page boundaries exactly once', () => {
  const projected = projectEntry({ type: 'message', id: 'result-entry', message: result }, { offset: 0, length: 100 });
  const orphan = fromHistory([projected]);
  assert.deepEqual(displayBlocks(orphan).map(b => b.kind), ['progress']);
  assert.equal(ultraProgress({ id: call.id, name: call.name }, orphan.tools[call.id]).done, report.done);
  const joined = fromHistory([assistant, projected]);
  assert.equal(displayBlocks(joined).filter(b => b.kind === 'progress').length, 1);
  assert.equal(displayBlocks(joined).find(b => b.kind === 'progress').key, displayBlocks(orphan)[0].key);
});

test('ordinary commentary stays between tool groups rather than being folded', () => {
  const m = { ...assistant, content: [{ type: 'toolCall', id: 'before', name: 'read', arguments: {} },
    { type: 'text', text: 'The check failed; I am trying the smaller reproduction.' }, { type: 'toolCall', id: 'after', name: 'bash', arguments: {} }] };
  assert.deepEqual(displayBlocks(fromHistory([m])).map(b => b.kind), ['work', 'text', 'work', 'usage']);
});
