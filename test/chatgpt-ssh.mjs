// GitHub CI only: native auth daemon and Pi's installed OAuth implementation over a real SSH channel.
// The grant is a non-expired fixture, so this never contacts OpenAI or generates model tokens.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChatGPTAuth } from '../app/main/chatgpt.mjs';
import { chatGPTCapability, chatGPTSocketPath, chatGPTVaultPath, sealChatGPT } from '../agent/pidesk-chatgpt-vault.mjs';
import { runSsh } from '../app/main/remote-setup.mjs';
import { shellQuote } from '../core/transports.mjs';

process.env.PIDESK_NO_SSH_MUX = '1'; // every admin/client connection really closes before the next
const root = mkdtempSync(join(tmpdir(), 'pd-auth-ssh-'));
const env = { id: 'ssh:pidesk-test', kind: 'ssh', host: 'pidesk-test', label: 'CI SSH', sshArgs: ['-F', '/tmp/pidesk-sshd/ssh_config'] };
const target = { env, node: process.execPath, authPath: resolve('agent/pidesk-chatgpt-auth.mjs'),
  piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), agentDir: join(root, 'agent'), runDir: root };
const key = randomBytes(32).toString('hex'), vaultId = randomUUID();
const credential = { type: 'oauth', access: 'ci-only-access', refresh: 'ci-only-refresh', expires: Date.now() + 3600000,
  clientId: 'ci-only-client', scopes: ['chatgpt.tokens.use.direct'] };
const socketPath = chatGPTSocketPath(root, vaultId);
const clientScript = `import {chatGPTRequest} from ${JSON.stringify(pathToFileURL(target.authPath).href)};
let input='';for await(const chunk of process.stdin)input+=chunk;const data=JSON.parse(input);
try{const result=await chatGPTRequest(data.socketPath,data.request);process.stdout.write(JSON.stringify({valid:result.access===data.expected,pid:result.pid}));}
catch{process.stdout.write(JSON.stringify({rejected:true}));}`;
const client = async (request, expected) => JSON.parse(await runSsh(env,
  [target.node, '--input-type=module', '-e', clientScript].map(shellQuote).join(' '),
  { input: JSON.stringify({ socketPath, request, expected }), timeout: 65000 }));
let pid;
try {
  const transcript = join(root, 'unrelated.jsonl'); writeFileSync(transcript, 'original session prefix\n');
  const ready = await runChatGPTAuth(target, { op: 'configure', vaultId, key, agentDir: target.agentDir, piCli: target.piCli,
    encoded: sealChatGPT({ openai: credential }, key) });
  assert.equal(ready.connected, true); assert.ok(Number.isInteger(ready.pid)); pid = ready.pid;
  const request = { op: 'access', vaultId, capability: chatGPTCapability(key) };
  const first = await client(request, credential.access);
  assert.equal(first.valid, true); assert.equal(first.pid, pid);
  // The login/desktop SSH channel has ended. The owner is still on the host, not on the desktop.
  const afterDisconnect = await client(request, credential.access);
  assert.equal(afterDisconnect.valid, true); assert.equal(afterDisconnect.pid, pid);
  const attack = await client({ op: 'configure', vaultId: randomUUID(), key, agentDir: root, piCli: '/not/a/trusted/package' });
  assert.equal(attack.rejected, true, 'request clients cannot register another SDK into this owner');
  assert.equal((await client({ op: 'logout', vaultId, key: request.capability })).rejected, true);
  assert.equal((await client(request, credential.access)).valid, true);
  const encoded = readFileSync(chatGPTVaultPath(target.agentDir, vaultId), 'utf8');
  assert.ok(!encoded.includes(credential.access) && !encoded.includes(credential.refresh));
  assert.equal(readFileSync(transcript, 'utf8'), 'original session prefix\n');
  await runChatGPTAuth(target, { op: 'logout', vaultId, key });
  assert.equal((await client(request, credential.access)).rejected, true);
  assert.equal((await client({ op: 'configure', vaultId, key: request.capability, agentDir: target.agentDir, piCli: target.piCli })).rejected, true,
    'logout does not open the owner to reconfiguration by old request clients');
  console.log('PASS  SSH ChatGPT: native owner survives client disconnect, private capabilities, encrypted grant, logout, unchanged history; no model requests');
} finally {
  if (pid) await runSsh(env, `kill -TERM ${pid}`, { timeout: 5000 }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
