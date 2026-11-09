// Commands run beside the session's Pi, including while the desktop is disconnected.
// Only completion and the one-time escalation notify the model; UI updates are throttled status
// events. Tracking is process-local and bounded. Session shutdown stops the tracked process groups.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const BACKGROUND_LIMIT = 8;
export const FINISHED_LIMIT = 32;
const TAIL_BYTES = 64 * 1024;
const ESCALATE_MS = 30 * 60 * 1000;
const humanMs = ms => `${Math.max(0, Math.round(ms / 1000))}s`;
const tailLines = (job, max = 40) => job.tail.split('\n').slice(-max).join('\n').replace(/\n*$/, '');

export function createBackground({ notify, isIdle, signal, publish, escalateMs = ESCALATE_MS }) {
  const jobs = new Map();
  const generation = randomUUID();
  let seq = 0, revision = 0, publishTimer = null, closed = false;
  const snapshot = job => ({
    id: job.id, command: job.command, description: job.description, cwd: job.cwd,
    status: job.status, stopping: job.stopped && job.status === 'running',
    exitCode: job.exitCode, exitSignal: job.exitSignal, pid: job.pid,
    startedAt: job.startedAt, endedAt: job.endedAt,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    escalated: job.escalated, error: job.error ?? null, tail: tailLines(job, 10).slice(-2048),
  });
  function trimFinished() {
    const finished = [...jobs.values()].filter(j => j.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT))) jobs.delete(job.id);
  }
  function sync() {
    clearTimeout(publishTimer); publishTimer = null;
    if (closed) return;
    trimFinished();
    try { publish?.({ generation, revision: ++revision, jobs: [...jobs.values()].map(snapshot) }); } catch { /* next resync catches up */ }
  }
  function outputChanged() {
    if (closed || !publish || publishTimer) return;
    publishTimer = setTimeout(sync, 1000);
    publishTimer.unref?.();
  }
  function announce(job, text) {
    if (closed || signal?.aborted) return;
    const options = { triggerTurn: true, deliverAs: isIdle?.() === false ? 'steer' : 'followUp' };
    try { notify?.({ customType: 'pidesk-background', content: text, display: true,
      details: { kind: 'pidesk-background', key: `${generation}:${job.id}:${job.status}`, job: snapshot(job) } }, options); }
    catch { /* session gone */ }
  }
  function start(command, { cwd = process.cwd(), description = '' } = {}) {
    if (closed || signal?.aborted) throw new Error('This session has shut down');
    if (typeof command !== 'string' || !command.trim()) throw new Error('A shell command is required');
    if ([...jobs.values()].filter(j => j.status === 'running').length >= BACKGROUND_LIMIT)
      throw new Error(`Too many concurrent background jobs (${BACKGROUND_LIMIT}). Stop one with background_stop first.`);
    const job = {
      id: `bg-${String(++seq).padStart(2, '0')}`, command, description, cwd,
      startedAt: Date.now(), endedAt: null, status: 'running', pid: null,
      exitCode: null, exitSignal: null, escalated: false, stopped: false, error: null,
      tail: '', timer: null, force: null, child: null,
    };
    jobs.set(job.id, job);
    const prefix = `Automated message from Pi Desktop, not from the user: background job ${job.id}${description ? ` (${description})` : ''}`;
    const finish = (code, exitSignal, error) => {
      if (job.status !== 'running') return; // spawn error is followed by close
      job.endedAt = Date.now();
      clearTimeout(job.timer); clearTimeout(job.force);
      job.exitCode = code; job.exitSignal = exitSignal; job.error = error?.message ?? null;
      job.status = job.stopped ? 'stopped' : error ? 'failed' : 'exited';
      sync();
      if (job.stopped) return;
      const outcome = error ? `failed to run: ${error.message}` : code === 0 ? 'finished successfully' : code === null ? `ended with signal ${exitSignal}` : `finished with exit code ${code}`;
      const tail = tailLines(job);
      announce(job, `${prefix} ${outcome} after ${humanMs(job.endedAt - job.startedAt)}.${tail ? `\nOutput tail:\n${tail}` : ''}`);
    };
    try {
      // A process group lets Stop terminate pipelines and their children, not just the shell.
      job.child = spawn('sh', ['-c', command], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(null, null, error);
      throw new Error(`Could not start the background job: ${error.message}`);
    }
    job.pid = job.child.pid;
    for (const stream of [job.child.stdout, job.child.stderr]) {
      const decoder = new StringDecoder('utf8');
      const append = text => {
        job.tail += text;
        if (Buffer.byteLength(job.tail, 'utf8') > TAIL_BYTES) job.tail = Buffer.from(job.tail).subarray(-TAIL_BYTES + 4).toString('utf8');
        outputChanged();
      };
      stream.on('data', chunk => append(decoder.write(chunk)));
      stream.on('end', () => append(decoder.end()));
    }
    job.timer = setTimeout(() => {
      if (closed || job.status !== 'running' || job.stopped || job.escalated) return;
      job.escalated = true;
      sync();
      announce(job, `${prefix} is still running after ${humanMs(Date.now() - job.startedAt)}; it was started with: ${command}. Check it with background_status, or stop it with background_stop if it is stuck.`);
    }, escalateMs);
    job.timer.unref?.();
    job.child.on('close', (code, exitSignal) => finish(code, exitSignal));
    job.child.on('error', error => finish(null, null, error));
    sync();
    return snapshot(job);
  }
  function get(id) {
    const job = jobs.get(String(id ?? ''));
    if (!job) throw new Error(`Unknown background job: ${id}`);
    return job;
  }
  function kill(job, how) {
    if (!job.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-job.pid, how);
      else job.child.kill(how);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  function stop(id) {
    const job = get(id);
    if (job.status !== 'running' || job.stopped) return snapshot(job);
    job.stopped = true;
    clearTimeout(job.timer);
    kill(job, 'SIGTERM');
    job.force = setTimeout(() => { if (job.status === 'running') kill(job, 'SIGKILL'); }, 3000);
    job.force.unref?.();
    sync();
    return snapshot(job);
  }
  function list(filter) { return [...jobs.values()].filter(j => !filter || j.id === String(filter)).map(snapshot); }
  function shutdown() {
    if (closed) return;
    closed = true;
    clearTimeout(publishTimer); publishTimer = null;
    for (const job of jobs.values()) if (job.status === 'running') stop(job.id);
    signal?.removeEventListener('abort', shutdown);
  }
  signal?.addEventListener('abort', shutdown, { once: true });
  return { start, stop, list, get, sync, shutdown, limit: BACKGROUND_LIMIT };
}
