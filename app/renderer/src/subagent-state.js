// Shared view model for the inline delegation card and the right-hand inspector.
export const isSubagentActive = task => ['pending', 'queued', 'running', 'retrying'].includes(task.status);
export const isSubagentFinished = task => ['completed', 'failed', 'cancelled', 'timed_out'].includes(task.status);
export const subagentHistoryId = task => task.id ? `child:${task.id}` : `task:${task.key}`;
export const visibleSubagentTasks = (tasks, clearedIds = []) => {
  const cleared = new Set(clearedIds);
  // Never hide active or unknown state, even if stale/corrupt presentation metadata mentions it.
  return tasks.filter(task => !isSubagentFinished(task) || !cleared.has(subagentHistoryId(task)));
};
export const visibleSubagentBatches = (batches, clearedIds = []) => batches.map(batch => ({ ...batch, tasks: visibleSubagentTasks(batch.tasks, clearedIds) }))
  .filter(batch => batch.tasks.length > 0);
export const subagentStatus = status => ({ pending: 'Waiting for details', queued: 'Queued', running: 'Running', retrying: 'Retrying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out' })[status] ?? status;
export const subagentTaskStatus = task => task.status === 'failed' && (task.failureKind === 'output_limit' || /ended without a complete answer \(length\)/i.test(task.error ?? '')) ? 'Output limit' : subagentStatus(task.status);

export function subagentBatch(call, tool) {
  const details = tool?.result?.details;
  const recorded = details?.kind === 'pidesk-subagents' && Array.isArray(details.results) ? details.results : [];
  const planned = Array.isArray(call.arguments?.tasks) ? call.arguments.tasks : [];
  const tasks = (recorded.length ? recorded : planned).map((task, index) => ({
    ...task, index, key: `${call.id}:${index}`,
    name: task.name || `Task ${index + 1}`,
    task: planned[index]?.task ?? task.task ?? '',
    status: recorded.length ? task.status : tool?.status === 'error' ? 'failed' : 'pending',
  }));
  return { callId: call.id, tasks };
}

export function subagentBatches(transcript) {
  if (!transcript) return [];
  const calls = new Map(), finished = new Map();
  for (const message of [...transcript.messages, ...(transcript.live ? [transcript.live] : [])]) {
    if (message.role === 'assistant') for (const call of message.content ?? []) {
      if (call?.type === 'toolCall' && call.name === 'subagent' && call.id) calls.set(call.id, call);
    }
    if (message.role === 'toolResult' && message.toolName === 'subagent') {
      finished.set(message.toolCallId, { status: message.isError ? 'error' : 'done', result: { details: message.details } });
      if (!calls.has(message.toolCallId)) calls.set(message.toolCallId, { id: message.toolCallId, arguments: {} });
    }
  }
  return [...calls.values()].map(call => subagentBatch(call, finished.get(call.id) ?? transcript.tools?.[call.id]));
}

export function subagentElapsed(task, now = Date.now()) {
  const start = task.runStartedAt ?? task.startedAt;
  const end = task.finishedAt ?? (isSubagentActive(task) ? now : null);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function subagentSummary(tasks) {
  if (!tasks.length) return 'Preparing tasks…';
  const counts = new Map();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${subagentStatus(status).toLowerCase()}`).join(' · ');
}
