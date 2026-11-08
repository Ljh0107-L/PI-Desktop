// Real Settings actions against the injected OAuth fixture; no browser launch or model inference.
import assert from 'node:assert/strict';

export async function checkChatGPT({ page, screenshot, settingsBefore }) {
  const originalModel = await page.evaluate(() => window.__pideskState().draft.model);
  const openChatGPT = async () => {
    await page.locator('.settings-sidebar-nav').getByRole('button', { name: 'ChatGPT', exact: true }).click();
    await page.locator('.section-title', { hasText: 'ChatGPT accounts' }).waitFor();
  };
  const chooseModel = async model => {
    await page.locator('.model-trigger').click();
    await page.locator('.model-menu').getByTitle(`${model.provider}/${model.id}`, { exact: true }).click();
  };
  await openChatGPT();
  const local = page.locator('.row-card').filter({ hasText: /This computer|This Mac|Local/ }).first();
  const remote = page.locator('.row-card').filter({ hasText: 'pidesk-test' });
  assert.equal(await remote.count(), 1);
  const geometry = await local.evaluate(el => {
    const style = getComputedStyle(el), head = getComputedStyle(el.querySelector('.row-head'));
    return { background: style.backgroundColor, radius: style.borderRadius, padding: head.padding, font: head.fontSize };
  });
  assert.deepEqual(geometry, settingsBefore, 'ChatGPT reuses the Models row-card styling');
  await screenshot('03d-chatgpt');
  await local.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
  await local.locator('input[type=password]').waitFor();
  await screenshot('03d-chatgpt-signing-in');
  await local.getByRole('button', { name: 'Cancel', exact: true }).click();
  await local.locator('form').waitFor({ state: 'detached' });
  await local.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
  await local.locator('input[type=password]').fill('wrong');
  await local.getByRole('button', { name: 'Complete sign-in' }).click();
  await local.locator('.form-error').waitFor();
  assert.ok(!(await local.innerText()).includes('fixture-refresh'));
  for (const row of [local, remote]) {
    await row.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
    await row.locator('input[type=password]').fill('fixture-authorized');
    await row.getByRole('button', { name: 'Complete sign-in' }).click();
    await row.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  }
  await screenshot('03e-chatgpt-connected');
  let boot = await page.evaluate(() => window.pidesk.invoke('bootstrap'));
  assert.notEqual(boot.settings.chatgpt.accounts.local.vaultId, boot.settings.chatgpt.accounts['ssh:pidesk-test'].vaultId);
  assert.notEqual(boot.settings.chatgpt.accounts.local.deviceId, boot.settings.chatgpt.accounts['ssh:pidesk-test'].deviceId);
  assert.ok(boot.settings.providers.some(p => p.name === 'Mock Lab'));
  assert.ok(!JSON.stringify(boot.settings).includes('fixture-refresh'));
  const models = await page.evaluate(() => window.pidesk.invoke('catalog'));
  let subscription = models.filter(m => m.provider === 'pidesk-chatgpt');
  assert.equal(subscription.length, 3);
  assert.ok(subscription.every(m => m.contextWindow > 0 && m.maxTokens > 0 && m.environments.includes('local') && m.environments.includes('ssh:pidesk-test')));
  const settings = page.locator('.chatgpt-models');
  await settings.getByRole('button', { name: 'Edit', exact: true }).click();
  await settings.locator('.model-catalog-actions').getByRole('button', { name: 'Choose models', exact: true }).click();
  await page.locator('.modal').getByRole('button', { name: 'Deselect all', exact: true }).click();
  await page.locator('.modal .search-field input').fill('gpt-6');
  await page.locator('.modal .pick-row').filter({ hasText: 'GPT-6 Astra' }).click();
  await page.locator('.modal .pick-row').filter({ hasText: 'GPT-6.1 Sol' }).click();
  assert.equal(await page.locator('.picker-count').innerText(), '2 of 3');
  await screenshot('03f-chatgpt-model-picker');
  await page.locator('.modal').getByRole('button', { name: 'Done', exact: true }).click();
  const astra = settings.locator('.model-entry').filter({ has: page.locator('input[value="gpt-6-astra"]') });
  await astra.getByRole('button', { name: 'Parameters', exact: true }).click();
  const context = astra.locator('label.field').filter({ hasText: 'Context window' }).locator('input');
  const output = astra.locator('label.field').filter({ hasText: 'Max output tokens' }).locator('input');
  assert.equal(await context.inputValue(), '272000'); assert.equal(await output.inputValue(), '128000');
  await context.fill('512000'); await output.fill('64000');
  await screenshot('03g-chatgpt-model-parameters');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await settings.locator('form').waitFor({ state: 'detached' });
  subscription = (await page.evaluate(() => window.pidesk.invoke('catalog'))).filter(m => m.provider === 'pidesk-chatgpt');
  assert.deepEqual(subscription.map(m => m.id), ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.equal(subscription[0].contextWindow, 512000); assert.equal(subscription[0].maxTokens, 64000);
  assert.deepEqual(subscription[0].speeds, ['standard', 'fast', 'ultrafast']);
  assert.equal(subscription.find(m => m.id === 'gpt-6.1-sol').contextWindow, 500000);
  await settings.getByRole('button', { name: 'Edit', exact: true }).click();
  await astra.getByRole('button', { name: 'Parameters', exact: true }).click();
  assert.equal(await context.inputValue(), '512000'); assert.equal(await output.inputValue(), '64000');
  await settings.getByRole('button', { name: 'Reset parameters', exact: true }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await settings.locator('form').waitFor({ state: 'detached' });
  const restored = await page.evaluate(() => window.pidesk.invoke('chatGPTModelSettings'));
  assert.ok(restored.models.every(m => m.api === 'openai-codex-responses'));
  assert.equal(restored.models[0].contextWindow, 272000); assert.equal(restored.models[0].maxTokens, 128000);
  await page.locator('.nav-item.back').click();
  for (const model of subscription) {
    await chooseModel(model);
    await page.locator('.speed-trigger').click();
    await page.getByRole('button', { name: 'Fast', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__pideskState().draft.speed), 'fast');
    await page.locator('.speed-trigger').click();
    await page.getByRole('button', { name: 'Ultrafast', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__pideskState().draft.speed), 'ultrafast');
  }
  await screenshot('03h-chatgpt-ultrafast');
  await page.locator('.speed-trigger').click();
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await page.locator('.model-trigger').click();
  assert.equal(await page.locator('.model-menu').getByTitle('pidesk-chatgpt/gpt-6-luna', { exact: true }).count(), 0);
  await page.locator('.model-menu').getByRole('button', { name: 'Manage models…', exact: true }).click();
  await page.locator('.section-title', { hasText: 'ChatGPT accounts' }).waitFor();
  await screenshot('03h-chatgpt-managed-models');
  await local.getByRole('button', { name: 'Sign out', exact: true }).click();
  await local.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).waitFor();
  const remaining = await page.evaluate(() => window.pidesk.invoke('catalog'));
  assert.ok(remaining.filter(m => m.provider === 'pidesk-chatgpt').every(m => !m.environments.includes('local') && m.environments.includes('ssh:pidesk-test')));
  await page.locator('.nav-item.back').click();
  assert.equal(await page.evaluate(() => window.__pideskState().draft.model.provider), 'pidesk-chatgpt', 'logout must not switch to a paid API provider');
  await page.locator('.composer textarea').fill('This must not be sent after logout');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForFunction(() => (window.__pideskNoticeLog ?? []).some(n => n.includes('Sign in to ChatGPT for this environment')));
  assert.equal((await page.evaluate(() => window.pidesk.invoke('listSessions'))).length, 0, 'no fallback request or conversation was created');
  await page.locator('.composer textarea').fill('');
  await chooseModel(originalModel);
  await page.locator('.settings-button').click(); await openChatGPT();
  await remote.getByRole('button', { name: 'Sign out', exact: true }).click();
  await remote.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).waitFor();
  boot = await page.evaluate(() => window.pidesk.invoke('bootstrap'));
  assert.ok(!boot.settings.providers.some(p => p.kind === 'subscription'));
  assert.ok(boot.settings.providers.some(p => p.name === 'Mock Lab' && p.hasKey));
}
