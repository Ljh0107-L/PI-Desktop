// The real pinned CLI, not the mock ACP peer. CI only. Synthetic invalid keys test
// the pre-authenticated routing branch; no authenticate, session/new, prompt, key
// exchange or inference requests are sent. This does not validate a real account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CursorAcp } from '../agent/cursor-acp.mjs';
import { CursorRuntime } from '../app/main/cursor-runtime.mjs';
import { CURSOR_RUNTIME_VERSION } from '../core/cursor-release.mjs';
import { sshBaseArgs } from '../app/main/remote-setup.mjs';
import { shellQuote } from '../core/transports.mjs';

if (process.env.CI) {
  const root = '/tmp/pidesk-e2e/cursor-official';
  await rm(root, { recursive: true, force: true });
  const home = join(root, 'home');
  await mkdir(join(home, '.local/bin'), { recursive: true });
  const grok = join(home, 'grok-placeholder');
  await writeFile(grok, '#!/bin/sh\nexit 77\n', { mode: 0o755 });
  const alias = join(home, '.local/bin/agent');
  await symlink(grok, alias);
  const runtime = new CursorRuntime({ cacheDir: join(root, 'cache'), localRoot: join(root, 'managed') });
  const command = await runtime.ensure({ id: 'local', kind: 'local' }, {}, message => console.log(message));
  assert.equal(await readlink(alias), grok, 'installing Cursor must not replace the Grok alias');
  const client = new CursorAcp({ command, cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: root, LANG: 'en_US.UTF-8', AGENT_CLI_CREDENTIAL_STORE: 'memory' } });
  const methods = [];
  const send = client.send.bind(client);
  client.send = message => { if (message.method) methods.push(message.method); return send(message); };
  try {
    const initialized = await client.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(initialized.authMethods?.some(method => method.id === 'cursor_login'));
    assert.deepEqual(methods, ['initialize']);
    assert.equal(await readlink(alias), grok, 'running ACP must not replace the Grok alias either');
    console.log(`PASS official Cursor ${CURSOR_RUNTIME_VERSION}: verified download, private install, no-TTY ACP initialize, no credentials or inference`);
  } finally { await client.close(); }

  const syntheticKey = 'cursor-ci-synthetic-invalid-key';
  const keyClient = new CursorAcp({ command, cwd: home, apiKey: syntheticKey, env: { HOME: home, PATH: process.env.PATH } });
  const keyMethods = [];
  const keySend = keyClient.send.bind(keyClient);
  keyClient.send = message => { if (message.method) keyMethods.push(message.method); return keySend(message); };
  try {
    await keyClient.start();
    const listed = await keyClient.request('session/list', { cwd: home });
    assert.ok(Array.isArray(listed.sessions));
    assert.deepEqual(keyMethods, ['initialize', 'session/list'], 'API-key startup must not enter cursor_login browser authentication');
    console.log('PASS official Cursor API-key routing: initialize + local session listing only; no browser login or account validation');
  } finally { await keyClient.close(); }

  // Exercise the real SSH upload path and official ACP startup as well. The throwaway
  // sshd is on this runner; its shared filesystem allows the client's static identity
  // check, while installation and program execution go through SSH.
  const remote = { id: 'ssh:cursor-official', kind: 'ssh', host: 'pidesk-test', sshArgs: ['-F', '/tmp/pidesk-e2e/ssh_config'] };
  const remoteCommand = await runtime.ensure(remote, { root: join(root, 'remote'), node: process.execPath }, message => console.log(message));
  const sshClient = new CursorAcp({ command: remoteCommand, cwd: home, apiKey: syntheticKey, env: { HOME: home, PATH: process.env.PATH, AGENT_CLI_CREDENTIAL_STORE: 'memory' },
    spawnProcess: (command, args, options) => {
      const script = `IFS= read -r CURSOR_API_KEY; export CURSOR_API_KEY; cd ${shellQuote(home)} && exec ${['env', '-u', 'CURSOR_AUTH_TOKEN', `HOME=${home}`, 'NO_OPEN_BROWSER=1', 'AGENT_CLI_CREDENTIAL_STORE=memory', command, ...args].map(shellQuote).join(' ')}`;
      const child = spawn('ssh', [...sshBaseArgs(remote), remote.host, script], options);
      child.stdin.write(syntheticKey + '\n'); // private stdin, never argv
      return child;
    },
  });
  const sshMethods = [];
  const sshSend = sshClient.send.bind(sshClient);
  sshClient.send = message => { if (message.method) sshMethods.push(message.method); return sshSend(message); };
  try {
    const initialized = await sshClient.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(initialized.authMethods?.some(method => method.id === 'cursor_login'));
    assert.equal(await readlink(alias), grok);
    assert.ok(Array.isArray((await sshClient.request('session/list', { cwd: home })).sessions));
    assert.deepEqual(sshMethods, ['initialize', 'session/list']);
    console.log(`PASS official Cursor ${CURSOR_RUNTIME_VERSION}: real SSH install and API-key routing without interactive authentication or inference`);
  } finally { await sshClient.close(); }
} else console.log('SKIP official Cursor startup probe (GitHub CI only)');
