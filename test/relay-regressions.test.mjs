// Standalone relay tests with private sockets and fake RPC processes (no SSH or model needed).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const relay = fileURLToPath(new URL('../agent/pidesk-relay.mjs', import.meta.url));
const exec = promisify(execFile);
const waitFor = async (predicate, description) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(25); }
  assert.fail(`Timed out waiting for ${description}`);
};
function running(pid) {
  // kill(pid, 0) alone treats a zombie as running (notably under a container's PID 1).
  try {
    const state = process.platform === 'linux'
      ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0]
      : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return !!state && !/^[ZX]/.test(state);
  } catch (error) {
    if (error.code === 'ENOENT' || error.status === 1) return false;
    throw error;
  }
}

async function fixture(t, preload) {
  const dir = mkdtempSync('/tmp/pidesk-relay-test-');
  const address = join(dir, 'relay.sock');
  const env = { ...process.env, PIDESK_RUN_DIR: dir };
  const args = [];
  if (preload) {
    const path = join(dir, 'preload.mjs');
    writeFileSync(path, preload(dir));
    args.push('--import', path);
  }
  const daemon = spawn(process.execPath, [...args, relay, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(daemon, 'close');
  let stderr = '';
  daemon.stderr.on('data', chunk => { stderr += chunk; });
  const sockets = [], children = new Set();
  const control = (...args) => exec(process.execPath, [relay, ...args], { env, timeout: 8000 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      try { await control('shutdown'); } catch { daemon.kill(); }
    }
    await closed;
    for (const pid of children) if (running(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  await waitFor(() => existsSync(address), 'relay listener');

  async function connect(message, { paused = false } = {}) {
    const socket = net.connect(address);
    sockets.push(socket);
    socket.on('error', () => {});
    await once(socket, 'connect');
    const records = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const record = JSON.parse(line);
        if (record.created) children.add(record.pid);
        if (record.data) { record.bytes = Buffer.byteLength(line) + 1; delete record.data; }
        records.push(record);
      }
    });
    if (paused) socket.pause();
    const write = value => socket.write(JSON.stringify(value) + '\n');
    write(message);
    return { socket, records, write };
  }
  const spawnSpec = code => ({ cwd: dir, argv: [process.execPath, '-e', code] });
  const attach = (sessionId, code) => connect({ op: 'attach', sessionId, spawn: spawnSpec(code) });
  const list = async () => JSON.parse((await control('list')).stdout).sessions;
  return { dir, connect, attach, spawnSpec, list, control, closed, children };
}

const stubborn = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;

test('relay stop waits for detached tool groups after the session leader exits', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const tool = `
    const { spawn } = require('node:child_process');
    ${stubborn}
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });
    console.log(JSON.stringify({ type: 'toolReady', toolPid: process.pid, workerPid: worker.pid }));
  `;
  const leader = `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });
    const tool = spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    createInterface({ input: tool.stdout }).once('line', line => console.log(JSON.stringify({ ...JSON.parse(line), groupWorkerPid: worker.pid })));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  `;
  const a = await f.attach('tree', leader);
  const other = await f.attach('unrelated', `${stubborn} process.stdin.resume();`);
  await waitFor(() => a.records.some(r => r.type === 'toolReady') && other.records.length, 'child processes to start');
  const { toolPid, workerPid, groupWorkerPid } = a.records.find(r => r.type === 'toolReady');
  for (const pid of [toolPid, workerPid, groupWorkerPid]) f.children.add(pid);
  const leaderPid = a.records[0].pid, otherPid = other.records[0].pid;
  const tree = [leaderPid, toolPid, workerPid, groupWorkerPid];
  assert.ok([...tree, otherPid].every(running));

  const [stopped, earlyAttach] = await Promise.all([
    f.control('stop', 'tree').then(({ stdout }) => {
      assert.deepEqual(JSON.parse(stdout), { relay: 'stopped', found: true });
      return tree.filter(running);
    }),
    (async () => {
      // Do not replace the process between the leader shutting down and its tools exiting.
      await waitFor(() => !running(leaderPid), 'session leader to exit');
      const retry = await f.connect({ op: 'attach', sessionId: 'tree', spawn: f.spawnSpec('process.stdin.resume()') });
      await waitFor(() => retry.records.length, 'attach while stopping');
      return retry.records[0];
    })(),
  ]);
  assert.deepEqual(stopped, [], 'no process in the tree still running at acknowledgement');
  assert.equal(earlyAttach.relay, 'error');
  assert.match(earlyAttach.error, /stopping/);
  assert.equal(running(otherPid), true, 'another session was not signalled');
  assert.equal((await f.list()).find(s => s.id === 'tree').alive, false);
  assert.equal(a.records.at(-1).relay, 'exit');
  const replacement = await f.attach('tree', 'process.stdin.resume()');
  await waitFor(() => replacement.records.length, 'replacement attach');
  assert.equal(replacement.records[0].created, true);
});

test('relay shutdown returns a bounded error instead of acknowledging a surviving process', { timeout: 15000 }, async t => {
  const f = await fixture(t, dir => `
    import { existsSync } from 'node:fs';
    const kill = process.kill;
    process.kill = (pid, signal) => pid < 0 && signal !== 0 && existsSync(${JSON.stringify(join(dir, 'block-signals'))})
      ? true : kill(pid, signal);
  `);
  const a = await f.attach('stubborn', `${stubborn} process.stdin.resume(); console.log('{"type":"ready"}');`);
  await waitFor(() => a.records.length === 2, 'stubborn child to start');
  const pid = a.records[0].pid;
  const block = join(f.dir, 'block-signals');
  writeFileSync(block, '');
  try {
    await assert.rejects(f.control('shutdown'), error => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stdout), { relay: 'error', error: 'Timed out stopping session stubborn' });
      assert.match(error.stderr, /Timed out stopping/);
      return true;
    });
    assert.equal(running(pid), true);
    assert.equal((await f.list()).find(s => s.id === 'stubborn').alive, true);
  } finally { rmSync(block); }
  assert.equal(JSON.parse((await f.control('shutdown')).stdout).relay, 'shutdown');
  assert.equal(running(pid), false);
  assert.deepEqual(await f.closed, [0, null]);
});

test('relay bounds live and replay socket queues while healthy readers catch up', { timeout: 15000 }, async t => {
  const f = await fixture(t, dir => `
    import net from 'node:net';
    import { writeFileSync } from 'node:fs';
    const clients = new WeakSet();
    const emit = net.Server.prototype.emit;
    net.Server.prototype.emit = function (event, ...args) {
      if (event === 'connection') clients.add(args[0]);
      return emit.call(this, event, ...args);
    };
    let peak = 0;
    const write = net.Socket.prototype.write;
    net.Socket.prototype.write = function (...args) {
      const result = write.apply(this, args);
      if (clients.has(this) && this.writableLength > peak) {
        peak = this.writableLength;
        writeFileSync(${JSON.stringify(join(dir, 'peak'))}, String(peak));
      }
      return result;
    };
  `);
  const count = 512;
  const healthy = await f.attach('stream', `
    const { createInterface } = require('node:readline');
    const { once } = require('node:events');
    console.log(JSON.stringify({ type: 'extension_ui_request', id: 'ask', method: 'confirm' }));
    createInterface({ input: process.stdin }).on('line', async line => {
      const r = JSON.parse(line);
      if (r.cmd === 'burst') {
        for (let i = 0; i < ${count}; i++) {
          if (!process.stdout.write(JSON.stringify({ type: 'chunk', i, data: '界'.repeat(20000) }) + '\\n')) await once(process.stdout, 'drain');
        }
        console.log(JSON.stringify({ type: 'finished' }));
      } else if (r.cmd === 'tail') console.log(JSON.stringify({ type: 'tail', data: '界'.repeat(50000) }));
      else if (r.type === 'extension_ui_response') console.log(JSON.stringify({ type: 'answer', id: r.id, confirmed: r.confirmed }));
    });
  `);
  await waitFor(() => healthy.records.some(r => r.id === 'ask'), 'pending confirmation');
  const ui = healthy.records.find(r => r.id === 'ask');
  const slow = await f.connect({ op: 'attach', sessionId: 'stream' });
  await waitFor(() => slow.records.length, 'slow attach');
  slow.socket.pause();
  healthy.write({ cmd: 'burst' });
  await waitFor(() => healthy.records.some(r => r.type === 'finished'), 'healthy client to receive burst');
  const chunks = healthy.records.filter(r => r.type === 'chunk');
  assert.deepEqual(chunks.map(r => r.i), Array.from({ length: count }, (_, i) => i));
  await waitFor(async () => (await f.list())[0].clients === 1, 'eviction of the lagging live client');
  const peak = () => Number(readFileSync(join(f.dir, 'peak'), 'utf8'));
  assert.ok(peak() <= 128 * 1024, `live socket queued ${peak()} bytes`);

  const replay = await f.connect({ op: 'attach', sessionId: 'stream', sinceSeq: ui._seq }, { paused: true });
  await waitFor(async () => (await f.list())[0].clients === 2, 'paused replay to stay attached');
  assert.ok(peak() <= 128 * 1024, `replay socket queued ${peak()} bytes`);
  replay.socket.resume();
  await waitFor(() => replay.records.some(r => r.relay === 'pending'), 'replay and pending confirmation to drain');
  const [attached, gap, ...afterGap] = replay.records;
  assert.equal(attached.relay, 'attached');
  assert.equal(attached.created, false);
  assert.equal(gap.relay, 'gap');
  const pending = afterGap.pop();
  assert.equal(pending.relay, 'pending');
  assert.deepEqual(pending.lines.map(JSON.parse), [ui]);
  assert.ok(gap.firstSeq > ui._seq + 1);
  assert.deepEqual(afterGap.map(r => r._seq), Array.from({ length: attached.lastSeq - gap.firstSeq + 1 }, (_, i) => gap.firstSeq + i));
  assert.ok(afterGap.reduce((sum, r) => sum + (r.bytes ?? 0), 0) <= 16 * 1024 * 1024, 'replay cap measures UTF-8 bytes');
  replay.socket.destroy();

  healthy.write({ cmd: 'tail' });
  await waitFor(() => healthy.records.some(r => r.type === 'tail'), 'one new record');
  const tail = healthy.records.find(r => r.type === 'tail');
  assert.equal(tail._seq, attached.lastSeq + 1);
  assert.ok(tail.bytes > 128 * 1024);
  const resume = await f.connect({ op: 'attach', sessionId: 'stream', sinceSeq: attached.lastSeq });
  await waitFor(() => resume.records.some(r => r.relay === 'pending'), 'resume without a gap');
  assert.deepEqual(resume.records.slice(1, -1), [tail]);
  resume.write({ type: 'extension_ui_response', id: ui.id, confirmed: true });
  await waitFor(() => healthy.records.some(r => r.type === 'answer' && r.confirmed), 'answer passthrough');
  assert.equal((await f.list())[0].pendingUi, 0);
  assert.ok(peak() <= 128 * 1024, `socket queued ${peak()} bytes`);
});
