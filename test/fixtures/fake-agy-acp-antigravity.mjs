// An offline ACP server for the Antigravity adapter tests. The workspace controls the
// scenario and stands in for the CLI's own credential and session cache.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

assert.deepEqual(process.argv.slice(2), ['acp']);
const scenarioFile = '.pidesk-agy-scenario.json';
const cacheFile = '.pidesk-fake-agy-cache.json';
const logFile = '.pidesk-fake-agy.jsonl';
const scenario = () => JSON.parse(readFileSync(scenarioFile, 'utf8'));
const cache = () => existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const save = value => writeFileSync(cacheFile, JSON.stringify(value));
const log = value => appendFileSync(logFile, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result = {}) => send({ id, result });
const error = (id, code, message) => send({ id, error: { code, message, data: { token: 'fixture-private-error-data' } } });
const SESSION = 'fake-acp/session?exact=1';
const update = (sessionUpdate, fields, sessionId = SESSION) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } } });
const chunk = (text, sessionId = SESSION) => update('agent_message_chunk', { content: { type: 'text', text } }, sessionId);
const toolCallId = 'fake-call';

log({ boot: { pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), env: Object.keys(process.env).sort() } });
process.stderr.write('fixture-private-stderr-oauth-url\n');

let model = 'mock-gemini-fast', effort = 'low';
const options = () => [{ id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: model,
  options: [{ group: 'mock-group', name: 'Advertised Gemini models', options: [
    { value: 'mock-gemini-fast', name: 'Mock Gemini Fast' }, { value: 'mock-gemini-pro', name: 'Mock Gemini Pro' },
  ] }] }, { id: 'effort', type: 'select', name: 'Effort', category: 'thought_level', currentValue: effort,
  options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
{ id: 'mode', type: 'select', name: 'Permissions', category: 'mode', currentValue: 'ask', options: [{ value: 'ask', name: 'Confirm' }, { value: 'auto', name: 'Automatic' }] },
{ id: 'unsupported', type: 'boolean', name: 'Not an MVP control', currentValue: true }];
const config = () => scenario().noOptions ? { models: { currentModelId: 'legacy-model' }, configOptions: null } : { configOptions: options() };
const authRequired = id => error(id, -32000, 'Authentication required');
let turn, nextPermission = 0, cancelTimer;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const r = JSON.parse(line);
  log(r);
  assert.equal(r.jsonrpc, '2.0');
  switch (r.method) {
    case 'initialize': {
      assert.equal(r.params.protocolVersion, 1);
      assert.equal(r.params.clientInfo.name, 'pi-desktop');
      assert.equal(r.params.clientInfo.title, 'Pi Desktop');
      assert.deepEqual(r.params.clientCapabilities, {});
      const { resume, unsupportedResume, oauth } = scenario();
      reply(r.id, { protocolVersion: 1, agentCapabilities: { loadSession: !unsupportedResume, ...(resume ? { sessionCapabilities: { resume: {} } } : {}) },
        authMethods: oauth === false ? [{ id: 'api-key' }] : [{ id: 'oauth-personal', name: 'Sign in with Google', ...(oauth === 'terminal' ? { type: 'terminal' } : {}) }] });
      break;
    }
    case 'authenticate':
      assert.deepEqual(r.params, { methodId: 'oauth-personal' });
      if (scenario().loginFailure) { error(r.id, -32000, 'fixture-private-login-failure'); break; }
      save({ ...cache(), signedIn: true });
      reply(r.id);
      break;
    case 'session/new': {
      assert.equal(r.params.cwd, process.cwd());
      assert.deepEqual(r.params.mcpServers, []);
      if (scenario().newFailure) { error(r.id, -32000, 'fixture-private-non-auth-server-error'); break; }
      if (!cache().signedIn) { authRequired(r.id); break; }
      assert.equal(cache().session, undefined, 'client tried to replace an existing CLI session');
      save({ ...cache(), session: SESSION });
      reply(r.id, { sessionId: SESSION, ...config() });
      break;
    }
    case 'session/load': case 'session/resume': {
      assert.deepEqual(r.params, { cwd: process.cwd(), mcpServers: [], sessionId: SESSION });
      if (!cache().signedIn || scenario().expireResume) { authRequired(r.id); break; }
      if (scenario().missingSession || cache().session !== SESSION) { error(r.id, -32002, 'fixture-private-stale-session-data'); break; }
      if (r.method === 'session/load') {
        update('user_message_chunk', { content: { type: 'text', text: 'replayed user' } });
        chunk('replayed assistant');
        update('tool_call', { toolCallId, title: 'Replayed tool' });
        update('config_option_update', { configOptions: options() });
        reply(r.id);
      } else reply(r.id, config());
      break;
    }
    case 'session/set_config_option':
      assert.equal(r.params.sessionId, SESSION);
      if (r.params.configId === 'model') {
        assert.equal(r.params.value, 'mock-gemini-pro');
        model = r.params.value;
      } else {
        assert.equal(r.params.configId, 'effort');
        assert.equal(r.params.value, 'high');
        effort = r.params.value;
      }
      reply(r.id, config());
      break;
    case 'session/prompt': {
      assert.equal(r.params.sessionId, SESSION);
      assert.equal(r.params.prompt.length, 1);
      assert.equal(r.params.prompt[0].type, 'text');
      assert.equal(turn, undefined);
      const text = r.params.prompt[0].text;
      if (text === 'expire') {
        save({ ...cache(), signedIn: false });
        authRequired(r.id); break;
      }
      if (text === 'simple') { chunk('No settings needed.'); reply(r.id, { stopReason: 'end_turn' }); break; }
      turn = { id: r.id, permission: `permission-${++nextPermission}`, text };
      chunk('foreign session should be ignored', 'wrong-session');
      chunk('Hello 🪐'); chunk('\u2028world');
      update('agent_thought_chunk', { content: { type: 'text', text: 'Thinking' } });
      update('tool_call', { toolCallId, title: 'Read fixture', kind: 'read', status: 'pending', locations: [{ path: '/work/fixture.txt' }], rawInput: { apiKey: 'fixture-private-raw-input' } });
      send({ id: turn.permission, method: 'session/request_permission', params: { sessionId: SESSION, toolCall: { toolCallId }, options: [
        { optionId: 'allow-once-original-id', name: 'Allow this read', kind: 'allow_once' },
        { optionId: 'reject-once-original-id', name: 'Reject this read', kind: 'reject_once' },
      ] } });
      if (text === 'disconnect') process.stdout.write('', () => process.exit(22));
      if (text === 'finish with pending permission') {
        reply(turn.id, { stopReason: 'end_turn' });
        turn = undefined;
      }
      break;
    }
    case 'session/cancel':
      assert.deepEqual(r.params, { sessionId: SESSION });
      assert.ok(turn);
      turn.cancelled = true;
      // Send a last chunk, then acknowledge asynchronously. abort must not settle on send.
      chunk('Final update after cancel.');
      if (turn.text !== 'unresponsive') cancelTimer = setTimeout(() => {
        const id = turn.id;
        turn = undefined;
        reply(id, { stopReason: 'cancelled' });
      }, 100);
      break;
    default:
      if (!turn || r.id !== turn.permission) break;
      if (turn.cancelled) {
        assert.deepEqual(r.result, { outcome: { outcome: 'cancelled' } });
        break;
      }
      const allowed = r.result?.outcome?.optionId === 'allow-once-original-id';
      update('tool_call_update', { toolCallId, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'Preparing read' } }] });
      update('tool_call_update', { toolCallId, status: allowed ? 'completed' : 'failed', rawOutput: { token: 'fixture-private-raw-output' },
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'Tool output' : 'Permission denied' } }] });
      effort = 'high';
      if (!scenario().noOptions) update('config_option_update', { configOptions: options() });
      chunk('Done.');
      reply(turn.id, { stopReason: 'end_turn' });
      turn = undefined;
  }
});
lines.on('close', () => clearTimeout(cancelTimer));
