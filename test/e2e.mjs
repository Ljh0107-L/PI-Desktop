// End-to-end test of Pi Desktop driven through its real UI with Playwright.
// Offline mock model + a real SSH connection to a throwaway sshd (m0/test-sshd.sh).
//
//   sh m0/test-sshd.sh &            # provides host alias "pidesk-test"
//   npx vite build && node test/e2e.mjs [--shots dir]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch, shot } from './harness.mjs';
import { startMockLlm } from '../m0/mock-llm.mjs';

const { values: opts } = parseArgs({ options: { shots: { type: 'string', default: '/tmp/pidesk-e2e/shots' }, 'ssh-config': { type: 'string', default: '/tmp/pidesk-sshd/ssh_config' } } });
const work = '/tmp/pidesk-e2e';
rmSync(join(work, 'profile'), { recursive: true, force: true });
const localProject = join(work, 'projects/demo-app');
const remoteProject = join(work, 'remote/api-server');
for (const dir of [localProject, remoteProject]) mkdirSync(dir, { recursive: true });
writeFileSync(join(localProject, 'README.md'), '# demo-app\n');
for (const f of ['denied.txt', 'notes/plan.md']) rmSync(join(localProject, f), { force: true });
for (const f of ['survived.txt', 'after-quit.txt']) rmSync(join(remoteProject, f), { force: true });
// Simulate the network dropping: kill this machine's ssh client for the remote session's relay connection.
const dropSsh = () => { try { execFileSync('pkill', ['-f', 'pidesk-test.*pidesk-relay.mjs attach']); return true; } catch { return false; } };

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const mock = await startMockLlm({ chunkDelay: 25 });
const env = { PIDESK_SSH_CONFIG: opts['ssh-config'], PIDESK_TEST_PICK_FOLDER: localProject };
const profile = join(work, 'profile');
rmSync(profile, { recursive: true, force: true });
// Let compaction summarize even this short test conversation (Pi keeps the last 20K tokens by default).
mkdirSync(join(profile, 'agent'), { recursive: true });
writeFileSync(join(profile, 'agent', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));
let { app, page } = await launch({ userData: profile, env });
const S = name => shot(page, opts.shots, name);
const composer = () => page.locator('.composer textarea');
async function send(text) { await composer().fill(text); await composer().press('Enter'); }
const waitText = (selector, text, timeout = 60000) => page.locator(selector, { hasText: text }).last().waitFor({ timeout });
// Wait for one more match than there is now (earlier messages may contain the same text).
async function waitNew(selector, text, action, timeout = 60000) {
  const count = await page.locator(selector, { hasText: text }).count();
  await action();
  await page.waitForFunction(([sel, t, n]) => [...document.querySelectorAll(sel)].filter(e => e.textContent.includes(t)).length > n, [selector, text, count], { timeout });
}

try {
  await page.waitForTimeout(400);
  await S('01-welcome');

  // ---- add a provider through Settings
  await page.click('.settings-button');
  await page.click('.add-button:has-text("Add provider")');
  await page.click('.segmented button:has-text("Custom endpoint")');
  await page.fill('label.field:has-text("Name") input', 'Mock Lab');
  await page.fill('label.field:has-text("Base URL") input', mock.baseUrl('mock-lab'));
  await page.fill('label.field:has-text("API key") input', 'sk-e2e-secret');
  // fetch the provider's model list and pick two of them, then tune one
  await page.click('.model-catalog .link-button:has-text("Choose models")');
  await page.locator('.modal .pick-row', { hasText: 'gamma-embed' }).waitFor({ timeout: 30000 });
  await page.click('.modal-foot .link-button:has-text("Select all")');
  const allCount = await page.locator('.picker-count').innerText();
  await page.click('.modal-foot .link-button:has-text("Deselect all")');
  const noneCount = await page.locator('.picker-count').innerText();
  check('model picker: select all / deselect all', allCount === '3 of 3' && noneCount === '0 of 3', `${allCount} / ${noneCount}`);
  await page.click('.modal .pick-row:has-text("alpha-1")');
  await page.click('.modal .pick-row:has-text("beta-1")');
  await S('02a-model-picker');
  await page.click('.modal-foot .button.primary');
  await page.locator('.model-entry').nth(1).locator('.icon-button').first().click();
  await page.locator('.model-advanced label.field:has-text("Context window") input').fill('200K');
  await page.click('.model-advanced .button:has-text("Add level")');
  await page.locator('.level-row input').first().fill('low');
  await S('02-add-provider');
  await page.click('form.editor button[type=submit]');
  await page.locator('.row-card', { hasText: 'Mock Lab' }).waitFor();
  await page.locator('.row-card', { hasText: '2 models' }).waitFor({ timeout: 30000 });
  const savedSettings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  const beta = savedSettings.providers.find(p => p.name === 'Mock Lab')?.models?.find(m => m.id === 'beta-1');
  check('provider added via Settings: two models picked, parameters saved', (await page.locator('.row-card', { hasText: 'Mock Lab' }).innerText()).includes('2 models') && beta?.contextWindow === 204800 && beta?.thinkingLevelMap?.minimal === 'low', JSON.stringify({ cw: beta?.contextWindow, map: beta?.thinkingLevelMap }));
  await S('03-providers');
  // ---- add the SSH connection the way Codex does: pick it from ~/.ssh/config
  await page.click('.settings-sidebar-nav .nav-item:has-text("Connections")');
  await page.click('.section-head .button.pill');
  await page.fill('.modal .search-field input', 'pidesk');
  await page.click('.pick-row:has-text("pidesk-test")');
  await S('03b-add-connection');
  await page.click('.modal-foot .button.primary');
  await page.locator('.connection.ready', { hasText: 'pidesk-test' }).waitFor({ timeout: 300000 });
  check('SSH connection added from ssh config and set up automatically', true);
  await S('03c-connections');
  await page.click('.nav-item.back');

  // ---- local session
  await page.click('.trigger:has-text("Choose folder")');
  await page.click('.menu-item:has-text("Choose a folder")');
  await page.locator('.trigger', { hasText: 'demo-app' }).waitFor();
  check('model chip shows first model', await page.locator('.model-trigger').innerText() === 'alpha-1');
  await send('hello from the desktop');
  await waitText('.markdown', '[mock-lab/alpha-1] echo: hello from the desktop');
  check('local session streamed a reply', true);
  await page.locator('.usage-table').waitFor({ timeout: 15000 });
  const usageText = await page.locator('.usage').innerText();
  check('right panel Usage card shows tok/s and input / cached / output', /tok\/s/.test(usageText) && /Input/.test(usageText) && /Cached/.test(usageText) && /Output/.test(usageText), usageText.replace(/\s+/g, ' '));
  check('nothing under the composer but model controls', !(await page.locator('.session-meter').count()));
  // a model that reasons privately: no fake speed, a "Thought for" row with its reasoning tokens
  await waitNew('.markdown', 'echo:', () => send('[[hidden-think]] ponder this'));
  await page.locator('.thinking', { hasText: 'Thought for' }).last().waitFor({ timeout: 15000 });
  const hiddenRow = await page.locator('.thinking', { hasText: 'Thought for' }).last().innerText();
  const tpsAfter = Number((await page.locator('.usage-speed-value b').innerText()).replace(/[^\d.]/g, ''));
  check('hidden reasoning shown as "Thought for…" and speed not inflated', /^Thought for \d+s$/.test(hiddenRow.trim()) && tpsAfter > 0 && tpsAfter < 600, `${hiddenRow.replace(/\s+/g, ' ')} · ${tpsAfter} tok/s`);
  await S('04b-usage-card');
  // Manual compaction from the conversation menu leaves a marker with the summary.
  for (const word of ['alpha', 'beta', 'gamma']) await waitNew('.markdown', `echo: ${word} `, () => send(`${word} `.repeat(300)));
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
  await page.click('.title-button');
  await page.click('.menu-item:has-text("Compact conversation")');
  await page.locator('.compaction', { hasText: 'Conversation compacted' }).waitFor({ timeout: 30000 });
  check('manual compaction shows a "Conversation compacted" marker', true);
  await S('04c-compacted');
  check('session listed under "demo-app · This computer"', await page.locator('.group-head', { hasText: 'demo-app' }).count() === 1);
  check('provider received the stored key', mock.requests.at(-1).authorization === 'Bearer sk-e2e-secret');

  await send('[[bash:echo hi-from-pi && pwd]]');
  await waitText('.markdown', 'Tool result: hi-from-pi');
  check('YOLO: command ran without any approval prompt', !(await page.locator('.question-card, .approval-card').count()));
  await page.click('.tool-group-head:has-text("Ran 1 command")');
  await page.click('.tool-call-head');
  check('tool output visible when expanded', (await page.locator('.tool-output').last().innerText()).includes(localProject.replace('/tmp', '')));

  await waitNew('.markdown', 'Tool result', () => send('[[write:notes/plan.md|# Plan\n- ship M1]]'));
  await page.locator('.panel-row.file', { hasText: 'plan.md' }).waitFor();
  // Claude-style file preview: open the output, rendered and as source, and browse the tree
  await page.locator('.panel-row.file', { hasText: 'plan.md' }).click();
  await page.locator('.file-pane .fp-markdown h1', { hasText: 'Plan' }).waitFor({ timeout: 15000 });
  check('file preview renders Markdown from Outputs', await page.locator('.fp-tab.active', { hasText: 'plan.md' }).count() === 1);
  await page.click('.fp-crumbs .tool-button');
  await page.locator('.fp-source', { hasText: '# Plan' }).waitFor();
  await page.locator('.fp-tree-row', { hasText: 'notes' }).waitFor();
  check('source view with line numbers and the folder tree', (await page.locator('.fp-gutter').innerText()).startsWith('1'));
  await S('05a-file-preview');
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  // a path written in a reply (inline code) opens the preview, like Claude
  await waitNew('.markdown code.file-ref', 'notes/plan.md', () => send('Plan is in `notes/plan.md` now'));
  await page.locator('.markdown code.file-ref', { hasText: 'notes/plan.md' }).last().click();
  await page.locator('.fp-tab.active', { hasText: 'plan.md' }).waitFor({ timeout: 10000 });
  check('file path in a reply opens the file preview', true);
  await page.click('.fp-tab-close');
  await page.locator('.fp-placeholder').waitFor();
  check('empty file pane keeps preview area and tree side by side', await page.locator('.fp-tree .fp-tree-row').count() > 0);
  await page.click('.fp-actions .tool-button[aria-label="Maximize files"]');
  check('file pane maximizes over the conversation', !(await page.locator('.session-main').isVisible()));
  await S('05b-files-empty-max');
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  check('write tool created the file and Outputs lists it', existsSync(join(localProject, 'notes/plan.md')) && readFileSync(join(localProject, 'notes/plan.md'), 'utf8').includes('ship M1'));

  // Pi asks a question with choices: answered by clicking an option
  await send('[[ask:Which database should the demo use?|Postgres,SQLite,No database]]');
  await page.locator('.question-card').waitFor();
  check('question card shows the options', (await page.locator('.question-option').allInnerTexts()).map(t => t.replace(/^\d+\s*/, '')).join('|') === 'Postgres|SQLite|No database');
  await S('04-question');
  await waitNew('.markdown', 'The user answered: SQLite', () => page.click('.question-option:has-text("SQLite")'));
  check('answer reached the model and is shown inline', await page.locator('.ask-block', { hasText: 'SQLite' }).count() === 1 && !(await page.locator('.question-card').count()));
  // free-text question answered from the message box
  await send('[[ask:What should the project be called?]]');
  await page.locator('.question-card input').waitFor();
  await waitNew('.markdown', 'The user answered: pi-desktop', () => send('pi-desktop'));
  check('free-text question answered from the composer', true);

  // switch model inside the session
  await page.locator('.model-trigger').click();
  await page.click('.model-menu .menu-item:has-text("beta-1")');
  await send('after switching models');
  await waitText('.markdown', '[mock-lab/beta-1] echo: after switching models');
  check('model switched mid-session', true);
  // Rotating a key in Settings must reach this already-running session (old conversations broke before).
  await page.click('.settings-button');
  await page.click('.settings-sidebar-nav .nav-item:has-text("Models")');
  await page.locator('.row-card', { hasText: 'Mock Lab' }).locator('button:has-text("Edit")').click();
  await page.fill('form.editor label.field:has-text("API key") input', 'sk-e2e-rotated');
  await page.click('form.editor button[type=submit]');
  await page.locator('form.editor').waitFor({ state: 'detached' });
  await page.click('.nav-item.back');
  await waitNew('.markdown', 'echo: after rotating the key', () => send('after rotating the key'));
  check('a running session picks up a rotated API key', mock.requests.at(-1).authorization === 'Bearer sk-e2e-rotated', mock.requests.at(-1).authorization);

  await composer().fill('Here is some code:\n```js\nconst answer = 42;\nfunction greet(name) { return `hi ${name}`; }\n```');
  await composer().press('Enter');
  await page.locator('.markdown .code-block').last().waitFor();
  check('code blocks are syntax highlighted with a copy button', await page.locator('.code-block .hljs-keyword').count() > 0 && await page.locator('.code-block .code-copy').count() > 0);
  await S('05-local-session');

  // ---- remote session over SSH
  await page.click('.nav-item.new');
  await page.click('.env-trigger');
  await page.waitForTimeout(300);
  await page.waitForTimeout(300);
  await S('06-environment-menu');
  await page.fill('.env-menu .menu-search', 'pidesk');
  await page.click('.menu-item:has-text("pidesk-test")');
  await page.locator('.bar-status').waitFor({ state: 'detached', timeout: 300000 }).catch(() => {});
  const prep = await page.evaluate(() => window.pidesk.invoke('prepareEnvironment', 'ssh:pidesk-test'));
  check('SSH host prepared (Pi installed under ~/.pidesk)', prep.ok, prep.ok ? `${prep.facts.hostname}, Node ${prep.facts.nodeVersion}, Pi ${prep.facts.piVersion}` : prep.error);
  await page.click('.trigger:has-text("Choose folder")');
  await page.click('.menu-item:has-text("Browse pidesk-test")');
  await page.locator('.browse-item').first().waitFor({ timeout: 30000 });
  await page.fill('.browse-path input', remoteProject);
  await page.click('.browse-path button');
  await page.waitForFunction(p => document.querySelector('.browse-path input')?.value.endsWith(p) && !document.querySelector('.browse-list .spinner'), '/remote/api-server');
  await page.waitForTimeout(300);
  await S('07-remote-browser');
  await page.click('button:has-text("Use this folder")');
  await page.locator('.trigger', { hasText: 'api-server' }).waitFor();
  await page.waitForTimeout(4000); // a Pi is pre-warmed on the host meanwhile
  await send('hello from the server ' + 'with a longer message so streaming takes a moment '.repeat(4));
  // While the remote session streams, switch to the local one and work there too.
  await page.locator('.session-row', { hasText: 'after switching' }).first().waitFor({ timeout: 1000 }).catch(() => {});
  const sentAt = Date.now();
  await waitText('.markdown', 'echo: hello from the server', 120000);
  check('first message on a pre-warmed SSH host starts without waiting for Pi', Date.now() - sentAt < 2500, `${Date.now() - sentAt} ms to first reply`);
  check('remote session streamed a reply over SSH', true);
  check('sidebar groups by project and machine', await page.locator('.group-head', { hasText: 'api-server' }).locator('text=pidesk-test').count() === 1);

  await waitNew('.markdown', 'Tool result', () => send('[[bash:hostname && pwd]]'));
  await page.click('.tool-group-head:has-text("Ran 1 command")');
  await page.click('.tool-call-head');
  check('remote command ran in the remote folder', (await page.locator('.tool-output').last().innerText()).includes('api-server'));
  await S('08-remote-session');

  // concurrent sessions: start a remote run, switch to local, run there, both complete
  await send('remote run ' + 'x'.repeat(300));
  await page.locator('.session-row').nth(1).click();
  await send('local run while remote works');
  await waitText('.markdown', 'echo: local run while remote works');
  await page.locator('.session-row').nth(0).click();
  await waitText('.markdown', 'echo: remote run');
  check('two sessions ran concurrently and switching kept both', true);

  // stop a long-running reply with the stop button
  await send('long ' + 'y'.repeat(3000));
  await page.locator('.send-button.stop').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.click('.send-button.stop');
  await page.locator('.block-notice', { hasText: 'Interrupted' }).last().waitFor({ timeout: 30000 });
  check('stop button aborts the running reply', !(await page.locator('.markdown', { hasText: 'y'.repeat(2900) }).count()));
  await S('09-sidebar-two-machines');
  await page.keyboard.press('Meta+k');
  await page.locator('.palette').waitFor();
  await page.waitForTimeout(300);
  await S('11-search-palette');
  await page.keyboard.press('Escape');

  // ---- the connection drops while Pi is waiting for an answer; the question comes back after reconnecting
  await send('[[ask:Keep going after the network drop?|Yes,No]]');
  await page.locator('.question-card').waitFor();
  check('dropped the SSH connection', dropSsh());
  await page.locator('.conn-banner', { hasText: 'Reconnecting' }).waitFor({ timeout: 15000 });
  await S('12-reconnecting');
  await page.locator('.conn-banner').waitFor({ state: 'detached', timeout: 60000 });
  await page.locator('.question-card').waitFor({ timeout: 30000 });
  check('reconnected automatically and the pending question came back', true);
  await waitNew('.markdown', 'The user answered: Yes', () => page.click('.question-option:has-text("Yes")'), 30000);
  check('answered after reconnecting', true);

  // ---- a command keeps running on the host through a drop; its events are replayed
  await send('[[bash:sleep 2 && echo survived | tee survived.txt]]');
  await page.locator('.tool-group-head .spinner').first().waitFor({ timeout: 15000 });
  dropSsh();
  await page.locator('.markdown', { hasText: 'Tool result: survived' }).waitFor({ timeout: 60000 });
  check('command finished during the drop and its result was replayed', existsSync(join(remoteProject, 'survived.txt')));
  await page.click('.main-tools .tool-button[aria-label="Files"]');
  await page.locator('.fp-tree-row', { hasText: 'survived.txt' }).click();
  await page.locator('.fp-source', { hasText: 'survived' }).waitFor({ timeout: 30000 });
  check('file preview reads files on the SSH host', true);
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');

  // ---- a command started just before quitting finishes on the host while the app is closed
  await send('[[bash:sleep 3 && echo after-quit | tee after-quit.txt]]');
  await page.locator('.tool-group-head .spinner').first().waitFor({ timeout: 15000 });
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0]);
  await S('zz-failure').catch(() => {});
}

// ---- restart: sessions and history come back
await app.close();
await new Promise(r => setTimeout(r, 4500));
check('remote command finished while the app was closed', existsSync(join(remoteProject, 'after-quit.txt')));
({ app, page } = await launch({ userData: profile, env }));
try {
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await waitText('.markdown', 'Tool result: after-quit', 90000);
  check('reopened remote session shows the reply produced while closed', true);
  await page.locator('.session-row').first().waitFor();
  check('sessions restored after restart', await page.locator('.session-row').count() === 2);
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click();
  await waitText('.markdown', '[mock-lab/alpha-1] echo: hello from the desktop', 90000);
  await waitText('.markdown', '[mock-lab/beta-1] echo: after switching models');
  check('history reloaded from the Pi session file', true);
  await page.waitForTimeout(500);
  await S('10-restored');
} catch (error) {
  check('restore failed', false, error.message.split('\n')[0]);
  await S('zz-restore-failure').catch(() => {});
}
const secretsFile = readFileSync(join(profile, 'secrets.json'), 'utf8');
check('settings never store the key in settings.json', !readFileSync(join(profile, 'settings.json'), 'utf8').includes('sk-e2e-secret') && !secretsFile.includes('sk-e2e-secret') && !readFileSync(join(profile, 'settings.json'), 'utf8').includes('sk-e2e-rotated') && !secretsFile.includes('sk-e2e-rotated'));
await app.close();
await mock.close();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${opts.shots}`);
process.exitCode = failed ? 1 : 0;
