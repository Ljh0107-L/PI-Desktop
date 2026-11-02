// Shared view model for the inline delegation card and the right-hand inspector.
export const isSubagentActive = task => ['pending', 'queued', 'running', 'retrying'].includes(task.status);
export const subagentStatus = status => ({ pending: 'Waiting for details', queued: 'Queued', running: 'Running', retrying: 'Retrying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out' })[status] ?? status;

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

export function subagentSummary(tasks) {
  if (!tasks.length) return 'Preparing tasks…';
  const counts = new Map();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${subagentStatus(status).toLowerCase()}`).join(' · ');
}
