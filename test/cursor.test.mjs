import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CursorAcp, cursorCommand, cursorEnvironment, cursorModels, estimateTokens } from '../agent/cursor-acp.mjs';
import { CursorDesktopSession } from '../agent/pidesk-cursor.mjs';
import { branchMessages } from '../app/main/session-manager.mjs';
import { mockCursorCommand } from './cursor-fixture.mjs';

function fixture(t, { configModels = false, flags = [], effort } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pidesk-cursor-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const command = mockCursorCommand(cwd, [...(configModels ? ['--config-models'] : []), ...flags]);
  const file = join(cwd, 'history/session.jsonl');
  const events = [];
  const client = new CursorAcp({ command, cwd });
  t.after(() => client.close());
  const desktop = new CursorDesktopSession({ client, file, cwd, send: event => events.push(structuredClone(event)), effort });
  return { cwd, command, file, events, client, desktop };
}
// Drive the adapter's own entry point over JSONL, as the relay does.
function adapterProcess(t, args, env = {}) {
  const adapter = join(dirname(fileURLToPath(import.meta.url)), '../agent/pidesk-cursor.mjs');
  const child = spawn(process.execPath, [adapter, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PIDESK_BOOT: '{}', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const responses = new Map(), events = [];
  let buffer = '', next = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const record = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      if (record.type === 'response') responses.get(record.id)?.(record); else events.push(record);
    }
  });
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = `r${++next}`;
    responses.set(id, response => response.success ? resolve(response.data) : reject(new Error(response.error)));
    child.stdin.write(JSON.stringify({ ...payload, type, id }) + '\n');
  });
  const settled = () => new Promise(resolve => { const timer = setInterval(() => { if (events.some(e => e.type === 'agent_settled')) { clearInterval(timer); events.length = 0; resolve(); } }, 10); });
  return { child, request, events, settled };
}

// These execute only in GitHub CI; the peer and models are offline fixtures.
test('Cursor environment excludes Pi boot credentials and Electron Node mode', () => {
  const env = cursorEnvironment({ PATH: '/bin', HOME: '/home/user', PIDESK_BOOT: 'secret', ANTHROPIC_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', CURSOR_AUTH_TOKEN: 'cursor-login' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/user', CURSOR_AUTH_TOKEN: 'cursor-login', NO_OPEN_BROWSER: '1', AGENT_CLI_CREDENTIAL_STORE: 'memory' });
  // A host behind a company proxy: Cursor needs the same proxy and CA settings as any program there.
  const proxied = cursorEnvironment({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:8118', http_proxy: 'http://proxy:8118', NO_PROXY: '.corp', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', OPENAI_API_KEY: 'secret' });
  assert.deepEqual(proxied, { PATH: '/bin', HTTPS_PROXY: 'http://proxy:8118', http_proxy: 'http://proxy:8118', NO_PROXY: '.corp', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', NO_OPEN_BROWSER: '1' });
  assert.equal(cursorCommand('~/.local/bin/agent', '/remote/home'), '/remote/home/.local/bin/agent');
  assert.equal(cursorCommand('/path with spaces/agent'), '/path with spaces/agent');
  assert.throws(() => cursorCommand('bad\npath'));
  assert.deepEqual(cursorModels({}), []);
});

test('Cursor ACP launches with official YOLO mode before the subcommand', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const launches = [];
  f.client.spawnProcess = (command, args, options) => {
    launches.push(args);
    return spawn(command, args, options);
  };
  await f.desktop.start();
  assert.deepEqual(launches, [['--disable-auto-update', '--force', 'acp']]);
});

test('official ACP initializes, advertises models, switches and streams exactly once', { timeout: 15000 }, async t => {
  const f = fixture(t);
  await f.desktop.start('cursor-test-b');
  assert.equal(f.desktop.models.length,  3);
  assert.equal(f.desktop.state().model.id, 'cursor-test-b');
  assert.deepEqual(f.desktop.prompt('hello'), { disposition: 'started' });
  await f.desktop.turn;
  const messages = f.desktop.messages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content[0].text, 'Cursor (cursor-test-b): 回复 hello');
  assert.equal(messages[1].stopReason, 'stop');
  assert.equal(messages[1].usage, undefined, 'never invent token counts');
  assert.equal(f.events.filter(e => e.type === 'agent_settled').length, 1);
  await assert.rejects(f.desktop.request('set_model', { provider: 'openai', modelId: 'x' }), /Cursor model/);
  await assert.rejects(f.desktop.setModel('missing'), /not available/);
  const entries = readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(branchMessages(entries, entries.at(-1).id), messages);
});

test('catalog entry point works through symlinks, including macOS /tmp SSH installations', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const adapter = join(dirname(fileURLToPath(import.meta.url)), '../agent/pidesk-cursor.mjs');
  const link = join(f.cwd, 'cursor-adapter.mjs');
  symlinkSync(adapter, link);
  const { stdout } = await promisify(execFile)(process.execPath, [link, '--catalog', '--cwd', f.cwd, '--command', f.command], { timeout: 10000 });
  assert.equal(JSON.parse(stdout).models.length,  3);
});

test('Cursor model config options support grouped models and the standard setter', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true });
  await f.desktop.start('cursor-test-b');
  assert.equal(f.desktop.models.length,  3);
  assert.equal(f.desktop.state().model.id, 'cursor-test-b');
  await f.desktop.setModel('cursor-test-a');
  assert.equal(f.desktop.state().model.name, 'Cursor Test A');
  f.desktop.prompt('config model'); await f.desktop.turn;
  assert.match(f.desktop.messages().at(-1).content[0].text, /cursor-test-a/);
});

test('advertised reasoning and boolean Fast controls use exact ACP config IDs and values', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true }); await f.desktop.start();
  assert.equal(f.desktop.state().thinkingLevel, 'medium');
  assert.equal(f.desktop.state().cursorConfigOptions.find(option => option.id === 'speed').currentValue, false);
  await f.desktop.request('set_thinking_level', { level: 'high' });
  await f.desktop.request('set_config_option', { configId: 'speed', value: true });
  assert.equal(f.desktop.state().thinkingLevel, 'high');
  assert.equal(f.desktop.state().cursorConfigOptions.find(option => option.id === 'speed').currentValue, true);
  await assert.rejects(f.desktop.request('set_config_option', { configId: 'speed', value: 'true' }), /not available/);
  await assert.rejects(f.desktop.request('set_thinking_level', { level: 'invented' }), /not available/);
  await f.desktop.setModel('cursor-test-c');
  assert.deepEqual(f.desktop.state().cursorConfigOptions.map(option => option.id), [], 'model and mode are not settings of their own');
  await assert.rejects(f.desktop.request('set_thinking_level', { level: 'high' }), /does not advertise/);
  await assert.rejects(f.desktop.request('set_config_option', { configId: 'speed', value: true }), /not available/);
  assert.ok(f.events.some(event => event.type === 'cursor_model_changed' && event.cursorConfigOptions));
});

test('desktop conversations always run in Agent mode, and the mode is never offered', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true, flags: ['--initial-mode', 'plan'] });
  await f.desktop.start();
  assert.ok(!f.desktop.state().cursorConfigOptions.some(option => option.category === 'mode' || option.id === 'mode'));
  f.desktop.prompt('mode-status'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).content[0].text, 'Mode: agent · effort: medium');
  await assert.rejects(f.desktop.request('set_config_option', { configId: 'mode', value: 'ask' }), /Agent mode/);
});

test('each conversation keeps its own reasoning effort, although Cursor shares one per model', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true, effort: 'high' });
  await f.desktop.start();
  assert.equal(f.desktop.state().thinkingLevel, 'high', 'a new conversation starts with the chosen effort');
  // A restarted CLI begins at its own default (another conversation may have changed it): restore ours.
  await f.client.close();
  const resume = async () => {
    const client = new CursorAcp({ command: f.command, cwd: f.cwd }); t.after(() => client.close());
    const desktop = new CursorDesktopSession({ client, file: f.file, cwd: f.cwd, send: () => {}, effort: 'medium' });
    await desktop.start(); return { client, desktop };
  };
  let { client, desktop } = await resume();
  assert.equal(desktop.state().thinkingLevel, 'high', 'the recorded choice wins over a start-up default');
  await desktop.request('set_thinking_level', { level: 'medium' });
  await client.close();
  ({ desktop } = await resume());
  assert.equal(desktop.state().thinkingLevel, 'medium');
  await desktop.setModel('cursor-test-b');
  assert.equal(desktop.state().thinkingLevel, 'medium', 'switching models keeps the conversation effort where offered');
});

test('a thinking switch and an effort level form one Pi-style effort', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true });
  await f.desktop.start('cursor-test-b');
  const effort = () => f.desktop.state().cursorConfigOptions.find(option => option.category === 'thought_level');
  assert.deepEqual(f.desktop.state().cursorConfigOptions.filter(option => option.category === 'thought_level').length, 1);
  assert.deepEqual([effort().currentValue, effort().options.map(option => option.name)], ['medium', ['Off', 'Medium', 'High']]);
  await f.desktop.request('set_thinking_level', { level: 'off' });
  assert.equal(f.desktop.state().thinkingLevel, 'off');
  f.desktop.prompt('mode-status'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).content[0].text, 'Mode: agent · effort: off');
  await f.desktop.request('set_config_option', { configId: 'pidesk-effort', value: 'high' }); // thinking on, then the level
  assert.equal(f.desktop.state().thinkingLevel, 'high');
  f.desktop.prompt('mode-status'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).content[0].text, 'Mode: agent · effort: high');
  await assert.rejects(f.desktop.request('set_thinking_level', { level: 'max' }), /not available/);
});

test('Cursor context is an explicit estimate when the CLI reports none', { timeout: 15000 }, async t => {
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('你好世界'), 4);
  const f = fixture(t); await f.desktop.start();
  assert.equal((await f.desktop.request('get_session_stats')).contextUsage, null);
  f.desktop.prompt('hello'); await f.desktop.turn;
  const { contextUsage } = await f.desktop.request('get_session_stats');
  assert.equal(contextUsage.estimated, true);
  assert.ok(contextUsage.tokens > 0);
  assert.equal(contextUsage.contextWindow, undefined, 'no invented window');
  assert.equal(contextUsage.percent, undefined, 'no invented percentage');
  assert.equal(f.desktop.messages().at(-1).usage, undefined, 'messages never carry invented usage');
});

test('catalog lists each model’s own efforts without mode or model', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true });
  const adapter = join(dirname(fileURLToPath(import.meta.url)), '../agent/pidesk-cursor.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [adapter, '--catalog', '--cwd', f.cwd, '--command', f.command], { timeout: 10000 });
  const { models } = JSON.parse(stdout);
  assert.deepEqual(models.find(m => m.id === 'cursor-test-a').configOptions.map(o => o.id), ['speed', 'pidesk-effort']);
  assert.deepEqual(models.find(m => m.id === 'cursor-test-b').configOptions.find(o => o.id === 'pidesk-effort').options.map(o => o.value), ['off', 'medium', 'high'], 'a thinking switch and its levels are one effort');
  assert.equal(models.find(m => m.id === 'cursor-test-a').reasoning, true);
  assert.deepEqual(models.find(m => m.id === 'cursor-test-c').configOptions, []);
});

test('a conversation started ahead of its first message is ready in its directory and lists model efforts', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true, flags: ['--initial-mode', 'ask'] });
  const conversation = join(f.cwd, 'conversation'); mkdirSync(conversation);
  const file = join(conversation, 'history.jsonl');
  const spare = adapterProcess(t, ['--spare', '--cwd', conversation, '--command', f.command, '--session-file', file, '--model', 'cursor-test-b', '--thought', 'high']);
  const state = await spare.request('get_state');
  assert.deepEqual([state.model.id, state.thinkingLevel], ['cursor-test-b', 'high']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).cwd, conversation);
  for (let i = 0; i < 100 && !spare.events.some(e => e.type === 'cursor_models'); i++) await new Promise(r => setTimeout(r, 20));
  const listed = spare.events.find(e => e.type === 'cursor_models');
  assert.deepEqual(listed.models.find(m => m.id === 'cursor-test-b').configOptions.map(o => o.id), ['speed', 'pidesk-effort']);
  await spare.request('prompt', { message: 'tool' }); await spare.settled();
  assert.equal(readFileSync(join(conversation, 'cursor-output.md'), 'utf8'), '# Cursor output\n', 'tools work in the conversation directory');
  await spare.request('prompt', { message: 'mode-status' }); await spare.settled();
  assert.equal((await spare.request('get_messages')).messages.at(-1).content[0].text, 'Mode: agent · effort: high');
});

// Hold an ACP setter before sending it, without timing-dependent sleeps.
function holdSetter(client, method) {
  const request = client.request.bind(client);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  client.request = async (name, ...args) => {
    calls.push(name);
    if (name === method) {
      const error = await gate;
      if (error) throw error;
    }
    return request(name, ...args);
  };
  return { calls, release };
}

for (const configModels of [false, true]) {
  test(`pending Cursor model setter rejects overlapping prompts and changes (${configModels ? 'config' : 'legacy'})`, { timeout: 15000 }, async t => {
    const f = fixture(t, { configModels }); await f.desktop.start();
    const method = configModels ? 'session/set_config_option' : 'session/set_model';
    const held = holdSetter(f.client, method);
    const changing = f.desktop.request('set_model', { provider: 'cursor', modelId: 'cursor-test-b' });
    const before = f.desktop.messages().length;
    await assert.rejects(f.desktop.request('prompt', { message: 'must retry' }), /configuration is changing/);
    await assert.rejects(f.desktop.request('set_model', { provider: 'cursor', modelId: 'cursor-test-a' }), /configuration is changing/);
    if (configModels) {
      await assert.rejects(f.desktop.request('set_config_option', { configId: 'speed', value: true }), /configuration is changing/);
      await assert.rejects(f.desktop.request('set_thinking_level', { level: 'high' }), /configuration is changing/);
    }
    assert.deepEqual(held.calls, [method]);
    assert.equal(f.desktop.messages().length, before);
    assert.equal(f.desktop.streaming, false);
    await f.desktop.abort(); // No active turn: must not cancel or unlock the setter.
    assert.throws(() => f.desktop.prompt('still blocked'), /configuration is changing/);
    held.release(); await changing;
    assert.deepEqual(f.desktop.prompt('retry'), { disposition: 'started' });
    await f.desktop.turn;
    assert.equal(f.desktop.messages().at(-1).model, 'cursor-test-b');
    assert.match(f.desktop.messages().at(-1).content[0].text, /cursor-test-b/);
    await f.desktop.setModel('cursor-test-a');
    assert.equal(f.desktop.state().model.id, 'cursor-test-a');
  });
}

test('delayed Cursor config failure releases reservation and allows explicit retries', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true }); await f.desktop.start();
  const held = holdSetter(f.client, 'session/set_config_option');
  const changing = f.desktop.request('set_config_option', { configId: 'speed', value: true });
  const failed = assert.rejects(changing, /fixture setter failure/);
  await assert.rejects(f.desktop.request('set_config_option', { configId: 'reasoning-effort', value: 'high' }), /configuration is changing/);
  assert.throws(() => f.desktop.prompt('blocked'), /configuration is changing/);
  held.release(new Error('fixture setter failure')); await failed;
  assert.equal(f.desktop.state().cursorConfigOptions.find(option => option.id === 'speed').currentValue, false);
  // Replace the deliberately failed transport gate, then retry each operation.
  delete f.client.request;
  await assert.rejects(f.desktop.setConfigOption('speed', 'invalid'), /not available/);
  await f.desktop.setConfigOption('speed', true);
  await f.desktop.setModel('cursor-test-b');
  f.desktop.prompt('hold');
  await assert.rejects(f.desktop.setConfigOption('speed', false), /Wait for Cursor to finish before changing configuration/);
  await assert.rejects(f.desktop.setModel('cursor-test-a'), /Wait for Cursor to finish before switching models/);
  assert.throws(() => f.desktop.prompt('busy'), /Cursor is still working; stop the current turn first/);
  await f.desktop.abort();
  assert.equal(f.desktop.messages().at(-1).stopReason, 'aborted');
  await f.desktop.setConfigOption('speed', false);
  f.desktop.prompt('recovered'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).stopReason, 'stop');
});

test('context reflects only real ACP usage, including idle updates and history restore', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  assert.equal((await f.desktop.request('get_session_stats')).contextUsage, null);
  f.desktop.prompt('usage'); await f.desktop.turn;
  assert.deepEqual((await f.desktop.request('get_session_stats')).contextUsage, { tokens: 53000, contextWindow: 200000, percent: 26.5 });
  const update = value => f.desktop.notification({ method: 'session/update', params: { sessionId: f.desktop.sessionId, update: { sessionUpdate: 'usage_update', ...value } } });
  update({ used: -1, size: 100 });
  assert.equal(f.desktop.state().contextUsage.tokens, 53000);
  update({ used: 0, size: 100000 });
  assert.equal(f.desktop.state().contextUsage.percent, 0);
  const restored = new CursorDesktopSession({ client: new EventEmitter(), file: f.file, cwd: f.cwd, send: () => {} });
  assert.deepEqual(restored.state().contextUsage, { tokens: 0, contextWindow: 100000, percent: 0 });
});

test('Always Allow is passed unchanged and persisted by the native agent across restore', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  let questions = 0;
  f.desktop.send = event => {
    if (event.type !== 'extension_ui_request') return;
    questions++;
    assert.equal(event.permissionOptions[0].kind, 'allow_always');
    assert.equal(event.toolCall.locations[0].path, '/fixture/file');
    setImmediate(() => f.desktop.answer(event.id, { optionId: event.permissionOptions[0].optionId }));
  };
  f.desktop.prompt('permission-always'); await f.desktop.turn;
  await f.client.close();
  const client = new CursorAcp({ command: f.command, cwd: f.cwd }); t.after(() => client.close());
  const restored = new CursorDesktopSession({ client, file: f.file, cwd: f.cwd, send: f.desktop.send });
  await restored.start(); restored.prompt('permission-always'); await restored.turn;
  assert.equal(questions, 1);
  assert.equal(restored.messages().at(-1).content[0].text, 'Native remembered approval');
});

test('late permissions during cancellation receive cancelled without reopening dialogs', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  f.desktop.prompt('hold'); f.desktop.cancelling = true;
  const replies = [];
  const respond = f.client.respond.bind(f.client);
  f.client.respond = (id, result) => replies.push({ id, result });
  await f.desktop.clientRequest({ id: 999, method: 'session/request_permission', params: { sessionId: f.desktop.sessionId, options: [] } });
  assert.deepEqual(replies, [{ id: 999, result: { outcome: { outcome: 'cancelled' } } }]);
  assert.equal(f.desktop.dialogs.size, 0);
  f.client.respond = respond;
  await f.desktop.abort();
});

test('Cursor history resumes the same native session and ignores session/load replay', { timeout: 15000 }, async t => {
  const f = fixture(t);
  await f.desktop.start(); f.desktop.prompt('first'); await f.desktop.turn;
  await f.client.close();
  const client = new CursorAcp({ command: f.command, cwd: f.cwd }); t.after(() => client.close());
  const next = new CursorDesktopSession({ client, file: f.file, cwd: f.cwd, send: () => {} });
  await next.start();
  assert.equal(next.sessionId, f.desktop.sessionId);
  assert.equal(next.messages().length, 2);
  next.prompt('second'); await next.turn;
  assert.equal(next.messages().length, 4);
  assert.ok(!JSON.stringify(next.messages()).includes('REPLAY MUST BE IGNORED'));
});

test('Cursor tool execution, permission and questions use normal desktop events', { timeout: 15000 }, async t => {
  const f = fixture(t);
  await f.desktop.start();
  f.desktop.prompt('tool'); await f.desktop.turn;
  assert.equal(f.events.filter(e => e.type === 'tool_execution_start').length, 1);
  assert.equal(f.events.filter(e => e.type === 'tool_execution_end').length, 1);
  assert.equal(f.desktop.messages().at(-1).role, 'toolResult');
  assert.equal(readFileSync(join(f.cwd, 'cursor-output.md'), 'utf8'), '# Cursor output\n');
  for (const prompt of ['permission', 'question', 'plan']) {
    f.desktop.send = event => {
      f.events.push(structuredClone(event));
      if (event.type === 'extension_ui_request') setImmediate(() => f.desktop.answer(event.id, event.method === 'confirm' ? { confirmed: true } : { value: event.options[0] }));
    };
    f.desktop.prompt(prompt); await f.desktop.turn;
    assert.equal(f.desktop.messages().at(-1).stopReason, 'stop');
  }
  assert.ok(f.desktop.messages().some(m => m.content?.[0]?.text === 'Permission: allow-read'));
  assert.ok(f.desktop.messages().some(m => m.content?.[0]?.text === 'Question: answered'));
  assert.ok(f.desktop.messages().some(m => m.content?.[0]?.text === 'Plan: accepted'));
});

test('Cursor abort settles a turn, rejects overlaps and leaves the connection reusable', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  f.desktop.prompt('hold');
  assert.throws(() => f.desktop.prompt('overlap'), /still working/);
  await assert.rejects(f.desktop.setModel('cursor-test-b'), /finish/);
  await f.desktop.abort();
  assert.equal(f.desktop.messages().at(-1).stopReason, 'aborted');
  assert.equal(f.desktop.streaming, false);
  f.desktop.prompt('after abort'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).stopReason, 'stop');
  await assert.rejects(f.desktop.request('clone'), /not available/);
  assert.throws(() => f.desktop.prompt('/goal pretend'), /not available/);
});

test('cancelling a pending Cursor permission clears desktop and relay question state', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  let requested;
  const question = new Promise(resolve => { requested = resolve; });
  f.desktop.send = event => { f.events.push(structuredClone(event)); if (event.type === 'extension_ui_request') requested(event); };
  f.desktop.prompt('permission'); await question;
  await f.desktop.abort();
  assert.equal(f.desktop.dialogs.size, 0);
  assert.ok(f.events.some(event => event.type === 'cursor_questions_cleared'));
  assert.equal(f.desktop.streaming, false);
});

test('Cursor close releases inherited pipes even when a detached helper retains them', { timeout: 7000 }, async () => {
  const client = new CursorAcp({ command: 'unused', cwd: '/tmp' });
  const child = new EventEmitter(), signals = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { signals.push(signal); return true; };
  // Model a direct process which has exited but cannot emit close until its pipes close.
  child.stderr.once('close', () => { if (child.stdout.destroyed) child.emit('close'); });
  client.child = child;
  client.exit = new Promise(resolve => child.once('close', resolve));
  await client.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});

test('Cursor EOF is an error, never successful completion', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.desktop.start();
  f.desktop.prompt('crash'); await f.desktop.turn;
  assert.equal(f.desktop.messages().at(-1).stopReason, 'error');
  assert.match(f.desktop.messages().at(-1).errorMessage, /offline cursor crash/);
  assert.equal(f.desktop.streaming, false);
});
