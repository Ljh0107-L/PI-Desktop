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

// Refresh locators/status without collapsing content already received live or explicitly loaded.
export function retainLoadedContent(page, current) {
  const byId = new Map(current.filter(m => m.__entryId).map(m => [m.__entryId, m]));
  const byFingerprint = new Map(current.map(m => [historyKey(m), m]));
  return page.map(message => {
    const previous = byId.get(message.__entryId) ?? byFingerprint.get(historyKey(message));
    if (!previous || previous.__optimistic || previous.__history?.truncated || (previous.__entryId && previous.__entryId !== message.__entryId)) return message;
    const content = Array.isArray(previous.content) ? previous.content.map(block => {
      if (!block || typeof block !== 'object') return block;
      const { thinkingSignature, textSignature, thoughtSignature, ...visible } = block;
      return visible;
    }) : previous.content;
    return { ...previous, content, __entryId: message.__entryId, __retryOmitted: message.__retryOmitted,
      __history: { ...message.__history, truncated: false } };
  });
}
