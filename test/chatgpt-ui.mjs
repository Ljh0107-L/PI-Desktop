// Real Settings actions against the injected OAuth fixture; no browser launch or model inference.
import assert from 'node:assert/strict';

export async function checkChatGPT({ page, screenshot, settingsBefore }) {
  await page.locator('.settings-sidebar-nav').getByRole('button', { name: 'ChatGPT', exact: true }).click();
  await page.locator('.section-title', { hasText: 'ChatGPT accounts' }).waitFor();
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
  const subscription = models.filter(m => m.provider === 'pidesk-chatgpt');
  assert.equal(subscription.length, 2);
  assert.ok(subscription.every(m => m.contextWindow > 0 && m.maxTokens > 0 && m.environments.includes('local') && m.environments.includes('ssh:pidesk-test')));
  await local.getByRole('button', { name: 'Sign out', exact: true }).click();
  await local.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).waitFor();
  const remaining = await page.evaluate(() => window.pidesk.invoke('catalog'));
  assert.ok(remaining.filter(m => m.provider === 'pidesk-chatgpt').every(m => !m.environments.includes('local') && m.environments.includes('ssh:pidesk-test')));
  await remote.getByRole('button', { name: 'Sign out', exact: true }).click();
  await remote.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).waitFor();
  boot = await page.evaluate(() => window.pidesk.invoke('bootstrap'));
  assert.ok(!boot.settings.providers.some(p => p.kind === 'subscription'));
  assert.ok(boot.settings.providers.some(p => p.name === 'Mock Lab' && p.hasKey));
}
