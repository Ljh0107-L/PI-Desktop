// Background jobs: the model offloads long commands to the background and keeps working. A job is a
// shell child of this Pi (on an SSH host: of the host's Pi), so it carries on while the model does
// other work and while the desktop is disconnected. Completion — or the 30-minute escalation —
// reaches the model as an automated message on the same channel subagent reports use: injected into
// the current step while a turn runs, or delivered as a follow-up that starts a new turn when idle.
// Jobs are tracked in memory: they are killed when the session shuts down, and a Pi restart drops
// the tracking (a finished job's message is then lost).
import { spawn } from 'node:child_process';

export const BACKGROUND_LIMIT = 8; // concurrent running jobs
const TAIL_BYTES = 64 * 1024;      // of output retained per job
const MESSAGE_TAIL_LINES = 40;
const ESCALATE_MS = 30 * 60 * 1000;

const humanMs = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}`.trim() : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const tailLines = (job, max = MESSAGE_TAIL_LINES) =>
  job.tail.split('\n').slice(-max).join('\n').replace(/\n*$/, '');

export function createBackground({ notify, isIdle, signal, escalateMs = ESCALATE_MS }) {
  const jobs = new Map();
  let seq = 0;

  const snapshot = job => ({
    id: job.id, command: job.command, description: job.description, cwd: job.cwd,
    status: job.status, exitCode: job.exitCode, exitSignal: job.exitSignal,
    pid: job.pid, startedAt: job.startedAt,
    elapsedMs: job.status === 'running' ? Date.now() - job.startedAt : job.endedAt - job.startedAt,
    escalated: job.escalated, error: job.error ?? null,
    tail: job.tail.split('\n').slice(-10).join('\n').replace(/\n*$/, ''),
  });

  // Same delivery rules as subagent reports: steer the running turn, or start one when idle.
  function announce(job, text) {
    if (signal?.aborted) return;
    const busy = isIdle?.() === false;
    const options = busy ? { triggerTurn: true, deliverAs: 'steer' } : { triggerTurn: true, deliverAs: 'followUp' };
    try { notify({ customType: 'pidesk-background', content: text, display: true,
      details: { kind: 'pidesk-background', key: `${job.id}:${job.status}`, job: snapshot(job) } }, options); }
    catch { /* session gone */ }
  }

  function start(command, { cwd = process.cwd(), description = '' } = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('A shell command is required');
    const running = [...jobs.values()].filter(j => j.status === 'running').length;
    if (running >= BACKGROUND_LIMIT)
      throw new Error(`Too many concurrent background jobs (${BACKGROUND_LIMIT}). Stop one with background_stop first.`);
    const job = {
      id: `bg-${String(++seq).padStart(2, '0')}`, command, description, cwd,
      startedAt: Date.now(), endedAt: null, status: 'running', pid: null,
      exitCode: null, exitSignal: null, escalated: false, stopped: false, error: null, tail: '', timer: null, child: null,
    };
    jobs.set(job.id, job);
    let child;
    try {
      child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      job.status = 'failed'; job.endedAt = Date.now(); job.error = error.message;
      throw new Error(`Could not start the background job: ${error.message}`);
    }
    job.child = child; job.pid = child.pid;
    const onData = chunk => {
      job.tail += chunk.toString('utf8');
      if (Buffer.byteLength(job.tail, 'utf8') > TAIL_BYTES) job.tail = job.tail.slice(-TAIL_BYTES / 2);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    job.timer = setTimeout(() => {
      if (job.status !== 'running' || job.escalated) return;
      job.escalated = true;
      announce(job, `Automated message from Pi Desktop, not from the user: background job ${job.id}` +
        `${description ? ` (${description})` : ''} is still running after ${humanMs(Date.now() - job.startedAt)}; it was started with: ${command}. Check it with background_status, or stop it with background_stop if it is stuck.`);
    }, escalateMs);
    job.timer.unref?.();
    child.on('close', (code, signal) => {
      if (job.status !== 'running') return; // spawn failed: the error handler already reported it
      job.endedAt = Date.now();
      clearTimeout(job.timer);
      job.exitCode = code; job.exitSignal = signal;
      if (job.stopped) { job.status = 'stopped'; return; }
      job.status = 'exited';
      const outcome = code === 0 ? 'finished successfully' : code === null ? `ended with signal ${signal}` : `finished with exit code ${code}`;
      const tail = tailLines(job);
      announce(job, `Automated message from Pi Desktop, not from the user: background job ${job.id}` +
        `${description ? ` (${description})` : ''} ${outcome} after ${humanMs(Date.now() - job.startedAt)}.` +
        (tail ? `\nOutput tail:\n${tail}` : ''));
    });
    child.on('error', error => {
      job.endedAt = Date.now();
      clearTimeout(job.timer);
      job.status = 'failed'; job.error = error.message;
      announce(job, `Automated message from Pi Desktop, not from the user: background job ${job.id}` +
        `${description ? ` (${description})` : ''} failed to run: ${error.message}`);
    });
    return snapshot(job);
  }

  function get(id) {
    const job = jobs.get(String(id ?? ''));
    if (!job) throw new Error(`Unknown background job: ${id}`);
    return job;
  }

  function stop(id) {
    const job = get(id);
    if (job.status !== 'running') return snapshot(job);
    job.stopped = true;
    job.child.kill('SIGTERM');
    const force = setTimeout(() => { if (job.status === 'running') job.child.kill('SIGKILL'); }, 3000);
    force.unref?.();
    return job; // status flips to 'stopped' on close
  }

  function list(filter) {
    const all = [...jobs.values()];
    return (filter ? all.filter(j => j.id === String(filter)) : all).map(snapshot);
  }

  // Kill every tracked job and forget the timers; the bridge aborts the signal so no
  // completion message is delivered to a session that is shutting down.
  function shutdown() {
    for (const job of jobs.values()) {
      if (job.status !== 'running') continue;
      job.stopped = true;
      job.child.kill('SIGTERM');
      const force = setTimeout(() => job.child.kill('SIGKILL'), 3000);
      force.unref?.();
    }
  }

  return { start, stop, list, get, shutdown, limit: BACKGROUND_LIMIT };
}
