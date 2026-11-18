// An in-app update is different from a normal quit/reconnect: the new desktop must
// replace the live session processes, not attach to code they loaded before the update.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRetiredProvider } from '../../core/retired-providers.mjs';

const planPath = dir => join(dir, 'session-update.json');
const restartable = record => !record.archived && record.engine !== 'cursor' && !isRetiredProvider(record.model?.provider);
const errorMessage = error => String(error?.message ?? error).trim().slice(-800);

export function saveSessionUpdate(dir, plan) {
  const target = planPath(dir), tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, target);
  } finally { rmSync(tmp, { force: true }); }
}

export function loadSessionUpdate(dir, version, { legacyCache } = {}) {
  try {
    const plan = JSON.parse(readFileSync(planPath(dir), 'utf8'));
    if (plan?.version === version && [plan.reopen, plan.done, plan.only ?? []].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) return plan;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Before this feature, the updater moved the only .app out of updates/<version>/app.
  // An empty staging directory at that exact version signals a successful in-app update.
  // Old builds didn't record which local sessions were live before quitting, so don't
  // guess from history; only restart sessions we can still see on their relays.
  if (!legacyCache) return null;
  try { if (readdirSync(join(legacyCache, version, 'app')).length) return null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const plan = { version, reopen: [], done: [] };
  saveSessionUpdate(dir, plan);
  return plan;
}

export function clearSessionUpdate(dir) { rmSync(planPath(dir), { force: true }); }

export async function planSessionUpdate(manager, version) {
  const local = manager.environments().find(env => env.kind === 'local');
  const records = manager.store.sessions.filter(record => record.environmentId === local?.id && restartable(record));
  const alive = new Set(records.length ? (await manager.relaySessions(local)).filter(s => s.alive).map(s => s.id) : []);
  return { version, reopen: records.filter(record => alive.has(record.id)).map(record => record.id), done: [] };
}

export async function restartUpdatedSessions(manager, plan, { checkpoint, cancelled = () => false } = {}) {
  const restarted = [], failures = [], skipResume = new Set(), failedIds = new Set();
  const reopen = new Set(plan.reopen), done = new Set(plan.done), only = plan.only && new Set(plan.only);
  const snapshot = () => ({ ...plan, reopen: [...reopen], done: [...done] });
  const save = () => checkpoint?.(snapshot());
  const byEnv = new Map();
  for (const record of manager.store.sessions) {
    if (!restartable(record) || done.has(record.id) || (only && !only.has(record.id))) continue;
    skipResume.add(record.id); // discovery below owns these records; don't attach again at startup
    if (!byEnv.has(record.environmentId)) byEnv.set(record.environmentId, []);
    byEnv.get(record.environmentId).push(record);
  }
  const envs = new Map(manager.environments().map(env => [env.id, env]));
  await Promise.all([...byEnv].map(async ([envId, records]) => {
    const env = envs.get(envId), environment = env?.label ?? records[0].environmentLabel ?? envId;
    if (cancelled() || !env || (env.kind === 'ssh' && (!env.added || !env.enabled))) return;
    let live;
    try { live = new Set((await manager.relaySessions(env)).filter(s => s.alive).map(s => s.id)); }
    catch (error) {
      for (const { id } of records) failedIds.add(id);
      failures.push({ environment, message: `Could not check for running conversations: ${errorMessage(error)}` });
      return;
    }
    // Keep relay probes and attaches under OpenSSH's per-connection session limit.
    for (const { id, title } of records) {
      if (cancelled()) return;
      if (!live.has(id) && !reopen.has(id)) continue;
      try {
        // Record this before stopping: if the desktop quits mid-update the next launch
        // must still reopen this history even if the process is no longer listed as live.
        if (!reopen.has(id)) { reopen.add(id); save(); }
        if (live.has(id)) {
          const stdout = await manager.stopRelay(env, id, { forUpdate: true });
          const ack = JSON.parse(stdout.trim().split('\n').at(-1));
          if (ack.relay !== 'stopped' || typeof ack.found !== 'boolean') throw new Error('Relay did not acknowledge the stop');
        }
        if (cancelled()) return;
        const session = await manager.ensureStarted(id).catch(async error => {
          await manager.close(id); // configuration can fail after scheduling a reconnect
          throw error;
        });
        if (cancelled()) return;
        if (!session.attachInfo?.created) {
          await manager.close(id);
          throw new Error('The relay reattached to an existing process instead of starting a new one');
        }
        done.add(id);
        save();
        restarted.push({ id, title, environment });
      } catch (error) {
        failedIds.add(id);
        failures.push({ id, title, environment, message: errorMessage(error) });
      }
    }
  }));
  return { version: plan.version, restarted, failures, skipResume, failedIds, retryPlan: { ...snapshot(), only: [...failedIds] } };
}
