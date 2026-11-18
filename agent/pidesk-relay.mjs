#!/usr/bin/env node
// Pi Desktop relay: keeps Pi sessions running on a host while the desktop is disconnected.
//
//   node pidesk-relay.mjs attach   stdin/stdout bridge for one desktop connection (run over SSH)
//   node pidesk-relay.mjs daemon   the long-lived owner of Pi processes (started on demand, detached)
//   node pidesk-relay.mjs list     JSON summary of sessions
//   node pidesk-relay.mjs stop ID  terminate a session's Pi process and its tools
//   node pidesk-relay.mjs stop-for-update ID  stop a session for replacement, checking idle legacy processes
//   node pidesk-relay.mjs stop-compatible ID  administrative stop, even on a legacy relay
//   node pidesk-relay.mjs shutdown terminate every session and both daemons (local app quit only)
//
// New daemons use ~/.pidesk/run/relay2.sock (directory 0700, socket 0600). The CLI can still reach
// sessions owned by an older daemon on relay.sock without starting or replacing that daemon.
// Every line Pi writes
// is numbered and kept in a bounded log; a re-attaching client sends the last number it saw and gets
// everything after it, plus any extension dialogs (approvals) still waiting for an answer.
//
// Secrets: the attach handshake carries the session's boot record (provider keys). The daemon passes
// it to Pi in the PIDESK_BOOT environment variable at spawn and does not keep it.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const RUN_DIR = process.env.PIDESK_RUN_DIR ?? join(homedir(), '.pidesk', 'run');
const SOCKET = join(RUN_DIR, 'relay2.sock');
const LEGACY_SOCKET = join(RUN_DIR, 'relay.sock');
const LOG_LIMIT_BYTES = 16 * 1024 * 1024;
const CLIENT_CHUNK_BYTES = 64 * 1024;
const CLIENT_DRAIN_MS = 30000;
const STOP_TERM_MS = 500;
const STOP_KILL_MS = 2000;
const STOP_TIMEOUT_MS = 5000;
const CONTROL_TIMEOUT_MS = STOP_TIMEOUT_MS + 3000;
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
const reply = (socket, value) => {
  if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify(value) + '\n');
};

// Pi's bash tool and background jobs create their own groups. Capture those groups by
// ancestry before sending EOF, then keep following them even after the leader exits.
const exec = promisify(execFile);
async function readProcesses(verify = false) {
  if (process.platform === 'linux') {
    // Works on minimal Linux hosts too (BusyBox ps may not expose process group IDs).
    const rows = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const [state, parent, group] = fields;
        // starttime is field 22; fields here start at field 3 (state).
        if (verify && (!state || ![parent, group, fields[19]].every(n => /^\d+$/.test(n)))) throw new Error('Unexpected process table format');
        rows.push({ pid: Number(entry), parent: Number(parent), group: Number(group), state, started: fields[19] });
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
        if (verify || !['EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
    return rows;
  }
  const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
    timeout: 1000, maxBuffer: 4 * 1024 * 1024,
    ...(verify ? { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } } : {}),
  });
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, group, state, ...started] = line.trim().split(/\s+/);
    if (!state || !started.length || ![pid, parent, group].every(n => /^\d+$/.test(n))) throw new Error('Unexpected process table format');
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state, started: started.join(' ') };
  });
}

function updateGroups(groups, processes, child) {
  const children = new Map(), members = new Map(), live = new Set(), owned = [], seen = new Set();
  const previous = new Map();
  for (const group of groups.values()) if (group) for (const [pid, started] of group) previous.set(pid, started);
  const initial = groups.get(child.pid) === null && child.exitCode === null && child.signalCode === null;
  for (const p of processes) {
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p);
    if (!members.has(p.group)) members.set(p.group, []);
    members.get(p.group).push(p);
    // Zombies cannot run or write files, and an orphaned zombie may linger on Linux.
    if (!/^[ZXx]/.test(p.state)) live.add(p.group);
    if ((p.started && previous.get(p.pid) === p.started) ||
        (initial && p.pid === child.pid && p.group === child.pid && p.parent === process.pid)) owned.push(p);
  }
  // A PGID alone is not proof of ownership, even during escalation. Seed each scan
  // from the original child or a process seen in an earlier scan with the same birth time.
  const confirmed = new Set();
  while (owned.length) {
    const p = owned.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (p.group <= 1) continue;
    if (!confirmed.has(p.group)) {
      confirmed.add(p.group);
      for (const member of members.get(p.group)) if (!seen.has(member.pid)) owned.push(member);
    }
    for (const descendant of children.get(p.pid) ?? []) owned.push(descendant);
  }
  for (const group of groups.keys()) {
    if ((live.has(group) && !confirmed.has(group)) || (!members.has(group) && signalGroup(group, 0))) {
      throw new Error(`Could not verify ownership of process group ${group}`);
    }
  }
  groups.clear();
  for (const group of confirmed) if (live.has(group)) {
    groups.set(group, new Map(members.get(group).map(p => [p.pid, p.started])));
  }
}

function signalGroup(group, signal) {
  try { process.kill(-group, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// ------------------------------------------------------------------ daemon
function runDaemon() {
  const sessions = new Map();
  let idleTimer = null, processScan = null;
  let shuttingDown = false;
  const snapshot = () => processScan ??= readProcesses().finally(() => { processScan = null; });
  const touch = () => {
    clearTimeout(idleTimer);
    const busy = [...sessions.values()].some(s => !s.exit || s.clients.size);
    if (!busy) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  const firstSeq = session => session.seq - session.log.length + session.logHead + 1;

  function writeFrame(client, frame) {
    while (client.offset < frame.length && !client.drainTimer) {
      const end = Math.min(client.offset + CLIENT_CHUNK_BYTES, frame.length);
      // Don't pin a large, possibly evicted frame behind a single queued slice.
      const chunk = frame.length <= CLIENT_CHUNK_BYTES ? frame : Buffer.from(frame.subarray(client.offset, end));
      const more = client.socket.write(chunk);
      client.offset = end;
      if (!more) client.drainTimer = setTimeout(() => client.socket.destroy(), CLIENT_DRAIN_MS);
    }
    if (client.offset < frame.length) return false;
    client.offset = 0;
    return true;
  }

  function pump(session, client) {
    const { socket } = client;
    if (socket.destroyed || socket.writableEnded) return;
    const first = firstSeq(session);
    // Live output and replay share one bounded log. Never queue a private copy for a
    // lagging client. If it gets too far behind, a new attach can replay or report a gap.
    if (client.nextSeq < first) { socket.destroy(); return; }
    while (!client.drainTimer) {
      if (client.nextSeq > client.replayThrough && client.pending) {
        if (!client.pendingFrame) {
          const { value, done } = client.pending.next();
          if (done) { client.pending = null; continue; }
          if (value.seq > client.replayThrough) continue; // this request will arrive live
          if (!value.pendingFrame) {
            const line = value.frame.toString('utf8', 0, value.frame.length - 1);
            value.pendingFrame = Buffer.from(JSON.stringify({ relay: 'pending', lines: [line] }) + '\n');
          }
          client.pendingFrame = value.pendingFrame;
        }
        if (writeFrame(client, client.pendingFrame)) client.pendingFrame = null;
      } else if (client.nextSeq <= session.seq) {
        const frame = session.log[session.logHead + client.nextSeq - first];
        if (writeFrame(client, frame)) client.nextSeq++;
      } else {
        if (session.exit) reply(socket, { relay: 'exit', code: session.exit.code, signal: session.exit.signal, stderr: session.exit.stderr });
        break;
      }
    }
  }

  function finishSession(session) {
    session.exit = session.childExit;
    session.pendingUi.clear();
    for (const client of session.clients) pump(session, client);
    setTimeout(() => { if (sessions.get(session.id) === session) sessions.delete(session.id); touch(); }, EXITED_RETENTION_MS).unref();
    touch();
  }

  function spawnSession(id, spec, boot) {
    const env = { ...process.env, ...spec.env, PIDESK_BOOT: JSON.stringify(boot ?? {}) };
    // On supported POSIX hosts detached starts a new session and process group (not a new tty).
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const groups = new Map(child.pid > 1 ? [[child.pid, null]] : []);
    const session = { id, child, groups, cwd: spec.cwd, seq: 0, log: [], logHead: 0, logBytes: 0, pendingUi: new Map(), clients: new Set(), exit: null, startedAt: Date.now(), stderr: '' };
    sessions.set(id, session);
    let stdoutYield = null;
    lineReader(child.stdout, line => {
      if (!line.startsWith('{') || line.length < 3) return; // Pi's stdout carries only JSON records
      session.seq += 1;
      const frame = Buffer.from('{"_seq":' + session.seq + ',' + line.slice(1) + '\n');
      session.log.push(frame);
      session.logBytes += frame.length;
      // Keep one oversize record (e.g. a large get_messages reply); writes still use bounded chunks.
      while (session.logBytes > LOG_LIMIT_BYTES && session.log.length > session.logHead + 1) {
        session.logBytes -= session.log[session.logHead].length;
        session.log[session.logHead++] = null;
      }
      if (session.logHead >= 4096 && session.logHead * 2 >= session.log.length) {
        session.log = session.log.slice(session.logHead);
        session.logHead = 0;
      }
      try {
        const record = JSON.parse(line);
        if (record.type === 'extension_ui_request' && DIALOGS.has(record.method)) session.pendingUi.set(record.id, { seq: session.seq, frame });
      } catch { /* non-JSON output is still forwarded */ }
      let blocked = false;
      for (const client of session.clients) {
        pump(session, client);
        if (client.drainTimer && !client.socket.destroyed) blocked = true;
      }
      // A busy Pi pipe can monopolize the I/O loop. Give socket drains a turn, but
      // never make Pi wait for a particular reader: unattended sessions must run on.
      if (blocked && !stdoutYield) {
        child.stdout.pause();
        stdoutYield = setTimeout(() => { stdoutYield = null; child.stdout.resume(); }, 1);
      }
    });
    child.stderr.on('data', d => { session.stderr = (session.stderr + d).slice(-8000); });
    child.on('close', (code, signal) => {
      session.childExit = { code, signal, at: Date.now(), stderr: session.stderr.slice(-2000) };
      if (session.stopRequested) return;
      // A group can outlive Pi even when none of its members hold Pi's pipes open.
      // Check immediately, not later when the ID could have been reused.
      try {
        if (!groups.size || !signalGroup(child.pid, 0)) { finishSession(session); return; }
      } catch { /* try cleanup and keep the session available for retry if it fails */ }
      stopSession(session).catch(error => process.stderr.write(`pidesk-relay: ${error.message}\n`));
    });
    child.on('error', error => { session.stderr += `\nspawn failed: ${error.message}`; });
    child.stdin.on('error', () => {});
    return session;
  }

  function stopSession(session) {
    if (session.stopping) return session.stopping;
    if (session.exit) return Promise.resolve();
    session.stopRequested = true;
    session.stopping = (async () => {
      const start = performance.now();
      const terminated = new Set();
      for (;;) {
        if (session.groups.size) updateGroups(session.groups, await snapshot(), session.child);
        if (session.childExit && !session.groups.size) { finishSession(session); return; }
        // Keep polling through escalation: the leader closing its stdio is not proof
        // that independently reparented tools are gone.
        const elapsed = performance.now() - start;
        if (elapsed >= STOP_TIMEOUT_MS) throw new Error(`Timed out stopping session ${session.id}`);
        if (!session.child.stdin.writableEnded) session.child.stdin.end();
        for (const group of session.groups.keys()) {
          if (elapsed >= STOP_KILL_MS) signalGroup(group, 'SIGKILL');
          else if (elapsed >= STOP_TERM_MS && !terminated.has(group)) {
            signalGroup(group, 'SIGTERM');
            terminated.add(group);
          }
        }
        await sleep(75);
      }
    })().finally(() => { session.stopping = null; });
    return session.stopping;
  }

  function attach(socket, message) {
    if (shuttingDown) throw new Error('Relay is shutting down');
    let session = sessions.get(message.sessionId);
    let created = false;
    if (!session || session.exit) {
      if (!message.spawn) throw new Error('Session is not running');
      const spec = message.spawn;
      if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(a => typeof a !== 'string') || typeof spec.cwd !== 'string') throw new Error('Invalid spawn specification');
      session = spawnSession(message.sessionId, spec, message.boot);
      created = true;
    }
    if (session.stopRequested) throw new Error('Session is stopping; retry after stop completes');
    delete message.boot;
    const first = firstSeq(session);
    const replayThrough = session.seq;
    const since = !created && Number.isSafeInteger(message.sinceSeq) ? Math.min(message.sinceSeq, replayThrough) : replayThrough;
    const client = { socket, replayThrough, nextSeq: Math.max(first, since + 1), offset: 0, pending: session.pendingUi.values() };
    session.clients.add(client);
    socket.on('drain', () => { clearTimeout(client.drainTimer); client.drainTimer = null; pump(session, client); });
    socket.on('close', () => { clearTimeout(client.drainTimer); session.clients.delete(client); touch(); });
    socket.write(JSON.stringify({ relay: 'attached', created, lastSeq: replayThrough, pid: session.child.pid, startedAt: session.startedAt }) + '\n');
    if (since + 1 < first) socket.write(JSON.stringify({ relay: 'gap', from: since, firstSeq: first }) + '\n');
    pump(session, client);
    touch();
    return session;
  }

  const server = net.createServer({ highWaterMark: CLIENT_CHUNK_BYTES }, socket => {
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
          reply(socket, { relay: 'list', sessions: [...sessions.values()].map(s => ({ id: s.id, pid: s.child.pid, cwd: s.cwd, alive: !s.exit, exit: s.exit, startedAt: s.startedAt, lastSeq: s.seq, clients: s.clients.size, pendingUi: s.pendingUi.size })) });
          return;
        }
        if (message.op === 'stop-tree' || message.op === 'stop') {
          if (typeof message.sessionId !== 'string' || !message.sessionId) {
            reply(socket, { relay: 'error', error: 'Invalid session id' });
            return;
          }
          const s = sessions.get(message.sessionId);
          // Acknowledgement means neither Pi nor its tools can still write the session.
          const stopped = s ? stopSession(s) : Promise.resolve();
          stopped.then(() => reply(socket, { relay: 'stopped', found: !!s }), error => reply(socket, { relay: 'error', error: error.message }));
          return;
        }
        if (message.op === 'shutdown') {
          // Sessions here need not outlive the desktop: stop them all, answer, then exit.
          if (shuttingDown) { reply(socket, { relay: 'error', error: 'Relay is already shutting down' }); return; }
          shuttingDown = true;
          Promise.allSettled([...sessions.values()].filter(s => !s.exit).map(stopSession)).then(results => {
            const failure = results.find(result => result.status === 'rejected');
            if (failure) {
              shuttingDown = false;
              reply(socket, { relay: 'error', error: failure.reason.message });
              return;
            }
            reply(socket, { relay: 'shutdown', stopped: sessions.size });
            server.close();
            setTimeout(() => process.exit(0), 50);
          });
          return;
        }
        if (message.op === 'attach') {
          try {
            if (typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('Invalid session id');
            session = attach(socket, message);
          } catch (error) { reply(socket, { relay: 'error', error: error.message }); }
          return;
        }
        socket.end(); return;
      }
      if (!session || session.stopRequested || session.exit) return;
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
function connect(address = SOCKET) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectOrStart() {
  try { return await connect(); } catch { /* start below */ }
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RUN_DIR, 0o700);
  const lock = join(RUN_DIR, 'startup2.lock');
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
      const log = openSync(join(RUN_DIR, 'relay2.log'), 'a', 0o600);
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
      throw new Error(`relay daemon did not start; see ${join(RUN_DIR, 'relay2.log')}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(lock); } catch { /* already removed */ }
    }
  }
  throw new Error(`relay startup timed out; see ${join(RUN_DIR, 'relay2.log')}`);
}

const OFFLINE = ['ENOENT', 'ECONNREFUSED'];
async function request(address, message, expected, absent = []) {
  const out = await new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let out = '', connected = false;
    const timer = setTimeout(() => socket.destroy(new Error('Timed out waiting for relay acknowledgement')), CONTROL_TIMEOUT_MS);
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify(message) + '\n');
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => { out += chunk; });
    socket.on('error', error => {
      if (!connected && absent.includes(error.code)) resolve(null);
      else reject(error);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
  if (out === null) return null;
  let response;
  try { response = JSON.parse(out); } catch { /* incomplete or unsupported reply */ }
  if (response?.relay === 'error') throw new Error(response.error);
  if (response?.relay !== expected) throw new Error(`No relay ${message.op} acknowledgement`);
  return response;
}

function hasLegacySocket() {
  let stat;
  try { stat = lstatSync(LEGACY_SOCKET); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return stat.isSocket(); // an abandoned regular file cannot own a legacy session
}

async function listOn(address) {
  const response = await request(address, { op: 'list' }, 'list', OFFLINE);
  if (response && (!Array.isArray(response.sessions) || response.sessions.some(s =>
    typeof s?.id !== 'string' || !s.id || typeof s.alive !== 'boolean'))) throw new Error('Invalid relay session list');
  return response;
}

async function listLegacy() {
  return hasLegacySocket() ? listOn(LEGACY_SOCKET) : null;
}

const isAlive = (list, id) => list?.sessions.some(s => s.id === id && s.alive);

async function listSessions() {
  const [legacy, current] = await Promise.all([listLegacy(), listOn(SOCKET)]);
  const sessions = new Map(current?.sessions.map(s => [s.id, s]));
  // Prefer a live entry over exit history. If both are live, show the owner attach
  // will use; old clients can still be connected to the legacy daemon.
  for (const s of legacy?.sessions ?? []) if (s.alive || !sessions.has(s.id)) sessions.set(s.id, s);
  return { relay: 'list', sessions: [...sessions.values()], ...(!legacy && !current ? { daemon: false } : {}) };
}

async function stopForCli(sessionId, compatible) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id');
  if (isAlive(await listLegacy(), sessionId)) {
    if (!compatible) throw new Error('Session is running in the legacy relay, which cannot acknowledge a process-tree stop');
    if (isAlive(await listOn(SOCKET), sessionId)) throw new Error('Session is live in both relay daemons; refusing an ambiguous stop');
    const reply = await request(LEGACY_SOCKET, { op: 'stop', sessionId }, 'stopped');
    if (reply.found !== true) throw new Error('Legacy relay did not acknowledge stopping the listed session');
    return reply;
  }
  // Both verbs require tree-stop acknowledgement from a running v2 daemon. Routine
  // cleanup of a saved conversation must also work when neither daemon is running.
  return stopTree(sessionId, compatible ? OFFLINE : []);
}

async function stopTree(sessionId, absent = []) {
  const reply = await request(SOCKET, { op: 'stop-tree', sessionId }, 'stopped', absent);
  if (!reply) return { relay: 'stopped', found: false, daemon: false };
  if (typeof reply.found !== 'boolean') throw new Error('Invalid process-tree stop acknowledgement');
  return reply;
}

const processIsLive = p => !!p && !/^[ZXx]/.test(p.state);
const sameLegacySession = (a, b) => a?.pid === b.pid && a.startedAt === b.startedAt;

async function verifyLegacyStart(session, leader) {
  let bornAt;
  if (process.platform === 'linux') {
    const { stdout } = await exec('getconf', ['CLK_TCK'], { timeout: 1000, maxBuffer: 1024 });
    const ticks = Number(stdout);
    const boot = readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m);
    bornAt = Number.isSafeInteger(ticks) && ticks > 0 && boot
      ? Number(boot[1]) * 1000 + Math.floor(Number(leader.started) * 1000 / ticks) : NaN;
  } else bornAt = Date.parse(`${leader.started} UTC`);
  // The relay timestamps just after spawn; ps and Linux btime are only second-precise.
  // The kernel start token, not this rounded time, is compared across snapshots below.
  if (!Number.isFinite(bornAt) || session.startedAt < bornAt || session.startedAt - bornAt >= 2000) {
    throw new Error(`Could not verify legacy session ${session.id} PID ${session.pid} start time; retry Update after it exits`);
  }
}

function checkLegacyTools(session, rows, ownGroup) {
  const children = new Map();
  const blocked = p => {
    throw new Error(`Legacy session ${session.id} has a running tool process (PID ${p.pid}); wait for it to finish or stop the tool, then retry Update`);
  };
  for (const p of rows) {
    if (ownGroup && p.group === session.pid && p.pid !== session.pid && processIsLive(p)) blocked(p);
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p);
  }
  // Older relays shared their group with every session. Check ancestry, not that
  // shared PGID, and include descendants that have started groups of their own.
  const seen = new Set([session.pid]), pending = [session.pid];
  while (pending.length) for (const p of children.get(pending.pop()) ?? []) {
    if (seen.has(p.pid)) continue;
    if (processIsLive(p)) blocked(p);
    seen.add(p.pid);
    pending.push(p.pid);
  }
}

function legacyLeader(rows, pid) {
  const leader = rows.find(p => p.pid === pid);
  if (!leader) {
    // A process missing from the scan is not proof that it already exited.
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    throw new Error(`Could not verify legacy session PID ${pid} in the process table`);
  }
  return leader;
}

async function stopForUpdate(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id');
  const readOwners = async () => {
    const [legacy, current] = await Promise.all([listLegacy(), listOn(SOCKET)]);
    const live = list => {
      const matches = list?.sessions.filter(s => s.id === sessionId) ?? [];
      if (matches.length > 1) throw new Error('Relay listed duplicate session identities; refusing an ambiguous stop');
      return matches[0]?.alive ? matches[0] : null;
    };
    return { legacy: live(legacy), current: live(current), daemon: !!(legacy || current) };
  };
  const ambiguous = () => new Error('Session is live in both relay daemons; refusing an ambiguous stop');
  const noSession = { relay: 'stopped', found: false };
  const { legacy, current, daemon } = await readOwners();
  if (legacy && current) throw ambiguous();
  if (!legacy) {
    if (!current) return daemon ? noSession : { ...noSession, daemon: false };
    const ack = await stopTree(sessionId);
    if (!ack.found) throw new Error('Relay did not acknowledge stopping the listed session');
    return ack;
  }

  if (!Number.isSafeInteger(legacy.pid) || legacy.pid <= 1 || !Number.isSafeInteger(legacy.startedAt) || legacy.startedAt <= 0) {
    throw new Error(`Legacy relay did not list a valid PID and start time for session ${sessionId}`);
  }
  const changed = () => new Error(`Legacy session ${sessionId} changed identity or could not be verified; retry Update after it exits`);
  const first = await readProcesses(true);
  const original = legacyLeader(first, legacy.pid);
  const parent = first.find(p => p.pid === original?.parent);
  const ownGroup = original?.group === legacy.pid;
  if (original) await verifyLegacyStart(legacy, original);
  checkLegacyTools(legacy, first, ownGroup);

  // No client-count assumption: an idle process can have several attached desktops.
  // Reconfirm the listed incarnation and both owners immediately before asking the
  // old daemon to stop its own child. Its protocol has no conditional stop verb.
  let owners = await readOwners();
  if (owners.current) throw ambiguous();
  if (owners.legacy && !sameLegacySession(owners.legacy, legacy)) throw changed();
  const before = await readProcesses(true);
  const leader = legacyLeader(before, legacy.pid);
  if (leader && (!original || leader.started !== original.started)) throw changed();
  checkLegacyTools(legacy, before, ownGroup);
  if (!processIsLive(leader)) {
    // A process can exit between list and the scan. Do not attach a replacement
    // while the legacy relay still claims it (e.g. inherited pipes may be open).
    if (owners.legacy) owners = await readOwners();
    if (owners.current) throw ambiguous();
    if (!owners.legacy) return noSession;
    throw changed();
  }
  if (!owners.legacy || leader.parent <= 1 || !processIsLive(parent) || !before.some(p => p.pid === leader.parent &&
    p.pid === parent.pid && p.started === parent.started && processIsLive(p))) throw changed();

  const ack = await request(LEGACY_SOCKET, { op: 'stop', sessionId }, 'stopped');
  if (ack.found !== true) throw new Error('Legacy relay did not acknowledge stopping the listed session');
  const after = await readProcesses(true);
  const remaining = legacyLeader(after, legacy.pid);
  if (remaining?.started === leader.started && processIsLive(remaining)) {
    throw new Error(`Legacy relay acknowledged stop, but session ${sessionId} PID ${legacy.pid} is still running; retry Update after it exits`);
  }
  if (!remaining || remaining.started === leader.started) checkLegacyTools(legacy, after, ownGroup);
  owners = await readOwners();
  if (owners.current || owners.legacy) throw changed();
  return ack;
}

async function shutdownDaemons() {
  const shutdown = address => request(address, { op: 'shutdown' }, 'shutdown', OFFLINE);
  const legacy = async () => hasLegacySocket() ? shutdown(LEGACY_SOCKET) : null;
  const results = await Promise.allSettled([shutdown(SOCKET), legacy()]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const replies = results.map(result => result.value).filter(Boolean);
  return { relay: 'shutdown', stopped: replies.reduce((n, r) => n + (Number.isSafeInteger(r.stopped) ? r.stopped : 0), 0), ...(!replies.length ? { daemon: false } : {}) };
}

async function runControl(command, sessionId) {
  try {
    const response = command === 'list' ? await listSessions() : command === 'shutdown' ? await shutdownDaemons()
      : command === 'stop-for-update' ? await stopForUpdate(sessionId) : await stopForCli(sessionId, command === 'stop-compatible');
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ relay: 'error', error: error.message }) + '\n');
    process.stderr.write(`pidesk-relay: ${error.message}\n`);
    process.exitCode = 1;
  }
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
  let message;
  try { message = JSON.parse(handshake); } catch { /* do not log the boot record */ }
  if (message?.op !== 'attach' || typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('Invalid attach handshake');
  const legacy = isAlive(await listLegacy(), message.sessionId);
  const socket = legacy ? await connect(LEGACY_SOCKET) : await connectOrStart();
  if (legacy) {
    // The listed process can exit before this connection. Never respawn it on the
    // old daemon; a subsequent attach will route to v2 once the old ID is not live.
    delete message.spawn;
    delete message.boot;
  }
  socket.write((legacy ? JSON.stringify(message) : handshake) + '\n');
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
else if (['list', 'stop', 'stop-for-update', 'stop-compatible', 'shutdown'].includes(command)) runControl(command, arg);
else { process.stderr.write('usage: pidesk-relay.mjs attach|daemon|list|stop <id>|stop-for-update <id>|stop-compatible <id>|shutdown\n'); process.exit(2); }
