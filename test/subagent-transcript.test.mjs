// Pure display-adapter regressions. Run in CI only; no model, renderer or filesystem I/O.
import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentTranscript } from '../app/renderer/src/subagent-transcript.js';

const task = extra => ({ key: 'batch-1:0', task: 'Inspect only the assigned file.', status: 'completed', startedAt: 100, finishedAt: 900, steps: [], ...extra });
const all = transcript => [...transcript.messages, ...(transcript.live ? [transcript.live] : [])];
const calls = transcript => all(transcript).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : []);
const texts = transcript => all(transcript).flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text));
const errors = transcript => all(transcript).map(message => message.errorMessage).filter(Boolean);
const notices = transcript => all(transcript).filter(message => message.role === 'custom');

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test('assignment is the first user message and public steps retain their observed order', () => {
  const t = subagentTranscript(task({ steps: [
    { id: 'm1', type: 'message', text: 'Inspecting the file.', status: 'completed', at: 101 },
    { id: 't1', type: 'tool', name: 'read', input: '{"path":"a.txt"}', path: 'a.txt', output: 'file contents', status: 'completed', at: 102, durationMs: 10 },
    { id: 'retry1', type: 'notice', text: 'Retry 1/2: connection reset', at: 103 },
    { id: 'm2', type: 'message', text: 'Conclusion.', status: 'completed', at: 104 },
  ] }));
  assert.deepEqual(t.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'custom', 'assistant']);
  assert.equal(t.messages[0].content, 'Inspect only the assigned file.');
  assert.deepEqual(t.messages.map(m => m.timestamp), [100, 101, 102, 103, 104]);
  assert.equal(t.messages[3].customType, 'pidesk-subagent-notice');
  assert.equal(t.messages[3].content, 'Retry 1/2: connection reset');
  const call = calls(t)[0];
  assert.deepEqual(call.arguments, { path: 'a.txt' });
  assert.deepEqual(call.__trace, { input: '{"path":"a.txt"}', status: 'completed', durationMs: 10, path: 'a.txt' });
  assert.deepEqual(t.tools[call.id].result.content, [{ type: 'text', text: 'file contents' }]);
  assert.equal(t.tools[call.id].durationMs, 10);
  assert.equal(t.live, null);
  assert.equal(t.loaded, true);
  assert.equal(t.error, null);
  assert.ok(!t.messages.some(m => m.role === 'toolResult'));
});

test('every recorded tool status is translated without losing its original value', () => {
  for (const [status, expected] of [['running', 'running'], ['completed', 'done'], ['failed', 'error'], ['cancelled', 'cancelled'], ['timed_out', 'timed_out'], ['done', 'done'], ['error', 'error']]) {
    const t = subagentTranscript(task({ steps: [{ id: 'tool', type: 'tool', name: 'bash', input: 'pwd', status }] }));
    const call = calls(t)[0];
    assert.equal(t.tools[call.id].status, expected, status);
    assert.equal(call.__trace.status, status);
    assert.deepEqual(t.tools[call.id].result.content, [], 'missing output is not an invented result');
  }
});

test('tool IDs and message timestamps survive partial updates and trace eviction', () => {
  const step = { id: 'tool:2:read-1', type: 'tool', name: 'read', input: '{"path":"a"}', at: 200, status: 'running' };
  const before = subagentTranscript(task({ status: 'running', steps: [{ id: 'm', type: 'message', text: 'Inspecting' }, step] }));
  const after = subagentTranscript(task({ omittedSteps: 1, steps: [{ ...step, output: 'actual output', status: 'completed', endedAt: 800, durationMs: 600 }] }));
  assert.equal(calls(before)[0].id, calls(after)[0].id);
  assert.equal(before.messages.at(-1).id, after.messages.at(-1).id);
  assert.equal(before.messages.at(-1).timestamp, after.messages.at(-1).timestamp);
  assert.equal(after.messages.at(-1).timestamp, 200);
  const other = subagentTranscript(task({ key: 'batch-2:0', steps: [step] }));
  assert.notEqual(calls(before)[0].id, calls(other)[0].id);
  const noTime = { ...step, at: undefined };
  assert.deepEqual(subagentTranscript(task({ steps: [noTime] })), subagentTranscript(task({ steps: [noTime] })));
  assert.equal(subagentTranscript(task({ steps: [noTime] })).messages.at(-1).timestamp, null);
});

test('only the final running public message becomes live and becomes history with the same ID', () => {
  const first = { id: 'm1', type: 'message', status: 'completed', text: 'First', at: 101 };
  const partial = { id: 'm2', type: 'message', status: 'running', text: 'Part', at: 102 };
  const t = subagentTranscript(task({ status: 'running', output: 'Part', steps: [first, partial] }));
  assert.equal(t.messages.length, 2);
  assert.equal(t.live.content[0].text, 'Part');
  assert.equal(t.live.stopReason, 'pending');
  const done = subagentTranscript(task({ output: 'Partial answer', steps: [first, { ...partial, status: 'completed', text: 'Partial answer' }] }));
  assert.equal(done.live, null);
  assert.equal(t.live.id, done.messages.at(-1).id);
  assert.equal(t.live.timestamp, done.messages.at(-1).timestamp);
  const followedByTool = subagentTranscript(task({ status: 'running', steps: [partial, { id: 't', type: 'tool', name: 'bash', status: 'running', input: 'pwd' }] }));
  assert.equal(followedByTool.live, null);
  assert.equal(followedByTool.messages[1].content[0].text, 'Part');
});

test('legacy output-only tasks disclose missing traces without inventing steps', () => {
  for (const steps of [undefined, null, 'not an array']) {
    const t = subagentTranscript(task({ steps, output: 'Older saved answer' }));
    assert.equal(t.messages[0].role, 'user');
    assert.match(notices(t)[0].content, /older task.*not a detailed execution trace/);
    assert.equal(t.messages.at(-1).content[0].text, 'Older saved answer');
    assert.deepEqual(calls(t), []);
    assert.deepEqual(t.tools, {});
  }
  const pending = subagentTranscript(task({ status: 'running', steps: undefined }));
  assert.match(notices(pending)[0].content, /Waiting for live execution details/);
});

test('empty, missing, malformed and unknown steps never turn into invented tool calls', () => {
  assert.match(notices(subagentTranscript(task()))[0].content, /No execution steps/);
  assert.match(notices(subagentTranscript(task({ status: 'queued' })))[0].content, /available subagent slot/);
  assert.match(notices(subagentTranscript(task({ status: 'running' })))[0].content, /Waiting for the first action/);
  const t = subagentTranscript(task({ steps: [null, false, 'invalid', {}, { type: 'thinking', thinking: 'DO_NOT_RENDER' }, { type: 'provider', payload: 'DO_NOT_RENDER' }] }));
  assert.deepEqual(calls(t), []);
  assert.ok(!JSON.stringify(t).includes('DO_NOT_RENDER'));
  assert.equal(subagentTranscript().messages[0].content, '');
  assert.equal(subagentTranscript(null).error, null);
});

test('bounded history has an explicit omission notice and retains bounded public text verbatim', () => {
  const raw = 'A partial answer\n… [truncated]';
  const t = subagentTranscript(task({ omittedSteps: 7, output: raw, steps: [{ id: 'last', type: 'message', text: raw, status: 'completed' }] }));
  assert.equal(t.messages[1].customType, 'pidesk-subagent-notice');
  assert.match(t.messages[1].content, /^7 earlier records omitted/);
  assert.equal(texts(t).filter(value => value === raw).length, 1);
  const old = subagentTranscript(task({ omittedSteps: 1, steps: undefined, output: raw }));
  assert.equal(notices(old).length, 2);
  assert.match(notices(old)[1].content, /^1 earlier record omitted/);
  const noID = { type: 'tool', name: 'read', status: 'completed', path: 'a' };
  const before = subagentTranscript(task({ steps: [{ type: 'notice', text: 'Before' }, noID] }));
  const after = subagentTranscript(task({ omittedSteps: 1, steps: [noID] }));
  assert.equal(calls(before)[0].id, calls(after)[0].id);
});

test('output and errors already present in the trace are not appended a second time', () => {
  const t = subagentTranscript(task({ status: 'failed', output: 'Observed text', error: 'Actual failure', steps: [
    { id: 'm', type: 'message', text: 'Observed text', error: 'Actual failure', status: 'failed' },
  ] }));
  assert.equal(texts(t).filter(value => value === 'Observed text').length, 1);
  assert.deepEqual(errors(t), ['Actual failure']);
  assert.equal(t.messages.length, 2);
  const toolFailure = subagentTranscript(task({ status: 'failed', error: 'Actual failure', steps: [{ id: 't', type: 'tool', name: 'bash', status: 'failed', input: 'false', output: 'Actual failure' }] }));
  assert.deepEqual(errors(toolFailure), []);
  assert.equal(toolFailure.messages.length, 2);
  const different = subagentTranscript(task({ output: 'short', steps: [{ id: 'm', type: 'message', text: 'A short explanation' }] }));
  assert.equal(different.messages.at(-1).content[0].text, 'short', 'a substring is not a duplicate');
});

test('terminal failures appear after fallback output and never as transcript-level errors', () => {
  for (const status of ['failed', 'timed_out']) {
    const t = subagentTranscript(task({ status, output: 'Partial result', error: 'Terminal failure', steps: [] }));
    assert.equal(t.error, null);
    assert.equal(t.messages.at(-2).content[0].text, 'Partial result');
    assert.equal(t.messages.at(-1).errorMessage, 'Terminal failure');
    assert.equal(t.messages.at(-1).stopReason, 'error');
  }
  const t = subagentTranscript(task({ status: 'failed', output: 'Partial result', error: 'Cleanup failed', steps: [{ id: 'm', type: 'message', text: 'Partial result', error: 'Request failed' }] }));
  assert.deepEqual(errors(t), ['Request failed', 'Cleanup failed']);
  const statusOnly = subagentTranscript(task({ status: 'timed_out' }));
  assert.equal(statusOnly.messages.at(-1).errorMessage, 'Subagent timed out.');
});

test('cancellation is a neutral notice and preserves its public reason', () => {
  const t = subagentTranscript(task({ status: 'cancelled', error: 'User stopped this task', steps: [{ id: 'm', type: 'message', text: 'Partial', status: 'failed', error: 'User stopped this task' }] }));
  assert.equal(t.error, null);
  assert.deepEqual(errors(t), []);
  assert.equal(notices(t).length, 1);
  assert.equal(notices(t)[0].content, 'User stopped this task');
  assert.equal(t.messages.at(-1).role, 'custom');
  const aborted = subagentTranscript(task({ status: 'cancelled', error: 'This operation was aborted', steps: [{ id: 'm', type: 'message', status: 'failed', error: 'This operation was aborted' }] }));
  assert.deepEqual(errors(aborted), []);
  assert.equal(notices(aborted).length, 1);
  assert.equal(notices(subagentTranscript(task({ status: 'cancelled' }))).at(-1).content, 'Subagent cancelled.');
});

test('bash uses the recorded command and distinct summary, never parsing command text as JSON', () => {
  for (const [summary, description] of [['Inspect working directory', 'Inspect working directory'], ['bash', undefined], [undefined, undefined]]) {
    const input = '{"command":"not a reconstructed command"}';
    const t = subagentTranscript(task({ steps: [{ id: 't', type: 'tool', name: 'bash', input, summary, status: 'completed', output: '' }] }));
    const call = calls(t)[0];
    assert.equal(call.arguments.command, input);
    assert.equal(call.arguments.description, description);
    assert.equal(call.__trace.input, input);
    assert.deepEqual(t.tools[call.id].result.content, [{ type: 'text', text: '' }]);
  }
});

test('malformed, truncated and non-object JSON remains raw trace input, with only the observed path as fallback', () => {
  for (const input of ['{"path":"a","edits":[…', '{broken', '[{"path":"other"}]', 'null', '42', '"a string"', '']) {
    const t = subagentTranscript(task({ steps: [{ id: 't', type: 'tool', name: 'edit', input, path: 'a.txt', status: 'completed' }] }));
    const call = calls(t)[0];
    assert.deepEqual(call.arguments, { path: 'a.txt' });
    assert.equal(call.__trace.input, input);
    assert.equal(call.arguments.edits, undefined);
    assert.deepEqual(t.tools[call.id].result.content, []);
  }
  const noPath = subagentTranscript(task({ steps: [{ id: 't', type: 'tool', name: 'write', input: '{truncated', status: 'completed' }] }));
  assert.deepEqual(calls(noPath)[0].arguments, {});
  const valid = '{"path":"a","edits":[{"oldText":"before","newText":"after"}]}';
  const t = subagentTranscript(task({ steps: [{ id: 't', type: 'tool', name: 'edit', input: valid, status: 'completed' }] }));
  assert.deepEqual(calls(t)[0].arguments, JSON.parse(valid));
  assert.equal(calls(t)[0].__trace.input, valid);
});

test('tool step errors survive separately without being fabricated into output', () => {
  const t = subagentTranscript(task({ steps: [{ id: 't', type: 'tool', name: 'read', input: '{}', output: 'Observed output', error: 'Observed error', status: 'failed' }] }));
  assert.deepEqual(errors(t), ['Observed error']);
  assert.deepEqual(t.tools[calls(t)[0].id].result.content, [{ type: 'text', text: 'Observed output' }]);
  assert.equal(t.messages.at(-1).errorMessage, 'Observed error');
});

test('projection does not mutate source data or expose provider payloads, hidden reasoning or usage', () => {
  const source = deepFreeze(task({ usage: { reasoning: 50, totalTokens: 100 }, provider: 'PRIVATE_PROVIDER', messages: [{ content: 'PRIVATE_PAYLOAD' }], steps: [
    { id: 'm', type: 'message', text: 'Public text', thinking: 'PRIVATE_THINKING', usage: { reasoning: 50 }, content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }] },
    { id: 't', type: 'tool', name: 'edit', input: '{"path":"a","edits":[]}', status: 'completed', output: 'Public output', details: { credentials: 'PRIVATE_CREDENTIALS' } },
  ] }));
  const snapshot = JSON.stringify(source);
  const t = subagentTranscript(source);
  assert.equal(JSON.stringify(source), snapshot);
  assert.ok(!JSON.stringify(t).includes('PRIVATE_'));
  assert.ok(!all(t).some(message => message.usage || message.provider || message.model));
  calls(t)[0].arguments.edits.push({ oldText: 'a', newText: 'b' });
  t.tools[calls(t)[0].id].result.content[0].text = 'Changed view';
  assert.equal(JSON.stringify(source), snapshot);
});
