// Dedicated offline Cursor UI coverage. Run only by GitHub CI after the normal E2E suite.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, root, shot } from './harness.mjs';
import { shellQuote } from '../core/transports.mjs';

const KEY = 'cursor-fixture-key-one', NEXT_KEY = 'cursor-fixture-key-two';
const work = '/tmp/pidesk-e2e/cursor';
rmSync(work, { recursive: true, force: true });
const profile = join(work, 'profile'), project = join(work, 'project');
mkdirSync(profile, { recursive: true }); mkdirSync(project, { recursive: true });
const command = join(work, 'mock cursor');
writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'test/fixtures/cursor-peer.mjs'))} --config-models --require-key "$@"\n`);
chmodSync(command, 0o700);
// Reuse only the isolated test-host install; never ~/.pidesk.
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ environments: { 'ssh:pidesk-test': { root: '/tmp/pidesk-e2e/remote-install', added: true, enabled: true } } }));
const env = { PIDESK_SSH_CONFIG: '/tmp/pidesk-e2e/ssh_config', PIDESK_TEST_PICK_FOLDER: project, PIDESK_DEFAULT_WORKSPACE: join(work, 'Pi'), PIDESK_FORCE_PI_UPLOAD: '1' };
let { app, page } = await launch({ userData: profile, env });
const ids = [];
const send = async text => { await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter'); };
const idle = () => page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
try {
  await page.click('.settings-button');
  await page.getByRole('button', { name: 'Cursor SDK', exact: true }).click();
  await page.getByLabel('Enable Cursor SDK').check();
  await page.getByLabel('Cursor API Key', { exact: true }).fill(KEY);
  await page.locator('.cursor-advanced summary').click();
  await page.getByLabel('Cursor CLI executable').fill(command);
  await page.getByRole('button', { name: 'Check connection and models', exact: true }).click();
  await page.locator('.cursor-model-list', { hasText: '2 models available' }).waitFor({ timeout: 90000 });
  assert.equal(await page.getByLabel('Cursor API Key', { exact: true }).getAttribute('type'), 'password');
  assert.equal(await page.getByLabel('Cursor API Key', { exact: true }).inputValue(), '');
  assert.equal(await page.evaluate(() => window.__pideskState().settings.cursor.hasKey), true);
  for (const file of ['settings.json', 'secrets.json']) assert.ok(!readFileSync(join(profile, file), 'utf8').includes(KEY), 'plaintext key must not be written to desktop settings/secrets');
  assert.ok(!JSON.stringify(await page.evaluate(() => window.__pideskState().settings)).includes(KEY), 'bootstrap/settings expose only key presence');
  assert.ok(await page.locator('.cursor-settings .row-meta').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).whiteSpace === 'normal' && node.scrollWidth <= node.clientWidth + 1)), 'Cursor setup instructions must wrap instead of being clipped');
  await shot(page, '/tmp/pidesk-e2e/shots', 'cursor-sdk-settings');
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  for (const environmentId of ['local', 'ssh:pidesk-test']) {
    if (environmentId !== 'local') {
      await page.click('.nav-item.new');
      await page.getByRole('button', { name: 'Environment', exact: true }).click();
      await page.locator('.env-menu .menu-item', { hasText: 'pidesk-test' }).first().click();
      await page.evaluate(async project => {
        const state = window.__pideskState();
        // Only the directory picker is bypassed; engine/model selection and chat are real UI.
        await window.pidesk.invoke('prepareEnvironment', state.draft.environmentId);
      }, project);
    }
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.popover .menu-item', { hasText: /^Cursor CLI$/ }).click();
    if (environmentId === 'local') {
      await page.getByRole('button', { name: 'Folder', exact: true }).click();
      await page.locator('.popover .menu-item', { hasText: 'Choose a folder' }).click();
    }
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.locator('.cursor-model-menu .menu-item', { hasText: 'Cursor Test B' }).click({ timeout: 90000 });
    await send(`hello ${environmentId}`);
    await page.locator('.session-main .markdown', { hasText: `Cursor (cursor-test-b): 回复 hello ${environmentId}` }).waitFor({ timeout: 90000 });
    await idle();
    const id = await page.evaluate(() => window.__pideskState().activeId); ids.push(id);
    const record = await page.evaluate(async id => (await window.pidesk.invoke('listSessions')).find(s => s.id === id), id);
    assert.equal(record.engine, 'cursor'); assert.equal(record.environmentId, environmentId);
    assert.equal(await page.locator('.effort-trigger').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit message', exact: true }).count(), 0);
    assert.equal(await page.locator('.usage-table').count(), 0, 'unreported usage must not be fabricated');
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.locator('.cursor-model-menu .menu-item', { hasText: 'Cursor Test A' }).click();
    await send('tool');
    await page.locator('.session-main .markdown', { hasText: 'Cursor (cursor-test-a): 回复 tool' }).waitFor(); await idle();
    await page.locator('.tool-group.work .tool-group-head').last().click();
    await page.locator('[data-tool-id="cursor-write"] .tool-call-head').click();
    await page.locator('[data-tool-id="cursor-write"] .step-open', { hasText: 'cursor-output.md' }).click();
    await page.locator('.fp-markdown h1', { hasText: 'Cursor output' }).waitFor();
    await page.getByRole('button', { name: 'Close files', exact: true }).click();
    await send('permission');
    await page.locator('.question-option', { hasText: 'Allow once' }).click();
    await page.locator('.session-main .markdown', { hasText: 'Permission: allow-read' }).waitFor(); await idle();
    await send('question');
    await page.locator('.question-option', { hasText: 'Blue' }).click();
    await page.locator('.session-main .markdown', { hasText: 'Question: answered' }).waitFor(); await idle();
    await send('hold');
    await page.locator('.session-main .markdown', { hasText: 'Waiting for cancellation' }).waitFor();
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await idle();
    await shot(page, '/tmp/pidesk-e2e/shots', `cursor-chat-${environmentId.replace(/\W/g, '-')}`);
    await page.reload();
    await page.locator('.session-row', { hasText: `hello ${environmentId}` }).click();
    await page.locator('.session-main .markdown', { hasText: 'Permission: allow-read' }).waitFor({ timeout: 90000 });
    await send(`after reload ${environmentId}`);
    await page.locator('.session-main .markdown', { hasText: `回复 after reload ${environmentId}` }).waitFor(); await idle();
  }
  // A real desktop restart detaches/reattaches through the durable relay.
  await app.close();
  ({ app, page } = await launch({ userData: profile, env }));
  await page.locator('.session-row', { hasText: 'hello ssh:pidesk-test' }).click();
  await page.locator('.session-main .markdown', { hasText: '回复 after reload ssh:pidesk-test' }).waitFor({ timeout: 90000 });
  await send('after desktop restart');
  await page.locator('.session-main .markdown', { hasText: '回复 after desktop restart' }).waitFor(); await idle();
  // Rotate without changing the desktop/native conversation identity or losing history.
  const beforeRotation = await page.evaluate(async () => {
    const id = window.__pideskState().activeId;
    return (await window.pidesk.invoke('listSessions')).find(s => s.id === id);
  });
  await page.click('.settings-button');
  await page.getByRole('button', { name: 'Cursor SDK', exact: true }).click();
  assert.match(await page.getByLabel('Cursor API Key', { exact: true }).getAttribute('placeholder'), /Key saved/);
  await page.getByLabel('Cursor API Key', { exact: true }).fill(NEXT_KEY);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.cursor-settings input[type="password"]')?.value === '');
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await send('auth-status');
  await page.locator('.session-main .markdown', { hasText: 'Credential: rotated' }).waitFor({ timeout: 90000 }); await idle();
  const afterRotation = await page.evaluate(async id => (await window.pidesk.invoke('listSessions')).find(s => s.id === id), beforeRotation.id);
  assert.equal(afterRotation.piSessionId, beforeRotation.piSessionId);
  assert.equal(afterRotation.piSessionFile, beforeRotation.piSessionFile);
  assert.ok(!readFileSync(afterRotation.piSessionFile, 'utf8').includes(NEXT_KEY), 'SSH transcript must never store credentials');
  await page.click('.settings-button');
  await page.getByRole('button', { name: 'Cursor SDK', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved key', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__pideskState().settings.cursor.hasKey), false);
  await page.getByRole('button', { name: 'Check connection and models', exact: true }).click();
  await page.locator('.cursor-settings .error', { hasText: 'Cursor API Key is missing or invalid' }).waitFor({ timeout: 90000 });
  console.log('PASS Cursor API-key entry, encrypted storage, local/SSH auth, rotation/removal, SDK models, tools, approvals, cancel and restart');
} catch (error) {
  await shot(page, '/tmp/pidesk-e2e/shots', 'zz-cursor-failure').catch(() => {});
  console.error(error);
  console.error(await page.locator('.toasts, .conn-banner, .cursor-model-menu .error').allInnerTexts().catch(() => []));
  process.exitCode = 1;
} finally {
  for (const id of ids) await page.evaluate(id => window.pidesk.invoke('deleteSession', id), id).catch(() => {});
  await app.close();
}
