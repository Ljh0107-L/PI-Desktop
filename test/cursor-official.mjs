// The actual pinned official CLI, not the mock ACP peer. CI only, no API key,
// authentication call, session/new, prompt, model request or inference quota.
import assert from 'node:assert/strict';
import { mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CursorAcp } from '../agent/cursor-acp.mjs';
import { CursorRuntime } from '../app/main/cursor-runtime.mjs';
import { CURSOR_RUNTIME_VERSION } from '../core/cursor-release.mjs';

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
  const client = new CursorAcp({ command, cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: root, LANG: 'en_US.UTF-8' } });
  const methods = [];
  const send = client.send.bind(client);
  client.send = message => { if (message.method) methods.push(message.method); return send(message); };
  try {
    const initialized = await client.start({ authenticate: false });
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(initialized.authMethods?.some(method => method.id === 'cursor_login'));
    assert.deepEqual(methods, ['initialize']);
    assert.equal(await readlink(alias), grok, 'running ACP must not replace the Grok alias either');
    console.log(`PASS official Cursor ${CURSOR_RUNTIME_VERSION}: verified download, private install, no-TTY ACP initialize, no credentials or inference`);
  } finally { await client.close(); }
} else console.log('SKIP official Cursor startup probe (GitHub CI only)');
