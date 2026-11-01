// How long each user-facing operation takes, on this machine and over SSH, through the real
// SessionManager (no UI). Prints a table and fails if an operation is slower than its budget.
//   sh test/sshd.sh &   then   node test/latency.mjs [--ssh-config /tmp/pidesk-sshd/ssh_config]
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { Store } from '../app/main/store.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { listEnvironments } from '../app/main/environments.mjs';
import { startMockLlm } from './mock-llm.mjs';

const { values: opts } = parseArgs({ options: { 'ssh-config': { type: 'string', default: '/tmp/pidesk-sshd/ssh_config' }, 'no-ssh': { type: 'boolean', default: false } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'pidesk-latency-'));
const mock = await startMockLlm();
const store = new Store(join(work, 'profile'), null, { insecureTestStorage: true });
store.settings.providers = [{ id: 'mock-lab', name: 'Mock Lab', kind: 'custom', api: 'openai-completions', baseUrl: mock.baseUrl('mock-lab'), models: [{ id: 'alpha-1' }, { id: 'beta-1' }] }];
store.setKey('mock-lab', 'sk-latency');
// Own install root on the host and own relay copy here, so this can run next to the other suites.
const state = opts['no-ssh'] ? {} : { 'ssh:pidesk-test': { added: true, root: join(work, 'host-root') } };
store.settings.environments = state;
const relayPath = join(work, 'pidesk-relay.mjs');
copyFileSync(join(root, 'agent/pidesk-relay.mjs'), relayPath);
const manager = new SessionManager({
  store, environments: () => listEnvironments({ sshConfig: opts['ssh-config'], state }), piVersion: '1.4.0',
  bridgePath: join(root, 'agent/pidesk-bridge.js'), relayPath,
  piPackageDir: join(root, 'node_modules/@earendil-works/pi-coding-agent'), cacheDir: join(work, 'downloads'),
  local: { node: process.execPath, piCli: join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), agentDir: join(work, 'agent'), runDir: join(work, 'run'), uploadDir: join(work, 'uploads'), extraEnv: {} },
});

const rows = [];
let failed = 0;
// Shared CI runners are several times slower than a developer Mac.
const SCALE = process.env.CI ? 3 : 1;
async function time(env, op, budgetMs, fn) {
  budgetMs *= SCALE;
  const t = Date.now();
  let error = null, result;
  try { result = await fn(); } catch (e) { error = e; }
  const ms = Date.now() - t;
  const ok = !error && ms <= budgetMs;
  if (!ok) failed++;
  rows.push({ env, op, ms, budgetMs, ok, error: error?.message?.split('\n')[0] });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${env.padEnd(6)} ${op.padEnd(34)} ${String(ms).padStart(6)} ms  (budget ${budgetMs})${error ? '  — ' + error.message.split('\n')[0] : ''}`);
  return result;
}
const settled = id => new Promise(resolve => {
  const on = ({ id: sid, event }) => { if (sid === id && event.type === 'agent_settled') { manager.off('event', on); resolve(); } };
  manager.on('event', on);
});
const firstToken = id => new Promise(resolve => {
  const on = ({ id: sid, event }) => { if (sid === id && event.type === 'message_update') { manager.off('event', on); resolve(); } };
  manager.on('event', on);
});
const model = { provider: 'mock-lab', id: 'alpha-1' };

async function suite(envId, label, cwd) {
  if (envId !== 'local') await time(label, 'prepare host (first use)', 60000, () => manager.prepare(envId));
  const a = await time(label, 'create session (cold)', label === 'ssh' ? 4000 : 2500, () => manager.create({ environmentId: envId, cwd, model }));
  let done = settled(a.id), first = firstToken(a.id);
  await time(label, 'send → first token', 1500, async () => { await manager.prompt(a.id, 'hello'); await first; });
  await done;
  done = settled(a.id); await manager.prompt(a.id, 'second message'); await done;
  await time(label, 'rename', 50, () => manager.rename(a.id, 'renamed'));
  await time(label, 'switch model', 1000, () => manager.setModel(a.id, 'mock-lab', 'beta-1'));
  await time(label, 'list commands', 1000, () => manager.commands(a.id));
  await time(label, 'load history', 1000, () => manager.messages(a.id));
  const b = await time(label, 'fork', label === 'ssh' ? 4000 : 2500, () => manager.fork(a.id));
  // Fork again with a spare Pi kept warm in the folder (as while the conversation is open).
  await manager.warmFolder(a.id);
  for (let i = 0; i < 200 && ![...manager.spares.values()].some(sp => manager.runtimes.get(sp.id)?.status === 'connected'); i++) await new Promise(r => setTimeout(r, 50));
  const bw = await time(label, 'fork (spare Pi in the folder)', 500, () => manager.fork(a.id));
  await manager.delete(bw.id);
  await time(label, 'edit message (idle)', 2000, async () => { const d = settled(a.id); await manager.editMessage(a.id, 1, 'second message', 'edited'); await d; });
  // edit while a long reply is streaming: abort, branch, resend
  done = settled(a.id); await manager.prompt(a.id, 'long ' + 'z'.repeat(4000));
  await new Promise(r => setTimeout(r, 400));
  await time(label, 'edit message (while streaming)', 3000, async () => { const d = settled(a.id); await manager.editMessage(a.id, 1, 'edited', 'edited again'); await d; });
  // Pi stopped (e.g. by the idle sweep): opening shows the history from the session file at once.
  await manager.close(b.id);
  await manager.stopRelay(manager.env(envId), b.id);
  await new Promise(r => setTimeout(r, 300));
  const shown = await time(label, 'open history (Pi not running)', label === 'ssh' ? 800 : 300, () => manager.messages(b.id));
  if (!shown?.some(m => m.role === 'user')) { failed++; console.log('FAIL  history from the session file was empty'); }
  await manager.ensureStarted(b.id);
  // The idle sweep stops a Pi nobody used for a while (not the conversation on screen).
  manager.focused = null;
  manager.runtimes.get(b.id).lastUsed = 0;
  await time(label, 'idle sweep stops an unused Pi', 3000, async () => {
    const stopped = await manager.sweep();
    if (!stopped.includes(b.id)) throw new Error('idle Pi was not stopped');
    for (let i = 0; i < 20; i++) {
      if (!(await manager.relaySessions(manager.env(envId))).find(s => s.id === b.id)?.alive) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Pi still running after the sweep');
  });
  await time(label, 'close (detach)', 1000, () => manager.close(b.id));
  await time(label, 'reopen detached session', 2500, () => manager.messages(b.id));
  await time(label, 'archive', 1500, () => manager.archive(b.id));
  await time(label, 'delete', 1500, () => manager.delete(a.id));
  await manager.prewarm({ environmentId: envId, cwd, model });
  for (let i = 0; i < 200 && ![...manager.spares.values()].some(sp => manager.runtimes.get(sp.id)?.status === 'connected'); i++) await new Promise(r => setTimeout(r, 50));
  const c = await time(label, 'create from a pre-warmed Pi', 300, () => manager.create({ environmentId: envId, cwd, model }));
  await manager.delete(c.id);
}

const localDir = join(work, 'project'); mkdirSync(localDir);
try {
  await suite('local', 'local', localDir);
  if (!opts['no-ssh']) {
    const remoteDir = join(work, 'remote'); mkdirSync(remoteDir);
    await suite('ssh:pidesk-test', 'ssh', remoteDir);
  }
} catch (error) {
  console.log('FAIL  unexpected error', error.stack);
  failed++;
}
await manager.shutdown();
try { execFileSync('pkill', ['-f', `${relayPath} daemon`]); } catch { /* none */ }
await mock.close();
console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} operations within budget.`);
process.exitCode = failed ? 1 : 0;
