// CI only: large-history opening, pagination, lazy details and viewport-only content in Electron.
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
const sessionId = '11111111-2222-4333-8444-555555555555';
const desktopId = 'history-ui';
const mock = await startMockLlm({ chunkDelay: 0 });
const provider = { id: 'history-lab', name: 'History lab', kind: 'custom', api: 'openai-completions', baseUrl: mock.baseUrl('history-lab'),
  models: [{ id: 'model', name: 'Model', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'] }] };
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ providers: [provider], defaults: { model: { provider: provider.id, id: 'model' } }, environments: {} }));
writeFileSync(join(profile, 'secrets.json'), JSON.stringify({ [provider.id]: { insecure: Buffer.from('test-only').toString('base64') } }));
writeFileSync(join(profile, 'sessions.json'), JSON.stringify([{ id: desktopId, title: 'Long history fixture', environmentId: 'local', environmentLabel: 'This computer', cwd,
  project: 'History', piSessionFile: file, piSessionId: sessionId, model: { provider: provider.id, id: 'model' }, thinkingLevel: 'off', createdAt: 1, updatedAt: 1 }]));
writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + '\n');
let parentId = null;
for (let i = 0; i < 800; i++) {
  const role = i % 2 ? 'assistant' : 'user';
  const text = i === 799 ? 'LONG_BODY_START ' + 'visible body '.repeat(4000) + ' LONG_BODY_END' : `History ${role} ${i}`;
  const message = { role, timestamp: 1000 + i, content: [{ type: 'text', text }] };
  if (role === 'assistant') Object.assign(message, { api: 'openai-completions', provider: provider.id, model: 'model', stopReason: 'stop',
    usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { total: 0 } },
    content: [{ type: 'thinking', thinking: '', thinkingSignature: 'PRIVATE_OPAQUE_SIGNATURE'.repeat(2500) }, ...message.content] });
  const id = `history-${i}`;
  appendFileSync(file, JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message }) + '\n'); parentId = id;
}
const original = readFileSync(file);
let app, page;
try {
  ({ app, page } = await launch({ userData: profile, env: { PIDESK_DEFAULT_WORKSPACE: join(profile, 'Pi') } }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const invoke = (method, ...args) => page.evaluate(([method, args]) => window.pidesk.invoke(method, ...args), [method, args]);
  const started = Date.now();
  await page.locator('.session-row', { hasText: 'Long history fixture' }).click();
  await page.locator('.session-main .history-earlier').waitFor({ state: 'attached', timeout: 15000 });
  await page.locator('.session-main .transcript-loading').waitFor({ state: 'hidden' });
  console.log(`PASS cold large history displayed in ${Date.now() - started} ms (${original.length} source bytes)`);
  const first = await invoke('historyPage', desktopId);
  assert.ok(first.messages.length <= 80);
  assert.ok(JSON.stringify(first).length < 300000);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_OPAQUE_SIGNATURE'));
  assert.equal(await page.getByText('History user 0', { exact: true }).count(), 0, 'old history is not eagerly rendered');
  await page.locator('.session-main .history-detail').last().click();
  await page.locator('.session-main .markdown', { hasText: 'LONG_BODY_END' }).waitFor({ timeout: 15000 });
  console.log('PASS explicit detail loading restores the whole visible message');
  for (let i = 0; i < 5; i++) {
    await page.locator('.session-main .history-earlier').click();
    await page.locator('.session-main .history-earlier').filter({ hasText: 'Load earlier messages' }).waitFor();
  }
  await page.waitForFunction(() => document.querySelectorAll('.session-main .history-virtual-row').length > 80);
  const mounted = await page.locator('.session-main .history-virtual-row[data-mounted="true"]').count();
  const rows = await page.locator('.session-main .history-virtual-row').count();
  assert.ok(mounted < 80 && mounted < rows, `${mounted}/${rows} history rows mounted`);
  assert.deepEqual(errors, []);
  assert.ok(readFileSync(file).subarray(0, original.length).equals(original), 'no truncation or rewrite of original history');
  assert.equal(mock.requests.length, 0, 'browsing history never calls a model');
  console.log(`PASS pagination with viewport-only rendering (${mounted}/${rows} mounted), no inference and original history retained`);
  await shot(page, '/tmp/pidesk-e2e/shots', '15-long-history');
} finally { if (app) await app.close(); await mock.close(); }
