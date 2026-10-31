// Launch Pi Desktop under Playwright with an isolated profile.
import { _electron as electron } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const electronBinary = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

export async function launch({ userData, env = {}, width = 1440, height = 900 }) {
  mkdirSync(userData, { recursive: true });
  // A parent Electron app (e.g. the harness running these tests) may export ELECTRON_RUN_AS_NODE,
  // which would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE, ...parentEnv } = process.env;
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [root],
    env: { ...parentEnv, PIDESK_USER_DATA: userData, PIDESK_INSECURE_TEST_STORAGE: '1', PIDESK_QUIT_ON_CLOSE: '1', ...env },
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => console.log('[renderer error]', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('[renderer console]', message.text()); });
  await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(size.width, size.height); w.center(); }, { width, height });
  await page.waitForSelector('.app:not(.loading)');
  return { app, page };
}

export async function shot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path });
  return path;
}
