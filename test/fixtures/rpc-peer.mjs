// Tiny deterministic RPC peer: no model, credentials or external network required.
import { createInterface } from 'node:readline';

const mode = process.env.TEST_RPC_MODE;
if (mode === 'stubborn') process.on('SIGTERM', () => {});
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const r = JSON.parse(line);
  if (mode === 'silent' || (mode === 'stubborn' && r.type === 'abort')) return;
  if (mode === 'exit') {
    process.stderr.write('fixture: cannot load session\n');
    process.exitCode = 23;
    lines.close(); process.stdin.destroy();
    return;
  }
  const data = r.type === 'get_state' ? { sessionId: 'fixture', isStreaming: false } : {};
  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'response', id: r.id, success: true, data }) + '\n'),
    r.type === 'get_state' ? Number(process.env.TEST_READY_DELAY ?? 0) : 0);
});
lines.on('close', () => {
  if (mode === 'stubborn') setInterval(() => {}, 1000);
  else process.exitCode ??= 0;
});
