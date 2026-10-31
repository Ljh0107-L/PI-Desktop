// Probe: what happens to a remote Pi run when the SSH link drops mid-tool-call?
// Usage: node m0/disconnect-probe.mjs --ssh-host <alias> [--ssh-config <file>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PiSession } from '../core/pi-session.mjs';
import { sshTransport } from '../core/transports.mjs';
import { startMockLlm } from './mock-llm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { 'ssh-host': { type: 'string' }, 'ssh-config': { type: 'string' } } });
const mock = await startMockLlm();
const work = mkdtempSync(join(tmpdir(), 'pidesk-probe-'));
const project = join(work, 'project'), agentDir = join(work, 'agent');
mkdirSync(project); mkdirSync(agentDir);
const session = new PiSession({
  id: 'probe',
  transport: sshTransport({ host: opts['ssh-host'], sshOptions: opts['ssh-config'] ? ['-F', opts['ssh-config']] : [],
    cwd: project, node: process.execPath, piCli: join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), agentDir, extensions: [join(root, 'agent/pidesk-bridge.js')] }),
  boot: { providers: [{ id: 'mock-alpha', api: 'openai-completions', baseUrl: mock.baseUrl('mock-alpha'), apiKey: 'sk-probe', models: [{ id: 'alpha-1' }] }], permissionMode: 'bypass' },
});
await session.start();
await session.setModel('mock-alpha', 'alpha-1');
// Pi sets its process title to "pi".
const piPids = () => execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .map(line => line.trim().split(/\s+/)).filter(([, command, ...rest]) => command === 'pi' && rest.length === 0).map(([pid]) => pid);
await session.prompt('[[bash:sleep 4 && echo finished > done.txt]]');
await new Promise(r => setTimeout(r, 1500));
const before = piPids();
process.kill(session.pid, 'SIGKILL'); // simulate the laptop dropping the SSH connection
await new Promise(r => setTimeout(r, 5000));
const after = piPids();
console.log(JSON.stringify({ remotePiBefore: before, remotePiAfterDrop: after, toolFinishedAfterDrop: existsSync(join(project, 'done.txt')) }));
await mock.close();
