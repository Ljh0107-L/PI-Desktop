// CI only: seamless history browsing and model-visible images in real Electron.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, shot } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';
import { PAGE_MESSAGES } from '../agent/pidesk-history.mjs';
import { checkComposerStability } from './composer-stability-ui.mjs';

if (!process.env.CI) throw new Error('Run this regression only in GitHub CI.');
const profile = mkdtempSync(join(tmpdir(), 'pidesk-history-ui-'));
const cwd = join(profile, 'project'); mkdirSync(cwd);
const file = join(profile, 'long-session.jsonl');
const sessionId = '11111111-2222-4333-8444-555555555555', desktopId = 'history-ui';
const sparseId = 'history-sparse', sparseSessionId = '22222222-2222-4333-8444-555555555555';
const sparseFile = join(profile, 'tool-heavy-session.jsonl');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
writeFileSync(join(cwd, 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#42a5f5"/></svg>');
const mock = await startMockLlm({ chunkDelay: 0 });
const provider = { id: 'history-lab', name: 'History lab', kind: 'custom', api: 'openai-completions', baseUrl: mock.baseUrl('history-lab'),
  models: [{ id: 'model', name: 'Model', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'] }] };
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ providers: [provider], defaults: { model: { provider: provider.id, id: 'model' } }, environments: {} }));
writeFileSync(join(profile, 'secrets.json'), JSON.stringify({ [provider.id]: { insecure: Buffer.from('test-only').toString('base64') } }));
writeFileSync(join(profile, 'sessions.json'), JSON.stringify([{ id: desktopId, title: 'Long history fixture', environmentId: 'local', environmentLabel: 'This computer', cwd,
  project: 'History', piSessionFile: file, piSessionId: sessionId, model: { provider: provider.id, id: 'model' }, thinkingLevel: 'off', createdAt: 1, updatedAt: 1 },
  { id: sparseId, title: 'Tool-heavy history fixture', environmentId: 'local', environmentLabel: 'This computer', cwd, project: 'History', piSessionFile: sparseFile, piSessionId: sparseSessionId, model: { provider: provider.id, id: 'model' }, thinkingLevel: 'off', createdAt: 1, updatedAt: 1 }]));
writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
let parentId = null, index = 0;
function append(message) {
  message.timestamp = 1000 + index;
  if (message.role === 'assistant') Object.assign(message, { api: 'openai-completions', provider: provider.id, model: 'model', stopReason: message.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { total: 0 } } });
  const id = `history-${index++}`;
  appendFileSync(file, JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message }) + '\n'); parentId = id;
}
for (let i = 0; i < 800; i++) {
  const role = i % 2 ? 'assistant' : 'user';
  append({ role, content: [...(role === 'assistant' ? [{ type: 'thinking', thinking: '', thinkingSignature: 'PRIVATE_OPAQUE_SIGNATURE'.repeat(2500) }] : []), { type: 'text', text: i === 751 ? 'OLDER_PROSE_START ' + 'older visible prose '.repeat(1500) + ' OLDER_PROSE_END' : `History ${role} ${i}` }] });
}
append({ role: 'user', content: [{ type: 'text', text: 'Inspect and show the plot' }] });
for (let i = 0; i < 120; i++) {
  append({ role: 'assistant', content: [{ type: 'toolCall', name: 'read', id: `read-${i}`, arguments: { path: 'plot.svg' } }] });
  append({ role: 'toolResult', toolCallId: `read-${i}`, toolName: 'read', content: [{ type: 'text', text: `OUTPUT_START_${i} ` + 'tool output '.repeat(2000) + ` OUTPUT_END_${i}` }, { type: 'image', mimeType: 'image/png', data: png }] });
}
append({ role: 'assistant', content: [{ type: 'toolCall', name: 'present_files', id: 'show-plot', arguments: { paths: ['plot.svg'] } }] });
append({ role: 'toolResult', toolCallId: 'show-plot', toolName: 'present_files', content: [], details: { kind: 'pidesk-files', files: [{ path: 'plot.svg', name: 'plot.svg', size: 130 }] } });
append({ role: 'assistant', content: [{ type: 'text', text: 'LONG_BODY_START ' + 'visible body '.repeat(1200) + ' LONG_BODY_END\n\n![Reply plot](plot.svg)' }, { type: 'image', mimeType: 'image/png', data: png }] });
const original = readFileSync(file);
writeFileSync(sparseFile, JSON.stringify({ type: 'session', version: 3, id: sparseSessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
let sparseParent = null, sparseIndex = 0;
const sparseAppend = message => {
  const id = `sparse-${sparseIndex++}`;
  message.timestamp = 2000 + sparseIndex;
  if (message.role === 'assistant') Object.assign(message, { api: 'openai-completions', provider: provider.id, model: 'model', stopReason: 'toolUse', usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { total: 0 } } });
  appendFileSync(sparseFile, JSON.stringify({ type: 'message', id, parentId: sparseParent, timestamp: new Date().toISOString(), message }) + '\n');
  sparseParent = id;
};
sparseAppend({ role: 'user', content: [{ type: 'text', text: 'Continue this long-running task' }] });
for (let i = 0; i < 2000; i++) {
  sparseAppend({ role: 'assistant', content: [{ type: 'toolCall', id: `sparse-call-${i}`, name: 'bash', arguments: { command: 'true', description: 'Check the output' } }] });
  sparseAppend({ role: 'toolResult', toolCallId: `sparse-call-${i}`, toolName: 'bash', content: [{ type: 'text', text: 'output '.repeat(80) }] });
  if (i % 20 === 0) sparseAppend({ role: 'assistant', content: [{ type: 'text', text: `Progress update ${i}: ` + 'Completed this part of the work and continued to the next check. '.repeat(3) }] });
}
const sparseOriginal = readFileSync(sparseFile);
let app, page;
try {
  ({ app, page } = await launch({ userData: profile, env: { PIDESK_DEFAULT_WORKSPACE: join(profile, 'Pi') } }));
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('pidesk:invoke');
    globalThis.__historyReads = [];
    ipcMain.removeHandler('pidesk:invoke');
    ipcMain.handle('pidesk:invoke', async (event, method, ...args) => {
      let request;
      if (method === 'historyPage' && args[1]?.cursor) {
        request = { cursor: JSON.stringify(args[1].cursor), done: false, session: args[0] };
        globalThis.__historyReads.push(request);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      const result = await original(event, method, ...args);
      if (request) request.done = true;
      return result;
    });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await page.locator('.session-row', { hasText: 'Long history fixture' }).click();
  await page.locator('.session-main .markdown', { hasText: 'LONG_BODY_END' }).waitFor({ timeout: 15000 });
  await page.locator('.session-main .transcript-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: /Load (full|earlier)/ }).count(), 0);
  const state = () => page.evaluate(() => { const s = window.__pideskState(); return s.transcripts[s.activeId]; });
  const first = await state();
  assert.ok(first.messages.length <= PAGE_MESSAGES);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_OPAQUE_SIGNATURE'));
  const deferredTools = first.messages.filter(m => m.role === 'toolResult' && m.__history?.truncated).length;
  assert.ok(deferredTools > 30, 'folded tool outputs are not fetched eagerly');
  await page.waitForTimeout(600);
  assert.equal((await state()).messages.length, first.messages.length, 'idle opening does not page backward automatically');
  assert.equal(await page.locator('.session-main .tool-group.work').count(), 1, 'large results must not fragment a continuous work group');
  console.log(`PASS normal cold history in ${Date.now() - started} ms (${original.length} source bytes), no load buttons or eager tool details`);

  await page.waitForFunction(() => {
    const images = ['.session-main img[alt="Reply plot"]', '.session-main img[alt="Assistant image"]', '.session-main .file-card img'];
    return images.every(selector => { const image = document.querySelector(selector); return image?.complete && image.naturalWidth > 0; });
  });
  await page.getByRole('button', { name: 'View image: Assistant image', exact: true }).click();
  await page.locator('.image-lightbox img').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const group = page.locator('.session-main .tool-group.work > .tool-group-head');
  await group.click();
  const call = page.locator('.session-main [data-tool-id="read-119"]');
  await call.locator('.tool-call-head').click();
  await call.locator('.tool-output', { hasText: 'OUTPUT_END_119' }).waitFor();
  await call.locator('img').waitFor();
  assert.equal((await state()).messages.filter(m => m.role === 'toolResult' && m.__history?.truncated).length, deferredTools - 1);
  await call.locator('.tool-call-head').click();
  // Keep the group open: older pages must preserve a tool's reading position inside it.
  console.log('PASS tool images, response images, Markdown session images and presented image thumbnails');
  await shot(page, '/tmp/pidesk-e2e/shots', '15-seamless-history');

  const scroller = page.locator('.session-main .transcript');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await app.evaluate(() => globalThis.__historyReads.filter(r => r.done).length >= 2)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await app.evaluate(() => globalThis.__historyReads.filter(r => r.done).length), 2, 'two pages should be prepared before upward navigation');
  assert.equal((await state()).messages.length, first.messages.length, 'prefetch does not alter the displayed window');
  const oldest = JSON.stringify((await state()).history.next);
  assert.ok(await app.evaluate((_, cursor) => globalThis.__historyReads.some(r => r.cursor === cursor && r.done), oldest));
  console.log('PASS two pages prefetched across simulated 800 ms transport latency before scrolling');
  for (let i = 0; i < 5; i++) {
    const before = JSON.stringify((await state()).history.next);
    const anchor = await scroller.evaluate(el => {
      el.scrollTop = 40;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      const top = el.getBoundingClientRect().top;
      const candidates = [...el.querySelectorAll('[data-tool-id], [data-history-key]')].filter(n => n.getBoundingClientRect().bottom > top && n.getBoundingClientRect().top < top + el.clientHeight && n.getBoundingClientRect().height > 0);
      const node = candidates.find(n => n.dataset.toolId) ?? candidates[0];
      const mark = { key: node.dataset.toolId ?? node.dataset.historyKey, tool: !!node.dataset.toolId, offset: node.getBoundingClientRect().top - top };
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      return mark;
    });
    if (i === 0) {
      const immediate = await state();
      assert.equal(immediate.history.loading, false, 'a warmed page must not enter a loading state');
      assert.notEqual(JSON.stringify(immediate.history.next), before, 'warmed history should be inserted without waiting for transport');
      assert.equal(immediate.messages.find(m => m.__entryId === 'history-751').__history.truncated, false, 'older prose must be hydrated before it becomes visible');
    }
    await page.waitForFunction(before => { const s = window.__pideskState(), h = s.transcripts[s.activeId].history; return !h.loading && JSON.stringify(h.next) !== before; }, before);
    await page.waitForTimeout(150);
    const shift = await scroller.evaluate((el, anchor) => {
      const node = [...el.querySelectorAll(anchor.tool ? '[data-tool-id]' : '[data-history-key]')].find(n => (anchor.tool ? n.dataset.toolId : n.dataset.historyKey) === anchor.key);
      return node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
    }, anchor);
    assert.ok(Math.abs(shift) < 3, `prepend moved the reading anchor by ${shift}px`);
  }
  const mounted = await page.locator('.session-main .history-virtual-row[data-mounted="true"]').count();
  const rows = await page.locator('.session-main .history-virtual-row').count();
  assert.ok(mounted < 80 && mounted < rows, `${mounted}/${rows} history rows mounted`);
  await checkComposerStability({ app, page, id: desktopId });
  const top = await scroller.evaluate(el => el.scrollTop);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'event', payload: { id,
    event: { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: 'New live reply while browsing' }] } } } }), desktopId);
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - top) < 3, 'live output must not pull a reader to the bottom');
  const count = (await state()).messages.length;
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await page.locator('.session-main .markdown', { hasText: 'New live reply while browsing' }).waitFor();
  assert.equal((await state()).messages.length, count, 'Latest is a scroll action, not a history reset');
  assert.deepEqual(errors, []);
  assert.ok(readFileSync(file).subarray(0, original.length).equals(original));
  assert.equal(mock.requests.length, 0);
  console.log(`PASS upward-only paging, stable anchors, viewport rendering (${mounted}/${rows}), live browsing and intact original history`);
  await page.locator('.session-row', { hasText: 'Tool-heavy history fixture' }).click();
  await page.waitForFunction(limit => {
    const state = window.__pideskState(), transcript = state.transcripts[state.activeId];
    const el = document.querySelector('.session-main .transcript');
    return transcript?.messages.length > limit && !transcript.history?.loading && el.scrollHeight >= el.clientHeight * 2.5;
  }, PAGE_MESSAGES, { timeout: 20000 });
  const sparse = await state();
  assert.ok(sparse.messages.length < sparseIndex, 'initial filling must not download the entire tool-heavy history');
  assert.equal(await page.locator('.session-main .history-boundary .spinner').count(), 0);
  assert.ok(readFileSync(sparseFile).subarray(0, sparseOriginal.length).equals(sparseOriginal));
  assert.equal(mock.requests.length, 0);
  console.log(`PASS useful initial history window after folded tools: ${sparse.messages.length}/${sparseIndex} records, at least 2.5 screens, no loading spinner`);
  await shot(page, '/tmp/pidesk-e2e/shots', '16-prefetched-tool-history');
} catch (error) {
  if (page) await shot(page, '/tmp/pidesk-e2e/shots', 'zz-history-failure').catch(() => {});
  throw error;
} finally { if (app) await app.close(); await mock.close(); }
