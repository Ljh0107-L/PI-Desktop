// Offline adapter and relay contracts. All SSH and agy invocations reach private fixtures.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { attachJsonlReader, serializeJsonLine } from '../core/jsonl.mjs';
import { PiSession } from '../core/pi-session.mjs';
import { localRelayTransport } from '../core/transports.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { prepareRemote } from '../app/main/remote-setup.mjs';
import { installAntigravityCli } from '../app/main/antigravity.mjs';
import { readHistory } from '../agent/pidesk-history.mjs';
import { antigravityTurnSpeed, usageOf } from '../app/renderer/src/transcript.js';

const adapter = fileURLToPath(new URL('../agent/pidesk-antigravity.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-agy-acp-antigravity.mjs', import.meta.url));
const relay = fileURLToPath(new URL('../agent/pidesk-relay.mjs', import.meta.url));
const exec = promisify(execFile);
const secretEnv = {
  GEMINI_API_KEY: 'fixture-private-gemini', GOOGLE_API_KEY: 'fixture-private-google',
  ANTHROPIC_API_KEY: 'fixture-private-anthropic', OPENAI_API_KEY: 'fixture-private-openai',
  GOOGLE_APPLICATION_CREDENTIALS: '/fixture-private-service-key', AGY_API_KEY: 'fixture-private-agy',
  HTTPS_PROXY: 'http://fixture-private-proxy', LC_API_KEY: 'fixture-private-not-a-locale',
};
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const parseLines = value => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(fn, description, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await sleep(12);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function fixture(t, scenario = {}, signedIn = false) {
  // Short POSIX path leaves room for the Unix-domain relay socket on macOS.
  const cwd = realpathSync(mkdtempSync('/tmp/pd-agy-'));
  const bin = join(cwd, 'fake agy');
  // Pi Desktop's bundled Node can be an Electron helper; only this wrapper sets the flag.
  writeFileSync(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(fake)} "$@"\n`, { mode: 0o700 });
  const setScenario = value => writeFileSync(join(cwd, '.pidesk-agy-scenario.json'), JSON.stringify(value));
  setScenario(scenario);
  if (signedIn) writeFileSync(join(cwd, '.pidesk-fake-agy-cache.json'), JSON.stringify({ signedIn }));
  const config = { bin, cwd, sessionsDir: join(cwd, 'sessions') };
  const cleanup = [];
  const log = () => {
    const file = join(cwd, '.pidesk-fake-agy.jsonl');
    return existsSync(file) ? parseLines(readFileSync(file, 'utf8')) : [];
  };
  const calls = method => log().filter(r => r.method === method);
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  function start(sessionFile, overrides = {}) {
    const boot = { antigravity: { ...config, sessionFile, ...overrides }, providers: [{ apiKey: 'fixture-private-boot-provider' }] };
    const child = spawn(process.execPath, [adapter], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...secretEnv, PIDESK_BOOT: JSON.stringify(boot) } });
    const closed = once(child, 'close');
    const events = [];
    let stderr = '', n = 0;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { stderr += chunk; });
    attachJsonlReader(child.stdout, line => events.push(JSON.parse(line)));
    const send = r => child.stdin.write(serializeJsonLine(r));
    const next = (predicate, from = 0) => until(() => events.slice(from).find(predicate), 'adapter event');
    const rpc = (type, payload = {}) => {
      const id = `rpc-${++n}`;
      send({ ...payload, id, type });
      return next(r => r.id === id && r.type === 'response');
    };
    const request = async (type, payload) => {
      const r = await rpc(type, payload);
      assert.equal(r.success, true, r.error);
      return r.data;
    };
    const stop = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { return await closed; } finally { clearTimeout(timer); }
    };
    const peer = { events, request, rpc, next, stop, send, stderr: () => stderr };
    cleanup.push(stop);
    return peer;
  }
  return { cwd, config, start, log, calls, setScenario, onCleanup: fn => cleanup.push(fn) };
}

const event = type => r => r.type === type;
const lastAssistant = messages => messages.findLast(m => m.role === 'assistant');
const fileEntries = path => parseLines(readFileSync(path, 'utf8'));
const authOptions = ({ authRequired, canSignIn, options }) => ({ authRequired, canSignIn, options });

test('Settings checks and signs in without creating a conversation or exposing CLI session details', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const account = async mode => JSON.parse((await exec(process.execPath, [adapter, `--account-${mode}`, f.config.bin], { cwd: f.cwd, timeout: 5000 })).stdout);
  assert.deepEqual(await account('check'), { antigravityAccount: { signedIn: false, canSignIn: true } });
  assert.equal(f.calls('authenticate').length, 0);
  assert.deepEqual(await account('login'), { antigravityAccount: { signedIn: true, canSignIn: true } });
  assert.deepEqual(await account('check'), { antigravityAccount: { signedIn: true, canSignIn: true } });
  assert.equal(f.calls('session/list').length, 3);
  assert.equal(f.calls('authenticate').length, 1);
  assert.equal(f.calls('session/new').length, 0);
  assert.equal(existsSync(f.config.sessionsDir), false);
});

test('installer runs only the official HTTPS installer on the chosen host', async () => {
  const env = { kind: 'ssh', host: 'fixture-host', label: 'Host' };
  let calls = 0;
  await installAntigravityCli(env, { run: async (target, script, options) => {
    calls++;
    assert.equal(target, env);
    assert.match(script, /--proto '=https' --proto-redir '=https'/);
    assert.match(script, /https:\/\/antigravity\.google\/cli\/install\.sh/);
    assert.match(script, /-o "\$installer"/);
    assert.match(script, /\n\/bin\/bash "\$installer"$/);
    assert.doesNotMatch(script, /sudo|agy acp --login|openExternal/);
    assert.equal(options.timeout, 240000);
  } });
  assert.equal(calls, 1);
});

test('standby negotiates once and only creates a transcript and ACP session on activation', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const cwd = join(f.cwd, 'conversation-folder');
  mkdirSync(cwd);
  f.setScenario({ workspace: cwd });
  const peer = f.start(null, { standby: true });
  const [a, b] = await Promise.all([peer.request('get_state'), peer.request('get_state')]);
  assert.deepEqual(a, b);
  assert.equal(a.antigravity.standby, true);
  assert.equal(a.sessionFile, null);
  assert.equal(existsSync(f.config.sessionsDir), false);
  assert.deepEqual(f.log().filter(r => r.method).map(r => r.method), ['initialize']);
  assert.match((await peer.rpc('prompt', { message: 'must not send' })).error, /Open the Antigravity conversation first/);
  assert.match((await peer.rpc('antigravity_activate', { cwd: 'relative' })).error, /Invalid Antigravity workspace/);
  const [active, same] = await Promise.all([
    peer.request('antigravity_activate', { cwd }), peer.request('antigravity_activate', { cwd }),
  ]);
  assert.deepEqual(active, same);
  assert.equal(active.antigravity.standby, undefined);
  assert.equal(fileEntries(active.sessionFile)[0].cwd, cwd);
  assert.equal(f.log()[0].boot.cwd, f.cwd);
  assert.deepEqual(f.log().filter(r => r.method).map(r => r.method), ['initialize', 'session/new']);
  assert.equal(f.calls('session/new')[0].params.cwd, cwd);
});

test('negotiates image input, CLI commands and context, and persists turn speed without fake usage', { timeout: 12000 }, async t => {
  const f = fixture(t, { photo: true, telemetry: true }, true);
  const peer = f.start(null, { bypassPermissions: true });
  const state = await peer.request('get_state');
  assert.equal(state.antigravity.image, true);
  assert.equal(state.antigravity.permissionMode, 'bypassPermissions');
  assert.deepEqual(f.log()[0].boot.argv, ['acp', '--dangerously-skip-permissions']);
  assert.deepEqual((await peer.request('get_commands')).commands, [{ name: 'test-skill', description: 'Test skill', source: 'antigravity', argumentHint: '<input>' }]);
  assert.deepEqual(await peer.request('get_session_stats'), { contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 } });
  const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
  await peer.request('prompt', { message: '', images: [image] });
  await peer.next(event('agent_settled'));
  assert.deepEqual(f.calls('session/prompt')[0].params.prompt, [image]);
  assert.equal(peer.events.some(event('extension_ui_request')), false);
  const { messages } = await readHistory(state.sessionFile);
  const reply = lastAssistant(messages);
  assert.ok(antigravityTurnSpeed(reply)?.tps > 0);
  assert.equal(usageOf(messages).calls, 0);
  assert.equal(reply.usage, undefined);
  assert.equal(antigravityTurnSpeed({ ...reply, stopReason: 'aborted' }), null);
});

async function ask(peer, message) {
  const from = peer.events.length;
  assert.deepEqual(await peer.request('prompt', { message }), { disposition: 'started' });
  const question = await peer.next(event('extension_ui_request'), from);
  assert.equal(question.method, 'select');
  assert.ok(!peer.events.slice(from).some(event('agent_settled')), 'a permission request must wait for the user');
  return { from, question };
}

const answer = (peer, question, payload) => peer.send({ type: 'extension_ui_response', id: question.id, ...payload });

test('negotiates ACP v1 as Pi Desktop, handles personal auth and serializes concurrent sign-in', { timeout: 12000 }, async t => {
  const f = fixture(t, { loginFailure: true });
  const peer = f.start();
  const [a, b] = await Promise.all([peer.request('get_state'), peer.request('get_state')]);
  assert.deepEqual(a, b);
  assert.deepEqual(authOptions(a.antigravity), { authRequired: true, canSignIn: true, options: [] });
  assert.equal(a.engine, 'antigravity');
  assert.equal(a.isCompacting, false);
  assert.equal(a.pendingMessageCount, 0);
  assert.equal(a.model, undefined);
  assert.ok(a.sessionId && a.sessionFile);
  assert.equal(statSync(a.sessionFile).mode & 0o777, 0o600);
  assert.equal(f.calls('initialize').length, 1);
  assert.equal(f.calls('session/new').length, 1, 'concurrent ready probes should share the auth state');
  assert.equal(f.calls('authenticate').length, 0, 'get_state should not trigger a browser');
  const boot = f.log()[0].boot;
  assert.deepEqual(boot.argv, ['acp']);
  assert.equal(boot.cwd, f.cwd);
  assert.ok(boot.env.includes('HOME') && boot.env.includes('PATH'));
  for (const key of [...Object.keys(secretEnv), 'PIDESK_BOOT', 'NODE_OPTIONS']) assert.ok(!boot.env.includes(key), key);
  const failedLogin = await peer.rpc('antigravity_login');
  assert.equal(failedLogin.success, false);
  assert.match(failedLogin.error, /could not complete sign-in/);
  assert.deepEqual((await peer.request('get_state')).antigravity, a.antigravity);

  f.setScenario({});
  const [x, y] = await Promise.all([peer.request('antigravity_login'), peer.request('antigravity_login')]);
  assert.deepEqual(x, y);
  assert.equal(x.sessionFile, a.sessionFile);
  assert.equal(x.sessionId, a.sessionId);
  assert.equal(x.antigravity.authRequired, false);
  assert.deepEqual(x.model, { provider: 'antigravity', id: 'mock-gemini-fast' });
  assert.equal(f.calls('authenticate').length, 2, 'one failed user action and one shared successful action');
  assert.equal(f.calls('session/new').length, 2, 'one auth-required attempt and one successful open');
  assert.ok(peer.events.some(r => r.type === 'antigravity_state' && r.antigravity.authRequired));
  assert.ok(peer.events.some(r => r.type === 'antigravity_state' && r.antigravity.options.length === 2));
  assert.equal(peer.stderr(), '');
  assert.doesNotMatch(JSON.stringify(peer.events), /fixture-private/);
});

test('streams Pi messages, updates advertised settings, and selects only original permission options explicitly', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  assert.deepEqual(state.antigravity.options, [
    { id: 'model', name: 'Model', category: 'model', currentValue: 'mock-gemini-fast', options: [
      { value: 'mock-gemini-fast', name: 'Mock Gemini Fast' }, { value: 'mock-gemini-pro', name: 'Mock Gemini Pro' },
    ] },
    { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ]);
  assert.equal((await peer.rpc('antigravity_set_config', { configId: 'mode', value: 'auto' })).success, false);
  assert.equal((await peer.rpc('antigravity_set_config', { configId: 'model', value: 'unadvertised' })).success, false);
  assert.equal((await peer.rpc('antigravity_set_config', { configId: 'unadvertised', value: 'high' })).success, false);
  assert.equal((await peer.rpc('prompt', { message: 'see image', images: [{ type: 'image' }] })).success, false);
  assert.equal(f.calls('session/set_config_option').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  const changed = await peer.request('antigravity_set_config', { configId: 'model', value: 'mock-gemini-pro' });
  assert.equal(changed.model.id, 'mock-gemini-pro');
  const { from, question } = await ask(peer, 'explicit permission');
  assert.deepEqual(question.options, ['Allow this read', 'Reject this read']);
  assert.match(question.message, /\/work\/fixture.txt/);
  assert.equal((await peer.request('get_state')).isStreaming, true);
  assert.equal((await peer.rpc('prompt', { message: 'not queued' })).success, false);
  assert.equal(f.log().filter(r => r.id === 'permission-1').length, 0);
  answer(peer, question, { value: 'Allow this read' });
  await peer.next(event('agent_settled'), from);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'selected', optionId: 'allow-once-original-id' } });
  const turn = peer.events.slice(from);
  assert.ok(turn.some(event('agent_start')));
  assert.deepEqual(turn.filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  const begin = turn.find(event('tool_execution_start'));
  assert.equal(begin.args.path, '/work/fixture.txt');
  assert.equal(turn.find(event('tool_execution_update')).partialResult.content[0].text, 'Preparing read');
  const end = turn.find(event('tool_execution_end'));
  assert.equal(end.toolCallId, begin.toolCallId);
  assert.equal(end.isError, false);
  assert.equal(end.result.content[0].text, 'Tool output');
  assert.ok(turn.some(r => r.assistantMessageEvent?.type === 'text_delta' && r.assistantMessageEvent.delta === 'Hello 🪐'));
  assert.ok(turn.some(r => r.type === 'antigravity_state' && r.antigravity.options.find(o => o.id === 'effort')?.currentValue === 'high'));
  const { messages } = await peer.request('get_messages');
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'toolResult']);
  assert.deepEqual(messages[1].content.map(b => b.text ?? b.thinking ?? b.id), ['Hello 🪐\u2028world', 'Thinking', begin.toolCallId, 'Done.']);
  assert.equal(messages[2].toolCallId, begin.toolCallId);
  const entries = await peer.request('get_entries');
  assert.equal(entries.leafId, entries.entries.at(-1).id);
  assert.doesNotMatch(JSON.stringify(peer.events), /fixture-private|foreign session|fake-acp\/session/);
  assert.doesNotMatch(readFileSync(state.sessionFile, 'utf8'), /fixture-private|foreign session/);
  assert.equal((await peer.request('get_state')).isStreaming, false);

  const invalid = await ask(peer, 'forged permission');
  answer(peer, invalid.question, { value: 'allow-once-original-id' }); // label, not guessed ACP ID
  await peer.next(event('agent_settled'), invalid.from);
  assert.deepEqual(f.log().find(r => r.id === 'permission-2').result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(peer.events.slice(invalid.from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: invalid.question.id }]);
});

test('ignores optional unsupported config/auth methods without a model or API fallback', { timeout: 12000 }, async t => {
  const f = fixture(t, { oauth: false, noOptions: true });
  const peer = f.start();
  const required = await peer.request('get_state');
  assert.deepEqual(authOptions(required.antigravity), { authRequired: true, canSignIn: false, options: [] });
  assert.equal((await peer.rpc('antigravity_login')).success, false);
  assert.equal((await peer.rpc('prompt', { message: 'simple' })).success, false);
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  assert.deepEqual(await peer.stop(), [0, null]);
  writeFileSync(join(f.cwd, '.pidesk-fake-agy-cache.json'), JSON.stringify({ signedIn: true }));
  const cached = f.start(required.sessionFile);
  const state = await cached.request('get_state');
  assert.equal(state.sessionFile, required.sessionFile);
  assert.deepEqual(authOptions(state.antigravity), { authRequired: false, canSignIn: false, options: [] });
  assert.equal(state.model, undefined);
  await cached.request('prompt', { message: 'simple' });
  await cached.next(event('agent_settled'));
  assert.equal(lastAssistant((await cached.request('get_messages')).messages).content[0].text, 'No settings needed.');
  assert.deepEqual(await cached.request('get_commands'), { commands: [] });
  assert.equal(await cached.request('get_session_stats'), null);
});

test('an SSH session never starts browser login and can reopen with the host CLI’s cached sign-in', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const original = f.start(undefined, { remote: true });
  const state = await original.request('get_state');
  assert.deepEqual(authOptions(state.antigravity), { authRequired: true, canSignIn: false, options: [] });
  assert.match((await original.rpc('antigravity_login')).error, /on the SSH host/);
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  await original.stop();
  // Stand in for an explicit `agy acp --login` in the remote terminal.
  writeFileSync(join(f.cwd, '.pidesk-fake-agy-cache.json'), JSON.stringify({ signedIn: true }));
  const reopened = f.start(state.sessionFile, { remote: true });
  const ready = await reopened.request('get_state');
  assert.equal(ready.sessionId, state.sessionId);
  assert.equal(ready.antigravity.authRequired, false);
  await reopened.request('prompt', { message: 'simple' });
  await reopened.next(event('agent_settled'));
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(lastAssistant((await reopened.request('get_messages')).messages).content[0].text, 'No settings needed.');
});

test('a generic -32000 is not auth, and ambiguous or missing files cannot silently get a new session', { timeout: 12000 }, async t => {
  const f = fixture(t, { newFailure: true });
  const peer = f.start();
  const state = await peer.rpc('get_state');
  assert.equal(state.success, false);
  assert.match(state.error, /could not start a session \(ACP error -32000\)/);
  assert.equal(peer.events.some(r => r.type === 'antigravity_state' && r.antigravity.authRequired), false);
  assert.match((await peer.rpc('get_state')).error, /session ID was not saved/);
  assert.equal(f.calls('session/new').length, 1);
  const missing = f.start(join(f.cwd, 'missing.jsonl'));
  assert.match((await missing.rpc('get_state')).error, /original Antigravity transcript/);
  const badBin = f.start(undefined, { bin: join(f.cwd, 'not-installed') });
  assert.match((await badBin.rpc('get_state')).error, /configured Antigravity CLI/);
  assert.equal(f.calls('initialize').length, 1);
  assert.equal(f.calls('authenticate').length, 0);
});

test('restart loads the exact ACP session without replay, prefers advertised resume and fails closed on a stale session', { timeout: 18000 }, async t => {
  const f = fixture(t, {}, true);
  const a = f.start();
  const state = await a.request('get_state');
  await a.request('prompt', { message: 'simple' });
  await a.next(event('agent_settled'));
  const { messages } = await a.request('get_messages');
  await a.stop();
  const original = readFileSync(state.sessionFile, 'utf8');
  assert.equal(fileEntries(state.sessionFile).find(e => e.data?.sessionId).data.sessionId, 'fake-acp/session?exact=1');

  const b = f.start(state.sessionFile);
  const loaded = await b.request('get_state');
  assert.equal(loaded.sessionId, state.sessionId);
  assert.deepEqual(loaded.antigravity.options, state.antigravity.options, 'load can advertise settings in a notification');
  assert.deepEqual((await b.request('get_messages')).messages, messages);
  assert.ok(!b.events.some(r => r.type.startsWith('message_') || r.type.startsWith('tool_execution_')));
  await b.stop();
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);

  f.setScenario({ resume: true });
  const c = f.start(state.sessionFile);
  assert.equal((await c.request('get_state')).sessionId, state.sessionId);
  await c.stop();
  assert.equal(f.calls('session/load').length, 1);
  assert.equal(f.calls('session/resume').length, 1);

  f.setScenario({ missingSession: true });
  const stale = f.start(state.sessionFile);
  const missing = await stale.rpc('get_state');
  assert.equal(missing.success, false);
  assert.match(missing.error, /original Antigravity session was not found/);
  assert.deepEqual((await stale.request('get_messages')).messages, messages);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
  await stale.stop();

  f.setScenario({ unsupportedResume: true });
  const unsupported = f.start(state.sessionFile);
  assert.match((await unsupported.rpc('get_state')).error, /cannot resume/);
  assert.equal(f.calls('session/load').length, 2);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
});

test('expired credentials preserve the existing transcript binding through reauthentication', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'expire' });
  await peer.next(r => r.type === 'antigravity_state' && r.antigravity.authRequired);
  const failedPrompt = lastAssistant((await peer.request('get_messages')).messages);
  assert.equal(failedPrompt.stopReason, 'error');
  assert.match(failedPrompt.errorMessage, /sign in/i);
  const original = readFileSync(state.sessionFile, 'utf8');
  const afterLogin = await peer.request('antigravity_login');
  assert.equal(afterLogin.sessionId, state.sessionId);
  assert.equal(afterLogin.antigravity.authRequired, false);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(f.calls('session/load').length, 1);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
});

test('abort, turn completion and child exit each dismiss pending permissions', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  const { from, question } = await ask(peer, 'cancel me');
  const stopped = await peer.rpc('abort');
  assert.equal(stopped.success, true);
  assert.ok(peer.events.findIndex((r, i) => i >= from && r.type === 'agent_settled') < peer.events.indexOf(stopped));
  assert.ok(peer.events.slice(from).some(r => r.type === 'agent_settled'));
  assert.equal(f.calls('session/cancel').length, 1);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'cancelled' } });
  answer(peer, question, { value: 'Allow this read' }); // stale reply must be inert
  assert.deepEqual(await peer.request('abort_bash'), {});
  assert.deepEqual(await peer.request('clear_queue'), {});
  assert.deepEqual(peer.events.slice(from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  assert.equal(f.log().filter(r => r.id === 'permission-1').length, 1);
  assert.equal(lastAssistant((await peer.request('get_messages')).messages).stopReason, 'aborted');

  async function promptAndCheckDismissal(message) {
    const from = peer.events.length;
    await peer.request('prompt', { message });
    const question = await peer.next(event('extension_ui_request'), from);
    await peer.next(event('agent_settled'), from);
    assert.deepEqual(peer.events.slice(from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  }
  await promptAndCheckDismissal('finish with pending permission');
  await until(() => f.log().find(r => r.id === 'permission-2' && r.result?.outcome?.outcome === 'cancelled'), 'cancelled leftover permission');
  await promptAndCheckDismissal('disconnect');
  assert.match(lastAssistant((await peer.request('get_messages')).messages).errorMessage, /connection closed/);
  assert.equal((await peer.request('get_state')).sessionId, state.sessionId);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(f.calls('session/load').length, 1);
});

test('local relay owns adapter and fake CLI, reattaches to the same session and hard-stops a pending turn', { timeout: 18000 }, async t => {
  const f = fixture(t, {}, true);
  const env = { ...process.env, PIDESK_RUN_DIR: join(f.cwd, 'run') };
  // Only this private relay daemon is contacted by the test. No SSH or app needed.
  mkdirSync(env.PIDESK_RUN_DIR, { mode: 0o700 });
  const daemon = spawn(process.execPath, [relay, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.resume();
  const closed = once(daemon, 'close');
  const control = (...argv) => exec(process.execPath, [relay, ...argv], { env, timeout: 6500 });
  f.onCleanup(async () => {
    if (daemon.exitCode == null && daemon.signalCode == null) {
      try { await control('shutdown'); } catch { daemon.kill('SIGTERM'); }
    }
    await closed;
  });
  const address = join(env.PIDESK_RUN_DIR, 'relay2.sock');
  await until(() => existsSync(address), 'relay listener');
  const connect = async () => {
    const session = new PiSession({ id: 'mock-antigravity', boot: { antigravity: f.config },
      transport: localRelayTransport({ node: process.execPath, relayPath: relay, runDir: env.PIDESK_RUN_DIR }),
      relay: { spawn: { cwd: f.cwd, argv: [process.execPath, adapter], env: secretEnv } } });
    f.onCleanup(() => session.stop(100));
    await session.start({ readyTimeout: 4000 });
    return session;
  };
  const a = await connect();
  assert.equal(a.attachInfo.created, true);
  const settled = a.nextSettled(4000);
  await a.prompt('simple');
  await settled;
  await a.stop();
  const b = await connect();
  assert.equal(b.attachInfo.created, false);
  assert.equal(b.attachInfo.pid, a.attachInfo.pid);
  assert.equal(b.initialState.sessionId, a.initialState.sessionId);
  assert.equal((await b.messages()).length, 2);
  assert.equal(f.calls('initialize').length, 1);
  const question = once(b, 'ui');
  await b.prompt('unresponsive');
  assert.equal((await question)[0].method, 'select');
  const cliPid = f.log()[0].boot.pid;
  await control('stop', 'mock-antigravity');
  assert.throws(() => process.kill(cliPid, 0), { code: 'ESRCH' });
  assert.equal(f.calls('session/cancel').length, 1);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'cancelled' } });
  await control('shutdown');
  await closed;
});

test('SSH deploys the adapter, prompts for host-side login, and reattaches a running turn without forwarding credentials', { timeout: 20000 }, async t => {
  const f = fixture(t, { resume: true });
  const home = join(f.cwd, 'remote-home'), root = join(home, '.pidesk');
  const tools = join(f.cwd, 'test-tools'), remoteNode = join(tools, 'node');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(tools);
  const ssh = join(tools, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nfor a do prev=$last; last=$a; [ "$a" != '-R' ] || exit 97; done\n[ "$prev" = 'agy-test-host' ] || exit 98\nexport HOME=${shellQuote(home)} GEMINI_API_KEY=fixture-remote-secret\nexec /bin/sh -c "$last"\n`, { mode: 0o700 });
  writeFileSync(remoteNode, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(home, '.local/bin/agy'), readFileSync(f.config.bin), { mode: 0o700 });
  // There is deliberately no Pi package on this SSH host.
  const originalEnv = { PATH: process.env.PATH, PIDESK_NO_SSH_MUX: process.env.PIDESK_NO_SSH_MUX };
  process.env.PATH = `${tools}:${process.env.PATH}`;
  process.env.PIDESK_NO_SSH_MUX = '1';
  const env = { id: 'ssh:agy-fixture', kind: 'ssh', host: 'agy-test-host', label: 'Mock SSH', enabled: true, added: true };
  const store = { sessions: [], settings: { defaults: { antigravityBypassPermissions: false }, providers: [], environments: { [env.id]: { root, added: true } } },
    saveSettings() {}, saveSessions() {}, touchRecent() {} };
  const manager = new SessionManager({ store, environments: () => [env], piVersion: '1.2.3', relayPath: relay,
    bridgePath: fileURLToPath(new URL('../agent/pidesk-bridge.js', import.meta.url)),
    local: { node: process.execPath, agentDir: join(f.cwd, 'unused-local'), runDir: join(f.cwd, 'unused-run') },
    remoteSetup: (target, options) => prepareRemote(target, options, { probe: async () => ({ home, hostname: env.host, nodes: [{ path: remoteNode, version: process.version }], disks: [] }) }),
  });
  manager.providerHosts = async () => assert.fail('Antigravity must not load Pi providers');
  f.onCleanup(async () => {
    try {
      for (const record of store.sessions) await manager.stopRelay(env, record.id, { requireTree: true });
      await exec(ssh, [env.host, `PIDESK_RUN_DIR=${shellQuote(join(root, 'run'))} ${shellQuote(remoteNode)} ${shellQuote(join(root, 'antigravity/pidesk-relay.mjs'))} shutdown`]).catch(() => {});
    } finally {
      await manager.shutdown();
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  assert.deepEqual(await manager.antigravityInfo(env.id), { installed: true });
  const record = await manager.create({ environmentId: env.id, cwd: f.cwd, engine: 'antigravity' });
  assert.equal(record.antigravity.authRequired, true);
  assert.equal(record.antigravity.canSignIn, false);
  assert.ok(record.piSessionFile.startsWith(join(root, 'agent/sessions/antigravity')));
  assert.deepEqual(readFileSync(join(root, 'antigravity/pidesk-antigravity.mjs')), readFileSync(adapter));
  assert.equal(existsSync(join(root, 'pi')), false);
  await assert.rejects(manager.antigravityLogin(record.id), /agy acp --login/);
  await assert.rejects(manager.prompt(record.id, 'before sign-in'), /Sign in with Google/);
  writeFileSync(join(f.cwd, '.pidesk-fake-agy-cache.json'), JSON.stringify({ signedIn: true }));
  await manager.reconnect(record.id);
  assert.equal(manager.list()[0].antigravity.authRequired, false);
  assert.equal(manager.list()[0].piSessionFile, record.piSessionFile);
  assert.equal(f.calls('authenticate').length, 0);
  assert.ok(f.log().filter(r => r.boot).every(r => !r.boot.env.includes('GEMINI_API_KEY')));

  const active = await manager.ensureStarted(record.id);
  const permission = once(manager, 'question');
  await manager.prompt(record.id, 'waiting for permission');
  const [{ question }] = await permission;
  await manager.close(record.id); // disconnect only: do not stop the host's work
  const attached = await manager.ensureStarted(record.id);
  assert.equal(attached.attachInfo.created, false);
  assert.equal(attached.attachInfo.pid, active.attachInfo.pid);
  assert.equal(manager.list()[0].pendingQuestions[0].requestId, question.requestId);
  await manager.abort(record.id);
  assert.equal(manager.list()[0].pendingQuestions.length, 0);
  assert.equal(f.calls('session/prompt').length, 1);
  assert.equal(f.calls('session/cancel').length, 1);
  assert.equal(manager.list()[0].egressPort, undefined);
  assert.deepEqual((await manager.historyPage(record.id)).messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['waiting for permission']);
});
