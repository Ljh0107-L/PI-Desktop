// CI's throwaway SSH host shares the fixture filesystem; the reader itself runs over real SSH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellQuote } from '../core/transports.mjs';

if (!process.env.CI) throw new Error('Run this SSH regression only in GitHub CI.');
const dir = mkdtempSync(join(tmpdir(), 'pidesk-history-ssh-'));
const file = join(dir, 'history.jsonl');
try {
  for (let i = 0; i < 1000; i++) appendFileSync(file, JSON.stringify({ type: 'message', id: `row-${i}`, parentId: i ? `row-${i - 1}` : null,
    message: { role: 'assistant', timestamp: i, content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque-signature'.repeat(2000) }, { type: 'text', text: `row ${i}` }] } }) + '\n');
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const before = hash();
  const reader = join(dir, 'reader-link.mjs');
  symlinkSync(resolve('agent/pidesk-history.mjs'), reader);
  const read = options => execFileSync('ssh', ['-F', '/tmp/pidesk-sshd/ssh_config', 'pidesk-test',
    [process.execPath, reader, file, JSON.stringify(options)].map(shellQuote).join(' ')], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  const started = Date.now(), output = read({}), page = JSON.parse(output);
  assert.ok(Buffer.byteLength(output) < 300000);
  assert.ok(page.scannedBytes < statSync(file).size / 4);
  assert.ok(!output.includes('opaque-signature'));
  assert.equal(page.messages.at(-1).__entryId, 'row-999');
  const earlier = JSON.parse(read({ cursor: page.next }));
  assert.equal(earlier.messages.at(-1).__entryId, 'row-919');
  assert.equal(hash(), before);
  console.log(`PASS SSH history paging: ${statSync(file).size} source bytes, ${Buffer.byteLength(output)} wire bytes, ${Date.now() - started} ms for two pages; original hash unchanged`);
} finally { rmSync(dir, { recursive: true, force: true }); }
