import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
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

test('official ACP initializes, advertises models, switches and streams exactly once', { timeout: 15000 }, async t => {
  const f = fixture(t);
  await f.desktop.start('cursor-test-b');
  assert.equal(f.desktop.models.length, 2);
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
  assert.equal(JSON.parse(stdout).models.length, 2);
});

test('Cursor model config options support grouped models and the standard setter', { timeout: 15000 }, async t => {
  const f = fixture(t, { configModels: true });
  await f.desktop.start('cursor-test-b');
  assert.equal(f.desktop.models.length, 2);
  assert.equal(f.desktop.state().model.id, 'cursor-test-b');
  await f.desktop.setModel('cursor-test-a');
  assert.equal(f.desktop.state().model.name, 'Cursor Test A');
  f.desktop.prompt('config model'); await f.desktop.turn;
  assert.match(f.desktop.messages().at(-1).content[0].text, /cursor-test-a/);
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
