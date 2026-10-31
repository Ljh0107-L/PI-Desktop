// Real-environment M0 check: a real model provider and a real SSH host.
//
// node m0/real-check.mjs --ssh-host SCC --key-file /path/to/key --base-url https://…/v1 \
//   --model <model id> [--api openai-responses] [--egress]
//
// The API key is read from --key-file (never argv). The remote host must have Pi under
// ~/.pidesk/pi and the bridge extension at ~/.pidesk/ext/pidesk-bridge.js.
// --egress routes the remote model traffic through this machine (for hosts that cannot reach
// the provider), using an allowlisted CONNECT proxy and an SSH reverse forward.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport, sshTransport } from '../core/transports.mjs';
import { startEgressProxy, hostPortOf } from '../core/egress-proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: {
  'ssh-host': { type: 'string' }, 'key-file': { type: 'string' }, 'base-url': { type: 'string' },
  model: { type: 'string' }, api: { type: 'string', default: 'openai-responses' }, egress: { type: 'boolean' },
  verbose: { type: 'boolean' },
} });
const host = opts['ssh-host'];
const key = readFileSync(opts['key-file'], 'utf8').trim();
const ssh = (command, input) => execFileSync('ssh', ['-o', 'BatchMode=yes', host, command], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);

const remoteHome = ssh('printf %s "$HOME"');
const remoteHostname = ssh('hostname').trim();
const remote = {
  node: ssh('command -v node').trim(),
  piCli: `${remoteHome}/.pidesk/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
  ext: `${remoteHome}/.pidesk/ext/pidesk-bridge.js`,
  agentDir: `${remoteHome}/.pidesk/agent`,
  cwd: `${remoteHome}/.pidesk/projects/m0`,
};
ssh(`mkdir -p ${remote.agentDir} ${remote.cwd} && rm -f ${remote.cwd}/pidesk-denied.txt`);

const provider = {
  id: 'relay', name: 'Relay', api: opts.api, baseUrl: opts['base-url'], apiKey: key,
  models: [{ id: opts.model, name: opts.model, contextWindow: 200000, maxTokens: 32000 }],
};
const boot = { providers: [provider], permissionMode: 'ask' };
const egress = opts.egress ? await startEgressProxy({ allow: [hostPortOf(opts['base-url'])] }) : null;
const remotePort = 30000 + Math.floor(Math.random() * 30000);

const work = mkdtempSync(join(tmpdir(), 'pidesk-real-'));
const localDirs = { agentDir: join(work, 'agent'), cwd: join(work, 'project') };
Object.values(localDirs).forEach(dir => mkdirSync(dir, { recursive: true }));
const localSession = new PiSession({ id: 'local', boot, transport: localTransport({
  ...localDirs, node: process.execPath, piCli: join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), extensions: [join(root, 'agent/pidesk-bridge.js')] }) });
const remoteSession = new PiSession({ id: 'remote', boot, transport: sshTransport({
  host, egress: egress && { localPort: egress.port, remotePort },
  cwd: remote.cwd, node: remote.node, piCli: remote.piCli, agentDir: remote.agentDir, extensions: [remote.ext] }) });
const sessions = [localSession, remoteSession];

const trace = new Map();
for (const session of sessions) {
  const state = { deltas: [], tools: [], approvals: [], errors: [], decide: () => false };
  trace.set(session, state);
  session.on('event', event => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') state.deltas.push({ at: Date.now(), text: event.assistantMessageEvent.delta });
    if (event.type === 'tool_execution_end') state.tools.push(event);
    if (event.type === 'message_end' && event.message?.errorMessage) state.errors.push(event.message.errorMessage);
    if (opts.verbose) console.log(`  [${session.id}] ${event.type}`);
  });
  session.on('ui', request => {
    if (request.method !== 'confirm' || request.title !== 'pidesk.approval') return;
    const detail = JSON.parse(request.message);
    const approved = state.decide(detail);
    state.approvals.push({ ...detail, approved });
    session.respondUi(request.id, { confirmed: approved });
  });
  if (opts.verbose) session.on('stderr', text => process.stderr.write(`  [${session.id} stderr] ${text}`));
}
async function run(session, message) {
  const state = trace.get(session);
  Object.assign(state, { deltas: [], tools: [], approvals: [], errors: [] });
  const started = Date.now();
  const settled = session.nextSettled(240000);
  await session.prompt(message);
  await settled;
  return { started, ended: Date.now(), text: state.deltas.map(d => d.text).join(''), deltas: state.deltas, tools: state.tools, approvals: state.approvals, errors: state.errors };
}
const toolText = tool => tool?.result?.content?.map(c => c.text ?? '').join('').trim();
const filesUnder = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? filesUnder(p) : [p]; });

try {
  await Promise.all(sessions.map(s => s.start({ readyTimeout: 60000 })));
  check('local and remote sessions started', true, `remote ${host} (${remoteHostname}), node ${ssh('node -v').trim()}${egress ? ', model egress via this Mac' : ''}`);

  const localPs = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
  const remotePs = ssh('ps -eo args');
  check('API key absent from argv on both machines', !localPs.includes(key) && !remotePs.includes(key));

  for (const session of sessions) {
    const models = (await session.availableModels()).map(m => `${m.provider}/${m.id}`);
    check(`[${session.id}] relay model registered`, models.includes(`relay/${opts.model}`));
    await session.setModel('relay', opts.model);
  }

  const [a, b] = await Promise.all([
    run(localSession, 'Count from 1 to 30, separated by single spaces. Output nothing else.'),
    run(remoteSession, 'List the first 15 prime numbers separated by commas. Output nothing else.'),
  ]);
  check('[local] real model streamed a reply', a.deltas.length >= 2 && /\b30\b/.test(a.text) && !a.errors.length, `${a.deltas.length} deltas, ${a.ended - a.started} ms: "${a.text.slice(0, 80)}"${a.errors.length ? ' ERR ' + a.errors[0] : ''}`);
  check('[remote] real model streamed a reply', b.deltas.length >= 2 && /\b47\b/.test(b.text) && !b.errors.length, `${b.deltas.length} deltas, ${b.ended - b.started} ms: "${b.text.slice(0, 80)}"${b.errors.length ? ' ERR ' + b.errors[0] : ''}`);
  info('concurrency', `runs overlapped for ${Math.max(0, Math.min(a.ended, b.ended) - Math.max(a.started, b.started))} ms`);

  trace.get(remoteSession).decide = () => true;
  const c = await run(remoteSession, 'Use the bash tool to run exactly this command: hostname && pwd\nThen reply with its output verbatim.');
  const cTool = c.tools.find(t => t.toolName === 'bash');
  check('[remote] approval request reached the desktop', c.approvals.some(x => x.toolName === 'bash'), c.approvals.map(x => x.input?.command).join(' | '));
  check('[remote] approved tool ran on the server', cTool && !cTool.isError && toolText(cTool).includes(remoteHostname) && toolText(cTool).includes(remote.cwd), JSON.stringify(toolText(cTool)));
  check('[remote] model used the tool result', c.text.includes(remoteHostname), `"${c.text.slice(0, 120)}"`);

  trace.get(remoteSession).decide = () => false;
  const d = await run(remoteSession, 'Use the bash tool to run exactly this command: touch pidesk-denied.txt\nIf it is blocked, just say so.');
  const deniedExists = ssh(`test -e ${remote.cwd}/pidesk-denied.txt && echo yes || echo no`).trim();
  check('[remote] denied tool call was blocked', d.approvals.length >= 1 && d.approvals.every(x => !x.approved) && deniedExists === 'no', `${d.approvals.length} request(s), file exists: ${deniedExists}; model: "${d.text.slice(0, 100)}"`);

  trace.get(remoteSession).decide = () => true;
  const e = await run(remoteSession, 'Use the bash tool to run exactly this command: echo "boot=$(env | grep -c PIDESK_BOOT) plat=$(env | grep -c plat_)"\nThen reply with its output verbatim.');
  const envOut = toolText(e.tools.find(t => t.toolName === 'bash'));
  check('[remote] tool environment has no boot record or key', envOut === 'boot=0 plat=0', envOut);

  if (egress) check('model traffic tunnelled through the Mac (CONNECT allowlist)', egress.stats.tunnels > 0 && egress.stats.rejected.length === 0, `${egress.stats.tunnels} tunnels, rejected: ${egress.stats.rejected.join(', ') || 'none'}`);
} catch (error) {
  check('unexpected error', false, error.stack);
  for (const s of sessions) if (s.stderr) console.log(`--- ${s.id} stderr ---\n${s.stderr.slice(-3000)}`);
} finally {
  await Promise.all(sessions.map(s => s.stop().catch(() => {})));
  let remoteLeak = '';
  try { remoteLeak = ssh(`grep -rlF -f /dev/stdin ${remote.agentDir} ${remote.cwd} || true`, key + '\n').trim(); } catch (error) { remoteLeak = 'scan failed: ' + error.message; }
  const localLeak = filesUnder(work).filter(p => readFileSync(p, 'utf8').includes(key));
  check('API key not written to session files on either machine', !remoteLeak && !localLeak.length, remoteLeak || localLeak.join(', ') || 'clean');
  await egress?.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exitCode = failed ? 1 : 0;
}
