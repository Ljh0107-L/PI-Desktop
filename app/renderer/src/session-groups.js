// Sidebar grouping is a presentation choice, not a session's execution directory.
// No-folder chats keep separate projectless workspaces but share one group per host.
export function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const noFolder = session.noFolder === true;
    // Include the group kind so a real project named "No folder" stays a project.
    const key = JSON.stringify(noFolder
      ? [session.environmentId, 'no-folder']
      : [session.environmentId, 'folder', session.cwd]);
    if (!groups.has(key)) groups.set(key, {
      key, noFolder, cwd: noFolder ? undefined : session.cwd,
      project: noFolder ? 'No folder' : session.project,
      env: session.environmentLabel, remote: session.environmentId !== 'local', items: [],
    });
    groups.get(key).items.push(session);
  }
  // Preserve the source order (newest conversations/groups first) and session identities.
  return [...groups.values()];
}
