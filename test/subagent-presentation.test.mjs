import assert from 'node:assert/strict';
import test from 'node:test';
import { isSubagentFinished, subagentHistoryId, visibleSubagentBatches, visibleSubagentTasks } from '../app/renderer/src/subagent-state.js';
import { subagentTranscript } from '../app/renderer/src/subagent-transcript.js';
import { changesOf, displayBlocks, toolSummary } from '../app/renderer/src/transcript.js';

const task = (id, index, status) => ({ id, index, key: `batch:${index}`, status, name: id });

test('cleared tasks disappear from every view without changing original task indices', () => {
  const tasks = [task('first', 0, 'completed'), task('second', 1, 'failed')];
  const before = structuredClone(tasks);
  const batches = [{ callId: 'batch', tasks }];
  const visible = visibleSubagentBatches(batches, [subagentHistoryId(tasks[0])]);
  assert.deepEqual(visible[0].tasks, [tasks[1]]);
  assert.equal(visible[0].tasks[0].index, 1);
  assert.equal(visible[0].tasks.find(t => t.index === 1).id, 'second');
  assert.deepEqual(visibleSubagentBatches(batches, tasks.map(subagentHistoryId)), []);
  assert.deepEqual(tasks, before);
});

test('active and unknown states stay visible even if their IDs occur in clearing metadata', () => {
  for (const status of ['pending', 'queued', 'running', 'retrying', undefined, 'future-state']) {
    const active = task('active', 0, status);
    assert.equal(isSubagentFinished(active), false);
    assert.deepEqual(visibleSubagentTasks([active], [subagentHistoryId(active)]), [active]);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'timed_out']) assert.equal(isSubagentFinished(task('old', 0, status)), true);
});

test('clearing a mixed batch keeps running siblings and does not hide later results implicitly', () => {
  const done = task('done', 0, 'completed'), running = task('running', 1, 'running');
  const ids = [subagentHistoryId(done)];
  assert.deepEqual(visibleSubagentTasks([done, running], ids), [running]);
  const finishedLater = { ...running, status: 'completed' };
  assert.deepEqual(visibleSubagentTasks([done, finishedLater], ids), [finishedLater]);
  assert.notEqual(subagentHistoryId(done), subagentHistoryId(running));
});

test('legacy tasks use their stable call/index identity and separate batches do not collide', () => {
  const legacy = { key: 'one:0', index: 0, status: 'failed' };
  const other = { ...legacy, key: 'two:0' };
  assert.deepEqual(visibleSubagentTasks([legacy, other], [subagentHistoryId(legacy)]), [other]);
});

test('skipped truncated tool calls are neither running nor described as executed edits', () => {
  const t = subagentTranscript({ key: 'length:0', task: 'Write safely', status: 'failed', failureKind: 'output_limit', steps: [
    { id: 'write', type: 'tool', name: 'write', status: 'skipped', output: 'Tool call was not executed: output token limit.' },
    { id: 'edit', type: 'tool', name: 'edit', status: 'skipped', output: 'Tool call was not executed: output token limit.' },
  ] });
  const calls = t.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : []);
  assert.ok(calls.every(call => t.tools[call.id].status === 'skipped'));
  assert.equal(toolSummary(calls), '2 tool calls not executed');
  assert.deepEqual(changesOf(t.messages, t.tools), []);
});

test('public trace notices render in order, and bounded trace arguments never manufacture diffs', () => {
  const t = subagentTranscript({ key: 'one:0', task: 'Inspect this change', status: 'completed', omittedSteps: 3, steps: [
    { id: 'write', type: 'tool', name: 'write', status: 'completed', path: 'a.txt', input: '{"path":"a.txt","content":"partial"}', output: 'written' },
    { id: 'edit', type: 'tool', name: 'edit', status: 'completed', path: 'a.txt', input: '{"path":"a.txt","edits": [Truncated]', output: 'edited' },
    { id: 'm', type: 'message', status: 'completed', text: 'Finished.' },
  ] });
  assert.deepEqual(changesOf(t.messages, t.tools), []);
  const blocks = displayBlocks(t);
  assert.deepEqual(blocks.map(block => block.kind), ['user', 'notice', 'work', 'text']);
  assert.match(blocks[1].text, /3 earlier records omitted/);
  assert.equal(blocks[2].items[0].calls.length, 2);
  assert.equal(blocks.at(-1).text, 'Finished.');
});
