// Offline Cursor ACP peer for GitHub CI. Never contacts Cursor or calls a model.
import readline from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const models = [{ modelId: 'cursor-test-a', name: 'Cursor Test A' }, { modelId: 'cursor-test-b', name: 'Cursor Test B' }, { modelId: 'cursor-test-c', name: 'Cursor Test C' }];
let sessionId = 'cursor-fixture-session', modelId = models[0].modelId, turn, requestId = 10000;
const requiresKey = process.argv.includes('--require-key');
const validKeys = ['cursor-fixture-key-one', 'cursor-fixture-key-two'];
const configModels = process.argv.includes('--config-models');
let thoughtLevel = 'medium', fastMode = false, thinking = true;
// Like the official CLI, a session starts in the CLI's last mode (here: --initial-mode), not necessarily Agent.
let mode = process.argv.includes('--initial-mode') ? process.argv[process.argv.indexOf('--initial-mode') + 1] : 'agent';
// Tools work in the session's directory, which is not the CLI's own when it was started in advance.
let sessionCwd = process.cwd();
// cursor-test-b is shaped like Cursor's Claude models: a thinking switch plus an effort level.
const modelSettings = (id, effort = 'medium', fast = false, on = true) => id === 'cursor-test-c' ? [] : [
  ...(id === 'cursor-test-b' ? [{ id: 'thinking', category: 'thought_level', type: 'select', name: 'Thinking', currentValue: String(on), options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] }] : []),
  { id: 'reasoning-effort', category: 'thought_level', type: 'select', name: 'Reasoning', currentValue: effort, options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  { id: 'speed', category: 'model_config', type: 'boolean', name: 'Fast', currentValue: fast },
];
const modeOption = () => ({ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }] });
const modelState = () => configModels ? { configOptions: [modeOption(), { id: 'model-choice', category: 'model', type: 'select', name: 'Model', currentValue: modelId, options: [{ group: 'fixture', name: 'Fixture', options: models.map(model => ({ value: model.modelId, name: model.name })) }] }, ...modelSettings(modelId, thoughtLevel, fastMode, thinking)] } : { models: { availableModels: models, currentModelId: modelId } };
const pending = new Map();
const update = update => send({ method: 'session/update', params: { sessionId, update } });
const text = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finish = () => { if (turn) { result(turn, { stopReason: 'end_turn' }); turn = null; } };
const ask = (method, params, done) => { const id = ++requestId; pending.set(id, done); send({ id, method, params }); };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const p = JSON.parse(line);
  if (!p.method) { const done = pending.get(p.id); pending.delete(p.id); done?.(p.result); return; }
  switch (p.method) {
    case 'initialize':
      if (requiresKey && (!validKeys.includes(process.env.CURSOR_API_KEY) || process.env.CURSOR_AUTH_TOKEN)) {
        send({ id: p.id, error: { code: -32000, message: 'Cursor API Key is missing or invalid' } }); break;
      }
      result(p.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [{ id: 'cursor_login', name: 'Cursor login' }] }); break;
    case 'authenticate':
      // Mirrors the official CLI: this method is browser login, not API-key auth.
      if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) send({ id: p.id, error: { code: -32602, message: 'Invalid params', data: { message: 'Browser login must not be requested for a pre-authenticated API-key session' } } });
      else result(p.id, {});
      break;
    case 'cursor/list_available_models':
      if (!configModels) { send({ id: p.id, error: { code: -32601, message: `Unknown method ${p.method}` } }); break; }
      result(p.id, { models: models.map(model => ({ value: model.modelId, name: model.name, configOptions: modelSettings(model.modelId) })) }); break;
    case 'session/new': case 'session/load':
      sessionId = p.params.sessionId || sessionId;
      sessionCwd = p.params.cwd || sessionCwd;
      // A replay must not become a new assistant message in desktop history.
      if (p.method === 'session/load') text('REPLAY MUST BE IGNORED');
      result(p.id, { sessionId, ...modelState() }); break;
    case 'session/set_model':
      if (configModels) { send({ id: p.id, error: { code: -32601, message: 'Use config options' } }); break; }
      modelId = p.params.modelId; result(p.id, {}); break;
    case 'session/set_config_option':
      if (p.params.configId === 'model-choice') modelId = p.params.value;
      else if (p.params.configId === 'mode' && ['agent', 'plan', 'ask'].includes(p.params.value)) mode = p.params.value;
      else if (p.params.configId === 'thinking' && modelId === 'cursor-test-b' && ['true', 'false'].includes(p.params.value)) thinking = p.params.value === 'true';
      else if (p.params.configId === 'reasoning-effort') thoughtLevel = p.params.value;
      else if (p.params.configId === 'speed' && p.params.type === 'boolean') fastMode = p.params.value;
      else { send({ id: p.id, error: { code: -32602, message: 'Unknown configuration' } }); break; }
      result(p.id, modelState()); break;
    case 'session/prompt': {
      turn = p.id;
      const prompt = p.params.prompt.map(c => c.text || '').join('');
      if (prompt === 'mode-status') { text(`Mode: ${mode} · effort: ${modelId === 'cursor-test-b' && !thinking ? 'off' : thoughtLevel}`); finish(); break; }
      if (prompt === 'auth-status') { text(`Credential: ${process.env.CURSOR_API_KEY === validKeys[1] ? 'rotated' : process.env.CURSOR_API_KEY === validKeys[0] ? 'primary' : 'login'}`); finish(); break; }
      if (prompt === 'auth-error') {
        const secret = process.env.CURSOR_API_KEY || 'no-key';
        process.stderr.write('Bad credential ' + secret.slice(0, 8));
        setTimeout(() => { process.stderr.write(secret.slice(8), () => process.exit(1)); }, 10);
        break;
      }
      if (prompt === 'crash') { process.stderr.write('offline cursor crash'); process.exit(1); }
      if (prompt === 'hold') { text('Waiting for cancellation'); break; }
      if (prompt === 'usage') { update({ sessionUpdate: 'usage_update', used: 53000, size: 200000 }); text('Reported usage'); finish(); break; }
      if (prompt === 'permission-always') {
        const memory = join(sessionCwd, 'fixture-native-permissions.json');
        if (existsSync(memory) && JSON.parse(readFileSync(memory, 'utf8')).sessionId === sessionId) { text('Native remembered approval'); finish(); break; }
        ask('session/request_permission', { sessionId, toolCall: { title: 'Read fixture file?', kind: 'read', locations: [{ path: '/fixture/file' }] }, options: [{ optionId: 'remember-fixture-read', name: 'Always allow reading /fixture/file in this session', kind: 'allow_always' }] }, answer => {
          if (answer.outcome.optionId === 'remember-fixture-read') writeFileSync(memory, JSON.stringify({ sessionId }));
          text(`Permission: ${answer.outcome.optionId || answer.outcome.outcome}`); finish();
        }); break;
      }
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
        writeFileSync(join(sessionCwd, 'cursor-output.md'), '# Cursor output\n');
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'cursor-write', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Created cursor-output.md' } }] });
      }
      text(`Cursor (${modelId}): `); text(`回复 ${prompt}`);
      finish(); break;
    }
    case 'session/cancel': if (turn) { result(turn, { stopReason: 'cancelled' }); turn = null; } break;
    default: send({ id: p.id, error: { code: -32601, message: `Unknown method ${p.method}` } });
  }
});
