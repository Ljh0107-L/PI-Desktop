// Preloaded before Pi reads settings. Keep Pi's native retry, cancellation and history handling.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const defaults = { maxRetries: 10, baseDelayMs: 200, maxAgentDelayMs: 120_000 };
const agentDir = process.env.PI_CODING_AGENT_DIR;

if (agentDir) {
  const path = join(agentDir, 'settings.json');
  let temporary;
  try {
    let settings = {};
    try { settings = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const retry = settings?.retry;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        (retry != null && (typeof retry !== 'object' || Array.isArray(retry)))) {
      throw new Error('Invalid Pi settings');
    }
    if (Object.keys(defaults).some(key => retry?.[key] == null)) {
      settings.retry = { ...retry };
      for (const [key, value] of Object.entries(defaults)) settings.retry[key] ??= value;
      mkdirSync(agentDir, { recursive: true });
      temporary = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    }
  } catch {
    // Leave an unreadable or invalid file for Pi to report and keep session startup available.
    if (temporary) { try { rmSync(temporary, { force: true }); } catch { /* best effort */ } }
    process.stderr.write('pidesk: could not initialize model retry defaults\n');
  }
}
