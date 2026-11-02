// CI only: exercise Electron's bundled Node with no system Node on the app PATH,
// plus real SSE output-length recovery. All model responses come from localhost mocks.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch, shot } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

if (!process.env.CI) throw new Error('Run this Electron regression only in GitHub CI, not on the user workstation.');
const profile = mkdtempSync(join(tmpdir(), 'pidesk-runtime-e2e-'));
const cwd = join(profile, 'project'); mkdirSync(cwd);
const mock = await startMockLlm({ chunkDelay: 1 });
let app, page, session;
const invoke = (method, ...args) => page.evaluate(([method, args]) => window.pidesk.invoke(method, ...args), [method, args]);
async function run(prompt) {
  const before = (await invoke('messages', session.id)).length;
  await invoke('prompt', session.id, prompt, []);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const records = await invoke('messages', session.id);
    const current = (await invoke('listSessions')).find(row => row.id === session.id);
    const recent = records.slice(before);
    if (!current.streaming && recent.some(m => m.role === 'assistant' && m.stopReason === 'stop')) return recent;
    await sleep(80);
  }
  throw new Error('Mock runtime/recovery prompt did not settle');
}
const childOf = messages => messages.find(m => m.role === 'toolResult' && m.toolName === 'subagent')?.details?.results?.[0];
try {
  ({ app, page } = await launch({ userData: profile, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PIDESK_DEFAULT_WORKSPACE: join(profile, 'Pi') } }));
  await invoke('saveProvider', { id: 'runtime-lab', name: 'Runtime fixture', kind: 'custom', api: 'openai-completions', baseUrl: mock.baseUrl('runtime-lab'),
    models: [{ id: 'alpha-1', reasoning: false, contextWindow: 128000, maxTokens: 32768, input: ['text'] }] }, 'sk-offline-fixture');
  session = await invoke('createSession', { environmentId: 'local', cwd, model: { provider: 'runtime-lab', id: 'alpha-1' }, thinkingLevel: 'high', prompt: 'Runtime regression' });
  const main = await run(`[[bash:node -p "'main-runtime=' + Boolean(process.versions.electron)"; "$PI_NODE" -p "'main-pi-node=' + Boolean(process.versions.electron)"]]`);
  const mainOutput = main.find(m => m.role === 'toolResult' && m.toolName === 'bash')?.content?.[0]?.text ?? '';
  assert.match(mainOutput, /main-runtime=true/);
  assert.match(mainOutput, /main-pi-node=true/);
  const child = childOf(await run('[[subagents-runtime]]'));
  assert.equal(child.status, 'completed');
  const output = child.steps.find(step => step.name === 'bash')?.output ?? '';
  assert.match(output, /runtime=true/); assert.match(output, /pi-node=true/);
  assert.ok(mock.requests.filter(request => request.subagent).every(request => request.system.includes('Runtime availability is not permission')));
  console.log('PASS bundled Electron Node is callable from main and child tools without a system Node PATH or extra window');

  for (const mode of ['length', 'length-tools', 'length-repeat']) {
    const child = childOf(await run(`[[subagents-${mode}]]`));
    assert.equal(child.lengthRecoveries, 1);
    assert.equal(child.status, mode === 'length-repeat' ? 'failed' : 'completed');
    assert.ok(!JSON.stringify(child).includes('PRIVATE_REASONING_FIXTURE_NOT_FOR_TRACE'));
    assert.equal(existsSync(join(cwd, 'must-not-be-written.txt')), false);
    if (mode === 'length-tools') assert.equal(child.skippedToolCalls, 1);
    if (mode === 'length-repeat') { assert.equal(child.failureKind, 'output_limit'); assert.equal(child.lastResponse.reasoningTokens, 32768); }
    console.log(`PASS real SSE ${mode} recovery preserves safe tool execution and reports its budget`);
  }
  await page.locator('.session-row').first().click();
  const summaries = page.locator('.session-main .subagent-summary');
  await summaries.nth(3).locator('.subagent-task-row').click();
  await page.locator('.subagent-inspector-meta', { hasText: 'Output limit' }).waitFor();
  assert.ok((await page.locator('.subagent-inspector .block-error').allInnerTexts()).some(text => text.includes('32768 reasoning tokens')));
  await shot(page, '/tmp/pidesk-e2e/shots', '13-subagent-output-limit');
  await summaries.nth(2).locator('.subagent-task-row').click();
  await page.locator('.subagent-inspector .tool-group-head').click();
  await page.locator('.subagent-inspector .tool-call.skipped').waitFor();
  assert.equal(await page.locator('.subagent-inspector .tool-call.running').count(), 0);
  assert.equal(await page.locator('.subagent-inspector .block-error').count(), 0, 'recovered output limits must not remain final red failures');
  assert.ok(await page.locator('.subagent-inspector .block-notice', { hasText: 'Recovered from an earlier output limit' }).count());
  assert.equal(await page.locator('.subagent-inspector .step-open').count(), 0);
  await shot(page, '/tmp/pidesk-e2e/shots', '14-subagent-skipped-tool');
  assert.equal((await app.windows()).length, 1);
  console.log('PASS output-limit and skipped-call UI is explicit; no perpetual running marker');
} finally {
  if (session && page && !page.isClosed()) await invoke('deleteSession', session.id).catch(() => {});
  await app?.close().catch(() => {});
  await mock.close();
}
