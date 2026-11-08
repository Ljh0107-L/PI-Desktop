// CI only: seamless history browsing and model-visible images in real Electron.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, shot } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

if (!process.env.CI) throw new Error('Run this regression only in GitHub CI.');
const profile = mkdtempSync(join(tmpdir(), 'pidesk-history-ui-'));
const cwd = join(profile, 'project'); mkdirSync(cwd);
const file = join(profile, 'long-session.jsonl');
const sessionId = '11111111-2222-4333-8444-555555555555', desktopId = 'history-ui';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
writeFileSync(join(cwd, 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#42a5f5"/></svg>');
const mock = await startMockLlm({ chunkDelay: 0 });
const provider = { id: 'history-lab', name: 'History lab', kind: 'custom', api: 'openai-completions', baseUrl: mock.baseUrl('history-lab'),
  models: [{ id: 'model', name: 'Model', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'] }] };
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ providers: [provider], defaults: { model: { provider: provider.id, id: 'model' } }, environments: {} }));
writeFileSync(join(profile, 'secrets.json'), JSON.stringify({ [provider.id]: { insecure: Buffer.from('test-only').toString('base64') } }));
writeFileSync(join(profile, 'sessions.json'), JSON.stringify([{ id: desktopId, title: 'Long history fixture', environmentId: 'local', environmentLabel: 'This computer', cwd,
  project: 'History', piSessionFile: file, piSessionId: sessionId, model: { provider: provider.id, id: 'model' }, thinkingLevel: 'off', createdAt: 1, updatedAt: 1 }]));
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
  append({ role, content: [...(role === 'assistant' ? [{ type: 'thinking', thinking: '', thinkingSignature: 'PRIVATE_OPAQUE_SIGNATURE'.repeat(2500) }] : []), { type: 'text', text: `History ${role} ${i}` }] });
}
append({ role: 'user', content: [{ type: 'text', text: 'Inspect and show the plot' }] });
for (let i = 0; i < 12; i++) {
  append({ role: 'assistant', content: [{ type: 'toolCall', name: 'read', id: `read-${i}`, arguments: { path: 'plot.svg' } }] });
  append({ role: 'toolResult', toolCallId: `read-${i}`, toolName: 'read', content: [{ type: 'text', text: `OUTPUT_START_${i} ` + 'tool output '.repeat(2000) + ` OUTPUT_END_${i}` }, { type: 'image', mimeType: 'image/png', data: png }] });
}
append({ role: 'assistant', content: [{ type: 'toolCall', name: 'present_files', id: 'show-plot', arguments: { paths: ['plot.svg'] } }] });
append({ role: 'toolResult', toolCallId: 'show-plot', toolName: 'present_files', content: [], details: { kind: 'pidesk-files', files: [{ path: 'plot.svg', name: 'plot.svg', size: 130 }] } });
append({ role: 'assistant', content: [{ type: 'text', text: 'LONG_BODY_START ' + 'visible body '.repeat(1200) + ' LONG_BODY_END\n\n![Reply plot](plot.svg)' }, { type: 'image', mimeType: 'image/png', data: png }] });
const original = readFileSync(file);
let app, page;
try {
  ({ app, page } = await launch({ userData: profile, env: { PIDESK_DEFAULT_WORKSPACE: join(profile, 'Pi') } }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await page.locator('.session-row', { hasText: 'Long history fixture' }).click();
  await page.locator('.session-main .markdown', { hasText: 'LONG_BODY_END' }).waitFor({ timeout: 15000 });
  await page.locator('.session-main .transcript-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: /Load (full|earlier)/ }).count(), 0);
  const state = () => page.evaluate(() => { const s = window.__pideskState(); return s.transcripts[s.activeId]; });
  const first = await state();
  assert.ok(first.messages.length <= 80);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_OPAQUE_SIGNATURE'));
  assert.equal(first.messages.filter(m => m.role === 'toolResult' && m.__history?.truncated).length, 12, 'folded tool outputs are not fetched eagerly');
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
  const call = page.locator('.session-main [data-tool-id="read-11"]');
  await call.locator('.tool-call-head').click();
  await call.locator('.tool-output', { hasText: 'OUTPUT_END_11' }).waitFor();
  await call.locator('img').waitFor();
  assert.equal((await state()).messages.filter(m => m.role === 'toolResult' && m.__history?.truncated).length, 11);
  await call.locator('.tool-call-head').click();
  await group.click();
  console.log('PASS tool images, response images, Markdown session images and presented image thumbnails');
  await shot(page, '/tmp/pidesk-e2e/shots', '15-seamless-history');

  const scroller = page.locator('.session-main .transcript');
  for (let i = 0; i < 5; i++) {
    const before = JSON.stringify((await state()).history.next);
    const anchor = await scroller.evaluate(el => {
      el.scrollTop = 40;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      const top = el.getBoundingClientRect().top;
      const node = [...el.querySelectorAll('[data-history-key]')].find(n => n.getBoundingClientRect().bottom > top && n.getBoundingClientRect().height > 0);
      const mark = { key: node.dataset.historyKey, offset: node.getBoundingClientRect().top - top };
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      return mark;
    });
    await page.waitForFunction(before => { const s = window.__pideskState(), h = s.transcripts[s.activeId].history; return !h.loading && JSON.stringify(h.next) !== before; }, before);
    await page.waitForTimeout(150);
    const shift = await scroller.evaluate((el, anchor) => {
      const node = [...el.querySelectorAll('[data-history-key]')].find(n => n.dataset.historyKey === anchor.key);
      return node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
    }, anchor);
    assert.ok(Math.abs(shift) < 3, `prepend moved the reading anchor by ${shift}px`);
  }
  const mounted = await page.locator('.session-main .history-virtual-row[data-mounted="true"]').count();
  const rows = await page.locator('.session-main .history-virtual-row').count();
  assert.ok(mounted < 80 && mounted < rows, `${mounted}/${rows} history rows mounted`);
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
} catch (error) {
  if (page) await shot(page, '/tmp/pidesk-e2e/shots', 'zz-history-failure').catch(() => {});
  throw error;
} finally { if (app) await app.close(); await mock.close(); }
