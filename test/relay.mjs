// Protocol-level test: Pi sessions survive SSH disconnects through the pidesk relay.
//   sh m0/test-sshd.sh &     then   node test/relay.mjs [--ssh-config /tmp/pidesk-sshd/ssh_config]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PiSession } from '../core/pi-session.mjs';
import { relaySpawnSpec, sshRelayTransport } from '../core/transports.mjs';
import { startMockLlm } from '../m0/mock-llm.mjs';
import { root } from './harness.mjs';

const { values: opts } = parseArgs({ options: { 'ssh-config': { type: 'string', default: '/tmp/pidesk-sshd/ssh_config' } } });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mock = await startMockLlm();
const key = 'sk-relay-' + Math.random().toString(36).slice(2);
const work = mkdtempSync(join(tmpdir(), 'pidesk-relay-'));
const project = join(work, 'project'), agentDir = join(work, 'agent'), runDir = join(work, 'run');
for (const d of [project, agentDir]) mkdirSync(d);
const relayPath = join(root, 'agent/pidesk-relay.mjs');
const spawnSpec = relaySpawnSpec({ cwd: project, node: process.execPath, piCli: join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), agentDir, extensions: [join(root, 'agent/pidesk-bridge.js')] });
const boot = { providers: [{ id: 'mock-a', api: 'openai-completions', baseUrl: mock.baseUrl('mock-a'), apiKey: key, models: [{ id: 'alpha-1' }] }] };
const sessionId = 'relay-test-' + Date.now();
const ssh = (cmd, input) => execFileSync('ssh', ['-F', opts['ssh-config'], '-o', 'BatchMode=yes', 'pidesk-test', cmd], { encoding: 'utf8', input });
const relayList = () => JSON.parse(ssh(`env PIDESK_RUN_DIR=${runDir} ${process.execPath} ${relayPath} list`)).sessions;

function connect(sinceSeq) {
  const s = new PiSession({ id: sessionId, boot, relay: { sinceSeq, spawn: spawnSpec },
    transport: sshRelayTransport({ host: 'pidesk-test', sshOptions: ['-F', opts['ssh-config']], node: process.execPath, relayPath, runDir }) });
  s.events = []; s.ui = [];
  s.on('event', e => s.events.push(e));
  s.on('ui', r => s.ui.push(r));
  return s;
}
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };

try {
  // 1. start, then drop the connection while Pi waits for an answer (ask_user)
  let a = connect(null);
  await a.start({ readyTimeout: 60000 });
  check('session created through the relay', a.attachInfo?.created === true, `remote pid ${a.attachInfo?.pid}`);
  await a.setModel('mock-a', 'alpha-1');
  await a.prompt('[[ask:Write the done file?|Yes,No]]');
  check('question arrived', await waitFor(() => a.ui.some(r => r.method === 'select' && r.title === 'Write the done file?')));
  const seqBeforeDrop = a.lastSeq;
  process.kill(a.pid, 'SIGKILL'); // the laptop vanishes
  await sleep(1500);
  let list = relayList();
  const entry = list.find(s => s.id === sessionId);
  check('Pi still running on the host after the drop', entry?.alive && entry.clients === 0, JSON.stringify({ alive: entry?.alive, clients: entry?.clients, pendingUi: entry?.pendingUi }));
  check('the unanswered question is held by the relay', entry?.pendingUi === 1);

  // 2. reattach: the pending question comes back; answering it lets the run finish
  let b = connect(seqBeforeDrop);
  await b.start({ readyTimeout: 30000 });
  check('reattached to the same Pi process', b.attachInfo?.created === false && b.attachInfo.pid === entry.pid);
  check('pending question re-delivered after reconnect', await waitFor(() => b.ui.some(r => r.method === 'select')));
  const req = b.ui.find(r => r.method === 'select');
  b.respondUi(req.id, { value: 'Yes' });
  check('run finished after answering on the new connection', await waitFor(() => b.events.some(e => e.type === 'agent_settled'), 30000)
    && b.events.some(e => e.type === 'tool_execution_end' && e.result?.content?.[0]?.text === 'The user answered: Yes'));

  // 3. drop during a running tool: work continues, events are replayed on reattach
  b.ui.length = 0;
  await b.prompt('[[bash:sleep 3 && echo second > second.txt]]');
  await waitFor(() => b.events.some(e => e.type === 'tool_execution_start' && e.args?.command?.includes('second')));
  const seqMid = b.lastSeq;
  process.kill(b.pid, 'SIGKILL');
  await sleep(4500);
  check('tool kept running while disconnected', existsSync(join(project, 'second.txt')));
  let c = connect(seqMid);
  await c.start({ readyTimeout: 30000 });
  await waitFor(() => c.events.some(e => e.type === 'agent_settled'), 15000);
  check('missed events replayed on reconnect', c.events.some(e => e.type === 'tool_execution_end') && c.events.some(e => e.type === 'agent_settled'), `${c.events.length} events replayed`);
  check('no duplicate replay of events seen before the drop', !c.events.some(e => e.type === 'tool_execution_start' && e.toolName === 'ask_user'));

  // 4. a fresh client (e.g. after an app restart) attaches without replay and reads history
  await c.stop(); // detach only
  await sleep(500);
  check('detaching leaves Pi running', relayList().find(s => s.id === sessionId)?.alive);
  let d = connect(null);
  await d.start({ readyTimeout: 30000 });
  const history = await d.messages();
  check('fresh attach reads full history', history.filter(m => m.role === 'user').length === 2, `${history.length} messages`);
  check('fresh attach does not replay old events', d.events.length === 0);

  // 5. secrets
  const remotePs = ssh('ps -axww -o command=');
  const relayLog = existsSync(join(runDir, 'relay.log')) ? readFileSync(join(runDir, 'relay.log'), 'utf8') : '';
  check('API key not in any argv or relay log', !remotePs.includes(key) && !relayLog.includes(key));
  const envOut = await (async () => {
    d.ui.length = 0; d.events.length = 0;
    await d.prompt('[[bash:echo "boot=$(env | grep -c PIDESK_BOOT)"]]');
    await waitFor(() => d.events.some(e => e.type === 'tool_execution_end'));
    return d.events.find(e => e.type === 'tool_execution_end')?.result?.content?.[0]?.text?.trim();
  })();
  check('boot record scrubbed from tool environment', envOut === 'boot=0', envOut);

  // 6. stop
  ssh(`env PIDESK_RUN_DIR=${runDir} ${process.execPath} ${relayPath} stop ${sessionId}`);
  check('relay stop terminates Pi', await waitFor(() => relayList().find(s => s.id === sessionId)?.alive === false, 10000));
  await d.stop().catch(() => {});
} catch (error) {
  check('unexpected error', false, error.stack);
} finally {
  await mock.close();
  // shut the test daemon down
  try { execFileSync('pkill', ['-f', `${relayPath} daemon`]); } catch { /* none */ }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed.`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
