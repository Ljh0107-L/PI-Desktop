// Read-only UI history projection. Never changes Pi's transcript or model context.
// Runs beside the session file, locally or over SSH; only bounded pages cross the transport.
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PAGE_MESSAGES = 80;
export const PAGE_BYTES = 256 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const signatures = new Set(['thinkingSignature', 'textSignature', 'thoughtSignature']);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function clean(value, preview, state, depth = 0) {
  if (typeof value === 'string') {
    const limit = preview ? Math.min(2048, state.left) : value.length;
    state.left -= Math.min(limit, value.length);
    if (value.length > limit) { state.clipped = true; return value.slice(0, limit) + '…'; }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (preview && (depth > 10 || ++state.nodes > 512)) { state.clipped = true; state.structural = true; return null; }
  if (Array.isArray(value)) {
    if (preview && value.length > 32) state.clipped = true;
    return (preview ? value.slice(0, 32) : value).map(v => clean(v, preview, state, depth + 1));
  }
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (signatures.has(key) && ['thinking', 'text', 'toolCall'].includes(value.type)) continue;
    if (preview && key === 'data' && value.type === 'image') { state.clipped = true; continue; }
    if (preview && key === 'steps') { if (v?.length) state.clipped = true; continue; }
    out[key] = typeof v === 'string' && ['id', 'type', 'name', 'path', 'file_path', 'toolCallId', 'toolName', 'customType'].includes(key)
      ? v : clean(v, preview, state, depth + 1);
  }
  return out;
}

export function projectEntry(entry, ref, { preview = true, omitted = false } = {}) {
  let message;
  if (entry.type === 'message' && entry.message?.role !== 'system') message = entry.message;
  else if (entry.type === 'custom_message' && entry.display !== false) message = { role: 'custom', customType: entry.customType, content: entry.content, details: entry.details, timestamp: Date.parse(entry.timestamp) || 0 };
  else if (entry.type === 'custom_message' && entry.customType === 'pidesk-goal') message = { role: 'custom', customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp) || 0 };
  else if (entry.type === 'compaction') message = { role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: Date.parse(entry.timestamp) || 0 };
  if (!message) return null;
  const state = { left: 6000, nodes: 0, clipped: false };
  let out = clean(message, preview, state);
  if (preview && (state.structural || bytes(out) > 32 * 1024)) {
    state.clipped = true;
    out = { role: message.role, timestamp: message.timestamp, stopReason: message.stopReason, toolName: message.toolName, toolCallId: message.toolCallId,
      content: [{ type: 'text', text: 'Large history entry. Load its full content to inspect it.' }] };
  }
  // Usage/timing are compact metadata, not excerpts; never calculate costs from truncated fields.
  for (const key of ['usage', '__timing', '__speed', '__usageProvenance']) if (message[key] && bytes(message[key]) < 8192) out[key] = message[key];
  return { ...out, __entryId: entry.id, ...(omitted && message.stopReason === 'error' ? { __retryOmitted: true } : {}),
    __history: { ref, truncated: state.clipped } };
}

// LF only: Unicode line separators inside JSON strings are not record boundaries.
async function* reverseLines(handle, end, stats) {
  let pos = end, fragments = [], length = 0, lineEnd = end;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK), buffer = Buffer.alloc(pos - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    stats.scannedBytes += bytesRead;
    if (bytesRead !== buffer.length) throw new Error('History changed while reading; reload the conversation.');
    let right = buffer.length;
    for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i] === 10) {
      const part = buffer.subarray(i + 1, right);
      length += part.length;
      if (length > MAX_LINE) throw new Error('A history entry exceeds the 64 MB read limit. The original file was not changed.');
      const line = Buffer.concat([part, ...fragments.slice().reverse()], length);
      const offset = start + i + 1;
      if (line.length) yield { line, offset, length: lineEnd - offset };
      fragments = []; length = 0; lineEnd = start + i; right = i;
    }
    if (right) { fragments.push(buffer.subarray(0, right)); length += right; }
    if (length > MAX_LINE) throw new Error('A history entry exceeds the 64 MB read limit. The original file was not changed.');
    pos = start;
  }
  if (length) yield { line: Buffer.concat(fragments.reverse(), length), offset: 0, length: lineEnd };
}

const identity = stat => `${stat.dev}:${stat.ino}`;
function validate(snapshot, stat) {
  if (!snapshot || snapshot.identity !== identity(stat) || !Number.isSafeInteger(snapshot.end) || snapshot.end < 0 || snapshot.end > stat.size)
    throw new Error('History changed; reload the conversation.');
}

export async function readHistory(file, options = {}) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('History is not a regular file.');
    const cursor = options.cursor;
    const snapshot = cursor?.snapshot ?? options.ref?.snapshot ?? { identity: identity(stat), end: stat.size };
    validate(snapshot, stat);
    if (options.ref) {
      const { offset, length, id } = options.ref;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > MAX_LINE || offset + length > snapshot.end) throw new Error('Invalid history entry reference.');
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('History changed; reload the conversation.');
      let entry;
      try { entry = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('History entry is unreadable. The original file was not changed.'); }
      if (entry.id !== id) throw new Error('History changed; reload the conversation.');
      return projectEntry(entry, options.ref, { preview: false });
    }
    if (cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > snapshot.end || typeof cursor.id !== 'string')) throw new Error('Invalid history cursor.');
    let target = cursor?.id ?? null, remaining = cursor?.offset ?? snapshot.end;
    const messages = [], omitted = new Map(cursor?.omitted ?? []);
    let total = 0, next = null, warning = null, first = true;
    const stats = { scannedBytes: 0 };
    for await (const row of reverseLines(handle, remaining, stats)) {
      let entry;
      try { entry = JSON.parse(row.line.toString('utf8')); } catch {
        if (row.offset + row.length !== snapshot.end) warning = 'Some history records could not be read. The original file was not changed.';
        continue;
      }
      if (!entry?.id || entry.type === 'session') continue;
      if (first && !cursor) target = entry.id;
      first = false;
      if (entry.id !== target) continue;
      if (entry.type === 'context_edit' && !omitted.has(entry.targetId)) omitted.set(entry.targetId, entry.replacement === null);
      const ref = { snapshot, offset: row.offset, length: row.length, id: entry.id };
      const message = projectEntry(entry, ref, { omitted: omitted.get(entry.id) });
      const cost = message ? bytes(message) : 0;
      if (message && messages.length && (messages.length >= PAGE_MESSAGES || total + cost > PAGE_BYTES)) {
        next = { snapshot, offset: row.offset + row.length, id: entry.id, omitted: [...omitted] };
        break;
      }
      if (message) { messages.push(message); total += cost; }
      target = entry.parentId;
      remaining = row.offset;
      if (!target) break;
      if (message?.role === 'user' && messages.length >= 40) {
        next = { snapshot, offset: row.offset, id: target, omitted: [...omitted] };
        break;
      }
    }
    if (!next && target) warning = 'This history has a missing parent. Earlier entries on this branch cannot be reconstructed.';
    return { messages: messages.reverse(), next, warning, snapshot, ...stats };
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await readHistory(process.argv[2], JSON.parse(process.argv[3] ?? '{}'))) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
