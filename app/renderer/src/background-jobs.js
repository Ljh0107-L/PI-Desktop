// Main-process versions order live events and slower IPC replies. Elapsed time comes from the
// host's duration plus local time since receipt, never a comparison of two machines' wall clocks.
export function backgroundSnapshot(current, incoming, now = Date.now()) {
  if (!incoming || !Number.isFinite(incoming.version) || !Array.isArray(incoming.jobs) ||
      (current && incoming.version <= current.version)) return current;
  return { version: incoming.version, receivedAt: incoming.at ?? now, jobs: incoming.jobs };
}
export function sortedBackgroundJobs(jobs = []) {
  return [...jobs].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}
export function backgroundOutcome(job) {
  if (job.status === 'running') return { label: job.stopping ? 'Stopping…' : 'Running', kind: 'running' };
  if (job.status === 'stopped') return { label: 'Stopped', kind: 'stopped' };
  if (job.status === 'failed') return { label: 'Failed to start', kind: 'failed' };
  if (job.exitCode === 0) return { label: 'Done', kind: 'done' };
  return { label: job.exitCode != null ? `Exit ${job.exitCode}` : `Signal ${job.exitSignal ?? 'unknown'}`, kind: 'failed' };
}
export function backgroundElapsed(job, snapshot, now, connected = true) {
  const extra = job.status === 'running' && connected ? Math.max(0, now - snapshot.receivedAt) : 0;
  return Math.max(0, (job.elapsedMs ?? 0) + extra);
}
