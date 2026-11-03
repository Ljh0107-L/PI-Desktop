// An existing session's engine is immutable. Missing engine metadata belongs to
// legacy Pi sessions; it must never inherit the unrelated new-conversation draft.
export function composerEngine(session, draft) {
  const source = session ?? draft;
  return source?.engine === 'cursor' ? 'cursor' : 'pi';
}
