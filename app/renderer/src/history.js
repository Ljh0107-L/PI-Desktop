import { stripMessageSignatures } from '../../../core/history-view.mjs';

let nextLiveKey = 0;
export const createLiveKey = () => `live:${++nextLiveKey}`;
const localKeys = new WeakMap();
export function historyKey(message) {
  if (message.__liveKey) return message.__liveKey;
  if (message.__entryId) return `entry:${message.__entryId}`;
  if (!localKeys.has(message)) localKeys.set(message, createLiveKey());
  return localKeys.get(message);
}

function retainContent(message, previous) {
  if (!previous || previous.__optimistic) return message;
  const full = message.__history?.truncated && !previous.__history?.truncated;
  return { ...(full ? stripMessageSignatures(previous) : message),
    __entryId: message.__entryId, __retryOmitted: message.__retryOmitted,
    __liveKey: previous.__liveKey ?? message.__liveKey ?? (!previous.__entryId ? historyKey(previous) : undefined),
    __timing: message.__timing ?? previous.__timing,
    __history: full ? { ref: message.__history.ref, truncated: false } : message.__history };
}

// Earlier pages are read from a frozen cursor. Only source entry IDs can overlap;
// matching by timestamp or text here can eat a distinct message on either side.
export function mergeHistory(older, newer) {
  const out = [], ids = new Map();
  for (const message of [...older, ...newer]) {
    const at = message.__entryId ? ids.get(message.__entryId) : undefined;
    if (at !== undefined) out[at] = retainContent(message, out[at]);
    else {
      if (message.__entryId) ids.set(message.__entryId, out.length);
      out.push(message);
    }
  }
  return out;
}

// A timestamp narrows the candidates; it is not a message ID.
const bucketOf = m => JSON.stringify([m.role, m.timestamp, m.toolCallId, m.customType]);
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
const sameResponse = (a, b) => a.responseId && a.responseId === b.responseId && a.provider === b.provider && a.model === b.model && a.api === b.api;
const sourceTiming = t => ['agent', 'relay'].includes(t?.source) && t.complete && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start;
const payload = message => Object.fromEntries(Object.entries(stripMessageSignatures(message))
  .filter(([key]) => !key.startsWith('__') && !(message.role === 'custom' && key === 'display')));
function sameCompletedMessage(a, b) {
  if (a.__entryId && b.__entryId) return a.__entryId === b.__entryId;
  if (a.__optimistic || b.__optimistic || a.timestamp == null || bucketOf(a) !== bucketOf(b)) return false;
  if (a.responseId && b.responseId && !sameResponse(a, b)) return false;
  const bothTimed = sourceTiming(a.__timing) && sourceTiming(b.__timing);
  if (bothTimed && !sameValue(a.__timing, b.__timing)) return false;
  if (a.__history?.truncated || b.__history?.truncated) {
    // A clipped preview can match several different full replies. Do not infer
    // that any of them owns its locator without stronger source evidence.
    return sameResponse(a, b) || bothTimed || (a.role === 'toolResult' && !!a.toolCallId);
  }
  return sameValue(payload(a), payload(b));
}

function matchHistory(page, current) {
  const ids = new Map(), buckets = new Map(), used = new Set(), matches = new Map();
  current.forEach((message, i) => {
    if (message.__entryId) ids.set(message.__entryId, i);
    if (message.__optimistic) return;
    const key = bucketOf(message);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const match = (p, i) => { if (i !== undefined && !used.has(i)) { used.add(i); matches.set(p, i); } };
  // Reserve persisted entries first so an identical new live event cannot consume
  // a row we already know about. Pair other occurrences at most once, in order.
  page.forEach((message, p) => { if (message.__entryId) match(p, ids.get(message.__entryId)); });
  page.forEach((message, p) => {
    if (!matches.has(p)) match(p, buckets.get(bucketOf(message))?.find(i => !used.has(i) && sameCompletedMessage(message, current[i])));
  });
  return { matches, used };
}

// Even a unique timestamp match is not enough to dismiss a reply that's streaming.
function liveCompletion(page, current, matches) {
  const live = current.live;
  if (!live || live.timestamp == null) return -1;
  const candidates = page.map((m, i) => ({ m, i })).filter(({ m, i }) => !matches.has(i) && bucketOf(m) === bucketOf(live));
  const exact = candidates.find(({ m }) => (live.__entryId && m.__entryId === live.__entryId) || sameResponse(live, m));
  if (exact) return exact.i;
  if (candidates.length !== 1 || current.messages.some(m => bucketOf(m) === bucketOf(live))) return -1;
  const { m, i } = candidates[0];
  const prose = block => block?.type === 'text' ? block.text : block?.type === 'thinking' ? block.thinking : null;
  const blocks = live.content;
  return Array.isArray(m.content) && Array.isArray(blocks) && blocks.some(prose) && blocks.every((block, bi) => {
    const text = prose(block), saved = m.content[bi];
    return !block || (block.type === saved?.type && (text != null ? prose(saved)?.startsWith(text) : block.id && block.id === saved.id));
  }) ? i : -1;
}

// A tail refresh updates locators/status without resetting the reader's loaded window.
export function mergeReloadedHistory(page, current, initialKeys = null) {
  const { matches, used } = matchHistory(page.messages, current.messages);
  const completed = liveCompletion(page.messages, current, matches);
  const messages = page.messages.map((message, p) => p === completed ? { ...message, __liveKey: historyKey(current.live) }
    : retainContent(message, current.messages[matches.get(p)]));
  const snapshotId = current.history?.snapshot?.identity;
  const sameFile = snapshotId != null && snapshotId === page.snapshot?.identity;
  const keepWindow = sameFile && matches.size > 0 && !current.rewinding;
  const start = keepWindow && page.next ? matches.get(0) ?? 0 : 0;
  const older = current.messages.slice(0, start).filter((m, i) => !used.has(i) && !m.__optimistic);
  const end = matches.get(page.messages.length - 1);
  const keepSuffix = !current.rewinding && (sameFile || snapshotId == null) && end !== undefined;
  const later = current.messages.filter((message, i) => i >= start && !used.has(i) && (
    (initialKeys && !initialKeys.has(historyKey(message))) ||
    // Live events can precede their disk writes, including events received just
    // before the reload began. Keep an unconfirmed live suffix on the same file.
    (keepSuffix && i > end && message.__liveKey && !message.__entryId && !message.__optimistic)
  ));
  return {
    messages: mergeHistory([...older, ...messages], later),
    live: completed < 0 ? current.live : null,
    completedLiveKey: completed < 0 ? current.completedLiveKey : historyKey(current.live),
    history: { ...(keepWindow ? current.history : {}), snapshot: page.snapshot, next: keepWindow ? current.history.next : page.next,
      warning: page.warning ?? (keepWindow ? current.history.warning : null), loading: false },
  };
}

// The final live event may arrive just after a snapshot finished its streaming row.
export function finishSnapshotReply(messages, key, message) {
  const index = key ? messages.findIndex(m => m.__liveKey === key && sameCompletedMessage(m, message)) : -1;
  if (index < 0) return null;
  return messages.map((m, i) => i === index ? retainContent(m, { ...message, __liveKey: key }) : m);
}

export function retainLoadedContent(page, current) {
  const { matches } = matchHistory(page, current);
  return page.map((message, p) => retainContent(message, current[matches.get(p)]));
}
