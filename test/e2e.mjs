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
import { checkFilePreview } from './file-preview-ui.mjs';
import { checkBackgroundJobs } from './background-jobs-ui.mjs';

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
// Downloads land here instead of behind a save dialog.
const downloads = join(work, 'downloads');
rmSync(downloads, { recursive: true, force: true }); mkdirSync(downloads, { recursive: true });
const BINARY = Buffer.from([...Array(256).keys(), 0, 10, 13, 255]);
const env = { PIDESK_SSH_CONFIG: opts['ssh-config'], PIDESK_TEST_PICK_FOLDER: localProject, PIDESK_TEST_PICK_FILES: attachFile, PIDESK_DEFAULT_WORKSPACE: defaultWorkspace, PIDESK_TEST_SAVE_DIR: downloads };
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
const inspector = () => page.locator('.subagent-inspector');
const mainTranscript = () => page.locator('.session-main .transcript');
const clearDialog = () => page.locator('.modal').filter({ hasText: 'Clear subagent records?' });
const activeRecord = async () => page.evaluate(async () => {
  const id = window.__pideskState().activeId;
  return (await window.pidesk.invoke('listSessions')).find(session => session.id === id);
});
// Compare stored conversation data, not the delegation card's intentionally filtered rows.
const conversationSnapshot = () => page.evaluate(() => {
  const state = window.__pideskState(), transcript = state.transcripts[state.activeId];
  return JSON.stringify({ messages: transcript.messages, tools: transcript.tools });
});
async function send(text) { await composer().fill(text); await composer().press('Enter'); }
const waitText = (selector, text, timeout = 60000) => page.locator(selector, { hasText: text }).last().waitFor({ timeout });
// Historical assertions must explicitly browse pages; the first paint intentionally contains only
// recent messages, and off-screen content is not mounted until it approaches the viewport.
async function loadAllHistory() {
  await page.waitForFunction(() => {
    const state = window.__pideskState(), transcript = state.transcripts[state.activeId];
    return transcript?.loaded && !transcript.rewinding;
  });
  for (let i = 0; i < 40 && await page.locator('.session-main .history-boundary').count(); i++) {
    const before = await page.evaluate(() => JSON.stringify(window.__pideskState().transcripts[window.__pideskState().activeId].history.next));
    await mainTranscript().evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); });
    await page.waitForFunction(before => {
      const state = window.__pideskState(), history = state.transcripts[state.activeId].history;
      return !history.loading && JSON.stringify(history.next) !== before;
    }, before);
  }
  if (await page.locator('.session-main .history-boundary').count()) throw new Error('History did not finish paging');
}
async function revealHistory(selector, text) {
  await loadAllHistory();
  // Mark this as browsing before a late layout/virtual-row measurement can follow the tail.
  await mainTranscript().evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(60);
    const match = page.locator(selector, { hasText: text }).last();
    if (await match.count()) { await match.scrollIntoViewIfNeeded(); return; }
    const moved = await mainTranscript().evaluate(el => {
      const before = el.scrollTop;
      el.scrollTop += el.clientHeight * 0.7;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return el.scrollTop !== before;
    });
    if (!moved) break;
  }
  throw new Error(`Historical content not found after paging: ${text}`);
}
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
  check('subscription login is absent from Settings', await page.getByRole('button', { name: 'ChatGPT', exact: true }).count() === 0);
  const removedApi = await page.evaluate(() => window.pidesk.invoke('signInChatGPT', 'local').then(() => false, e => /Unknown method/.test(e.message)));
  check('removed subscription login cannot be invoked', removedApi);
  await page.click('.nav-item.back');

  // ---- background pre-warm cancellation must not leak a red connection-closed toast
  for (let i = 0; i < 4; i++) {
    await page.evaluate(cwd => window.pidesk.invoke('prewarm', { environmentId: 'local', cwd }), i % 2 ? null : localProject);
  }
  await page.waitForTimeout(800);
  check('switching pre-warmed folders is silent', !(await page.evaluate(() => window.__pideskNoticeLog ?? [])).some(n => /connection closed|Session start cancelled/.test(n)));

  await page.getByRole('button', { name: 'Group conversations by project', exact: true }).click();
  // ---- no folder: a session in the default workspace, like Codex and Claude
  check('new sessions default to "No folder"', (await page.locator('.folder-trigger').getAttribute('title')) === 'No folder');
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
  await page.getByRole('button', { name: 'Session details', exact: true }).click();
  await page.locator('.usage-table').waitFor({ timeout: 15000 });
  const rightTitles = await page.locator('.right-panel .panel-card-head').allInnerTexts();
  check('right panel retains Context/Usage without Environment or Outputs', rightTitles.some(t => t.includes('Context')) && rightTitles.some(t => t.includes('Usage')) && !rightTitles.some(t => /Environment|Outputs/.test(t)));
  check('Subagents has plain text followed only by its disclosure arrow, without helper text',
    await page.locator('.subagent-list-head').innerText() === 'Subagents' &&
    await page.locator('.subagent-list-head').evaluate(el => el.firstElementChild.tagName === 'SPAN') &&
    await page.locator('.subagent-list-head svg').count() === 1 &&
    await page.getByText('Delegated tasks will appear here.').count() === 0);
  await page.locator('.subagent-list-head').click();
  check('empty Subagents section can collapse', await page.locator('.subagent-list-head').getAttribute('aria-expanded') === 'false');
  await page.locator('.subagent-list-head').press('Enter');
  check('Subagents expands from keyboard like Usage', await page.locator('.subagent-list-head').getAttribute('aria-expanded') === 'true');
  check('empty Subagents has no finished records to clear', await page.getByRole('button', { name: 'Clear finished subagents', exact: true }).isDisabled());
  await S('04-plain-subagent-header');
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
  // Even a single-chunk reply has a full request duration, including the first-token wait.
  const shortSpeed = await page.locator('.usage-speed-value b').innerText(), shortKind = await page.locator('.usage-speed-kind').innerText();
  check('a short reply shows its own request TPS', /^~\d/.test(shortSpeed) && shortKind === 'Request TPS', `${shortSpeed} · ${shortKind}`);
  check('TPS includes the first-token wait', /including time to first token/.test(await page.locator('.usage-speed-metric').getAttribute('title')));
  check('nothing under the composer but model controls', !(await page.locator('.session-meter').count()));
  // a model that reasons privately: a "Thought for" row with its reasoning tokens, and an estimated speed
  await waitNew('.markdown', 'echo:', () => send('[[hidden-think]] ponder this'));
  await page.locator('.thinking', { hasText: 'Thought for' }).last().waitFor({ timeout: 15000 });
  const hiddenRow = await page.locator('.thinking', { hasText: 'Thought for' }).last().innerText();
  const tpsAfter = await page.locator('.usage-speed-value b').innerText();
  const hiddenSpeedKind = await page.locator('.usage-speed-kind').innerText();
  check('hidden reasoning shown as "Thought for…", with its speed estimated over the whole response', /^Thought for \d+s[\s\S]*400 tokens$/.test(hiddenRow.trim())
    && /^~\d/.test(tpsAfter) && hiddenSpeedKind === 'Request TPS', `${hiddenRow.replace(/\s+/g, ' ')} · ${tpsAfter} · ${hiddenSpeedKind}`);
  await S('04b-usage-card');
  await page.locator('.send-button.stop').waitFor({ state: 'detached' });
  const readingSession = (await page.evaluate(() => window.pidesk.invoke('listSessions'))).find(s => s.title.includes('hello from the desktop'));
  await checkReading({ app, page, id: readingSession.id });
  check('streaming preserves reading state; request TPS includes TTFT, first chunks and hidden reasoning', true);
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
  check('long tool rows never scroll the conversation sideways', await page.evaluate(() => { const t = document.querySelector('.session-main .transcript'); return t.scrollWidth <= t.clientWidth + 1; }));
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
  // change review: the turn's changed files with diffs
  await page.locator('.changes-pill', { hasText: 'plan.md' }).last().click();
  await page.locator('.change-file', { hasText: 'notes/plan.md' }).waitFor({ timeout: 10000 });
  check('change review lists the turn\'s files with added lines', await page.locator('.change-file .diff-row.add').count() >= 2);
  await S('05c-changes');
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  // Files remain accessible from the header/tree after removing the Outputs card.
  await page.click('.main-tools .tool-button[aria-label="Files"]');
  await page.locator('.fp-tree-row', { hasText: /^notes$/ }).click();
  await page.locator('.fp-tree-row.file', { hasText: 'plan.md' }).click();
  await page.locator('.file-pane .fp-markdown h1', { hasText: 'Plan' }).waitFor({ timeout: 15000 });
  check('file preview renders Markdown from the file browser', await page.locator('.fp-tab.active', { hasText: 'plan.md' }).count() === 1);
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
  check('write tool created the file and file browsing still works', existsSync(join(localProject, 'notes/plan.md')) && readFileSync(join(localProject, 'notes/plan.md'), 'utf8').includes('ship M1'));
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
  await checkFilePreview({ page, id: readingSession.id, project: localProject, environmentId: 'local', shots: opts.shots });
  check('local file preview: relative images/links, anchors, image refresh/errors, clean file switching and complete source', true);

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
  // A custom endpoint speaking Google's protocol (Gemini API), its URL entered without the version.
  await page.click('.add-button:has-text("Add provider")');
  await page.click('.segmented button:has-text("Custom endpoint")');
  await page.fill('label.field:has-text("Name") input', 'Mock Gemini');
  await page.selectOption('label.field:has-text("API protocol") select', { label: 'Google Gemini API compatible' });
  await page.fill('label.field:has-text("Base URL") input', mock.geminiRoot('mock-gemini'));
  await page.fill('label.field:has-text("API key") input', 'AIza-e2e-gemini');
  await page.click('.model-catalog .link-button:has-text("Choose models")');
  await page.locator('.modal .pick-row', { hasText: 'Gemini Mock 1' }).waitFor({ timeout: 30000 }); // Gemini's display name
  const geminiListed = await page.locator('.modal .pick-row').allInnerTexts();
  await page.click('.modal .pick-row:has-text("Gemini Mock 1")');
  await page.click('.modal-foot .button.primary');
  await page.click('form.editor button[type=submit]');
  await page.locator('.row-card', { hasText: 'Mock Gemini' }).waitFor();
  await page.locator('form.editor').waitFor({ state: 'detached' });
  const gemini = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).providers.find(p => p.name === 'Mock Gemini');
  check('a Google-protocol endpoint added via Settings: /v1beta added, only models that generate, their limits kept',
    gemini?.api === 'google-generative-ai' && gemini.baseUrl === `${mock.geminiRoot('mock-gemini')}/v1beta` && geminiListed.length === 1 &&
    gemini.models?.length === 1 && gemini.models[0].id === 'gemini-mock-1' && gemini.models[0].contextWindow === 1048576 && gemini.models[0].reasoning === true,
    JSON.stringify({ api: gemini?.api, baseUrl: gemini?.baseUrl, listed: geminiListed, models: gemini?.models }));
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
  // The same session replies through the Google-protocol endpoint added above, then goes back to beta-1.
  await page.locator('.model-trigger').click();
  await page.locator('.model-menu .menu-item', { hasText: /Gemini Mock 1|gemini-mock-1/ }).click();
  await waitNew('.markdown', '[mock-gemini/gemini-mock-1] echo: over Google', () => send('over Google'));
  const viaGemini = mock.requests.at(-1);
  check('a session replies through the Google-protocol endpoint, the key in x-goog-api-key',
    viaGemini?.api === 'google' && viaGemini.provider === 'mock-gemini' && viaGemini.apiKey === 'AIza-e2e-gemini' && !viaGemini.authorization && !viaGemini.url.includes('AIza'),
    JSON.stringify({ api: viaGemini?.api, provider: viaGemini?.provider, url: viaGemini?.url }));
  await page.locator('.model-trigger').click();
  await page.click('.model-menu .menu-item:has-text("beta-1")');

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

  // ---- Ultra: Pi works on its own after the message; replies with no progress end as stalled
  try {
    await page.getByRole('button', { name: 'Response options', exact: true }).click();
    await page.click('.ultra-trigger');
    await page.locator('.ultra-trigger.on').waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
    const before = await page.locator('.markdown', { hasText: 'Ultra mode: continue the task' }).count();
    await send('ultra demo task [[ultra-progress]]');
    await page.locator('.ultra-progress').filter({ hasText: '检查完成：fixture-check-ok' }).waitFor({ timeout: 20000 });
    const update = page.locator('.ultra-progress').filter({ hasText: '检查完成：fixture-check-ok' });
    check('Ultra milestone is readable without expanding tool groups', await update.isVisible() && await update.locator('.tool-group').count() === 0 && (await update.innerText()).includes('接下来验证异常路径'));
    check('Ultra communication instructions reach the model', mock.requests.some(r => r.system?.includes('Unattended does not mean silent')));
    await S('05f-ultra-progress');
    await page.locator('.ultra-banner').waitFor({ timeout: 20000 });
    await page.locator('.ultra-banner.stalled').waitFor({ timeout: 120000 });
    const continued = await page.locator('.markdown', { hasText: 'Ultra mode: continue the task' }).count() - before;
    const label = await page.locator('.ultra-banner .goal-state').innerText();
    check('Ultra continues on its own and stops as stalled after turns without progress', continued >= 4 && /Stalled/.test(label), `${continued} continuations · ${label}`);
    await S('05f-ultra');
    await page.getByRole('button', { name: 'Response options', exact: true }).click();
    await page.click('.ultra-trigger');
    await page.locator('.ultra-trigger.on').waitFor({ state: 'detached', timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.click('.ultra-banner .goal-close');
    await page.locator('.ultra-banner').waitFor({ state: 'detached', timeout: 15000 });
    const progressSession = await page.evaluate(async () => (await window.pidesk.invoke('listSessions')).find(s => s.id === window.__pideskState().activeId));
    const progressPrefix = readFileSync(progressSession.piSessionFile);
    await page.reload();
    await page.locator('.session-row-main').getByText(progressSession.title, { exact: true }).click();
    await page.locator('.ultra-progress').filter({ hasText: '检查完成：fixture-check-ok' }).waitFor({ timeout: 20000 });
    check('Ultra progress survives reopening and disabling Ultra without rewriting history', await page.locator('.ultra-progress').count() === 1 && readFileSync(progressSession.piSessionFile).subarray(0, progressPrefix.length).equals(progressPrefix));
  } catch (error) { check('Ultra', false, error.message.split('\n')[0]); }

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

  await checkBackgroundJobs({ page, send, check, shot: S });

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
  await page.locator('.send-button.stop').waitFor({ state: 'detached', timeout: 30000 });
  await checkFilePreview({ page, id: (await activeRecord()).id, project: remoteProject, environmentId: 'ssh:pidesk-test', shots: opts.shots });
  check('SSH file preview: relative images/links, anchors, image refresh/errors, clean file switching and complete source', true);

  await page.locator('.subagent-list-head').click();
  await waitNew('.session-main .markdown', 'Subagents: 2/2 completed', () => send('[[subagents]]'), 60000);
  await page.locator('.send-button.stop').waitFor({ state: 'detached' });
  const delegationCallId = await mainTranscript().locator('.subagent-summary').filter({ hasText: 'Inspect cwd' }).getAttribute('data-call-id');
  const delegation = () => mainTranscript().locator(`.subagent-summary[data-call-id="${delegationCallId}"]`);
  check('subagent tasks are visible without expanding a command group', await delegation().locator('.subagent-task-row.completed').count() === 2);
  check('collapsed Subagents stays closed as work runs and completes', await page.locator('.subagent-list-head').getAttribute('aria-expanded') === 'false' && await page.locator('.subagent-list .subagent-task-row').count() === 0);
  await S('08a1-subagents-collapsed');
  await page.locator('.subagent-list-head').click();
  check('reopening Subagents restores completed tasks without rerunning work', await page.locator('.subagent-list .subagent-task-row.completed').count() === 2);
  await S('08a2-subagents-expanded');
  await delegation().locator('.subagent-task-row', { hasText: 'Inspect cwd' }).click();
  await inspector().locator('.transcript').waitFor();
  check('subagent assignment and public answer use conversation bubbles and markdown',
    await inspector().locator('.user-bubble').innerText() === '[[bash:pwd]]' &&
    (await inspector().locator('.markdown').innerText()).includes('api-server'));
  check('subagent work starts folded like the main conversation',
    await inspector().locator('.tool-group.work .tool-group-head').getAttribute('aria-expanded') === 'false' &&
    await inspector().locator('.tool-command, .tool-output').count() === 0);
  check('the inspector transcript is read only; its one input messages the agent and the main composer is untouched',
    await inspector().getByRole('button', { name: 'Edit message', exact: true }).count() === 0 &&
    await inspector().locator('.composer').count() === 0 && await composer().count() === 1 &&
    await inspector().locator('textarea').count() === await inspector().locator('.subagent-message textarea').count());
  check('completed subagent replies have the same copy action as main replies', await inspector().getByRole('button', { name: 'Copy reply', exact: true }).count() === 1);
  await S('08b1-subagent-conversation-folded');
  await inspector().locator('.tool-group.work .tool-group-head').click();
  await inspector().locator('.tool-call-head').click();
  await inspector().locator('.tool-output', { hasText: 'api-server' }).waitFor();
  check('clicking a subagent shows its actual command and output', (await inspector().locator('.tool-command').innerText()).includes('pwd'));
  check('Latest stays hidden when all execution details fit', await inspector().getByRole('button', { name: 'Jump to latest', exact: true }).count() === 0);
  await S('08b-subagent-execution');
  await delegation().locator('.subagent-task-row', { hasText: 'Write delegated file' }).click();
  await inspector().locator('.tool-group.work .tool-group-head').click();
  await inspector().locator('.tool-call-head').click();
  await inspector().locator('.step-open', { hasText: 'Open subagent-result.txt' }).click();
  await page.locator('.file-pane .fp-source', { hasText: 'created by subagent' }).waitFor();
  check('delegated files open from the execution trace without an Outputs card', existsSync(join(remoteProject, 'subagent-result.txt')));
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  check('closing file preview returns to the same subagent', (await page.locator('.subagent-inspector-head').innerText()).includes('Write delegated file'));
  await page.getByRole('button', { name: 'Back to subagents' }).click();
  check('subagents do not create sidebar conversations or extra windows', (await app.windows()).length === 1 && await page.locator('.session-row').count() === 2);

  // Cancellation is a no-op; single-task clearing preserves the second task's original index.
  const beforeSingleClear = await conversationSnapshot();
  const beforeSingleUsage = await page.locator('.usage-table').innerText();
  await page.getByRole('button', { name: 'Clear finished subagents', exact: true }).click();
  await clearDialog().waitFor();
  check('clear confirmation explains what is preserved', (await clearDialog().innerText()).includes('Running tasks, main conversation, usage and files are kept'));
  check('clear confirmation is fully readable, not clipped to one line', await clearDialog().locator('.confirm-text').evaluate(el => getComputedStyle(el).whiteSpace !== 'nowrap' && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1));
  await S('08c1-subagent-clear-confirmation');
  await clearDialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  check('cancelling clear leaves all records and conversation intact', await page.locator('.subagent-list .subagent-task-row.completed').count() === 2 &&
    !(await activeRecord()).clearedSubagentIds?.length && await conversationSnapshot() === beforeSingleClear);
  await delegation().locator('.subagent-task-row', { hasText: 'Inspect cwd' }).click();
  await inspector().getByRole('button', { name: 'Clear this subagent record', exact: true }).click();
  await clearDialog().getByRole('button', { name: 'Clear records', exact: true }).click();
  await inspector().waitFor({ state: 'detached' });
  check('single clear removes only the selected finished task in both views',
    await delegation().locator('.subagent-task-row').count() === 1 &&
    await page.locator('.subagent-list .subagent-task-row').count() === 1 &&
    await delegation().locator('.subagent-task-row', { hasText: 'Inspect cwd' }).count() === 0 &&
    (await activeRecord()).clearedSubagentIds?.length === 1);
  check('clearing keeps parent messages, original tool results, usage and files',
    await conversationSnapshot() === beforeSingleClear && await page.locator('.usage-table').innerText() === beforeSingleUsage &&
    readFileSync(join(remoteProject, 'subagent-result.txt'), 'utf8') === 'created by subagent');
  await page.locator('.subagent-list .subagent-task-row', { hasText: 'Write delegated file' }).click();
  check('remaining task still opens its own assignment at original index 1',
    (await inspector().locator('.user-bubble').innerText()).includes('[[write:subagent-result.txt|created by subagent]]') &&
    await page.evaluate(() => { const s = window.__pideskState(); return s.subagentSelection[s.activeId]?.taskIndex === 1; }));
  await S('08c2-subagent-single-cleared');
  await page.getByRole('button', { name: 'Back to subagents' }).click();
  await page.click('.main-tools .tool-button[aria-label="Files"]');
  await waitNew('.session-main .markdown', 'Subagents: 2/2 completed', async () => {
    await send('[[subagents-background]]');
    await page.waitForFunction(() => {
      const state = window.__pideskState();
      return Object.values(state.transcripts[state.activeId]?.tools ?? {}).some(t => t.status === 'running' && t.args?.command?.includes('background-subagent'));
    }, undefined, { timeout: 15000 });
    check('new subagent activity does not replace the open file pane', await page.locator('.file-pane').isVisible());
    await mainTranscript().locator('.subagent-summary').last().locator('.subagent-task-row', { hasText: 'Delayed task 1' }).click();
    await inspector().locator('.tool-group.work .tool-group-head').click();
    await inspector().locator('.tool-call.running').waitFor({ timeout: 15000 });
    await inspector().locator('.tool-call-head').click();
    check('running subagent commands are inspectable but cannot be cleared',
      await inspector().locator('.subagent-inspector-meta', { hasText: 'Running' }).count() === 1 &&
      (await inspector().locator('.tool-command').innerText()).includes('background-subagent-1.txt') &&
      await inspector().getByRole('button', { name: 'Clear this subagent record', exact: true }).isDisabled());
    check('dropped SSH during delegated work', dropSsh());
  }, 60000);
  check('subagents finish on the host through a dropped desktop connection', [1, 2].every(i => existsSync(join(remoteProject, `background-subagent-${i}.txt`))));
  await page.locator('.subagent-inspector-meta', { hasText: 'Completed' }).waitFor();
  check('the selected execution view updates after reconnecting without folding the open command',
    await inspector().locator('.tool-call.done').count() === 1 &&
    await inspector().locator('.tool-call-head').getAttribute('aria-expanded') === 'true' &&
    (await inspector().locator('.tool-command').innerText()).includes('background-subagent-1.txt'));
  await S('08d-subagent-reconnected');
  await page.getByRole('button', { name: 'Back to subagents' }).click();

  await checkBackgroundJobs({ page, send, check, shot: S, remote: true, dropSsh });

  // concurrent sessions: start a remote run, switch to local, run there, both complete
  await send('remote run ' + 'x'.repeat(300));
  await page.locator('.session-row').nth(1).click();
  await send('local run while remote works');
  await waitText('.markdown', 'echo: local run while remote works');
  await page.locator('.session-row').nth(0).click();
  await waitText('.markdown', 'echo: remote run');
  check('two sessions ran concurrently and switching kept both', true);

  // ---- background agents (on this Mac): the report starts the parent's next turn; the inspector messages and stops agents
  await page.locator('.session-row').nth(1).click();
  await waitNew('.session-main .markdown', 'echo: Automated message from Pi Desktop', () => send('[[agents-background]]'), 60000);
  check('a background agent returns at once and its report starts the parent\'s next turn',
    await mainTranscript().locator('.markdown', { hasText: 'Tool result: Started 1 agent in the background' }).count() >= 1 &&
    await mainTranscript().locator('.agent-report.completed', { hasText: 'Background check' }).count() === 1);
  await S('08e-agent-report');
  await mainTranscript().locator('.agent-report.completed', { hasText: 'Background check' }).click();
  await inspector().locator('.subagent-inspector-meta', { hasText: 'Completed' }).waitFor({ timeout: 15000 });
  check('the report opens the agent, shown as an explore agent', (await inspector().locator('.subagent-inspector-meta').innerText()).includes('Explore'));
  await waitNew('.session-main .markdown', 'echo: Automated message from Pi Desktop', async () => {
    await inspector().getByLabel('Message this agent').fill('Say hi from the inspector');
    await inspector().getByLabel('Message this agent').press('Enter');
  }, 60000);
  check('a message from the inspector continues the agent, which reports again',
    (await inspector().locator('.user-bubble').allInnerTexts()).some(t => t.includes('Say hi from the inspector')) &&
    (await inspector().locator('.markdown').allInnerTexts()).some(t => t.includes('echo: Message from the user, sent to you directly')));
  await S('08f-agent-follow-up');
  await page.getByRole('button', { name: 'Back to subagents' }).click();
  await waitNew('.session-main .markdown', 'Tool result: Started 1 agent in the background', () => send('[[agents-slow]]'), 30000);
  await mainTranscript().locator('.subagent-summary').last().locator('.subagent-task-row', { hasText: 'Slow check' }).click();
  await inspector().locator('.subagent-inspector-meta', { hasText: 'Running' }).waitFor({ timeout: 30000 });
  check('a running background agent says so in its delegation card', await mainTranscript().locator('.subagent-summary').last().locator('.subagent-task-row', { hasText: 'Slow check' }).locator('.subagent-task-caption', { hasText: 'Running' }).count() >= 1);
  await inspector().getByRole('button', { name: 'Stop this agent', exact: true }).click();
  await inspector().locator('.subagent-inspector-meta', { hasText: 'Cancelled' }).waitFor({ timeout: 30000 });
  await mainTranscript().locator('.agent-report.cancelled', { hasText: 'Slow check' }).waitFor({ timeout: 30000 });
  check('Stop in the inspector cancels a running agent, and the parent hears of it', true);
  await page.getByRole('button', { name: 'Back to subagents' }).click();
  await page.locator('.session-row').nth(0).click();

  // Stop a demonstrably in-flight response; a timed 3K echo can already finish before the click.
  await send('[[hold-for-stop]]');
  await page.locator('.session-main .markdown', { hasText: 'Waiting for stop fixture' }).waitFor({ timeout: 30000 });
  await page.locator('.send-button.stop').waitFor({ timeout: 30000 });
  await page.click('.send-button.stop');
  await page.waitForFunction(() => {
    const s = window.__pideskState(), session = s.sessions.find(row => row.id === s.activeId);
    return !session?.streaming && s.transcripts[s.activeId]?.messages.some(m => m.role === 'assistant' && ['aborted', 'error'].includes(m.stopReason)
      && m.content?.some(b => b.type === 'text' && b.text.includes('Waiting for stop fixture')));
  }, undefined, { timeout: 30000 });
  await page.locator('.block-notice', { hasText: 'Interrupted' }).last().waitFor({ timeout: 30000 });
  check('stop button aborts the running reply', !(await page.locator('.session-main .markdown', { hasText: 'Unexpected completion after stop' }).count()));
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

  // ---- downloads to this Mac: a file from the host's file pane, and files the agent hands over
  await page.locator('.fp-crumbs .tool-button[aria-label="Download survived.txt"]').click();
  const downloaded = page.locator('.toast', { hasText: 'Downloaded survived.txt' });
  await downloaded.waitFor({ timeout: 30000 });
  check('the file pane downloads a file from the SSH host to this Mac', readFileSync(join(downloads, 'survived.txt'), 'utf8') === 'survived\n');
  check('a finished download offers Show in Finder', await downloaded.locator('.toast-action', { hasText: 'Show in Finder' }).count() === 1);
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  writeFileSync(join(remoteProject, 'export.bin'), BINARY);
  await send('[[present:export.bin]]');
  const card = mainTranscript().locator('.file-card', { hasText: 'export.bin' });
  await card.locator('.file-card-download').waitFor({ timeout: 30000 });
  check('present_files shows the file as a card with its size', (await card.innerText()).includes(`${BINARY.length} B`) && await mainTranscript().locator('.file-cards-caption', { hasText: 'Files for you' }).count() === 1);
  await card.locator('.file-card-download').click();
  await page.locator('.toast', { hasText: 'Downloaded export.bin' }).waitFor({ timeout: 30000 });
  check('a presented binary file downloads byte for byte from the SSH host', existsSync(join(downloads, 'export.bin')) && Buffer.compare(readFileSync(join(downloads, 'export.bin')), BINARY) === 0);
  await card.locator('.file-card-main').click();
  await page.locator('.fp-preview .fp-empty', { hasText: 'Binary file' }).waitFor({ timeout: 30000 });
  check('a file card opens the file in the file pane', true);
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');

  // ---- fork and delete from the session's right-click menu
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click({ button: 'right' });
  await page.click('.popover .menu-item:has-text("Fork")');
  await page.locator('.session-row', { hasText: '(fork)' }).waitFor({ timeout: 30000 });
  await revealHistory('.session-main .markdown', 'echo: hello from the desktop');
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

  // ---- a command started just before quitting finishes on the host while the app is closed;
  // on this Mac nothing keeps running once the app quits
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await send('[[bash:sleep 3 && echo after-quit | tee after-quit.txt]]');
  await page.locator('.tool-group-head .spinner').first().waitFor({ timeout: 15000 });
} catch (error) {
  check('unexpected error', false, error.message.split('\n').slice(0, 2).join(' | '));
  console.log(error.stack);
  console.log('notices:', JSON.stringify(await page.evaluate(() => window.__pideskNoticeLog ?? []).catch(() => [])));
  console.log('composer:', JSON.stringify(await composer().inputValue().catch(() => '')));
  await S('zz-failure').catch(() => {});
}

// ---- restart: sessions and history come back
await app.close();
await new Promise(r => setTimeout(r, 4500));
check('remote command finished while the app was closed', existsSync(join(remoteProject, 'after-quit.txt')));
const localRelay = JSON.parse(execFileSync(process.execPath, [join(root, 'agent/pidesk-relay.mjs'), 'list'], { env: { ...process.env, PIDESK_RUN_DIR: join(profile, 'run') } }).toString().trim().split('\n').pop());
check('quitting stops this Mac\'s relay and its Pis: nothing keeps running in the background', localRelay.daemon === false, JSON.stringify(localRelay).slice(0, 160));
({ app, page } = await launch({ userData: profile, env }));
try {
  await page.locator('.folder-trigger').waitFor();
  const draftNow = () => page.evaluate(() => { const s = window.__pideskState(); return { draft: s.draft, recent: s.settings.recentFolders?.[s.draft.environmentId] ?? [] }; });
  const onHost = await draftNow();
  check('a new conversation on an SSH host starts in its most recent folder', onHost.draft.environmentId.startsWith('ssh:') && onHost.draft.cwd === onHost.recent[0], JSON.stringify(onHost));
  // Right after a restart sessions and hosts are still being restored; retry if the menu misses a click.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.click('.env-trigger', { timeout: 5000 });
      await page.locator('.popover .menu-item', { hasText: 'This computer' }).first().click({ timeout: 3000 });
      break;
    } catch (error) {
      if (attempt === 4) throw new Error(`could not pick This computer from the environment menu: ${error.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  const onMac = await draftNow();
  check('a new conversation on this Mac starts with No folder, not its most recent folder',
    onMac.draft.environmentId === 'local' && onMac.draft.cwd === null && onMac.recent.length > 0 && (await page.locator('.folder-trigger').getAttribute('title')) === 'No folder', JSON.stringify(onMac));
  const openAt = Date.now();
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await waitText('.markdown', 'Tool result: after-quit', 90000);
  const remoteOpenMs = Date.now() - openAt;
  check('reopened remote session shows the reply produced while closed', true);
  check('after a restart, a conversation shows its history without waiting for Pi to start', remoteOpenMs < (process.env.CI ? 3000 : 1500), `${remoteOpenMs} ms (SSH)`);
  await page.locator('.session-row').first().waitFor();
  check('sessions restored after restart', await page.locator('.session-row').count() === 2);
  check('a presented file is still a card after an app restart', await mainTranscript().locator('.file-card', { hasText: 'export.bin' }).count() === 1);
  await page.waitForFunction(() => { const s = window.__pideskState(), session = s.sessions.find(row => row.id === s.activeId); return session?.status === 'connected' && !session.streaming; }, undefined, { timeout: 90000 });
  await loadAllHistory();
  check('single-task clearing survives an app restart in the sidebar and delegation card',
    await mainTranscript().locator('.subagent-task-row', { hasText: 'Inspect cwd' }).count() === 0 &&
    await page.locator('.subagent-list .subagent-task-row').count() === 3 &&
    (await activeRecord()).clearedSubagentIds?.length === 1);
  await revealHistory('.session-main .subagent-task-row', 'Write delegated file');
  await mainTranscript().locator('.subagent-task-row', { hasText: 'Write delegated file' }).click();
  await inspector().locator('.tool-group.work .tool-group-head').click();
  await inspector().locator('.tool-call-head').click();
  await inspector().locator('.tool-output').waitFor();
  check('remaining subagent command/output history remains inspectable after an app restart',
    (await inspector().locator('.tool-command').innerText()).includes('subagent-result.txt') &&
    /wrote/i.test(await inspector().locator('.tool-output').innerText()));
  await inspector().locator('.step-open').click();
  await page.locator('.file-pane .fp-source', { hasText: 'created by subagent' }).waitFor();
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  await page.getByRole('button', { name: 'Back to subagents' }).click();

  // A renderer-only legacy record exercises fallback rendering without inventing tool history.
  // Reload below discards the fixture; no synthetic messages are written to the Pi JSONL.
  const legacyRecord = await activeRecord();
  await app.evaluate(({ BrowserWindow }, id) => {
    const call = { type: 'toolCall', id: 'e2e-legacy-subagent', name: 'subagent', arguments: { tasks: [{ name: 'Legacy result', task: 'Read the older saved result' }] } };
    const details = { kind: 'pidesk-subagents', results: [{ name: 'Legacy result', status: 'completed', output: Array.from({ length: 60 }, (_, i) => `Legacy answer paragraph ${i}`).join('\n\n') }] };
    const events = [
      { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), content: [call] } },
      { type: 'tool_execution_end', toolCallId: call.id, result: { content: [], details }, isError: false },
    ];
    for (const event of events) BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'event', payload: { id, event } });
  }, legacyRecord.id);
  await mainTranscript().locator('.subagent-task-row', { hasText: 'Legacy result' }).click();
  check('legacy results use conversation text with an honest missing-trace notice',
    await inspector().locator('.user-bubble').innerText() === 'Read the older saved result' &&
    await inspector().locator('.block-notice', { hasText: 'This older task saved only its result' }).count() === 1 &&
    (await inspector().locator('.markdown').innerText()).includes('Legacy answer paragraph 59') &&
    await inspector().locator('.tool-group, .tool-call').count() === 0);
  await inspector().locator('.transcript').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await inspector().getByRole('button', { name: 'Jump to latest', exact: true }).waitFor();
  await S('10a-subagent-legacy-conversation');
  const mainScrollBeforeJump = await mainTranscript().evaluate(el => el.scrollTop);
  await inspector().getByRole('button', { name: 'Jump to latest', exact: true }).click();
  check('inspector Latest follows its own transcript, not the main conversation',
    await inspector().locator('.transcript').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2) &&
    Math.abs(await mainTranscript().evaluate(el => el.scrollTop) - mainScrollBeforeJump) < 2);
  await page.reload();
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await waitText('.session-main .markdown', 'Tool result: after-quit', 90000);
  await page.locator('.send-button.stop').waitFor({ state: 'detached' });
  await page.locator('.subagent-list .subagent-task-row', { hasText: 'Write delegated file' }).waitFor();
  check('legacy fixture was display-only', await mainTranscript().locator('.subagent-task-row', { hasText: 'Legacy result' }).count() === 0);
  await page.waitForFunction(() => { const s = window.__pideskState(), session = s.sessions.find(row => row.id === s.activeId); return session?.status === 'connected' && !session.streaming; }, undefined, { timeout: 90000 });

  const beforeClearAll = await conversationSnapshot();
  const beforeAllUsage = await page.locator('.usage-table').innerText();
  const storedBeforeClear = await activeRecord();
  const originalJsonl = readFileSync(storedBeforeClear.piSessionFile, 'utf8');
  await page.getByRole('button', { name: 'Clear finished subagents', exact: true }).click();
  await clearDialog().getByRole('button', { name: 'Clear records', exact: true }).click();
  await page.locator('.subagent-list .subagent-task-row').first().waitFor({ state: 'detached' });
  check('clear finished removes all task rows but retains delegation summaries',
    await mainTranscript().locator('.subagent-task-row').count() === 0 &&
    await mainTranscript().locator('.subagent-summary-head:disabled', { hasText: 'Task history cleared' }).count() === 2 &&
    await page.getByRole('button', { name: 'Clear finished subagents', exact: true }).isDisabled());
  check('clear finished preserves conversation, usage, original JSONL and generated files',
    await conversationSnapshot() === beforeClearAll && await page.locator('.usage-table').innerText() === beforeAllUsage &&
    readFileSync(storedBeforeClear.piSessionFile, 'utf8') === originalJsonl &&
    readFileSync(join(remoteProject, 'subagent-result.txt'), 'utf8') === 'created by subagent' &&
    [1, 2].every(i => readFileSync(join(remoteProject, `background-subagent-${i}.txt`), 'utf8').trim() === 'done'));
  check('clear finished persists all four original task identities over IPC', (await activeRecord()).clearedSubagentIds?.length === 4);
  await S('10b-subagent-all-cleared');
  await page.reload();
  await page.locator('.session-row', { hasText: 'hello from the server' }).click();
  await waitText('.session-main .markdown', 'Tool result: after-quit', 90000);
  await page.locator('.subagent-list-head').waitFor();
  check('finished-all clearing survives reload without hiding main replies',
    await page.locator('.subagent-list .subagent-task-row').count() === 0 &&
    await mainTranscript().locator('.subagent-task-row').count() === 0 &&
    await mainTranscript().locator('.markdown', { hasText: 'Subagents: 2/2 completed' }).count() === 2 &&
    (await activeRecord()).clearedSubagentIds?.length === 4);
  await page.click('.main-tools .tool-button[aria-label="Files"]');
  await page.locator('.fp-tree-row', { hasText: 'subagent-result.txt' }).click();
  await page.locator('.file-pane .fp-source', { hasText: 'created by subagent' }).waitFor();
  check('clearing history does not remove generated files from the file browser', true);
  await S('10c-subagent-cleared-files-preserved');
  await page.click('.fp-actions .tool-button[aria-label="Close files"]');
  await page.locator('.session-row', { hasText: 'hello from the desktop' }).click();
  const restoredJsonl = readFileSync((await activeRecord()).piSessionFile, 'utf8');
  check('original replies remain in the session file after renderer and app restarts',
    restoredJsonl.includes('[mock-lab/alpha-1] echo: hello from the desktop') &&
    restoredJsonl.includes('[mock-lab/beta-1] echo: after switching models'));
  await revealHistory('.session-main .markdown', '[mock-lab/alpha-1] echo: hello from the desktop');
  await revealHistory('.session-main .markdown', '[mock-lab/beta-1] echo: after switching models');
  check('history reloaded from the Pi session file', true);
  await page.waitForTimeout(500);
  await S('10-restored');
} catch (error) {
  check('restore failed', false, error.message.split('\n')[0]);
  console.log(error.stack);
  await S('zz-restore-failure').catch(() => {});
}
// ---- Settings → Agents: how many new agents Pi may start for one message
try {
  await page.click('.settings-button');
  await page.click('.settings-sidebar .nav-item:has-text("Agents")');
  await page.click('.grouped-row.selectable:has-text("Off")');
  await page.locator('.grouped-row.selectable.on', { hasText: 'Off' }).waitFor();
  const saved = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).defaults?.subagents;
  check('Settings → Agents saves how many agents Pi may start', saved === 'off', saved);
  await page.click('.grouped-row.selectable:has-text("When asked, up to 2 per message")');
  await page.locator('.grouped-row.selectable.on', { hasText: 'When asked, up to 2 per message' }).waitFor();
  check('Settings → Agents explains each choice on hover', await page.locator('.grouped-row.selectable.on').getAttribute('title') === 'Pi starts agents only when you, the project’s instructions or a skill ask for them.');
  await page.click('.settings-sidebar .nav-item.back');
} catch (error) { check('Settings → Agents', false, error.message.split('\n')[0]); }
const secretsFile = readFileSync(join(profile, 'secrets.json'), 'utf8');
check('settings never store the key in settings.json', !readFileSync(join(profile, 'settings.json'), 'utf8').includes('sk-e2e-secret') && !secretsFile.includes('sk-e2e-secret') && !readFileSync(join(profile, 'settings.json'), 'utf8').includes('sk-e2e-rotated') && !secretsFile.includes('sk-e2e-rotated'));
await app.close();
try { execFileSync('pkill', ['-f', `${join(root, 'agent/pidesk-relay.mjs')} daemon`]); } catch { /* not running */ }
try { execFileSync('pkill', ['-f', `${remoteInstall}/ext/pidesk-relay.mjs daemon`]); } catch { /* not running */ }
await mock.close();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${opts.shots}`);
process.exitCode = failed ? 1 : 0;
