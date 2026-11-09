// Background jobs: offload, status, stop, completion and escalation messages, shutdown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_LIMIT, createBackground } from '../agent/pidesk-background.mjs';

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

test('the card receives live state: start, ticks while running, completion with tail', async t => {
  const { bg, published } = harness(t);
  const job = bg.start('sh -c "sleep 1.2 && echo tick"', { description: 'soak' });
  assert.equal(published.length, 1);
  assert.equal(published[0].jobs[0].status, 'running');
  await wait(1500);
  assert.ok(published.length >= 2, 'the ticker refreshes the card while the job runs');
  const done = await settled(bg, job.id);
  assert.equal(done.status, 'exited');
  const last = published.at(-1);
  assert.equal(last.jobs[0].status, 'exited');
  assert.equal(last.jobs[0].exitCode, 0);
  assert.match(last.jobs[0].tail, /tick/);
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
  assert.equal(done.child.killed, true);
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
