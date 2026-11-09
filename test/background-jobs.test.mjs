// Background jobs: offload, status, stop, completion and escalation messages, shutdown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_LIMIT, FINISHED_LIMIT, createBackground } from '../agent/pidesk-background.mjs';
import { backgroundElapsed, backgroundOutcome, backgroundSnapshot, sortedBackgroundJobs } from '../app/renderer/src/background-jobs.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function harness(t, { idle = true, escalateMs = 60000 } = {}) {
  const controller = new AbortController();
  const messages = [];
  const published = [];
  const bg = createBackground({
    notify: (message, options) => messages.push({ ...message, options }),
    isIdle: () => idle,
    signal: controller.signal,
    escalateMs,
    publish: payload => published.push(payload),
  });
  t.after(() => bg.shutdown());
  return { bg, messages, published, controller };
}
const settled = async (bg, id, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const job = bg.get(id);
    if (job.status !== 'running' || Date.now() - t0 > ms) return job;
    await wait(20);
  }
};

test('the card receives output changes and terminal state without model polling', async t => {
  const { bg, published, messages } = harness(t);
  const job = bg.start('echo live; sleep 1.5; echo done', { description: 'soak' });
  assert.equal(published[0].jobs[0].status, 'running');
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'exited');
  assert.ok(published.some(p => p.jobs[0].status === 'running' && p.jobs[0].tail.includes('live')));
  const last = published.at(-1);
  assert.equal(last.jobs[0].status, 'exited');
  assert.equal(last.jobs[0].exitCode, 0);
  assert.ok(last.jobs[0].elapsedMs >= 1000);
  assert.equal(last.jobs[0].endedAt, done.endedAt);
  assert.match(last.jobs[0].tail, /done/);
  assert.equal(messages.length, 1, 'only completion wakes the model');
  assert.ok(published.every((p, i) => !i || p.revision > published[i - 1].revision));
});

test('stopping a job publishes its stopped state to the card without a completion message', async t => {
  const { bg, messages, published } = harness(t);
  const job = bg.start('sleep 30', {});
  bg.stop(job.id);
  await settled(bg, job.id);
  await wait(50);
  assert.equal(published.at(-1).jobs[0].status, 'stopped');
  assert.equal(messages.length, 0);
});

test('a command runs, reports success with its output tail, and starts a turn when idle', async t => {
  const { bg, messages } = harness(t);
  const job = bg.start("printf 'hello\\nworld'", { description: 'greet' });
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'exited');
  assert.equal(done.exitCode, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /background job bg-01 \(greet\) finished successfully/);
  assert.match(messages[0].content, /world/);
  assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(messages[0].customType, 'pidesk-background');
});

test('completion reaches a busy model as a steer into the running turn', async t => {
  const { bg, messages } = harness(t, { idle: false });
  const job = bg.start('true', {});
  await settled(bg, job.id);
  assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: 'steer' });
});

test('a failing command reports its exit code', async t => {
  const { bg, messages } = harness(t);
  const job = bg.start('sh -c "exit 3"', {});
  const done = await settled(bg, job.id);
  assert.equal(done.exitCode, 3);
  assert.match(messages[0].content, /finished with exit code 3/);
});

test('stop kills the process and marks it stopped without a completion message', async t => {
  const { bg, messages } = harness(t);
  const job = bg.start('sleep 30', {});
  bg.stop(job.id);
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'stopped');
  assert.equal(done.exitSignal, 'SIGTERM');
  await wait(50);
  assert.equal(messages.length, 0);
});

test('the job limit is enforced and releasing a slot allows a new job', async t => {
  const { bg } = harness(t);
  const ids = [];
  for (let i = 0; i < BACKGROUND_LIMIT; i++) ids.push(bg.start('sleep 30', {}).id);
  assert.throws(() => bg.start('true', {}), new RegExp(`Too many concurrent background jobs \\(${BACKGROUND_LIMIT}\\)`));
  bg.stop(ids[0]);
  await settled(bg, ids[0]);
  const extra = bg.start('true', {});
  assert.equal(extra.status, 'running');
  for (const id of ids) if (id !== ids[0]) bg.stop(id);
  await wait(50);
});

test('a long job escalates once after the limit', async t => {
  const { bg, messages } = harness(t, { escalateMs: 100 });
  const job = bg.start('sleep 5', { description: 'soak' });
  await wait(400);
  assert.equal(bg.get(job.id).status, 'running');
  assert.equal(messages.filter(m => /still running/.test(m.content)).length, 1);
  assert.match(messages[0].content, /background job bg-01 \(soak\) is still running/);
  bg.stop(job.id);
  await settled(bg, job.id);
});

test('the output tail is bounded', async t => {
  const { bg } = harness(t);
  const job = bg.start("head -c 300000 /dev/zero | tr '\\0' x", {});
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'exited');
  assert.ok(Buffer.byteLength(done.tail, 'utf8') <= 65536);
});

test('resync includes finished jobs and empty lists without waking the model', async t => {
  const { bg, published, messages } = harness(t);
  bg.sync();
  assert.deepEqual(published.at(-1).jobs, []);
  const job = bg.start('true');
  await settled(bg, job.id);
  const count = messages.length;
  bg.sync();
  assert.equal(published.at(-1).jobs[0].status, 'exited');
  assert.equal(messages.length, count);
});

test('spawn errors publish once, preserve failed state and can be inspected', async t => {
  const { bg, published, messages } = harness(t);
  const job = bg.start('true', { cwd: '/pidesk-nonexistent-directory-fixture' });
  await settled(bg, job.id);
  await wait(30);
  assert.equal(bg.get(job.id).status, 'failed');
  assert.equal(published.at(-1).jobs[0].status, 'failed');
  assert.match(published.at(-1).jobs[0].error, /ENOENT/);
  assert.equal(messages.length, 1);
});

test('Stop kills a TERM-resistant descendant, not only its parent shell', async t => {
  const { bg, published } = harness(t);
  const job = bg.start(`sh -c 'trap "" TERM; echo resistant; sleep 30' & wait`);
  for (let i = 0; i < 100 && !bg.get(job.id).tail.includes('resistant'); i++) await wait(20);
  assert.match(bg.get(job.id).tail, /resistant/);
  bg.stop(job.id);
  assert.equal(published.at(-1).jobs[0].stopping, true);
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'stopped');
});

test('finished records are bounded without evicting active work', async t => {
  const { bg } = harness(t);
  const active = bg.start('sleep 30');
  for (let i = 0; i < FINISHED_LIMIT + 3; i++) await settled(bg, bg.start('true').id);
  bg.sync();
  assert.equal(bg.list().length, FINISHED_LIMIT + 1);
  assert.equal(bg.get(active.id).status, 'running');
  bg.stop(active.id);
  await settled(bg, active.id);
  assert.equal(bg.get(active.id).status, 'stopped', 'a long-running job is retained when it has only just finished');
  assert.equal(bg.list().length, FINISHED_LIMIT);
});

test('shutdown cancels UI updates and reminders and rejects new jobs', async t => {
  const { bg, published, messages } = harness(t, { escalateMs: 50 });
  const job = bg.start('sleep 30');
  bg.shutdown();
  const count = published.length;
  await settled(bg, job.id);
  await wait(100);
  assert.equal(published.length, count);
  assert.equal(messages.length, 0);
  assert.throws(() => bg.start('true'), /shut down/);
});

test('card snapshots reject stale fetches but accept an authoritative empty reset', () => {
  const first = backgroundSnapshot(null, { version: 1, jobs: [{ id: 'bg-01' }] }, 100);
  const done = backgroundSnapshot(first, { version: 3, jobs: [{ id: 'bg-01', status: 'exited' }] }, 300);
  assert.equal(backgroundSnapshot(done, { version: 2, jobs: [{ id: 'bg-01', status: 'running' }] }), done);
  assert.equal(backgroundSnapshot(done, { version: 3, jobs: [] }), done);
  assert.deepEqual(backgroundSnapshot(done, { version: 4, jobs: [] }, 400).jobs, []);
});

test('the card sorts every active job first and distinguishes failure from success', () => {
  const jobs = Array.from({ length: 8 }, (_, i) => ({ id: `bg-${i}`, status: 'running', startedAt: i }));
  jobs.unshift({ id: 'old', status: 'exited', startedAt: 99 });
  assert.deepEqual(sortedBackgroundJobs(jobs).map(j => j.id), ['bg-7', 'bg-6', 'bg-5', 'bg-4', 'bg-3', 'bg-2', 'bg-1', 'bg-0', 'old']);
  assert.equal(backgroundOutcome({ status: 'exited', exitCode: 0 }).kind, 'done');
  assert.deepEqual(backgroundOutcome({ status: 'exited', exitCode: 7 }), { kind: 'failed', label: 'Exit 7' });
  assert.equal(backgroundOutcome({ status: 'exited', exitCode: null, exitSignal: 'SIGTERM' }).kind, 'failed');
  assert.equal(backgroundOutcome({ status: 'failed' }).label, 'Failed to start');
});

test('elapsed time ignores host clock skew and freezes terminal durations', () => {
  const job = { status: 'running', startedAt: 999999999, elapsedMs: 4000 };
  assert.equal(backgroundElapsed(job, { receivedAt: 1000 }, 2500), 5500);
  assert.equal(backgroundElapsed(job, { receivedAt: 1000 }, 2500, false), 4000);
  assert.equal(backgroundElapsed({ ...job, status: 'exited' }, { receivedAt: 1000 }, 2500), 4000);
});

test('shutdown kills running jobs and silences further messages', async t => {
  const controller = new AbortController();
  const messages = [];
  const bg = createBackground({ notify: (m, o) => messages.push(m), isIdle: () => true, signal: controller.signal, escalateMs: 60000 });
  const job = bg.start('sleep 30', {});
  bg.shutdown();
  const t0 = Date.now();
  while (bg.get(job.id).status === 'running' && Date.now() - t0 < 5000) await wait(20);
  assert.notEqual(bg.get(job.id).status, 'running');
  controller.abort();
  assert.equal(messages.length, 0);
});
