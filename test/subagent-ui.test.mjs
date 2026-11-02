import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, displayBlocks, emptyTranscript, fromHistory } from '../app/renderer/src/transcript.js';
import { subagentBatch, subagentBatches, subagentElapsed, subagentSummary } from '../app/renderer/src/subagent-state.js';

const call = { type: 'toolCall', id: 'batch-1', name: 'subagent', arguments: { tasks: [{ name: 'Inspect', task: 'Read the assigned file.' }, { name: 'Review', task: 'Review only.' }] } };
const assistant = { role: 'assistant', content: [call] };
const details = { kind: 'pidesk-subagents', results: [
  { id: 'child-1', name: 'Inspect', status: 'completed', output: 'Found it', steps: [{ id: 'tool:1:read', type: 'tool', name: 'read', input: '{"path":"a.txt"}', output: 'contents', status: 'completed' }] },
  { id: 'child-2', name: 'Review', status: 'failed', error: 'not found', steps: [] },
] };
const message = { role: 'toolResult', toolName: 'subagent', toolCallId: call.id, content: [], details, isError: true };

test('delegation gets a visible standalone chat card rather than being buried in a tool group', () => {
  const t = fromHistory([assistant, message]);
  const blocks = displayBlocks(t);
  assert.equal(blocks.filter(b => b.kind === 'subagents').length, 1);
  assert.equal(blocks.find(b => b.kind === 'subagents').key, `subagents:${call.id}`);
  assert.ok(!blocks.some(b => b.kind === 'work'));
});

test('live and persisted child activity resolve to the same stable task selection', () => {
  let t = { ...emptyTranscript(), messages: [assistant] };
  const pending = subagentBatches(t)[0];
  assert.equal(pending.tasks[0].status, 'pending');
  t = applyEvent(t, { type: 'tool_execution_update', toolCallId: call.id, partialResult: { content: [], details } });
  const live = subagentBatches(t)[0];
  const saved = subagentBatches(fromHistory([assistant, message]))[0];
  assert.equal(pending.tasks[0].key, live.tasks[0].key);
  assert.deepEqual(live, saved);
  assert.equal(saved.tasks[0].steps[0].output, 'contents');
  assert.equal(saved.tasks[0].task, 'Read the assigned file.');
  assert.match(subagentSummary(saved.tasks), /1 completed.*1 failed/);
});

test('persisted completion wins over a stale running update after history reload', () => {
  const t = fromHistory([assistant, message]);
  t.tools[call.id] = { status: 'running', result: { details: { ...details, results: [{ ...details.results[0], status: 'running' }] } } };
  assert.equal(subagentBatches(t)[0].tasks[0].status, 'completed');
});

test('legacy results remain inspectable without inventing an execution trace', () => {
  const legacy = subagentBatch(call, { status: 'done', result: { details: { kind: 'pidesk-subagents', results: [{ id: 'old', name: 'Inspect', status: 'completed', output: 'Older saved answer' }] } } });
  assert.equal(legacy.tasks[0].output, 'Older saved answer');
  assert.equal(legacy.tasks[0].steps, undefined);
  assert.deepEqual(subagentBatches(undefined), []);
  assert.equal(subagentBatches(fromHistory([message]))[0].tasks[0].name, 'Inspect');
});

test('elapsed time freezes at completion and stays unknown for old tasks without an end time', () => {
  assert.equal(subagentElapsed({ status: 'running', startedAt: 100 }, 1100), 1000);
  assert.equal(subagentElapsed({ status: 'completed', startedAt: 100, runStartedAt: 300, finishedAt: 900 }, 10000), 600);
  assert.equal(subagentElapsed({ status: 'completed', startedAt: 100 }, 10000), null);
  assert.equal(subagentElapsed({ status: 'failed', startedAt: 100 }, 10000), null);
  assert.equal(subagentElapsed({ status: 'pending' }), null);
});

test('overlapping batches are independent even when child names match', () => {
  const other = { ...call, id: 'batch-2' };
  const t = fromHistory([assistant, { role: 'assistant', content: [other] }, message]);
  const batches = subagentBatches(t);
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0].tasks[0].key, batches[1].tasks[0].key);
  assert.equal(batches[1].tasks[0].status, 'pending');
});
