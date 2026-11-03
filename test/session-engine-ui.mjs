// Regression for the reported mixed "Cursor CLI + model_hub/..." composer.
import assert from 'node:assert/strict';

export async function checkSessionEngineIsolation({ app, page, session }) {
  const originalCursor = await page.evaluate(() => window.__pideskState().settings.cursor);
  const originalSessions = await page.evaluate(() => window.pidesk.invoke('listSessions'));
  const longId = 'model_hub/modelhub-gpt-6-astra-very-long-legacy-model-identifier-'.repeat(4);
  const publish = sessions => app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'sessions', payload }), sessions);
  const selectExisting = () => page.locator('.session-row', { hasText: session.title }).first().click();
  const settings = async () => {
    await page.click('.settings-button');
    await page.getByRole('button', { name: 'Cursor SDK', exact: true }).click();
  };
  try {
    await settings();
    await page.getByLabel('Enable Cursor SDK').check();
    await page.locator('.cursor-advanced summary').click();
    // No Cursor launch/model request is involved in this renderer regression.
    await page.getByLabel('Cursor CLI executable').fill('/fixture/not-launched/cursor-agent');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.__pideskState().settings.cursor.enabled);
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.click('.nav-item.new');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.popover .menu-item', { hasText: /^Cursor CLI$/ }).click();
    assert.equal(await page.locator('.engine-trigger').innerText(), 'Cursor CLI');
    await page.locator('.composer textarea').fill('Unsent new conversation');
    await selectExisting();
    await page.locator('.composer textarea').fill('Unsent existing conversation');
    await page.locator('.composer').evaluate(element => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      transfer.items.add(new File([bytes], 'draft.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.locator('.attachment.image img').waitFor();
    await page.click('.nav-item.new');
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent new conversation');
    assert.equal(await page.locator('.attachment').count(), 0, 'attachments must not leak between sessions');
    await page.locator('.composer textarea').fill('');
    await selectExisting();
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent existing conversation');
    assert.equal(await page.locator('.attachment.image img').count(), 1, 'image draft survives composer unmount');
    await page.click('.settings-button');
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent existing conversation');
    await page.getByRole('button', { name: 'Remove draft.png', exact: true }).click();
    await page.locator('.composer textarea').fill('');
    // Simulate an older renderer/session payload without engine metadata. Backend
    // normalization alone must not hide a bad renderer fallback.
    await publish(originalSessions.map(record => {
      if (record.id !== session.id) return record;
      const { engine, ...legacy } = record;
      return { ...legacy, model: { provider: 'model_hub', id: longId } };
    }));
    await page.waitForFunction(() => document.querySelector('.engine-label')?.textContent === 'Pi');
    assert.equal(await page.locator('.effort-trigger').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Model', exact: true }).getAttribute('title'), `model_hub/${longId}`);
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.locator('.model-menu:not(.cursor-model-menu)').waitFor();
    assert.equal(await page.locator('.cursor-model-menu').count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('.composer textarea').fill('/');
    await page.locator('.slash-item', { hasText: '/goal' }).waitFor();
    await page.locator('.composer textarea').fill('');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 640));
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.file-pane').waitFor();
    await page.waitForFunction(() => {
      const bar = document.querySelector('.composer-bar');
      const model = bar?.querySelector('.model-trigger');
      return bar && model && bar.scrollWidth <= bar.clientWidth + 1 && model.getBoundingClientRect().width > 0;
    });
    assert.equal(await page.locator('.effort-trigger').isVisible(), true);
    await page.screenshot({ path: '/tmp/pidesk-e2e/shots/legacy-pi-engine-isolation.png' });
    await page.getByRole('button', { name: 'Close files', exact: true }).click();
    console.log('PASS legacy Pi engine/model/effort stay independent of Cursor draft; long model names fit narrow panes');
  } finally {
    if (await page.getByRole('button', { name: 'Close files', exact: true }).count()) await page.getByRole('button', { name: 'Close files', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await publish(originalSessions);
    await page.click('.nav-item.new');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.popover .menu-item', { hasText: /^Pi$/ }).click();
    await selectExisting();
    await settings();
    await page.getByLabel('Enable Cursor SDK').setChecked(!!originalCursor?.enabled);
    await page.locator('.cursor-advanced summary').click();
    await page.getByLabel('Cursor CLI executable').fill(originalCursor?.command ?? '');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(enabled => window.__pideskState().settings.cursor.enabled === enabled, !!originalCursor?.enabled);
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  }
}
