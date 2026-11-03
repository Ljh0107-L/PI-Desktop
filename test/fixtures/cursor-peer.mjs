// Offline Cursor ACP peer for GitHub CI. Never contacts Cursor or calls a model.
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const models = [{ modelId: 'cursor-test-a', name: 'Cursor Test A' }, { modelId: 'cursor-test-b', name: 'Cursor Test B' }];
let sessionId = 'cursor-fixture-session', modelId = models[0].modelId, turn, requestId = 10000;
const pending = new Map();
const update = update => send({ method: 'session/update', params: { sessionId, update } });
const text = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finish = () => { if (turn) { result(turn, { stopReason: 'end_turn' }); turn = null; } };
const ask = (method, params, done) => { const id = ++requestId; pending.set(id, done); send({ id, method, params }); };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const p = JSON.parse(line);
  if (!p.method) { const done = pending.get(p.id); pending.delete(p.id); done?.(p.result); return; }
  switch (p.method) {
    case 'initialize': result(p.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [{ id: 'cursor_login', name: 'Cursor login' }] }); break;
    case 'authenticate': result(p.id, {}); break;
    case 'session/new': case 'session/load':
      sessionId = p.params.sessionId || sessionId;
      // A replay must not become a new assistant message in desktop history.
      if (p.method === 'session/load') text('REPLAY MUST BE IGNORED');
      result(p.id, { sessionId, models: { availableModels: models, currentModelId: modelId } }); break;
    case 'session/set_model': modelId = p.params.modelId; result(p.id, {}); break;
    case 'session/prompt': {
      turn = p.id;
      const prompt = p.params.prompt.map(c => c.text || '').join('');
      if (prompt === 'crash') { process.stderr.write('offline cursor crash'); process.exit(1); }
      if (prompt === 'hold') { text('Waiting for cancellation'); break; }
      if (prompt === 'permission') {
        ask('session/request_permission', { sessionId, toolCall: { title: 'Allow fixture read?' }, options: [{ optionId: 'allow-read', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny-read', name: 'Reject', kind: 'reject_once' }] }, answer => { text(`Permission: ${answer.outcome.optionId || answer.outcome.outcome}`); finish(); }); break;
      }
      if (prompt === 'question') {
        ask('cursor/ask_question', { toolCallId: 'q1', questions: [{ id: 'color', prompt: 'Choose a color', options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }] }] }, answer => { text(`Question: ${answer.outcome.outcome}`); finish(); }); break;
      }
      if (prompt === 'plan') {
        ask('cursor/create_plan', { name: 'Approve fixture plan?', plan: 'Read the file only.' }, answer => { text(`Plan: ${answer.outcome.outcome}`); finish(); }); break;
      }
      if (prompt === 'tool') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'cursor-write', title: 'Write Cursor output', kind: 'edit', status: 'in_progress', rawInput: { path: 'cursor-output.md' } });
        writeFileSync(join(process.cwd(), 'cursor-output.md'), '# Cursor output\n');
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'cursor-write', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Created cursor-output.md' } }] });
      }
      text(`Cursor (${modelId}): `); text(`回复 ${prompt}`);
      finish(); break;
    }
    case 'session/cancel': if (turn) { result(turn, { stopReason: 'cancelled' }); turn = null; } break;
    default: send({ id: p.id, error: { code: -32601, message: `Unknown method ${p.method}` } });
  }
});
