// Token usage across every conversation (Settings → Usage).
//
// Two sources, merged and de-duplicated by model response:
//  - Pi's session files on this Mac (history from before the ledger existed, local sessions only);
//  - a ledger of every reply the desktop saw finish, local or on an SSH host (usage.jsonl in userData).
// Forked conversations copy their history; de-duplication keeps those replies from counting twice.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const tokensOf = u => u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
const keyOf = m => m.responseId ? `r:${m.responseId}` : `t:${m.timestamp}|${m.provider}|${m.model}|${m.usage?.output ?? 0}`;
// Compact record kept per reply.
const entryOf = m => ({
  k: keyOf(m), t: Number(m.timestamp) || Date.now(), p: m.provider ?? '', m: m.model ?? '',
  n: tokensOf(m.usage), i: m.usage.input ?? 0, o: m.usage.output ?? 0, cr: m.usage.cacheRead ?? 0, cw: m.usage.cacheWrite ?? 0, c: m.usage.cost?.total ?? 0,
});
const isReply = m => m?.role === 'assistant' && m.usage && tokensOf(m.usage) > 0;
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class UsageLedger {
  files = new Map(); // session file -> { mtimeMs, size, entries }

  constructor({ path, sessionsDir }) {
    this.path = path;
    this.sessionsDir = sessionsDir;
    this.seen = null; // keys already in the ledger (loaded lazily)
  }

  #ledger() {
    if (this.seen) return this.entries;
    this.entries = [];
    this.seen = new Set();
    let text = '';
    try { text = readFileSync(this.path, 'utf8'); } catch { /* no ledger yet */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (!this.seen.has(e.k)) { this.seen.add(e.k); this.entries.push(e); } } catch { /* torn line */ }
    }
    return this.entries;
  }

  // A reply finished streaming (any session, any machine).
  record(message) {
    if (!isReply(message)) return;
    this.#ledger();
    const entry = entryOf(message);
    if (this.seen.has(entry.k)) return; // replayed after a reconnect
    this.seen.add(entry.k);
    this.entries.push(entry);
    try { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(entry) + '\n'); } catch { /* best effort */ }
  }

  async #sessionFiles(dir = this.sessionsDir, out = []) {
    let items = [];
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await this.#sessionFiles(path, out);
      else if (item.name.endsWith('.jsonl')) out.push(path);
    }
    return out;
  }

  // Replies recorded in Pi's session files, re-read only when a file changed.
  async #scan() {
    const paths = await this.#sessionFiles();
    const live = new Set(paths);
    for (const path of this.files.keys()) if (!live.has(path)) this.files.delete(path);
    for (const path of paths) {
      try {
        const { mtimeMs, size } = await stat(path);
        const cached = this.files.get(path);
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;
        const entries = [];
        for (const line of (await readFile(path, 'utf8')).split('\n')) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
          try { const record = JSON.parse(line); if (record.type === 'message' && isReply(record.message)) entries.push(entryOf(record.message)); } catch { /* torn line */ }
        }
        this.files.set(path, { mtimeMs, size, entries });
      } catch { /* unreadable file */ }
    }
    return [...this.files.values()].flatMap(f => f.entries);
  }

  async summary() {
    const all = new Map();
    for (const e of [...await this.#scan(), ...this.#ledger()]) if (!all.has(e.k)) all.set(e.k, e);
    const days = new Map(), models = new Map();
    const totals = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
    let first = null;
    for (const e of all.values()) {
      totals.tokens += e.n; totals.input += e.i; totals.output += e.o; totals.cacheRead += e.cr; totals.cacheWrite += e.cw; totals.cost += e.c; totals.calls += 1;
      first = first == null ? e.t : Math.min(first, e.t);
      const day = dayOf(e.t);
      days.set(day, (days.get(day) ?? 0) + e.n);
      const id = `${e.p}\n${e.m}`;
      const model = models.get(id) ?? { provider: e.p, model: e.m, tokens: 0, output: 0, cost: 0, calls: 0 };
      model.tokens += e.n; model.output += e.o; model.cost += e.c; model.calls += 1;
      models.set(id, model);
    }
    return {
      totals, firstAt: first, today: dayOf(Date.now()),
      days: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b))),
      models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }
}
