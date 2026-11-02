// CI-only deterministic regressions: actual Agent scheduling, no provider/network/process calls.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { childBashParameters, createSubagentTool, LENGTH_RECOVERY_PROMPT, pruneLengthTurn, subagentResponseDiagnostics } from '../agent/pidesk-subagent.mjs';

const model = { id: 'mock-qwen', provider: 'mock', api: 'openai-completions', name: 'Mock', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = (output = 5, reasoning) => ({ input: 10, output, ...(reasoning === undefined ? {} : { reasoning }), cacheRead: 2, cacheWrite: 0, totalTokens: 12 + output, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
const reply = (stopReason = 'stop', content = [{ type: 'text', text: 'Done' }], extra = {}) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason, usage: usage(), ...extra });
const length = (calls = []) => reply('length', [{ type: 'thinking', thinking: 'HIDDEN_THINKING', thinkingSignature: 'PRIVATE_SIGNATURE' }, ...calls], { usage: usage(32768, 32768), rawStopReason: 'PRIVATE_RAW_STOP', diagnostics: [{ secret: 'PRIVATE_DIAGNOSTICS' }] });
const call = (name, args, id = 'reused-id') => ({ type: 'toolCall', id, name, arguments: args });
const transient = () => reply('error', [], { errorMessage: 'terminated' });
const text = message => typeof message.content === 'string' ? message.content : message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const ok = { result: { content: [{ type: 'text', text: 'Executed once' }], details: {} }, isError: false };
const bashSchema = (timeout = Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }))) => Type.Object({ command: Type.String(), description: Type.Optional(Type.String()), timeout }, { additionalProperties: false });
function fixture(produce) {
  const requests = [], executions = [];
  const ctx = {
    model, thinkingLevel: 'high', getSystemPrompt: () => 'Original system rules. Do not run local tests.',
    sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Only assigned files. No network or GUI.' } }] },
    tools: [
      { name: 'write', parameters: Type.Object({ path: Type.String(), content: Type.String() }), description: 'write' },
      { name: 'edit', parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }), description: 'edit' },
      { name: 'bash', parameters: bashSchema(), description: 'bash' },
    ],
    executeTool: async (name, args, options) => { executions.push({ name, args, options }); return structuredClone(ok); },
    modelRegistry: { streamSimple(m, transcript, options) {
      const request = { model: m, transcript: { ...transcript, messages: [...transcript.messages] }, options };
      requests.push(request);
      const stream = new AssistantMessageEventStream();
      Promise.resolve().then(() => produce(request, requests.length)).then(message => {
        stream.push(['error', 'aborted'].includes(message.stopReason) ? { type: 'error', reason: message.stopReason, error: message } : { type: 'done', reason: message.stopReason, message });
      }, error => stream.push({ type: 'error', reason: 'aborted', error: reply('aborted', [], { errorMessage: error.message }) })).finally(() => stream.end());
      return stream;
    } },
  };
  return { ctx, requests, executions };
}
const run = (f, options = {}, signal, update, controller = createSubagentTool(options)) => controller.tool.execute('parent', { tasks: [{ name: 'Owned task', task: 'Implement only owned.txt incrementally; do not run local tests.' }], context: 'Keep all original constraints.' }, signal, update, f.ctx);
const child = result => result.details.results[0];

function assertRecoveryRequest(request) {
  assert.equal(text(request.transcript.messages.at(-1)), LENGTH_RECOVERY_PROMPT, 'must use explicit user recovery, not natural tool continuation');
  assert.equal(request.transcript.messages.at(-1).role, 'user');
  assert.ok(JSON.stringify(request.transcript.messages).includes('Only assigned files'));
  assert.equal(request.model, model);
  assert.equal(request.model.maxTokens, 32768);
  assert.equal(request.model.reasoning, false);
  assert.equal(request.options.reasoning, 'high');
}

test('hidden-only length gets one explicit recovery, costs and notices survive success without hidden metadata', async () => {
  const first = length();
  const f = fixture(async (request, n) => {
    if (n === 1) return first;
    assertRecoveryRequest(request);
    assert.ok(!request.transcript.messages.includes(first));
    return reply();
  });
  const result = await run(f);
  const r = child(result);
  assert.equal(result.isError, false);
  assert.equal(f.requests.length, 2);
  assert.equal(r.status, 'completed');
  assert.equal(r.stopReason, 'stop');
  assert.equal(r.failureKind, undefined);
  assert.equal(r.lengthRecoveries, 1);
  assert.equal(r.retries, 0);
  assert.equal(r.usage.output, 32773);
  assert.equal(r.usage.reasoning, 32768);
  assert.equal(result.usage.totalTokens, 32797);
  assert.equal(result.usage.cost.total, 0.6);
  assert.ok(r.steps.some(s => s.type === 'message' && s.status === 'failed' && /No public answer/.test(s.error)));
  assert.ok(r.steps.some(s => s.type === 'notice' && /recovery 1\/1/.test(s.text)));
  assert.deepEqual(r.lastResponse, { publicTextPresent: true, skippedToolCalls: 0, outputTokens: 5, configuredMaxTokens: 32768 });
  const persisted = JSON.stringify(result);
  for (const hidden of ['HIDDEN_THINKING', 'PRIVATE_SIGNATURE', 'PRIVATE_RAW_STOP', 'PRIVATE_DIAGNOSTICS']) assert.ok(!persisted.includes(hidden));
});

test('clipped write/edit are skipped, exact earlier successful pair survives reused tool IDs, nothing is replayed', async () => {
  const successful = reply('toolUse', [call('write', { path: 'owned.txt', content: 'earlier complete write' })]);
  const clipped = length([
    call('write', { path: 'not-written.txt', content: 'looks complete but unsafe' }),
    call('edit', { path: 'owned.txt', oldText: 'earlier', newText: 'salvaged truncated edit' }, 'edit-id'),
  ]);
  let earlierResult;
  const f = fixture(async (request, n) => {
    if (n === 1) return successful;
    if (n === 2) { earlierResult = request.transcript.messages.at(-1); return clipped; }
    assert.equal(n, 3);
    assertRecoveryRequest(request);
    assert.ok(request.transcript.messages.includes(successful));
    assert.ok(request.transcript.messages.includes(earlierResult));
    assert.equal(request.transcript.messages.filter(m => m.role === 'toolResult').length, 1);
    assert.ok(!request.transcript.messages.includes(clipped));
    assert.ok(!JSON.stringify(request.transcript.messages).includes('salvaged truncated edit'));
    return reply();
  });
  const result = await run(f);
  const r = child(result);
  assert.equal(result.isError, false);
  assert.equal(f.executions.length, 1);
  assert.deepEqual(r.files, [{ path: 'owned.txt', tool: 'write' }]);
  assert.equal(r.toolCalls, 3, 'attempt count includes synthetic skipped calls');
  assert.equal(r.skippedToolCalls, 2);
  const skipped = r.steps.filter(s => s.status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every(s => /not executed/i.test(s.output) && !s.input && !s.path));
});

test('suffix pruning validates references, source order and errors, not global tool IDs', () => {
  const prior = reply('toolUse', [call('write', { path: 'a', content: 'a' })]);
  const priorResult = { role: 'toolResult', toolCallId: 'reused-id', toolName: 'write', isError: false };
  const last = length([call('write', {}), call('edit', {}, 'second')]);
  const skipped = [{ role: 'toolResult', toolCallId: 'reused-id', toolName: 'write', isError: true }, { role: 'toolResult', toolCallId: 'second', toolName: 'edit', isError: true }];
  const messages = [prior, priorResult, last, ...skipped];
  const turn = { message: last, toolResults: skipped };
  const prefix = pruneLengthTurn(messages, last, turn);
  assert.equal(prefix[0], prior); assert.equal(prefix[1], priorResult);
  assert.equal(messages.length, 5, 'helper must not mutate input');
  for (const [state, ended] of [
    [messages, { ...turn, message: structuredClone(last) }],
    [[prior, priorResult, last, ...structuredClone(skipped)], turn],
    [[prior, priorResult, last, ...skipped.toReversed()], turn],
    [[...messages, { role: 'user', content: 'unexpected' }], turn],
    [messages, { message: last, toolResults: [] }],
  ]) assert.throws(() => pruneLengthTurn(state, last, ended), /cannot safely recover/);
  skipped[0].isError = false;
  assert.throws(() => pruneLengthTurn(messages, last, turn), /cannot safely recover/);
});

for (const withTools of [false, true]) test(`second length is actionable output_limit, no extra requests (tools=${withTools})`, async () => {
  const f = fixture(async () => length(withTools ? [call('write', { path: 'never.txt', content: 'partial' })] : []));
  const result = await run(f);
  const r = child(result);
  assert.equal(f.requests.length, 2);
  assert.equal(f.executions.length, 0);
  assert.equal(r.status, 'failed');
  assert.equal(r.failureKind, 'output_limit');
  assert.equal(r.stopReason, 'length');
  assert.equal(r.lengthRecoveries, 1);
  assert.equal(r.lastResponse.outputTokens, 32768);
  assert.equal(r.lastResponse.reasoningTokens, 32768);
  assert.equal(r.lastResponse.configuredMaxTokens, 32768);
  assert.equal(r.lastResponse.reasoningConfigurationMismatch, true);
  assert.equal(r.skippedToolCalls, withTools ? 2 : 0);
  assert.match(r.error, /Output token limit reached again after one recovery/);
  assert.match(r.error, /including 32768 reasoning tokens; configured cap: 32768/);
  assert.match(r.error, /model.reasoning is configured false/);
  assert.match(r.error, /Split the remaining task/);
  assert.doesNotMatch(r.error, /crash|30KB|turn limit/);
});

test('diagnostics only report evidenced numeric fields and no provider payloads', () => {
  const diagnostic = subagentResponseDiagnostics(reply('length', [], { usage: { output: NaN, reasoning: undefined }, diagnostics: [{ payload: 'secret' }] }), { maxTokens: Infinity, reasoning: false });
  assert.deepEqual(diagnostic, { publicTextPresent: false, skippedToolCalls: 0 });
  assert.equal(subagentResponseDiagnostics(length(), { ...model, reasoning: true }).reasoningConfigurationMismatch, undefined);
});

for (const sequence of [
  ['length', 'error', 'length'],
  ['error', 'length', 'stop'],
  ['error', 'error', 'length', 'error'],
  ['length', 'error', 'error', 'error'],
]) test(`independent lifetime recovery/retry budgets: ${sequence.join(' -> ')}`, async () => {
  const f = fixture(async (_request, n) => {
    assert.ok(n <= sequence.length, 'no extra automatic request');
    return sequence[n - 1] === 'length' ? length() : sequence[n - 1] === 'error' ? transient() : reply();
  });
  const result = await run(f, { retryDelayMs: 1 });
  const r = child(result);
  assert.equal(f.requests.length, sequence.length);
  assert.equal(r.lengthRecoveries, 1);
  assert.equal(r.retries, Math.min(sequence.filter(s => s === 'error').length, 2));
  assert.equal(r.usage.totalTokens, sequence.reduce((sum, s) => sum + (s === 'length' ? 32780 : 17), 0));
  assert.equal(r.failureKind, sequence.at(-1) === 'stop' ? undefined : sequence.at(-1) === 'length' ? 'output_limit' : 'provider_error');
});

for (const when of ['before response', 'recovery notice', 'during recovery']) test(`parent cancellation ${when} prevents extra recovery work`, async () => {
  const parent = new AbortController();
  const f = fixture(async (request, n) => {
    if (when === 'before response') parent.abort(new Error('User stopped'));
    if (n === 2) {
      parent.abort(new Error('User stopped'));
      await sleep(10000, undefined, { signal: request.options.signal });
    }
    return length();
  });
  const result = await run(f, {}, parent.signal, update => {
    if (when === 'recovery notice' && child(update).lengthRecoveries === 1) parent.abort(new Error('User stopped'));
  });
  assert.equal(f.requests.length, when === 'during recovery' ? 2 : 1);
  assert.equal(child(result).status, 'cancelled');
  assert.equal(child(result).failureKind, 'cancelled');
  assert.equal(child(result).lengthRecoveries, when === 'before response' ? 0 : 1);
});

for (const duringRecovery of [false, true]) test(`batch deadline wins ${duringRecovery ? 'during' : 'before'} recovery`, async () => {
  const f = fixture(async (request, n) => {
    if (!duringRecovery || n === 2) {
      try { await sleep(10000, undefined, { signal: request.options.signal }); }
      catch { return length(); }
    }
    return length();
  });
  const result = await run(f, { defaultTimeoutMs: 80 });
  assert.equal(f.requests.length, duringRecovery ? 2 : 1);
  assert.equal(child(result).status, 'timed_out');
  assert.equal(child(result).failureKind, 'batch_timeout');
  assert.match(child(result).error, /waiting on model/);
  assert.equal(child(result).lengthRecoveries, duringRecovery ? 1 : 0);
  assert.ok(f.requests.every(r => r.options.timeoutMs === 80));
});

test('cancel during transport backoff after length prevents another request', async () => {
  const parent = new AbortController();
  const f = fixture(async (_request, n) => n === 1 ? length() : transient());
  const result = await run(f, { retryDelayMs: 1000 }, parent.signal, update => {
    if (child(update).retries === 1) parent.abort(new Error('Stop retry'));
  });
  assert.equal(f.requests.length, 2);
  assert.equal(child(result).lengthRecoveries, 1);
  assert.equal(child(result).retries, 1);
  assert.equal(child(result).failureKind, 'cancelled');
});

for (const timeout of [undefined, 7, 600, 0, -1]) test(`bash omitted default versus preserved explicit timeout ${timeout}`, async () => {
  const args = { command: 'bounded command', ...(timeout === undefined ? {} : { timeout }) };
  const f = fixture(async (_request, n) => n === 1 ? reply('toolUse', [call('bash', args)]) : reply());
  const originalSchema = f.ctx.tools[2].parameters;
  const serialized = JSON.stringify(originalSchema);
  await run(f);
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].args.timeout, timeout === undefined ? 120 : timeout);
  assert.equal(args.timeout, timeout, 'caller arguments are unchanged');
  assert.equal(JSON.stringify(originalSchema), serialized);
  assert.equal(f.ctx.tools[2].parameters, originalSchema);
  const declared = f.requests[0].transcript.messages[0].toolsAdded.find(t => t.name === 'bash').parameters;
  assert.match(declared.properties.timeout.description, /default 120 seconds/);
  assert.equal(declared.additionalProperties, false);
});

test('explicit invalid timeout null is rejected, not silently defaulted', async () => {
  const f = fixture(async (_request, n) => n === 1 ? reply('toolUse', [call('bash', { command: 'test', timeout: null })]) : reply());
  await run(f);
  assert.equal(f.executions.length, 0);
  assert.ok(f.requests[1].transcript.messages.some(m => m.role === 'toolResult' && m.isError));
});

const incompatible = [
  Type.Object({ command: Type.String() }, { additionalProperties: false }),
  bashSchema(Type.Number({ description: 'Timeout in seconds' })),
  bashSchema(Type.Optional(Type.String({ description: 'Timeout in seconds' }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in milliseconds' }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', maximum: 60 }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', minimum: 121 }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', exclusiveMaximum: 120 }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', multipleOf: 7 }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', enum: [5, 10] }))),
  bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', const: 5 }))),
  { ...bashSchema(), dependentRequired: { timeout: ['other'] } },
  { ...bashSchema(), allOf: [{ properties: { timeout: { maximum: 60 } } }] },
];
for (const [index, parameters] of incompatible.entries()) test(`unsupported/required bash schema ${index} receives no injected argument`, async () => {
  assert.equal(childBashParameters({ name: 'bash', parameters }), parameters);
  const f = fixture(async (_request, n) => n === 1 ? reply('toolUse', [call('bash', { command: 'test' })]) : reply());
  f.ctx.tools[2].parameters = parameters;
  await run(f);
  assert.ok(f.executions.every(e => !Object.hasOwn(e.args, 'timeout')));
});

test('compatible numeric constraints and parent optional metadata survive child schema copy', () => {
  const parameters = bashSchema(Type.Optional(Type.Number({ description: 'Timeout in seconds', minimum: 1, maximum: 900, multipleOf: 1, enum: [120, 600] })));
  const copied = childBashParameters({ name: 'bash', parameters });
  assert.notEqual(copied, parameters);
  assert.equal(copied.required, parameters.required);
  assert.equal(copied.properties.command, parameters.properties.command);
  assert.deepEqual({ ...copied.properties.timeout, description: parameters.properties.timeout.description }, parameters.properties.timeout);
  assert.equal(childBashParameters({ name: 'custom', parameters }), parameters);
});

test('tool-local timeout is a failed tool result, not a batch timeout', async () => {
  const f = fixture(async (_request, n) => n === 1 ? reply('toolUse', [call('bash', { command: 'bounded discovery' })]) : reply());
  f.ctx.executeTool = async (_name, args) => {
    assert.equal(args.timeout, 120);
    return { result: { content: [{ type: 'text', text: 'Command timed out after 120 seconds' }], details: {} }, isError: true };
  };
  const result = await run(f);
  assert.equal(child(result).status, 'completed');
  assert.equal(child(result).failureKind, undefined);
  assert.ok(child(result).steps.some(s => s.type === 'tool' && s.status === 'failed'));
});

test('batch deadline identifies blocked tool with clipped safe summary, even after cleanup settles', async () => {
  const f = fixture(async (_request, n) => n === 1 ? reply('toolUse', [call('bash', { command: 'RAW_SECRET_COMMAND', description: 'Scoped discovery token=SECRET https://secret.example ' + 'x'.repeat(500), timeout: 600 })]) : reply());
  let settled = false;
  f.ctx.executeTool = async (_name, args, options) => {
    assert.equal(args.timeout, 600);
    try { await sleep(10000, undefined, { signal: options.signal }); }
    finally { await sleep(10); settled = true; }
  };
  const result = await run(f, { defaultTimeoutMs: 80 });
  assert.ok(settled);
  assert.equal(child(result).failureKind, 'batch_timeout');
  assert.match(child(result).error, /running bash \(Scoped discovery/);
  assert.doesNotMatch(child(result).error, /RAW_SECRET_COMMAND|SECRET|secret.example/);
  assert.ok(child(result).error.length < 400);
  assert.equal(f.requests.length, 1);
});

test('cancellation during recovery tool waits for true settlement before releasing the shared worker', async () => {
  let started, releaseTool, observedAbort;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const abortPromise = new Promise(resolve => { observedAbort = resolve; });
  const held = new Promise(resolve => { releaseTool = resolve; });
  const parent = new AbortController();
  const controller = createSubagentTool({ concurrency: 1 });
  const f = fixture(async (_request, n) => n === 1 ? length() : reply('toolUse', [call('bash', { command: 'held operation' })]));
  f.ctx.executeTool = async (_name, args, options) => {
    assert.equal(args.timeout, 120);
    options.signal.addEventListener('abort', observedAbort, { once: true });
    started();
    await held; // Deliberately settles after abort, never raced/detached by wrapper.
    return structuredClone(ok);
  };
  let finished = false;
  const pending = run(f, {}, parent.signal, undefined, controller).then(value => { finished = true; return value; });
  let next;
  try {
    await startedPromise;
    parent.abort(new Error('Stop recovery tool'));
    await abortPromise;
    const second = fixture(async () => reply());
    next = run(second, {}, undefined, undefined, controller);
    await sleep(10);
    assert.equal(finished, false);
    assert.equal(second.requests.length, 0, 'worker remains occupied until actual tool settlement');
  } finally { releaseTool(); }
  const result = await pending;
  assert.equal(child(result).failureKind, 'cancelled');
  assert.equal(child(result).lengthRecoveries, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(child(await next).status, 'completed');
});
