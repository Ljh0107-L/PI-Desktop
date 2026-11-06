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
export const subagentTaskStatus = task => task.failureKind === 'refused' ? 'Not started' : task.status === 'failed' && (task.failureKind === 'output_limit' || /ended without a complete answer \(length\)/i.test(task.error ?? '')) ? 'Output limit' : subagentStatus(task.status);

// Every saved or live state of each agent, newest kept: its later reports (pidesk-agent messages),
// subagent_message/subagent_stop results, and the live state its Pi publishes.
export function agentSnapshots(transcript, live = {}) {
  const latest = new Map();
  const offer = agent => {
    if (!agent?.id) return;
    const known = latest.get(agent.id);
    if (!known || (agent.updatedAt ?? 0) >= (known.updatedAt ?? 0)) latest.set(agent.id, agent);
  };
  for (const message of transcript?.messages ?? []) {
    if (message.role === 'custom' && message.customType === 'pidesk-agent') offer(message.details?.agent);
    if (message.role === 'toolResult' && ['subagent_message', 'subagent_stop'].includes(message.toolName)) offer(message.details?.agent);
  }
  for (const agent of Object.values(live ?? {})) offer(agent);
  return latest;
}

export function subagentBatch(call, tool, latest = null) {
  const details = tool?.result?.details;
  const recorded = details?.kind === 'pidesk-subagents' && Array.isArray(details.results) ? details.results : [];
  const planned = Array.isArray(call.arguments?.tasks) ? call.arguments.tasks : [];
  const tasks = (recorded.length ? recorded : planned).map((task, index) => {
    // An agent that carried on after this call returned (in the background) has newer state elsewhere.
    const newer = task.id && latest?.get(task.id);
    const current = newer && (newer.updatedAt ?? 0) >= (task.updatedAt ?? 0) ? { ...task, ...newer } : task;
    return {
      ...current, index, key: `${call.id}:${index}`,
      name: current.name || `Task ${index + 1}`,
      task: planned[index]?.task ?? current.task ?? '',
      status: recorded.length ? current.status : details?.refused ? 'cancelled' : tool?.status === 'error' ? 'failed' : 'pending',
      // The per-request limit refused this call: its agents never started.
      ...(details?.refused && !recorded.length ? { failureKind: 'refused', error: details.refused } : {}),
    };
  });
  return { callId: call.id, tasks, background: details?.background === true };
}

export function subagentBatches(transcript, live = {}) {
  if (!transcript) return [];
  const latest = agentSnapshots(transcript, live);
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
  return [...calls.values()].map(call => subagentBatch(call, finished.get(call.id) ?? transcript.tools?.[call.id], latest));
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
