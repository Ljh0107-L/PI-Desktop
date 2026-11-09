import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import pideskBridge, { runtimeNote, setupRuntimeEnvironment, workingNote } from '../agent/pidesk-bridge.js';

// Child-process checks are deliberately CI-only. They never launch Electron or a GUI:
// the Electron case uses either a shell fixture or the CI runner's actual Node binary.
const ciOnly = { skip: !['1', 'true'].includes(process.env.CI) };
const posixOnly = { skip: process.platform === 'win32' };
const ciPosixOnly = { skip: ciOnly.skip || posixOnly.skip };
const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pidesk runtime ' quoted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { PATH: '/usr/bin:/bin', PI_CODING_AGENT_DIR: join(root, "agent's settings") } };
}
function executable(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o700 });
  return path;
}
function run(node, args, options = {}) {
  const result = spawnSync(node, args, { encoding: 'utf8', timeout: 10000, ...options });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test('actual Node setup only appends its directory, retains PATH order and is idempotent', t => {
  const { root, env } = fixture(t);
  env.PATH = [join(root, 'preferred node'), '/usr/bin', '', '/bin'].join(delimiter);
  const original = env.PATH;
  const result = setupRuntimeEnvironment({ env, electron: false });
  assert.equal(result.ready, true);
  assert.equal(result.node, process.execPath);
  assert.equal(env.PI_NODE, process.execPath);
  assert.equal(env.PATH, original.split(delimiter).includes(dirname(process.execPath)) ? original : original + delimiter + dirname(process.execPath));
  const once = env.PATH;
  assert.deepEqual(setupRuntimeEnvironment({ env, electron: false }), result);
  assert.equal(env.PATH, once);
  assert.equal(existsSync(env.PI_CODING_AGENT_DIR), false, 'real Node setup does not write a shim or settings');
});

test('existing fallback position, empty PATH entries and missing PATH are preserved', t => {
  const { env } = fixture(t);
  env.PATH = `${dirname(process.execPath)}${delimiter}/preferred/bin`;
  const original = env.PATH;
  setupRuntimeEnvironment({ env, electron: false });
  assert.equal(env.PATH, original);
  env.PATH = '';
  setupRuntimeEnvironment({ env, electron: false });
  assert.equal(env.PATH, delimiter + dirname(process.execPath));
  delete env.PATH;
  setupRuntimeEnvironment({ env, electron: false });
  assert.equal(env.PATH, dirname(process.execPath));
});

test('Electron shim is private, scoped, quoted, idempotent and contains no boot credentials', posixOnly, t => {
  const { root, env } = fixture(t);
  const execPath = executable(join(root, "Pi Desktop's app", 'Electron Helper'), '#!/bin/sh\nexit 0\n');
  env.PIDESK_BOOT = '{"apiKey":"never-write-this-key"}';
  env.ELECTRON_RUN_AS_NODE = 'unchanged-parent-value';
  const original = env.PATH;
  const result = setupRuntimeEnvironment({ env, execPath, electron: true });
  assert.equal(result.ready, true);
  assert.equal(result.nodeOnPath, true);
  assert.equal(basename(result.node), 'node');
  assert.equal(env.PI_NODE, result.node);
  assert.equal(env.PATH, original + delimiter + dirname(result.node));
  assert.equal(env.ELECTRON_RUN_AS_NODE, 'unchanged-parent-value');
  assert.equal(lstatSync(result.node).mode & 0o777, 0o700);
  assert.equal(lstatSync(dirname(result.node)).mode & 0o777, 0o700);
  const content = readFileSync(result.node, 'utf8');
  assert.equal(content, `#!/bin/sh\n# Pi Desktop's private Node fallback.\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} "$@"\n`);
  assert.ok(!content.includes('never-write-this-key'));
  assert.ok(!content.includes('PIDESK_BOOT'));
  assert.deepEqual(readdirSync(dirname(result.node)), ['node'], 'does not supply npm or npx');
  const modified = lstatSync(result.node).mtimeMs;
  assert.deepEqual(setupRuntimeEnvironment({ env, execPath, electron: true }), result);
  assert.equal(lstatSync(result.node).mtimeMs, modified, 'do not rewrite identical wrappers');
  const secondExecutable = executable(join(root, 'Other app', 'Electron Helper'), '#!/bin/sh\nexit 0\n');
  const second = setupRuntimeEnvironment({ env: { ...env }, execPath: secondExecutable, electron: true });
  assert.notEqual(second.node, result.node, 'different app executables cannot replace another session shim');
  assert.equal(readFileSync(result.node, 'utf8'), content);
});

test('Electron shim forces node mode only for its invocation and forwards every argument', ciPosixOnly, t => {
  const { root, env } = fixture(t);
  const execPath = executable(join(root, 'App "quotes" $literal', "Electron's Helper"), '#!/bin/sh\nprintf \'%s\\000\' "$ELECTRON_RUN_AS_NODE" "$@"\nexit 17\n');
  const setup = setupRuntimeEnvironment({ env, execPath, electron: true });
  assert.equal(setup.ready, true);
  const args = ['', 'two words', "single'quote", '"double"', '$HOME', '*', '--', 'line\nbreak'];
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: 'not-one' };
  const child = run(setup.node, args, { env: childEnv });
  assert.equal(child.status, 17, child.stderr);
  assert.deepEqual(child.stdout.split('\0'), ['1', ...args, '']);
  assert.equal(childEnv.ELECTRON_RUN_AS_NODE, 'not-one');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

test('CI Node CLI semantics survive both direct runtime and simulated Electron shim', ciPosixOnly, t => {
  for (const electron of [false, true]) {
    const { root, env } = fixture(t);
    const setup = setupRuntimeEnvironment({ env, electron });
    assert.equal(setup.ready, true);
    assert.equal(run(setup.node, ['--version'], { env }).stdout.trim(), process.version);
    assert.equal(run(setup.node, ['-p', '6 * 7'], { env }).stdout.trim(), '42');
    const args = ['with spaces', "quoted'value", '--option', '', '$literal'];
    const evaluated = run(setup.node, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args], { env });
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.deepEqual(JSON.parse(evaluated.stdout), args);
    const file = join(root, "script's name.cjs");
    writeFileSync(file, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    assert.deepEqual(JSON.parse(run(setup.node, [file, ...args], { env }).stdout), args);
    assert.equal(run(setup.node, ['-'], { env, input: 'console.log(42)' }).stdout.trim(), '42');
    assert.equal(run(setup.node, ['-e', 'process.exit(23)'], { env }).status, 23);
    assert.notEqual(run(setup.node, ['--definitely-not-a-node-option'], { env }).status, 0);
    const bash = run('/bin/sh', ['-c', '"$PI_NODE" -p "6 * 7"'], { env });
    assert.equal(bash.stdout.trim(), '42');
    const fallbackOnly = run('/bin/sh', ['-c', 'node -p "6 * 7"'], { env: { ...env, PATH: dirname(setup.node) } });
    assert.equal(fallbackOnly.status, 0, fallbackOnly.stderr);
    assert.equal(fallbackOnly.stdout.trim(), '42');
  }
});

test('PATH keeps an existing node ahead of the fallback while PI_NODE selects bundled runtime', ciPosixOnly, t => {
  const { root, env } = fixture(t);
  const preferred = join(root, 'preferred bin');
  executable(join(preferred, 'node'), '#!/bin/sh\nprintf preferred-node\n');
  env.PATH = preferred;
  const setup = setupRuntimeEnvironment({ env, electron: true });
  assert.equal(setup.ready, true);
  assert.equal(run('/bin/sh', ['-c', 'node'], { env }).stdout, 'preferred-node');
  assert.equal(run('/bin/sh', ['-c', '"$PI_NODE" -p "40 + 2"'], { env }).stdout.trim(), '42');
  assert.notEqual(run('/bin/sh', ['-c', 'command -v npm; command -v npx'], { env }).status, 0);
});

test('failure clears stale PI_NODE, leaves PATH intact and never includes credentials or raw errors', posixOnly, t => {
  const { root, env } = fixture(t);
  const secret = 'private-api-key-do-not-serialize';
  env.PI_NODE = '/stale/runtime';
  env.PIDESK_BOOT = secret;
  const original = env.PATH;
  const missing = setupRuntimeEnvironment({ env, execPath: join(root, secret), electron: true });
  assert.deepEqual(missing, { ready: false, diagnostic: 'runtime executable: ENOENT' });
  assert.equal(env.PI_NODE, undefined);
  assert.equal(env.PATH, original);
  assert.ok(!JSON.stringify(missing).includes(secret));
  assert.ok(!runtimeNote(missing).includes(secret));
  assert.match(runtimeNote(missing), /Do not assume node or PI_NODE works/);
  writeFileSync(join(root, 'not-a-directory'), secret);
  env.PI_CODING_AGENT_DIR = join(root, 'not-a-directory');
  const blocked = setupRuntimeEnvironment({ env, electron: true });
  assert.equal(blocked.ready, false);
  assert.match(blocked.diagnostic, /^Electron shim: (ENOTDIR|EEXIST)$/);
  assert.equal(env.PATH, original);
  assert.equal(readFileSync(join(root, 'not-a-directory'), 'utf8'), secret);
});

test('insecure shim directories and symlinked runtime roots are rejected without modifying targets', posixOnly, t => {
  const { root, env } = fixture(t);
  const result = setupRuntimeEnvironment({ env, electron: true });
  assert.equal(result.ready, true);
  chmodSync(dirname(result.node), 0o777);
  const rejected = setupRuntimeEnvironment({ env, electron: true });
  assert.deepEqual(rejected, { ready: false, diagnostic: 'Electron shim: EACCES' });
  chmodSync(dirname(result.node), 0o700);
  const other = join(root, 'other settings');
  const target = join(root, 'unrelated');
  mkdirSync(other); mkdirSync(target);
  symlinkSync(target, join(other, 'runtime'));
  const symlinked = setupRuntimeEnvironment({ env: { PI_CODING_AGENT_DIR: other }, electron: true });
  assert.deepEqual(symlinked, { ready: false, diagnostic: 'Electron shim: EACCES' });
  assert.deepEqual(readdirSync(target), []);
});

test('paths unrepresentable in PATH retain a working absolute PI_NODE without a false node claim', posixOnly, t => {
  const { root, env } = fixture(t);
  env.PI_CODING_AGENT_DIR = join(root, 'settings:colon');
  const original = env.PATH;
  const result = setupRuntimeEnvironment({ env, electron: true });
  assert.equal(result.ready, true);
  assert.equal(result.nodeOnPath, false);
  assert.equal(env.PATH, original);
  accessSync(env.PI_NODE, constants.X_OK);
  assert.ok(!runtimeNote(result).includes('through node and'));
});

test('runtime prompt facts are accurate and confer no test, install or GUI permissions', () => {
  const prompt = runtimeNote({ ready: true, node: "/private/Pi's app/node", nodeOnPath: true });
  assert.match(prompt, /node and/);
  assert.match(prompt, /"\$PI_NODE"/);
  assert.match(prompt, /does not supply npm or npx/);
  assert.match(prompt, /not permission/);
  assert.match(prompt, /no local tests or GUI launches/);
  assert.match(prompt, /CI\/SSH-only/);
  assert.match(prompt, /bounded lookup/);
  assert.match(prompt, /not a filesystem-wide find \/ search/);
  assert.match(runtimeNote(null), /session setup has not run/);
});

test('the working-style note: an assessment for a question, accurate reports, and a confirmation before what can\'t be undone, except in Ultra', () => {
  const note = workingNote();
  assert.match(note, /describes a problem without asking for a change, the answer is your assessment: say what you found, then stop/);
  assert.match(note, /a decision the user made stays made/);
  assert.match(note, /show the output of a failing test, mention any step you skipped/);
  assert.match(note, /fits the code around it/);
  assert.match(note, /confirm with the user unless they or the project's instructions already said to go ahead/);
  assert.match(note, /Send tool calls that don't depend on each other together, in one step/);
  assert.doesNotMatch(note, /instead of cat|dedicated tool/, 'Pi\'s own rules already cover its file tools');
  const unattended = workingNote({ unattended: true });
  assert.doesNotMatch(unattended, /confirm with the user/, 'nobody is there to confirm in Ultra');
  assert.match(unattended, /Look at what you are about to delete or overwrite before you do it/);
  assert.equal(unattended.split('\n').length, note.split('\n').length);
  assert.ok(note.length < 1400, 'a short section');
});

test('bridge waits for session_start and adds runtime metadata without replacing other sections', t => {
  const { env } = fixture(t);
  const keys = ['PATH', 'PI_NODE', 'PI_CODING_AGENT_DIR', 'PIDESK_BOOT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  delete process.env.PIDESK_BOOT;
  process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  const originalPath = process.env.PATH;
  const handlers = new Map();
  pideskBridge({
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    registerTool() {}, registerProvider() {}, registerCommand() {},
  });
  assert.equal(process.env.PATH, originalPath, 'factory must not initialize runtime resources');
  const before = { systemPromptOptions: { sections: { existing: 'unchanged' } } };
  for (const handler of handlers.get('before_agent_start')) handler(before);
  assert.match(before.systemPromptOptions.sections.runtime, /session setup has not run/);
  const ctx = { ui: { setStatus() {} }, sessionManager: { getBranch: () => [] } };
  for (const handler of handlers.get('session_start')) handler({}, ctx);
  for (const handler of handlers.get('before_agent_start')) handler(before);
  assert.equal(before.systemPromptOptions.sections.existing, 'unchanged');
  assert.match(before.systemPromptOptions.sections.runtime, /Node is available/);
  assert.ok(before.systemPromptOptions.sections.subagents);
  assert.equal(before.systemPromptOptions.sections.working_style, workingNote());
  assert.equal(before.systemPrompt, undefined);
  for (const handler of handlers.get('session_shutdown')) handler({});
});
