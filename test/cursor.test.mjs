import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CursorAcp, cursorCommand, cursorEnvironment, cursorModels } from '../agent/cursor-acp.mjs';
import { CursorDesktopSession } from '../agent/pidesk-cursor.mjs';
import { branchMessages } from '../app/main/session-manager.mjs';
import { mockCursorCommand } from './cursor-fixture.mjs';

function fixture(t, { configModels = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pidesk-cursor-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const command = mockCursorCommand(cwd, configModels ? ['--config-models'] : []);
  const file = join(cwd, 'history/session.jsonl');
  const events = [];
  const client = new CursorAcp({ command, cwd });
  t.after(() => client.close());
  const desktop = new CursorDesktopSession({ client, file, cwd, send: event => events.push(structuredClone(event)) });
  return { cwd, command, file, events, client, desktop };
}

// These execute only in GitHub CI; the peer and models are offline fixtures.
test('Cursor environment excludes Pi boot credentials and Electron Node mode', () => {
  const env = cursorEnvironment({ PATH: '/bin', HOME: '/home/user', PIDESK_BOOT: 'secret', ANTHROPIC_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', CURSOR_AUTH_TOKEN: 'cursor-login' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/user', CURSOR_AUTH_TOKEN: 'cursor-login', NO_OPEN_BROWSER: '1', AGENT_CLI_CREDENTIAL_STORE: 'memory' });
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
  assert.deepEqual(f.desktop.state().cursorConfigOptions.map(option => option.id), ['model-choice']);
  await assert.rejects(f.desktop.request('set_thinking_level', { level: 'high' }), /does not advertise/);
  await assert.rejects(f.desktop.request('set_config_option', { configId: 'speed', value: true }), /not available/);
  assert.ok(f.events.some(event => event.type === 'cursor_model_changed' && event.cursorConfigOptions));
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
