// M0 verification: drive two Pi sessions at once — one local, one over a real SSH connection —
// and check streaming, per-session multi-provider model switching, tool calls, questions to the user
// (allow and deny), and that API keys held by the desktop never appear in argv, tool environments
// or session files.
//
// Usage: node test/protocol.mjs --ssh-host <alias> [--ssh-config <file>] [--remote-node <path>] [--remote-pi <path>]
// Without --ssh-host the "remote" session uses the local transport (no SSH coverage).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport, sshTransport } from '../core/transports.mjs';
import { startMockLlm } from './mock-llm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: {
  'ssh-host': { type: 'string' }, 'ssh-config': { type: 'string' },
  'remote-node': { type: 'string' }, 'remote-pi': { type: 'string' }, verbose: { type: 'boolean' },
} });
const piCli = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const bridge = join(root, 'agent/pidesk-bridge.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------- fixtures
const mock = await startMockLlm({ chunkDelay: 60 }); // slow enough that the two streams overlap on a loaded runner
const keys = { alpha: 'sk-alpha-' + randomBytes(12).toString('hex'), beta: 'sk-beta-' + randomBytes(12).toString('hex') };
const providers = [
  { id: 'mock-alpha', name: 'Mock Alpha', api: 'openai-completions', baseUrl: mock.baseUrl('mock-alpha'), apiKey: keys.alpha, models: [{ id: 'alpha-1' }, { id: 'alpha-2' }] },
  { id: 'mock-beta', name: 'Mock Beta', api: 'openai-completions', baseUrl: mock.baseUrl('mock-beta'), apiKey: keys.beta, models: [{ id: 'beta-1' }] },
];
const work = mkdtempSync(join(tmpdir(), 'pidesk-m0-'));
const dirs = {
  localAgent: join(work, 'local/agent'), localProject: join(work, 'local/project'),
  remoteAgent: join(work, 'remote-home/agent'), remoteProject: join(work, 'remote-home/project'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

const localTarget = { cwd: dirs.localProject, node: process.execPath, piCli, agentDir: dirs.localAgent, extensions: [bridge] };
const remoteTarget = { cwd: dirs.remoteProject, node: opts['remote-node'] ?? process.execPath, piCli: opts['remote-pi'] ?? piCli, agentDir: dirs.remoteAgent, extensions: [bridge] };
const remoteTransport = opts['ssh-host']
  ? sshTransport({ host: opts['ssh-host'], sshOptions: opts['ssh-config'] ? ['-F', opts['ssh-config']] : [], ...remoteTarget })
  : localTransport(remoteTarget);
const boot = { providers };

const local = new PiSession({ id: 'local', transport: localTransport(localTarget), boot });
const remote = new PiSession({ id: 'remote', transport: remoteTransport, boot });
const sessions = [local, remote];

// Desktop-side state per session: streamed text, tool events, questions answered.
const trace = new Map();
for (const session of sessions) {
  const state = { deltas: [], tools: [], questions: [], answer: () => undefined };
  trace.set(session, state);
  session.on('event', event => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') state.deltas.push({ at: Date.now(), text: event.assistantMessageEvent.delta });
    if (event.type === 'tool_execution_end') state.tools.push(event);
    if (opts.verbose) console.log(`  [${session.id}] ${event.type}`);
  });
  session.on('ui', request => {
    if (request.method !== 'select' && request.method !== 'input') return;
    const value = state.answer(request);
    state.questions.push({ ...request, value });
    session.respondUi(request.id, value === undefined ? { cancelled: true } : { value });
  });
  if (opts.verbose) session.on('stderr', text => process.stderr.write(`  [${session.id} stderr] ${text}`));
}

async function run(session, message) {
  const state = trace.get(session);
  state.deltas = []; state.tools = []; state.questions = [];
  const settled = session.nextSettled();
  const accepted = await session.prompt(message);
  await settled;
  return { accepted, text: state.deltas.map(d => d.text).join(''), deltas: state.deltas, tools: state.tools, questions: state.questions };
}
const allFiles = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? allFiles(path) : [path];
});
const requestsSince = mark => mock.requests.slice(mark);

// ---------------------------------------------------------------------------- run
try {
  await Promise.all(sessions.map(session => session.start()));
  check('both sessions started', true, `local pid ${local.pid}; remote via ${remote.transport.kind}${opts['ssh-host'] ? ' ' + opts['ssh-host'] : ''}`);

  // argv check while both processes are alive (local ssh client, sshd children, Pi processes)
  const ps = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  check('no API key in any process argv', !Object.values(keys).some(key => ps.includes(key)));
  if (opts['ssh-host']) check('SSH transport process is running', ps.includes(opts['ssh-host']) && ps.includes('pidesk'));

  for (const session of sessions) {
    const models = (await session.availableModels()).map(m => `${m.provider}/${m.id}`);
    check(`[${session.id}] providers registered from boot record`, ['mock-alpha/alpha-1', 'mock-alpha/alpha-2', 'mock-beta/beta-1'].every(id => models.includes(id)), models.filter(id => id.startsWith('mock-')).join(', '));
  }

  await local.setModel('mock-alpha', 'alpha-1');
  await remote.setModel('mock-beta', 'beta-1');
  let mark = mock.requests.length;
  const [a, b] = await Promise.all([run(local, 'hello from the laptop'), run(remote, 'hello from the server')]);
  check('[local] streamed reply from mock-alpha/alpha-1', a.deltas.length > 3 && a.text === '[mock-alpha/alpha-1] echo: hello from the laptop', `${a.deltas.length} deltas: "${a.text}"`);
  check('[remote] streamed reply from mock-beta/beta-1', b.deltas.length > 3 && b.text === '[mock-beta/beta-1] echo: hello from the server', `${b.deltas.length} deltas: "${b.text}"`);
  const overlap = a.deltas[0].at < b.deltas.at(-1).at && b.deltas[0].at < a.deltas.at(-1).at;
  check('both sessions streamed concurrently', overlap);
  const reqs = requestsSince(mark);
  check('each provider received its own key', reqs.some(r => r.provider === 'mock-alpha' && r.authorization === `Bearer ${keys.alpha}`) && reqs.some(r => r.provider === 'mock-beta' && r.authorization === `Bearer ${keys.beta}`) && reqs.every(r => r.authorization === `Bearer ${keys[r.provider.slice(5)]}`));

  // Switch the local session to another provider mid-conversation.
  await local.setModel('mock-beta', 'beta-1');
  mark = mock.requests.length;
  const c = await run(local, 'second turn after switching');
  check('[local] switched provider mid-session', c.text === '[mock-beta/beta-1] echo: second turn after switching' && requestsSince(mark).every(r => r.provider === 'mock-beta'), `"${c.text}"`);
  const state = await local.state();
  check('[local] state reports current model', state.model?.provider === 'mock-beta' && state.model?.id === 'beta-1', `${state.model?.provider}/${state.model?.id}`);

  // Tool call on the remote session runs without any approval round-trip (YOLO).
  const d = await run(remote, '[[bash:echo approved > marker.txt && pwd]]');
  const dTool = d.tools.find(t => t.toolName === 'bash');
  check('[remote] tool ran without asking the desktop', d.questions.length === 0);
  check('[remote] tool ran in the remote project', dTool && !dTool.isError && existsSync(join(dirs.remoteProject, 'marker.txt')), dTool?.result?.content?.[0]?.text?.trim());
  check('[remote] model received the tool result', d.text.startsWith('Tool result: '), `"${d.text}"`);

  // ask_user: the model asks the desktop a question and gets the answer back.
  trace.get(local).answer = request => request.options?.[1];
  const e = await run(local, '[[ask:Pick a color|red,green,blue]]');
  const eTool = e.tools.find(t => t.toolName === 'ask_user');
  check('[local] ask_user question reached the desktop with options', e.questions.length === 1 && e.questions[0].title === 'Pick a color' && e.questions[0].options?.join() === 'red,green,blue');
  check('[local] the answer reached the model', eTool?.result?.content?.[0]?.text === 'The user answered: green' && e.text === 'Tool result: The user answered: green', e.text);

  // Tool subprocesses must not see the keys or the boot record.
  const f = await run(remote, `[[bash:echo "boot=$(env | grep -c PIDESK_BOOT) alpha=$(env | grep -c ${keys.alpha.slice(0, 12)}) beta=$(env | grep -c ${keys.beta.slice(0, 11)})"]]`);
  const envOut = f.tools.find(t => t.toolName === 'bash')?.result?.content?.[0]?.text?.trim();
  check('[remote] tool environment has no boot record or keys', envOut === 'boot=0 alpha=0 beta=0', envOut);

  // History is available for the desktop to render after reconnecting.
  const history = await remote.messages();
  check('[remote] history readable via get_messages', history.filter(m => m.role === 'user').length === 3, `${history.length} messages`);

  // Subagents execute through the owning session, with its model/key/cwd and no extra Pi process.
  for (const session of sessions) {
    const before = mock.requests.length;
    const delegated = await run(session, '[[subagents]]');
    const result = delegated.tools.find(t => t.toolName === 'subagent')?.result;
    check(`[${session.id}] subagent returned two successful tasks`, result?.details?.results?.length === 2 && result.details.results.every(r => r.status === 'completed'), JSON.stringify(result?.details?.results?.map(r => ({ status: r.status, error: r.error }))));
    const cwd = session === local ? dirs.localProject : dirs.remoteProject;
    check(`[${session.id}] delegated file is on the session machine and cwd`, existsSync(join(cwd, 'subagent-result.txt')) && readFileSync(join(cwd, 'subagent-result.txt'), 'utf8') === 'created by subagent');
    const childRequests = mock.requests.slice(before).filter(r => r.subagent);
    check(`[${session.id}] subagents inherit current provider credentials`, childRequests.length >= 4 && childRequests.every(r => r.provider === 'mock-beta' && r.model === 'beta-1' && r.authorization === `Bearer ${keys.beta}`));
    check(`[${session.id}] delegation guidance reaches the parent prompt`, mock.requests.slice(before).some(r => !r.subagent && r.system.includes('independent context windows')));
  }
} catch (error) {
  check('unexpected error', false, error.stack);
  for (const session of sessions) if (session.stderr) console.log(`--- ${session.id} stderr ---\n${session.stderr.slice(-3000)}`);
} finally {
  await Promise.all(sessions.map(session => session.stop().catch(() => {})));
  const leaked = allFiles(work).filter(path => { const text = readFileSync(path, 'utf8'); return Object.values(keys).some(key => text.includes(key)); });
  check('no API key written to agent or session files', leaked.length === 0, leaked.join(', ') || `${allFiles(work).length} files scanned`);
  await mock.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Work dir: ${work}`);
  process.exitCode = failed.length ? 1 : 0;
}
