// End-to-end test of Pi Desktop driven through its real UI with Playwright.
// Offline mock model + a real SSH connection to a throwaway sshd (test/sshd.sh).
//
//   sh test/sshd.sh &            # provides host alias "pidesk-test"
//   npx vite build && node test/e2e.mjs [--shots dir]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launch, shot } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';
import './transcript.mjs';
import './projectless.mjs';
import { checkReading } from './reading.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values: opts } = parseArgs({ options: { shots: { type: 'string', default: '/tmp/pidesk-e2e/shots' }, 'ssh-config': { type: 'string', default: '/tmp/pidesk-sshd/ssh_config' } } });
const work = '/tmp/pidesk-e2e';
rmSync(join(work, 'profile'), { recursive: true, force: true });
const localProject = join(work, 'projects/demo-app');
const remoteProject = join(work, 'remote/api-server');
const remoteInstall = join(work, 'remote-install');
for (const dir of [localProject, remoteProject]) mkdirSync(dir, { recursive: true });
writeFileSync(join(localProject, 'README.md'), '# demo-app\n');
for (const f of ['denied.txt', 'notes/plan.md', 'local-after-quit.txt']) rmSync(join(localProject, f), { force: true });
for (const f of ['survived.txt', 'after-quit.txt', 'subagent-result.txt', 'background-subagent-1.txt', 'background-subagent-2.txt']) rmSync(join(remoteProject, f), { force: true });
// Simulate the network dropping: kill this machine's ssh client for the remote session's relay connection.
const dropSsh = () => { try { execFileSync('pkill', ['-f', `pidesk-test.*${remoteInstall}/ext/pidesk-relay.mjs.*attach`]); return true; } catch { return false; } };

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const mock = await startMockLlm({ chunkDelay: 25 });
const attachFile = join(work, 'attach-notes.txt');
writeFileSync(attachFile, 'notes for Pi\n');
const defaultWorkspace = join(work, 'Pi');
const env = { PIDESK_SSH_CONFIG: opts['ssh-config'], PIDESK_TEST_PICK_FOLDER: localProject, PIDESK_TEST_PICK_FILES: attachFile, PIDESK_DEFAULT_WORKSPACE: defaultWorkspace };
// 1×1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const profile = join(work, 'profile');
rmSync(profile, { recursive: true, force: true });
// Let compaction summarize even this short test conversation (Pi keeps the last 20K tokens by default).
mkdirSync(join(profile, 'agent'), { recursive: true });
writeFileSync(join(profile, 'agent', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));
// Never install into (or stop a relay from) a developer's ~/.pidesk.
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ environments: { 'ssh:pidesk-test': { root: remoteInstall, added: false } } }));
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

  // ---- update button: progress while downloading, then "Update"
  await page.evaluate(() => window.pidesk.invoke('testUpdateStatus', { state: 'downloading', version: '9.9.9', progress: 0.42 }));
  await page.locator('.update-button.downloading', { hasText: '42%' }).waitFor({ timeout: 5000 });
  await S('01b-update-downloading');
  await page.evaluate(() => window.pidesk.invoke('testUpdateStatus', { state: 'ready', version: '9.9.9' }));
  await page.locator('button.update-button', { hasText: 'Update' }).waitFor({ timeout: 5000 });
  await S('01c-update-ready');
  check('update button shows download progress, then "Update"', true);
  await page.evaluate(() => window.pidesk.invoke('testUpdateStatus', { state: 'idle' }));

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
  await page.locator('.model-advanced label.check:has-text("Image") input').check();
  await page.click('.model-advanced .button:has-text("Add level")');
  await page.locator('.level-row input').first().fill('low');
  await S('02-add-provider');
  await page.click('form.editor button[type=submit]');
  await page.locator('.row-card', { hasText: 'Mock Lab' }).waitFor();
  await page.locator('form.editor').waitFor({ state: 'detached' });
  const savedSettings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  const provider = savedSettings.providers.find(p => p.name === 'Mock Lab');
  const beta = provider?.models?.find(m => m.id === 'beta-1');
  check('provider added via Settings: two models picked, parameters saved', provider?.models?.length === 2 && beta?.contextWindow === 204800 && beta?.thinkingLevelMap?.minimal === 'low', JSON.stringify({ cw: beta?.contextWindow, map: beta?.thinkingLevelMap }));
  const providerRow = page.locator('.row-card', { hasText: 'Mock Lab' });
  check('provider list omits model count and URL', !(await providerRow.locator('.row-meta').count()) && !(await providerRow.innerText()).includes(mock.baseUrl('mock-lab')));
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

  // ---- background pre-warm cancellation must not leak a red connection-closed toast
  for (let i = 0; i < 4; i++) {
    await page.evaluate(cwd => window.pidesk.invoke('prewarm', { environmentId: 'local', cwd }), i % 2 ? null : localProject);
  }
  await page.waitForTimeout(800);
  check('switching pre-warmed folders is silent', !(await page.evaluate(() => window.__pideskNoticeLog ?? [])).some(n => /connection closed|Session start cancelled/.test(n)));

  // ---- no folder: a session in the default workspace, like Codex and Claude
  check('new sessions default to "No folder"', (await page.locator('.folder-trigger').innerText()).includes('No folder'));
  await waitNew('.markdown', 'Tool result', () => send('[[bash:pwd]]'));
  await page.locator('.markdown', { hasText: 'pidesk-e2e/Pi' }).last().waitFor({ timeout: 15000 }).catch(() => {});
  const nfReply = await page.locator('.markdown', { hasText: 'Tool result' }).last().innerText();
  const nfGroups = await page.locator('.group-head').allInnerTexts();
  check('a session without a folder runs in the default workspace', nfReply.includes('/Pi') && nfGroups.some(g => g.includes('No folder')), JSON.stringify({ nfReply, nfGroups }));
  // As in Codex: <root>/<YYYY-MM-DD>/<slug of the first prompt>/ with work/ and outputs/.
  const nfPath = /(\/\S*\/Pi\/\d{4}-\d{2}-\d{2}\/bash-pwd)\b/.exec(nfReply)?.[1];
  check('a No-folder session gets its own directory named from its first prompt', !!nfPath && existsSync(join(nfPath, 'work')) && existsSync(join(nfPath, 'outputs')), nfPath ?? nfReply);
  check('the model is told how to use a No-folder directory (projectless prompt section)', mock.requests.some(r => r.system?.includes('started without a project folder')));
  // Two projectless conversations keep their workspaces but share one sidebar group.
  const firstNf = (await page.evaluate(() => window.pidesk.invoke('listSessions'))).find(s => s.noFolder);
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 15000 });
  await page.click('.nav-item.new');
  await send('second projectless conversation');
  await waitText('.markdown', 'echo: second projectless conversation');
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 15000 });
  const nfSessions = (await page.evaluate(() => window.pidesk.invoke('listSessions'))).filter(s => s.noFolder);
  const noFolderGroup = () => page.locator('.session-group').filter({ has: page.locator('.group-name', { hasText: /^No folder$/ }) });
  check('No folder conversations share one sidebar group', await noFolderGroup().count() === 1 && await noFolderGroup().locator('.session-row').count() === 2);
  check('grouping preserves independent projectless directories and session files', nfSessions.length === 2 && new Set(nfSessions.map(s => s.cwd)).size === 2
    && new Set(nfSessions.map(s => s.piSessionFile)).size === 2 && nfSessions.find(s => s.id === firstNf.id)?.cwd === firstNf.cwd);
  await S('03d-one-no-folder-group');
  await noFolderGroup().locator('.group-head').click();
  check('one No folder disclosure collapses all its conversations', await noFolderGroup().locator('.session-row').count() === 0);
  await noFolderGroup().locator('.group-head').click();
  await page.locator('.session-row', { hasText: '[[bash:pwd]]' }).click();
  await waitText('.markdown', 'Tool result');
  check('grouped conversations retain separate histories', !(await page.locator('.markdown', { hasText: 'second projectless conversation' }).count()));
  await page.reload();
  await page.locator('.app:not(.loading)').waitFor();
  await noFolderGroup().locator('.session-row').nth(1).waitFor();
  check('existing No folder records remain grouped after reloading', await noFolderGroup().count() === 1 && await noFolderGroup().locator('.session-row').count() === 2);
  for (const title of ['[[bash:pwd]]', 'second projectless conversation']) {
    await page.locator('.session-row', { hasText: title }).click({ button: 'right' });
    await page.click('.popover .menu-item:has-text("Archive")');
    await page.locator('.session-row', { hasText: title }).waitFor({ state: 'detached' });
  }
  check('archiving the last No folder conversation removes its empty group', await noFolderGroup().count() === 0);

  // ---- local session
  await page.click('.folder-trigger');
  await page.click('.menu-item:has-text("Choose a folder")');
  await page.locator('.trigger', { hasText: 'demo-app' }).waitFor();
  check('model chip shows first model', await page.locator('.model-trigger').innerText() === 'alpha-1');
  await send('hello from the desktop');
  await waitText('.markdown', '[mock-lab/alpha-1] echo: hello from the desktop');
  check('local session streamed a reply', true);
  await send('recover this reply [[drop-once]]');
  await page.locator('.working', { hasText: 'Reconnecting to model' }).waitFor({ timeout: 15000 });
  check('a broken model stream shows a bounded retry, not a final red error', await page.locator('.block-error', { hasText: 'terminated' }).count() === 0);
  await page.locator('.block-notice', { hasText: 'Recovered automatically' }).waitFor({ timeout: 15000 });
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 15000 });
  check('a recovered model stream no longer leaves a red terminated error', await page.locator('.block-error').count() === 0);
  await S('04a-stream-recovered');
  await page.locator('.usage-table').waitFor({ timeout: 15000 });
  const usageText = await page.locator('.usage').innerText();
  check('right panel Usage card shows tok/s and input / cached / output', /tok\/s/.test(usageText) && /Input/.test(usageText) && /Cached/.test(usageText) && /Output/.test(usageText), usageText.replace(/\s+/g, ' '));
  check('nothing under the composer but model controls', !(await page.locator('.session-meter').count()));
  // a model that reasons privately: no fake speed, a "Thought for" row with its reasoning tokens
  await waitNew('.markdown', 'echo:', () => send('[[hidden-think]] ponder this'));
  await page.locator('.thinking', { hasText: 'Thought for' }).last().waitFor({ timeout: 15000 });
  const hiddenRow = await page.locator('.thinking', { hasText: 'Thought for' }).last().innerText();
  const tpsAfter = Number((await page.locator('.usage-speed-value b').innerText()).replace(/[^\d.]/g, ''));
  check('hidden reasoning shown as "Thought for…" and speed not inflated', /^Thought for \d+s[\s\S]*400 tokens$/.test(hiddenRow.trim()) && tpsAfter > 0 && tpsAfter < 600, `${hiddenRow.replace(/\s+/g, ' ')} · ${tpsAfter} tok/s`);
  await S('04b-usage-card');
  await page.locator('.send-button.stop').waitFor({ state: 'detached' });
  const readingSession = (await page.evaluate(() => window.pidesk.invoke('listSessions'))).find(s => s.title.includes('hello from the desktop'));
  await checkReading({ app, page, id: readingSession.id });
  check('streaming preserves expanded commands and reading position; TPS updates per API call', true);
  // Manual compaction from the conversation menu leaves a marker with the summary.
  for (const word of ['alpha', 'beta', 'gamma']) await waitNew('.markdown', `echo: ${word} `, () => send(`${word} `.repeat(60)));
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
  await composer().fill('/');
  await page.locator('.slash-menu .slash-item', { hasText: '/compact' }).waitFor({ timeout: 10000 });
  check('typing / lists commands (goal, compact, fork, new)', (await page.locator('.slash-menu').innerText()).includes('/goal'));
  await send('/compact');
  await page.locator('.compaction', { hasText: 'Conversation compacted' }).waitFor({ timeout: 30000 });
  check('/compact shows a "Conversation compacted" marker', true);
  await S('04c-compacted');
  check('session listed under "demo-app · This computer"', await page.locator('.group-head', { hasText: 'demo-app' }).count() === 1);
  check('provider received the stored key', mock.requests.at(-1).authorization === 'Bearer sk-e2e-secret');

  await send('[[bash:echo hi-from-pi && pwd]]');
  await waitText('.markdown', 'Tool result: hi-from-pi');
  check('YOLO: command ran without any approval prompt', !(await page.locator('.question-card, .approval-card').count()));
  await page.click('.tool-group-head:has-text("Ran 1 command")');
  await page.click('.tool-call-head');
  check('tool output visible when expanded', (await page.locator('.tool-output').last().innerText()).includes(localProject.replace('/tmp', '')));
  await waitNew('.markdown', 'Tool result: described', () => send('[[bash:echo described]] [[desc:Say hello]]'));
  check('a command with a description shows the description, not the raw command', await page.locator('.tool-group-head', { hasText: 'Say hello' }).count() >= 1);
  check('the model names a new conversation (and the provisional title is replaced)', await page.locator('.session-row', { hasText: 'hello from the desktop (named)' }).count() === 1, (await page.locator('.session-row').allInnerTexts()).join(' | '));
  check('a reply\'s work folds into one line; the answer stays visible', await page.locator('.tool-group.work', { hasText: 'Ran 1 command' }).count() >= 1 && await page.locator('.markdown', { hasText: 'Tool result: hi-from-pi' }).count() >= 1);
  check('long tool rows never scroll the conversation sideways', await page.evaluate(() => { const t = document.querySelector('.transcript'); return t.scrollWidth <= t.clientWidth + 1; }));
  // numbered lists continue on Shift+Enter, and an empty item ends the list
  await composer().fill('1. first');
  await composer().press('Shift+Enter');
  const listed = await composer().inputValue();
  await composer().press('Shift+Enter');
  const ended = await composer().inputValue();
  await composer().fill('');
  await composer().pressSequentially('1. one');
  await composer().press('Shift+Enter');
  await composer().press('Tab');
  await composer().pressSequentially('sub');
  const nested = await composer().inputValue();
  await composer().fill('');
  check('list items indent as you type, Tab nests', nested === '   1. one\n      1. sub', JSON.stringify(nested));
  await waitNew('.markdown', 'echo:', () => send('Plan:\n   1. one\n      1. sub\n   2. two'));
  const levels = await page.locator('.user-bubble').last().locator('.ub-li').evaluateAll(els => els.map(el => getComputedStyle(el).getPropertyValue('--depth').trim()).join(','));
  check('sent lists keep their levels in your message', levels === '0,1,0', levels);
  await S('05b2-list-message');
  // a message sent while Pi works interrupts the active reply and starts a fresh turn
  await send('long ' + 'q'.repeat(30000));
  await page.locator('.send-button.stop').waitFor({ timeout: 30000 });
  const interruptedAt = Date.now();
  await send('interrupt and answer this');
  await page.locator('.user-bubble', { hasText: 'interrupt and answer this' }).waitFor({ timeout: 2000 });
  const optimisticMs = Date.now() - interruptedAt;
  await waitText('.markdown', 'echo: interrupt and answer this', 15000);
  const interruptMs = Date.now() - interruptedAt;
  check('a new message interrupts a running reply and starts a fresh turn', interruptMs < 10000 && await page.locator('.user-row.queued').count() === 0, `${interruptMs} ms to answer`);
  check('the interrupting message shows immediately and is not queued', optimisticMs < 2000 && await page.locator('.user-bubble', { hasText: 'interrupt and answer this' }).count() === 1, `${optimisticMs} ms to show`);
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
  check('composer continues 1. 2. 3. lists', listed === '1. first\n2. ' && ended === '1. first\n', JSON.stringify({ listed, ended }));

  await waitNew('.markdown', 'Tool result', () => send('[[write:notes/plan.md|# Plan\n- ship M1]]'));
  await page.locator('.panel-row.file', { hasText: 'plan.md' }).waitFor();
  // change review: the turn's changed files with diffs
  await page.locator('.changes-pill', { hasText: 'plan.md' }).last().click();
  await page.locator('.change-file', { hasText: 'notes/plan.md' }).waitFor({ timeout: 10000 });
  check('change review lists the turn\'s files with added lines', await page.locator('.change-file .diff-row.add').count() >= 2);
  await S('05c-changes');
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
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
  // Settings → Usage: totals, a day in the activity graph, models ranked by tokens
  await page.click('.settings-sidebar-nav .nav-item:has-text("Usage")');
  await page.locator('.model-rank-row').first().waitFor({ timeout: 15000 });
  const usageStats = await page.locator('.usage-stats').innerText();
  const ranked = (await page.locator('.model-rank-name').allInnerTexts()).map(t => t.split('\n')[0]);
  check('Settings → Usage shows total tokens, today\'s activity and a model ranking', /Total tokens\s+[\d.]+[KM]?/.test(usageStats) && await page.locator('.heat-cell.l1, .heat-cell.l2, .heat-cell.l3, .heat-cell.l4').count() >= 1 && ranked.includes('alpha-1') && ranked.includes('beta-1'), `${usageStats.replace(/\s+/g, ' ')} · ${ranked.join(', ')}`);
  check('Usage has three equal cards, no cost card or footer copy', await page.locator('.usage-stat').count() === 3 && !usageStats.includes('cost') && !(await page.locator('.settings-content .section-foot').count()));
  const cardWidths = await page.locator('.usage-stat').evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
  check('Usage summary cards share the available width', Math.max(...cardWidths) - Math.min(...cardWidths) < 1);
  await S('06b-usage');
  await page.click('.nav-item.back');
  await waitNew('.markdown', 'echo: after rotating the key', () => send('after rotating the key'));
  check('a running session picks up a rotated API key', mock.requests.at(-1).authorization === 'Bearer sk-e2e-rotated', mock.requests.at(-1).authorization);

  await composer().fill('Here is some code:\n```js\nconst answer = 42;\nfunction greet(name) { return `hi ${name}`; }\n```');
  await composer().press('Enter');
  await page.locator('.markdown .code-block').last().waitFor();
  check('code blocks are syntax highlighted with a copy button', await page.locator('.code-block .hljs-keyword').count() > 0 && await page.locator('.code-block .code-copy').count() > 0);
  await S('05-local-session');

  // ---- attachments: a picked file and a dropped image
  // (no paperclip: files are pasted or dropped onto the message box)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['notes for the model'], 'attach-notes.txt', { type: 'text/plain' }));
    document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.locator('.attachment.file', { hasText: 'attach-notes.txt' }).waitFor();
  await page.evaluate(png => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
    document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG);
  await page.locator('.attachment.image img').waitFor();
  await S('05d-attachments');
  await waitNew('.markdown', 'attach-notes.txt', () => send('look at these'));
  const attachReply = await page.locator('.markdown', { hasText: 'attach-notes.txt' }).last().innerText();
  const shownImages = await page.locator('.user-images img').count(), shownFiles = await page.locator('.user-files .attachment', { hasText: 'attach-notes.txt' }).count();
  check('attachments: image reaches the model, file path is attached', attachReply.includes('[images:1]') && /\/attach-notes\.txt/.test(attachReply) && shownImages >= 1 && shownFiles >= 1, JSON.stringify({ path: /\/attach-notes\.txt/.test(attachReply), shownImages, shownFiles }));

  // ---- /goal: Pi keeps going until the model marks the goal complete
  await send('/goal finish the demo [[goal-turns:2]]');
  await page.locator('.goal-banner').waitFor({ timeout: 15000 });
  await page.locator('.goal-state.complete').waitFor({ timeout: 60000 });
  check('/goal runs continuation turns until the goal is achieved', await page.locator('.markdown', { hasText: 'goal progress 1' }).count() >= 1 && await page.locator('.goal-marker', { hasText: 'finish the demo' }).count() === 1);
  await S('05e-goal');
  await page.click('.goal-close');
  await page.locator('.goal-banner').waitFor({ state: 'detached', timeout: 15000 });

  // ---- edit an earlier message and regenerate from there
  await waitNew('.markdown', 'echo: edit me please', () => send('edit me please'));
  await page.locator('.user-row', { hasText: 'edit me please' }).last().hover();
  await page.locator('.user-row', { hasText: 'edit me please' }).last().locator('button[aria-label="Edit message"]').click();
  await page.locator('.user-row.editing textarea').fill('edited text');
  await page.locator('.user-row.editing textarea').press('Enter');
  await waitText('.markdown', 'echo: edited text');
  check('editing a message regenerates from there', !(await page.locator('.markdown', { hasText: 'echo: edit me please' }).count()) && !(await page.locator('.user-bubble', { hasText: 'edit me please' }).count()));

  // ---- terminal panel in the session folder
  await page.click('.main-tools .tool-button[aria-label="Terminal"]');
  await page.locator('.terminal-panel .xterm').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.locator('.terminal-panel .xterm').click();
  await page.keyboard.type('echo term-$((40+2)) && pwd\n');
  await page.locator('.terminal-panel .xterm-rows', { hasText: 'term-42' }).waitFor({ timeout: 15000 });
  check('terminal panel runs a shell in the session folder', (await page.locator('.terminal-panel .xterm-rows').innerText()).includes('demo-app'));
  await S('05f-terminal');
  await page.click('.terminal-bar .tool-button');

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
  check('SSH host prepared in an isolated test install', prep.ok, prep.ok ? `${prep.facts.hostname}, Node ${prep.facts.nodeVersion}, Pi ${prep.facts.piVersion}` : prep.error);
  await page.click('.folder-trigger');
  await page.click('.menu-item:has-text("Browse pidesk-test")');
  await page.locator('.browse-item').first().waitFor({ timeout: 30000 });
  await page.fill('.browse-path input', remoteProject);
  await page.click('.browse-path button');
  await page.waitForFunction(p => document.querySelector('.browse-path input')?.value.endsWith(p) && !document.querySelector('.browse-list .spinner'), '/remote/api-server');
  await page.waitForTimeout(300);
  await S('07-remote-browser');
  await page.click('button:has-text("Use this folder")');
  await page.locator('.trigger', { hasText: 'api-server' }).waitFor();
  // a Pi is pre-warmed on the host meanwhile
  let warm = 0;
  for (let i = 0; i < 60 && !(warm = await page.evaluate(() => window.pidesk.invoke('warmSessions'))); i++) await page.waitForTimeout(250);
  await send('hello from the server ' + 'with a longer message so streaming takes a moment '.repeat(4));
  // While the remote session streams, switch to the local one and work there too.
  await page.locator('.session-row', { hasText: 'after switching' }).first().waitFor({ timeout: 1000 }).catch(() => {});
  const sentAt = Date.now();
  await waitText('.markdown', 'echo: hello from the server', 120000);
  check('first message on a pre-warmed SSH host starts without waiting for Pi', Date.now() - sentAt < 2500, `${Date.now() - sentAt} ms to first reply; warm sessions before sending: ${warm}`);
  check('remote session streamed a reply over SSH', true);
  check('sidebar groups by project and machine', await page.locator('.group-head', { hasText: 'api-server' }).locator('text=pidesk-test').count() === 1);

  await waitNew('.markdown', 'Tool result', () => send('[[bash:hostname && pwd]]'));
  await page.click('.tool-group-head:has-text("Ran 1 command")');
  await page.click('.tool-call-head');
  check('remote command ran in the remote folder', (await page.locator('.tool-output').last().innerText()).includes('api-server'));
  await S('08-remote-session');

  await waitNew('.markdown', 'Subagents: 2/2 completed', () => send('[[subagents]]'), 60000);
  await page.locator('.tool-group-head', { hasText: 'Subagents Inspect cwd' }).click();
  await page.locator('.tool-call-head', { hasText: 'Subagents' }).click();
  await page.locator('.subagent-result.completed').nth(1).waitFor({ timeout: 15000 });
  check('remote subagents display per-task results inside the parent conversation', await page.locator('.subagent-result.completed').count() === 2);
  await page.locator('.panel-row.file', { hasText: 'subagent-result.txt' }).waitFor();
  check('delegated file writes appear in Outputs', existsSync(join(remoteProject, 'subagent-result.txt')));
  check('subagents do not create sidebar conversations or extra windows', (await app.windows()).length === 1 && await page.locator('.session-row').count() === 2);
  await S('08b-subagents');
  await waitNew('.markdown', 'Subagents: 2/2 completed', async () => {
    await send('[[subagents-background]]');
    await page.waitForFunction(() => {
      const state = window.__pideskState();
      return Object.values(state.transcripts[state.activeId]?.tools ?? {}).some(t => t.status === 'running' && t.args?.command?.includes('background-subagent'));
    }, undefined, { timeout: 15000 });
    check('dropped SSH during delegated work', dropSsh());
  }, 60000);
  check('subagents finish on the host through a dropped desktop connection', [1, 2].every(i => existsSync(join(remoteProject, `background-subagent-${i}.txt`))));

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

  // ---- fork and delete from the session's right-click menu
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click({ button: 'right' });
  await page.click('.popover .menu-item:has-text("Fork")');
  await page.locator('.session-row', { hasText: '(fork)' }).waitFor({ timeout: 30000 });
  await waitText('.markdown', 'echo: hello from the desktop', 30000);
  check('fork opens a copy of the conversation', await page.locator('.session-row.active', { hasText: '(fork)' }).count() === 1);
  await page.locator('.session-row', { hasText: '(fork)' }).click({ button: 'right' });
  const menuItems = (await page.locator('.popover .menu-item').allInnerTexts()).map(t => t.trim()).join('|');
  await page.click('.popover .menu-item:has-text("Delete")');
  const deleteUiMs = await page.evaluate(async () => {
    const start = performance.now();
    document.querySelector('.modal .button.danger-solid').click();
    while ([...document.querySelectorAll('.session-row')].some(row => row.textContent.includes('(fork)'))) {
      if (performance.now() - start > 1500) break;
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  });
  check('Delete updates the interface without waiting for background cleanup', deleteUiMs < (process.env.CI ? 500 : 150), `${Math.round(deleteUiMs)} ms`);
  await page.locator('.session-row', { hasText: '(fork)' }).waitFor({ state: 'detached', timeout: 15000 });
  check('right-click menu is Rename / Fork / Archive / Delete, and Delete removes the session', menuItems === 'Rename|Fork|Archive|Delete', menuItems);

  // ---- commands started just before quitting finish while the app is closed (local and remote)
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click();
  await send('[[bash:sleep 3 && echo local-after-quit | tee local-after-quit.txt]]');
  await page.locator('.tool-group-head .spinner').first().waitFor({ timeout: 15000 });
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await send('[[bash:sleep 3 && echo after-quit | tee after-quit.txt]]');
  await page.locator('.tool-group-head .spinner').first().waitFor({ timeout: 15000 });
} catch (error) {
  check('unexpected error', false, error.message.split('\n').slice(0, 2).join(' | '));
  console.log('notices:', JSON.stringify(await page.evaluate(() => window.__pideskNoticeLog ?? []).catch(() => [])));
  console.log('composer:', JSON.stringify(await composer().inputValue().catch(() => '')));
  await S('zz-failure').catch(() => {});
}

// ---- restart: sessions and history come back
await app.close();
await new Promise(r => setTimeout(r, 4500));
check('remote command finished while the app was closed', existsSync(join(remoteProject, 'after-quit.txt')));
check('local command finished while the app was closed', existsSync(join(localProject, 'local-after-quit.txt')));
({ app, page } = await launch({ userData: profile, env }));
try {
  const openAt = Date.now();
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await waitText('.markdown', 'Tool result: after-quit', 90000);
  const remoteOpenMs = Date.now() - openAt;
  check('reopened remote session shows the reply produced while closed', true);
  check('after a restart, a conversation shows its history without waiting for Pi to start', remoteOpenMs < (process.env.CI ? 3000 : 1500), `${remoteOpenMs} ms (SSH)`);
  await page.locator('.session-row').first().waitFor();
  check('sessions restored after restart', await page.locator('.session-row').count() === 2);
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click();
  await waitText('.markdown', '[mock-lab/alpha-1] echo: hello from the desktop', 90000);
  await waitText('.markdown', 'Tool result: local-after-quit', 60000);
  check('reopened local session shows the reply produced while closed', true);
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
try { execFileSync('pkill', ['-f', `${join(root, 'agent/pidesk-relay.mjs')} daemon`]); } catch { /* not running */ }
try { execFileSync('pkill', ['-f', `${remoteInstall}/ext/pidesk-relay.mjs daemon`]); } catch { /* not running */ }
await mock.close();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${opts.shots}`);
process.exitCode = failed ? 1 : 0;
