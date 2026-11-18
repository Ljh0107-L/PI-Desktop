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
  const address = join(dir, 'relay2.sock');
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
  const sockets = [], bridges = [], children = new Set();
  const control = (...args) => exec(process.execPath, [relay, ...args], { env, timeout: 10000 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const { child, closed } of bridges) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
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

  function collect(stream) {
    const records = [];
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
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
    return records;
  }

  async function connect(message, { paused = false } = {}) {
    const socket = net.connect(address);
    sockets.push(socket);
    socket.on('error', () => {});
    await once(socket, 'connect');
    const records = collect(socket);
    if (paused) socket.pause();
    const write = value => socket.write(JSON.stringify(value) + '\n');
    write(message);
    return { socket, records, write };
  }
  const spawnSpec = code => ({ cwd: dir, argv: [process.execPath, '-e', code] });
  const attach = (sessionId, code) => connect({ op: 'attach', sessionId, spawn: spawnSpec(code) });
  function attachCli(sessionId, code = 'process.stdin.resume()') {
    const child = spawn(process.execPath, [relay, 'attach'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    bridges.push({ child, closed });
    const records = collect(child.stdout);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ op: 'attach', sessionId, spawn: spawnSpec(code), boot: { fixture: true }, sinceSeq: 1 }) + '\n');
    return { records, closed, stderr: () => stderr, detach: () => { child.stdin.end(); return closed; } };
  }
  const list = async () => JSON.parse((await control('list')).stdout).sessions;
  return { dir, connect, attach, attachCli, spawnSpec, list, control, closed, children };
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
  assert.deepEqual(JSON.parse((await f.control('stop-for-update', 'tree')).stdout), { relay: 'stopped', found: false });
  assert.deepEqual(JSON.parse((await f.control('stop-for-update', 'unrelated')).stdout), { relay: 'stopped', found: true });
  assert.equal(running(otherPid), false, 'update waits for the v2 process-tree stop');
  const replacement = await f.attach('tree', 'process.stdin.resume()');
  await waitFor(() => replacement.records.length, 'replacement attach');
  assert.equal(replacement.records[0].created, true);
});

test('relay stop and shutdown fail instead of acknowledging a surviving process', { timeout: 15000 }, async t => {
  const f = await fixture(t, dir => `
    import { existsSync, readFileSync } from 'node:fs';
    const block = ${JSON.stringify(join(dir, 'block-signals'))};
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid >= 0 || signal === 0 || !existsSync(block)) return kill(pid, signal);
      if (readFileSync(block, 'utf8') === 'timeout') return true;
      throw Object.assign(new Error('signal refused'), { code: 'EPERM' });
    };
  `);
  const a = await f.attach('stubborn', `${stubborn} process.stdin.resume(); console.log('{"type":"ready"}');`);
  await waitFor(() => a.records.length === 2, 'stubborn child to start');
  const pid = a.records[0].pid;
  const block = join(f.dir, 'block-signals');
  writeFileSync(block, 'timeout');
  try {
    const failed = reason => error => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stdout), { relay: 'error', error: reason });
      assert.ok(error.stderr.includes(reason));
      return true;
    };
    await assert.rejects(f.control('stop', 'stubborn'), failed('Timed out stopping session stubborn'));
    writeFileSync(block, 'refuse');
    await assert.rejects(f.control('shutdown'), failed('signal refused'));
    assert.equal(running(pid), true);
    assert.equal((await f.list()).find(s => s.id === 'stubborn').alive, true);
  } finally { rmSync(block); }
  assert.equal(JSON.parse((await f.control('shutdown')).stdout).relay, 'shutdown');
  assert.equal(running(pid), false);
  assert.deepEqual(await f.closed, [0, null]);
});

const controlError = reason => error => {
  assert.equal(error.code, 1);
  assert.equal(JSON.parse(error.stdout).relay, 'error');
  assert.match(error.stderr, reason);
  return true;
};

test('relay does not signal a group whose process identity changes during escalation', { timeout: 10000 }, async t => {
  const f = await fixture(t, dir => `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    const toggle = ${JSON.stringify(join(dir, 'reuse'))}, attempts = ${JSON.stringify(join(dir, 'attempts'))};
    let replaced;
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0 && fs.existsSync(toggle)) {
        fs.appendFileSync(attempts, signal + '\\n');
        replaced = -pid;
        return true;
      }
      return kill(pid, signal);
    };
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      const out = read(path, ...args);
      if (!replaced || path !== '/proc/' + replaced + '/stat' || !fs.existsSync(toggle)) return out;
      const end = out.lastIndexOf(')') + 2;
      const fields = out.slice(end).split(' ');
      fields[19] = '99999999999';
      return out.slice(0, end) + fields.join(' ');
    };
    const run = promisify(cp.execFile);
    cp.execFile = () => {};
    cp.execFile[promisify.custom] = async (...args) => {
      const result = await run(...args);
      if (replaced && args[0] === '/bin/ps' && fs.existsSync(toggle)) {
        result.stdout = result.stdout.split('\\n').map(line => {
          const fields = line.trim().split(/\\s+/);
          return Number(fields[0]) === replaced ? fields.slice(0, 4).join(' ') + ' another-start-time' : line;
        }).join('\\n');
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  const target = await f.attach('reused', `${stubborn} process.stdin.resume(); console.log('{"type":"ready"}');`);
  await waitFor(() => target.records.length === 2, 'child to start');
  const toggle = join(f.dir, 'reuse');
  writeFileSync(toggle, '');
  try {
    await assert.rejects(f.control('stop', 'reused'), controlError(/Could not verify ownership/));
    assert.equal(readFileSync(join(f.dir, 'attempts'), 'utf8'), 'SIGTERM\n');
    assert.ok(running(target.records[0].pid));
  } finally { rmSync(toggle); }
});

test('hard stop cannot succeed when no daemon answers', async t => {
  const dir = mkdtempSync('/tmp/pidesk-relay-absent-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PIDESK_RUN_DIR: dir };
  const control = command => exec(process.execPath, [relay, command, 'session'], { env, timeout: 10000 });
  await assert.rejects(control('stop'), controlError(/ENOENT/));
  assert.deepEqual(JSON.parse((await control('stop-compatible')).stdout), { relay: 'stopped', found: false, daemon: false });
  assert.deepEqual(JSON.parse((await control('stop-for-update')).stdout), { relay: 'stopped', found: false, daemon: false });
});

test('update stop requires a valid v2 acknowledgement for a listed live session', { timeout: 10000 }, async t => {
  const dir = mkdtempSync('/tmp/pidesk-relay-update-');
  const env = { ...process.env, PIDESK_RUN_DIR: dir };
  const requests = [];
  let ack = { relay: 'stopped', found: 'true' };
  const server = net.createServer(socket => socket.once('data', data => {
    const message = JSON.parse(data);
    requests.push(message);
    const reply = message.op === 'list' ? { relay: 'list', sessions: [{ id: 'v2', alive: true }] } : ack;
    socket.end(JSON.stringify(reply) + '\n');
  }));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(join(dir, 'relay2.sock'));
  await once(server, 'listening');
  const stop = () => exec(process.execPath, [relay, 'stop-for-update', 'v2'], { env, timeout: 10000 });
  await assert.rejects(stop(), controlError(/Invalid process-tree stop acknowledgement/));
  ack = { relay: 'stopped', found: false };
  await assert.rejects(stop(), controlError(/did not acknowledge stopping the listed session/));
  assert.deepEqual(requests.map(r => r.op), ['list', 'stop-tree', 'list', 'stop-tree']);
});

test('v2 and legacy daemons coexist: attach, list, stop and shutdown choose the right owner', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const oldHistory = await f.attach('old', 'process.exit(0)');
  await waitFor(() => oldHistory.records.some(r => r.relay === 'exit'), 'v2 exit history');
  const first = f.attachCli('fresh');
  await waitFor(() => first.records.length, 'v2 attach with no legacy socket');
  assert.equal(first.records[0].created, true);
  assert.deepEqual(await first.detach(), [0, null]);

  const legacy = new Map(['old', 'recycled', 'raced', 'bad-ack', 'stay'].map((id, i) => [id, { id, alive: id !== 'recycled', pid: 20000 + i }]));
  const requests = [], sockets = new Set();
  let invalidList = false;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const answer = value => socket.end(JSON.stringify(value) + '\n');
    socket.once('data', data => {
      const message = JSON.parse(data);
      requests.push(message);
      const session = legacy.get(message.sessionId);
      if (message.op === 'list') {
        answer({ relay: 'list', sessions: invalidList ? [{ id: 'bad', alive: 'yes' }] : [...legacy.values()] });
      } else if (message.op === 'attach') {
        if (session.id === 'raced') {
          session.alive = false;
          answer({ relay: 'error', error: 'Session is not running' });
        } else socket.write(JSON.stringify({ relay: 'attached', created: false, pid: session.pid }) + '\n');
      } else if (message.op === 'stop') {
        if (session.id !== 'bad-ack') session.alive = false;
        answer({ relay: 'stopped', found: session.id !== 'bad-ack' });
      } else if (message.op === 'shutdown') {
        for (const session of legacy.values()) session.alive = false;
        answer({ relay: 'shutdown', stopped: legacy.size });
        server.close();
      } else socket.end();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(join(f.dir, 'relay.sock'));
  await once(server, 'listening');

  const old = f.attachCli('old');
  await waitFor(() => old.records.length, 'legacy attach');
  assert.deepEqual(old.records[0], { relay: 'attached', created: false, pid: legacy.get('old').pid });
  assert.deepEqual(requests.find(r => r.op === 'attach'), { op: 'attach', sessionId: 'old', sinceSeq: 1 }, 'legacy attach cannot spawn a new process');
  assert.deepEqual(await old.detach(), [0, null]);

  const recycled = f.attachCli('recycled');
  await waitFor(() => recycled.records.length, 'v2 attach for an exited legacy ID');
  assert.equal(recycled.records[0].created, true);
  assert.deepEqual(await recycled.detach(), [0, null]);
  const raced = f.attachCli('raced');
  await waitFor(() => raced.records.length, 'legacy attach race');
  assert.equal(raced.records[0].relay, 'error');
  assert.equal(requests.find(r => r.sessionId === 'raced').spawn, undefined);
  assert.deepEqual(await raced.detach(), [0, null]);

  const sessions = await f.list();
  assert.equal(sessions.length, 6, 'list merges both daemons and deduplicates IDs');
  assert.deepEqual(sessions.find(s => s.id === 'old'), legacy.get('old'), 'alive legacy wins over v2 exit history');
  assert.equal(sessions.find(s => s.id === 'recycled').pid, recycled.records[0].pid, 'alive v2 wins over legacy exit history');
  assert.ok(sessions.find(s => s.id === 'fresh').alive);

  await assert.rejects(f.control('stop', 'old'), controlError(/legacy relay.*process-tree/));
  assert.ok(legacy.get('old').alive, 'strict stop leaves the legacy session alone');
  assert.ok(requests.every(r => ['list', 'attach'].includes(r.op)));
  assert.equal(JSON.parse((await f.control('stop-compatible', 'old')).stdout).found, true);
  assert.equal(legacy.get('old').alive, false);
  await assert.rejects(f.control('stop-compatible', 'bad-ack'), controlError(/did not acknowledge/));
  assert.equal(JSON.parse((await f.control('stop-compatible', 'recycled')).stdout).found, true);
  assert.equal(running(recycled.records[0].pid), false, 'compatible stop still awaits v2 exit');
  assert.deepEqual(requests.filter(r => r.op === 'stop').map(r => r.sessionId), ['old', 'bad-ack']);

  invalidList = true;
  const blocked = f.attachCli('stay');
  assert.deepEqual(await blocked.closed, [1, null]);
  assert.match(blocked.stderr(), /Invalid relay session list/);
  await assert.rejects(f.control('stop-compatible', 'stay'), controlError(/Invalid relay session list/));
  invalidList = false;
  assert.ok(legacy.get('stay').alive);
  assert.ok(requests.every(r => r.op !== 'shutdown'));
  assert.equal(JSON.parse((await f.control('shutdown')).stdout).relay, 'shutdown');
  assert.deepEqual(await f.closed, [0, null]);
  assert.equal(running(first.records[0].pid), false);
  assert.equal(legacy.get('stay').alive, false);
  assert.equal(requests.filter(r => r.op === 'shutdown').length, 1);
});

test('update stops an idle legacy parent with an attached client but refuses unsafe legacy replacement', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const dual = await f.attach('dual', 'process.stdin.resume()');
  await waitFor(() => dual.records.length, 'v2 owner of dual');

  const sessions = new Map(), sockets = new Set(), stopRequests = [];
  const idle = `process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`;
  function add(id, code = idle) {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'ignore'] });
    const listed = { id, pid: child.pid, startedAt: Date.now(), alive: true, clients: 0 };
    const clients = new Set();
    const closed = once(child, 'close').then(() => {
      listed.alive = false;
      for (const socket of clients) socket.end('{"relay":"exit","code":0}\n');
    });
    child.stdin.on('error', () => {});
    f.children.add(child.pid);
    sessions.set(id, { child, listed, closed, clients });
    return sessions.get(id);
  }
  const old = add('idle');
  const busy = add('busy', `
    const tool = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { detached: true, stdio: 'ignore' });
    console.log(tool.pid);
    ${idle}
  `);
  const [pidLine] = await once(busy.child.stdout, 'data');
  const toolPid = Number(pidLine);
  f.children.add(toolPid);
  const legacyDual = add('dual');
  const wrongStart = add('wrong-start');
  wrongStart.listed.startedAt -= 60_000;
  const surviving = add('surviving');
  const raced = add('raced');
  let exitBeforeList = false;

  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const answer = value => socket.end(JSON.stringify(value) + '\n');
    socket.once('data', async data => {
      const message = JSON.parse(data);
      const session = sessions.get(message.sessionId);
      if (message.op === 'list') {
        const list = { relay: 'list', sessions: [...sessions.values()].map(s => ({ ...s.listed })) };
        if (exitBeforeList) {
          exitBeforeList = false;
          raced.child.stdin.end();
          await raced.closed;
        }
        answer(list);
      } else if (message.op === 'stop') {
        stopRequests.push(message.sessionId);
        if (session && session !== surviving) {
          session.child.stdin.end();
          await session.closed;
        }
        answer({ relay: 'stopped', found: !!session });
      } else if (message.op === 'attach') {
        session.clients.add(socket);
        session.listed.clients++;
        socket.once('close', () => { session.clients.delete(socket); session.listed.clients--; });
        socket.write(JSON.stringify({ relay: 'attached', created: false, pid: session.child.pid, startedAt: session.listed.startedAt }) + '\n');
      } else if (message.op === 'shutdown') {
        for (const { child } of sessions.values()) child.stdin.end();
        await Promise.all([...sessions.values()].map(s => s.closed));
        answer({ relay: 'shutdown', stopped: sessions.size });
        server.close();
      } else socket.end();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(join(f.dir, 'relay.sock'));
  await once(server, 'listening');

  const attached = f.attachCli('idle');
  await waitFor(() => attached.records.length, 'legacy client attached to idle parent');
  assert.equal(attached.records[0].pid, old.child.pid);
  assert.equal((await f.list()).find(s => s.id === 'idle').clients, 1);
  assert.equal(running(old.child.pid), true);
  assert.deepEqual(JSON.parse((await f.control('stop-for-update', 'idle')).stdout), { relay: 'stopped', found: true });
  assert.equal(running(old.child.pid), false);
  assert.deepEqual(await attached.closed, [0, null]);
  assert.equal(attached.records.at(-1).relay, 'exit');
  const replacement = f.attachCli('idle');
  await waitFor(() => replacement.records.length, 'v2 replacement startup');
  assert.equal(replacement.records[0].created, true, 'the new session is not routed back to the legacy relay');

  await assert.rejects(f.control('stop-for-update', 'busy'), controlError(/running tool process.*wait for it to finish.*retry Update/));
  assert.ok([busy.child.pid, toolPid].every(running));
  await assert.rejects(f.control('stop-for-update', 'dual'), controlError(/both relay daemons/));
  assert.ok([legacyDual.child.pid, dual.records[0].pid].every(running));
  await assert.rejects(f.control('stop-for-update', 'wrong-start'), controlError(/Could not verify.*start time/));
  assert.equal(running(wrongStart.child.pid), true);
  await assert.rejects(f.control('stop-for-update', 'surviving'), controlError(/acknowledged stop.*still running/));
  assert.equal(running(surviving.child.pid), true);
  exitBeforeList = true;
  assert.deepEqual(JSON.parse((await f.control('stop-for-update', 'raced')).stdout), { relay: 'stopped', found: false });
  assert.equal(running(raced.child.pid), false);
  assert.deepEqual(stopRequests, ['idle', 'surviving'], 'a failed preflight or natural exit does not ask the legacy relay to stop');
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
