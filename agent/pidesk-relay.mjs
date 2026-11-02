#!/usr/bin/env node
// Pi Desktop relay: keeps Pi sessions running on a host while the desktop is disconnected.
//
//   node pidesk-relay.mjs attach   stdin/stdout bridge for one desktop connection (run over SSH)
//   node pidesk-relay.mjs daemon   the long-lived owner of Pi processes (started on demand, detached)
//   node pidesk-relay.mjs list     JSON summary of sessions
//   node pidesk-relay.mjs stop ID  terminate a session's Pi process
//
// The daemon listens on ~/.pidesk/run/relay.sock (directory 0700, socket 0600). Every line Pi writes
// is numbered and kept in a bounded log; a re-attaching client sends the last number it saw and gets
// everything after it, plus any extension dialogs (approvals) still waiting for an answer.
//
// Secrets: the attach handshake carries the session's boot record (provider keys). The daemon passes
// it to Pi in the PIDESK_BOOT environment variable at spawn and does not keep it.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_DIR = process.env.PIDESK_RUN_DIR ?? join(homedir(), '.pidesk', 'run');
const SOCKET = join(RUN_DIR, 'relay.sock');
const LOG_LIMIT_BYTES = 16 * 1024 * 1024;
const EXITED_RETENTION_MS = 30 * 60 * 1000;
const IDLE_EXIT_MS = 15 * 60 * 1000;
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);

function lineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
}
const send = (socket, value) => { if (!socket.destroyed && !socket.writableEnded) socket.write(JSON.stringify(value) + '\n'); };

// ------------------------------------------------------------------ daemon
function runDaemon() {
  const sessions = new Map();
  let idleTimer = null;
  const touch = () => {
    clearTimeout(idleTimer);
    const busy = [...sessions.values()].some(s => !s.exit || s.clients.size);
    if (!busy) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  function spawnSession(id, spec, boot) {
    const env = { ...process.env, ...spec.env, PIDESK_BOOT: JSON.stringify(boot ?? {}) };
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { id, child, cwd: spec.cwd, seq: 0, log: [], logBytes: 0, pendingUi: new Map(), clients: new Set(), exit: null, startedAt: Date.now(), stderr: '' };
    sessions.set(id, session);
    lineReader(child.stdout, line => {
      if (!line.startsWith('{') || line.length < 3) return; // Pi's stdout carries only JSON records
      session.seq += 1;
      const numbered = '{"_seq":' + session.seq + ',' + line.slice(1);
      session.log.push(numbered);
      session.logBytes += numbered.length;
      while (session.logBytes > LOG_LIMIT_BYTES && session.log.length > 1) session.logBytes -= session.log.shift().length;
      try {
        const record = JSON.parse(line);
        if (record.type === 'extension_ui_request' && DIALOGS.has(record.method)) session.pendingUi.set(record.id, numbered);
      } catch { /* non-JSON output is still forwarded */ }
      for (const client of session.clients) if (!client.destroyed) client.write(numbered + '\n');
    });
    child.stderr.on('data', d => { session.stderr = (session.stderr + d).slice(-8000); });
    session.closed = new Promise(resolve => child.once('close', resolve));
    child.on('close', (code, signal) => {
      session.exit = { code, signal, at: Date.now(), stderr: session.stderr.slice(-2000) };
      session.pendingUi.clear();
      for (const client of session.clients) { send(client, { relay: 'exit', code, signal, stderr: session.exit.stderr }); client.end(); }
      setTimeout(() => { if (sessions.get(id) === session) sessions.delete(id); touch(); }, EXITED_RETENTION_MS).unref();
      touch();
    });
    child.on('error', error => { session.stderr += `\nspawn failed: ${error.message}`; });
    child.stdin.on('error', () => {});
    return session;
  }

  function stopSession(session) {
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      session.child.stdin.end();
      const term = setTimeout(() => session.child.kill('SIGTERM'), 500);
      const kill = setTimeout(() => {
        session.child.kill('SIGKILL');
        session.child.stdout.destroy(); session.child.stderr.destroy();
      }, 2000);
      try { await session.closed; }
      finally { clearTimeout(term); clearTimeout(kill); }
    })();
    return session.stopping;
  }

  function attach(socket, message) {
    let session = sessions.get(message.sessionId);
    let created = false;
    if (!session || session.exit) {
      if (!message.spawn) { send(socket, { relay: 'error', error: 'Session is not running' }); socket.end(); return; }
      const spec = message.spawn;
      if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(a => typeof a !== 'string') || typeof spec.cwd !== 'string') throw new Error('Invalid spawn specification');
      session = spawnSession(message.sessionId, spec, message.boot);
      created = true;
    }
    if (session.stopping && !session.exit) { send(socket, { relay: 'error', error: 'Session is stopping; retry after stop completes' }); socket.end(); return; }
    delete message.boot;
    const firstSeq = session.seq - session.log.length + 1;
    send(socket, { relay: 'attached', created, lastSeq: session.seq, pid: session.child.pid, startedAt: session.startedAt });
    if (typeof message.sinceSeq === 'number' && !created) {
      if (message.sinceSeq + 1 < firstSeq) send(socket, { relay: 'gap', from: message.sinceSeq, firstSeq });
      for (let i = Math.max(0, message.sinceSeq + 1 - firstSeq); i < session.log.length; i++) socket.write(session.log[i] + '\n');
    }
    if (session.pendingUi.size) send(socket, { relay: 'pending', lines: [...session.pendingUi.values()] });
    session.clients.add(socket);
    touch();
    socket.on('close', () => { session.clients.delete(socket); touch(); });
    return session;
  }

  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let session = null;
    let first = true;
    lineReader(socket, line => {
      if (first) {
        first = false;
        let message;
        try { message = JSON.parse(line); } catch { socket.end(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.end(); return; }
        if (message.op === 'list') {
          send(socket, { relay: 'list', sessions: [...sessions.values()].map(s => ({ id: s.id, pid: s.child.pid, cwd: s.cwd, alive: !s.exit, exit: s.exit, startedAt: s.startedAt, lastSeq: s.seq, clients: s.clients.size, pendingUi: s.pendingUi.size })) });
          socket.end(); return;
        }
        if (message.op === 'stop') {
          const s = sessions.get(message.sessionId);
          // Acknowledgement means Pi has actually exited, not just received EOF. Callers
          // can now restart or delete its session file without racing the old writer.
          const stopped = s && !s.exit ? stopSession(s) : Promise.resolve();
          stopped.then(() => { send(socket, { relay: 'stopped', found: !!s }); socket.end(); });
          return;
        }
        if (message.op === 'attach') {
          try {
            if (typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('Invalid session id');
            session = attach(socket, message);
          } catch (error) { send(socket, { relay: 'error', error: error.message }); socket.end(); }
          return;
        }
        socket.end(); return;
      }
      if (!session || session.exit) return;
      // Answering a dialog clears it from the pending set.
      if (line.includes('"extension_ui_response"')) {
        try { const r = JSON.parse(line); if (r.type === 'extension_ui_response') session.pendingUi.delete(r.id); } catch { /* forward anyway */ }
      }
      session.child.stdin.write(line + '\n');
    });
  });

  const listen = () => server.listen(SOCKET, () => { chmodSync(SOCKET, 0o600); touch(); });
  server.on('error', error => {
    if (!['EADDRINUSE', 'EEXIST'].includes(error.code)) throw error;
    // Another daemon may own the socket; if nobody answers it is stale.
    const probe = net.connect(SOCKET);
    probe.on('connect', () => { probe.destroy(); process.exit(0); });
    probe.on('error', () => { try { unlinkSync(SOCKET); } catch { /* raced */ } listen(); });
  });
  process.on('SIGHUP', () => {}); // belt and braces: we run in our own session anyway
  listen();
}

// ------------------------------------------------------------------ client side
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectOrStart() {
  try { return await connect(); } catch { /* start below */ }
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RUN_DIR, 0o700);
  const lock = join(RUN_DIR, 'startup.lock');
  // Multiple pre-warms/reconnects can arrive together. Only one launcher may probe,
  // replace a stale socket and start a daemon; never unlink another starter's socket.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await connect(); } catch { /* start or wait for its owner below */ }
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') unlinkSync(lock); }
        }
      } catch { /* the owner just released it */ }
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    try {
      writeFileSync(fd, String(process.pid));
      closeSync(fd); fd = undefined;
      try { return await connect(); } catch { /* still no daemon */ }
      const log = openSync(join(RUN_DIR, 'relay.log'), 'a', 0o600);
      let launchError;
      try {
        const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: ['ignore', log, log], cwd: homedir() });
        daemon.on('error', error => { launchError = error; });
        daemon.unref();
      } finally { closeSync(log); }
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (launchError) throw launchError;
        try { return await connect(); } catch { /* not ready yet */ }
      }
      throw new Error(`relay daemon did not start; see ${join(RUN_DIR, 'relay.log')}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(lock); } catch { /* already removed */ }
    }
  }
  throw new Error(`relay startup timed out; see ${join(RUN_DIR, 'relay.log')}`);
}

async function request(message) {
  let socket;
  try { socket = await connect(); } catch { return JSON.stringify({ relay: message.op, sessions: [], found: false, daemon: false }); }
  socket.write(JSON.stringify(message) + '\n');
  let out = '';
  socket.setEncoding('utf8');
  socket.on('data', d => { out += d; });
  await new Promise(r => socket.on('close', r));
  return out.trim();
}

async function runAttach() {
  // Read exactly the handshake line from stdin, then bridge the rest.
  const handshake = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      const i = buffer.indexOf('\n');
      if (i === -1) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      const rest = buffer.slice(i + 1);
      if (rest) process.stdin.unshift(rest);
      resolve(buffer.slice(0, i));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', () => reject(new Error('no handshake')));
  });
  const socket = await connectOrStart();
  socket.write(handshake.endsWith('\n') ? handshake : handshake + '\n');
  process.stdin.resume();
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  // Do not process.exit() on socket close: stdout may still contain relay:exit or
  // replay records. Let pipe flush before the process exits naturally.
  socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
  socket.on('error', error => { process.stderr.write(`pidesk-relay: ${error.message}\n`); process.exitCode = 1; });
  process.stdout.on('error', () => { socket.destroy(); process.stdin.destroy(); });
  process.stdin.on('end', () => socket.end());
}

const [command, arg] = process.argv.slice(2);
if (command === 'daemon') runDaemon();
else if (command === 'attach') runAttach().catch(error => { process.stderr.write(`pidesk-relay: ${error.message}\n`); process.exit(1); });
else if (command === 'list') request({ op: 'list' }).then(out => { process.stdout.write(out + '\n'); });
else if (command === 'stop') request({ op: 'stop', sessionId: arg }).then(out => { process.stdout.write(out + '\n'); });
else { process.stderr.write('usage: pidesk-relay.mjs attach|daemon|list|stop <id>\n'); process.exit(2); }
