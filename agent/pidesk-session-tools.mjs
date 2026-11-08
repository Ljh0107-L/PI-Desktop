// Pi 1.4 restores tools from ordinary system entries only. A missing parent can hide the
// original declarations even though a later compaction still has the complete loadout.
// Repair the live loadout through the public extension API; never rewrite a damaged transcript.
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell']);
const RECOVERY = 'pidesk-tool-recovery';
const COMMAND = 'pidesk-recover-tools';
const namesOf = tools => Array.isArray(tools) ? tools.filter(tool => typeof tool?.name === 'string').map(tool => tool.name) : [];
const validTools = tools => Array.isArray(tools) && tools.every(tool => tool && typeof tool.name === 'string' && tool.name.length > 0);
const explicitTools = argv => argv.some(arg => /^(?:--tools|--no-tools|--exclude-tools)(?:=|$)/.test(arg));

export function toolCheckpoint(branch) {
  const at = branch.findLastIndex(entry => entry.type === 'compaction' && entry.systemMessage?.role === 'system' && validTools(entry.systemMessage.toolsAdded));
  if (at < 0) return null;
  const checkpoint = branch[at], initial = namesOf(checkpoint.systemMessage.toolsAdded);
  const tools = new Set(initial), mentioned = new Set(initial);
  for (const entry of branch) {
    const message = entry.type === 'compaction' ? entry.systemMessage : entry.type === 'message' ? entry.message : null;
    if (message?.role === 'system') for (const name of [...namesOf(message.toolsAdded), ...namesOf(message.toolsRemoved)]) mentioned.add(name);
  }
  for (const entry of branch.slice(at + 1)) {
    if (entry.type === 'message' && entry.message?.role === 'system') {
      for (const name of namesOf(entry.message.toolsRemoved)) tools.delete(name);
      for (const name of namesOf(entry.message.toolsAdded)) tools.add(name);
    } else if (entry.type === 'custom' && entry.customType === RECOVERY && entry.data?.checkpointId === checkpoint.id && Array.isArray(entry.data.tools)) {
      // A confirmed repair must survive a restart before the next model request records its delta.
      for (const name of entry.data.tools) if (initial.includes(name) && BASE_TOOLS.has(name)) tools.add(name);
    }
  }
  return { id: checkpoint.id, initial, tools: [...tools], mentioned };
}

export function restoredToolNames(checkpoint, active, registered) {
  const available = new Set(registered.filter(tool => tool.exposure !== 'hidden').map(tool => tool.name));
  return [...new Set([
    ...checkpoint.tools,
    // Keep newly registered extension tools, not defaults absent from the checkpoint.
    ...active.filter(name => !checkpoint.mentioned.has(name) && !BASE_TOOLS.has(name)),
  ])].filter(name => available.has(name));
}

function backupSession(file) {
  const backup = `${file}.tools-backup-${randomUUID()}`;
  const fd = openSync(backup, 'wx', 0o600);
  try { writeFileSync(fd, readFileSync(file)); fsyncSync(fd); }
  finally { closeSync(fd); }
  return backup;
}

export function registerSessionTools(pi, { argv = process.argv.slice(2), agentsRunning = () => false } = {}) {
  let issue = null;
  const constrained = explicitTools(argv);
  const notify = (ctx, message, level = 'warning') => ctx.ui?.notify?.(message, level);
  const inspect = ctx => {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const missing = branch[0]?.parentId;
    issue = null;
    if (!missing) return;
    const checkpoint = toolCheckpoint(branch);
    issue = { missing, checkpoint, blocked: !checkpoint };
    if (!checkpoint) {
      notify(ctx, 'Session history has a missing parent and no complete tool checkpoint. Model requests are stopped; restore a session backup or start a new conversation.', 'error');
      return;
    }
    if (!constrained) {
      const active = pi.getActiveTools();
      const restored = restoredToolNames(checkpoint, active, pi.getAllTools());
      if (restored.length !== active.length || restored.some((name, i) => name !== active[i])) pi.setActiveTools(restored);
    }
    notify(ctx, `Session history has a missing parent. ${constrained ? 'Explicit tool selection was left unchanged.' : 'Tools were restored from the latest complete checkpoint and subsequent changes.'} Missing history was not repaired. If an older version already removed the coding tools, use /${COMMAND} to review a backed-up recovery.`);
  };
  pi.on('session_start', (_event, ctx) => inspect(ctx));
  pi.on('session_tree', (_event, ctx) => inspect(ctx));
  pi.on('before_agent_start', (event, ctx) => {
    if (!issue) return;
    if (event.systemPromptOptions) (event.systemPromptOptions.sections ??= {}).session_integrity =
      'This session has an incomplete history chain. Do not treat missing history as verified work. Tool declarations reflect the current executable tools; a historical claim of missing tools is not evidence of the current tool state.';
    if (issue.blocked) {
      notify(ctx, 'Cannot continue: incomplete session history has no complete tool checkpoint. Restore a backup or start a new conversation.', 'error');
      ctx.abort();
    }
  });

  pi.registerCommand?.(COMMAND, {
    description: 'Recover coding tools from a damaged session checkpoint, with confirmation and a private backup',
    handler: async (_args, ctx) => {
      const idle = () => ctx.isIdle() && !agentsRunning();
      if (!idle()) { notify(ctx, 'Wait for the session and its subagents to stop before recovering tools.', 'error'); return; }
      if (constrained) { notify(ctx, 'Explicit tool selection is active. Recovery will not override it.', 'error'); return; }
      const branch = ctx.sessionManager.getBranch();
      const checkpoint = toolCheckpoint(branch);
      if (!branch[0]?.parentId || !checkpoint) { notify(ctx, 'No damaged history with a complete tool checkpoint was found. Nothing changed.'); return; }
      const available = new Set(pi.getAllTools().filter(tool => tool.exposure !== 'hidden').map(tool => tool.name));
      const active = pi.getActiveTools();
      const tools = checkpoint.initial.filter(name => BASE_TOOLS.has(name) && available.has(name) && !active.includes(name));
      if (!tools.length) { notify(ctx, 'The checkpoint has no missing, registered coding tools to recover. Nothing changed.', 'info'); return; }
      const file = ctx.sessionManager.getSessionFile();
      if (!file || !ctx.hasUI) { notify(ctx, 'Recovery requires a saved session and an interactive confirmation. Nothing changed.', 'error'); return; }
      const leaf = branch.at(-1)?.id;
      const confirmed = await ctx.ui.confirm('Recover session tools?', `Restore ${tools.join(', ')} from the last complete checkpoint? This explicitly re-enables these tools even if a later entry disabled them. A private backup will be saved beside the session file. Missing history will not be repaired.`);
      if (!confirmed) return;
      if (!idle() || ctx.sessionManager.getSessionFile() !== file || ctx.sessionManager.getBranch().at(-1)?.id !== leaf ||
          JSON.stringify(pi.getActiveTools()) !== JSON.stringify(active)) {
        notify(ctx, 'The session changed while confirmation was open. Nothing changed; run recovery again.', 'error'); return;
      }
      try {
        const backup = backupSession(file);
        // Persist intent before changing live tools. The next request writes Pi's normal system delta.
        pi.appendEntry(RECOVERY, { checkpointId: checkpoint.id, tools, backup });
        pi.setActiveTools([...active, ...tools]);
        notify(ctx, `Recovered ${tools.join(', ')}. Session backup: ${backup}. Missing history was not repaired.`, 'info');
      } catch {
        notify(ctx, 'Tool recovery could not be completed. Check session file access before retrying; the original history was not overwritten.', 'error');
      }
    },
  });
}
