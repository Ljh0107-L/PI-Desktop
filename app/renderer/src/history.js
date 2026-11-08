import { stripMessageSignatures } from '../../../core/history-view.mjs';

// Identity is independent of page position. Text is never used to identify a user message.
export const historyKey = message => `${message.role}:${message.timestamp ?? ''}:${message.toolCallId ?? ''}`;
export function mergeHistory(older, newer) {
  const out = [], ids = new Map(), fingerprints = new Map();
  for (const message of [...older, ...newer]) {
    const key = historyKey(message);
    let at = message.__entryId ? ids.get(message.__entryId) : fingerprints.get(key);
    if (at === undefined && message.__entryId) {
      const candidate = fingerprints.get(key);
      if (candidate !== undefined && !out[candidate].__entryId) at = candidate;
    }
    if (at === undefined) { at = out.length; out.push(message); }
    else {
      const previous = out[at];
      out[at] = { ...previous, ...message, ...(previous.__entryId && !message.__entryId ? { __entryId: previous.__entryId, __history: previous.__history } : {}) };
    }
    fingerprints.set(key, at);
    if (out[at].__entryId) ids.set(out[at].__entryId, at);
  }
  return out;
}

// A tail refresh updates locators and status, not the reader's already loaded window.
export function mergeReloadedHistory(page, current) {
  const messages = retainLoadedContent(page.messages, current.messages);
  const ids = new Set(current.messages.map(m => m.__entryId).filter(Boolean));
  const fingerprints = new Set(current.messages.filter(m => !m.__entryId).map(historyKey));
  const overlap = messages.some(m => ids.has(m.__entryId) || fingerprints.has(historyKey(m)));
  const keepWindow = current.history?.snapshot?.identity === page.snapshot?.identity && overlap && !current.rewinding;
  return {
    messages: keepWindow ? mergeHistory(current.messages, messages) : messages,
    history: { ...(keepWindow ? current.history : {}), snapshot: page.snapshot, next: keepWindow ? current.history.next : page.next,
      warning: page.warning ?? (keepWindow ? current.history.warning : null), loading: false },
  };
}

// Refresh locators/status without collapsing content already received live or explicitly loaded.
export function retainLoadedContent(page, current) {
  const byId = new Map(current.filter(m => m.__entryId).map(m => [m.__entryId, m]));
  const byFingerprint = new Map(current.map(m => [historyKey(m), m]));
  return page.map(message => {
    const previous = byId.get(message.__entryId) ?? byFingerprint.get(historyKey(message));
    if (!previous || previous.__optimistic || previous.__history?.truncated || (previous.__entryId && previous.__entryId !== message.__entryId)) return message;
    const { content } = stripMessageSignatures(previous);
    return { ...previous, content, __entryId: message.__entryId, __retryOmitted: message.__retryOmitted,
      __history: { ...message.__history, truncated: false } };
  });
}
