// Pure draft transactions. Navigation does not change identity; consumption and recovery
// invalidate pending reads, while deletion (a missing lifetime) invalidates all callbacks.
let nextLifetime = 0;
export const createComposerDraft = (text = '') => ({
  text, attachments: [], recoveries: [], lifetime: ++nextLifetime, generation: 0, revision: 0,
});
export const draftReadToken = draft => ({ lifetime: draft.lifetime, generation: draft.generation });
export function updateComposerDraft(draft, field, update, token) {
  if (!draft || (token && (draft.lifetime !== token.lifetime || draft.generation !== token.generation))) return draft;
  return { ...draft, revision: draft.revision + 1, [field]: typeof update === 'function' ? update(draft[field]) : update };
}
const contents = draft => ({ text: draft.text, attachments: draft.attachments });
const hasContents = draft => !!(draft.text.trim() || draft.attachments.length);
export function takeComposerDraft(draft) {
  if (!draft || !hasContents(draft)) return null;
  const next = { ...draft, text: '', attachments: [], generation: draft.generation + 1, revision: draft.revision + 1 };
  return { next, receipt: { ...contents(draft), ...draftReadToken(next), revision: next.revision } };
}
export function restoreComposerDraft(draft, receipt) {
  if (!draft || draft.lifetime !== receipt.lifetime) return draft;
  // Restore the whole message only if the successor has not been touched. Otherwise
  // retain it as a separate recoverable message, never blend text and attachments.
  if (draft.generation === receipt.generation && draft.revision === receipt.revision) {
    return { ...draft, ...contents(receipt), generation: draft.generation + 1, revision: draft.revision + 1 };
  }
  return { ...draft, recoveries: [...draft.recoveries, contents(receipt)] };
}
export function recoverComposerDraft(draft) {
  if (!draft?.recoveries.length) return draft;
  const [recovered, ...remaining] = draft.recoveries;
  // Swapping preserves the current message too; subsequent clicks cycle messages.
  if (draft.text || draft.attachments.length) remaining.push(contents(draft));
  return { ...draft, ...recovered, recoveries: remaining, generation: draft.generation + 1, revision: draft.revision + 1 };
}
