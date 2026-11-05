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
  n: tokensOf(m.usage), i: m.usage.input ?? 0, o: m.usage.output ?? 0, cr: m.usage.cacheRead ?? 0, cw: m.usage.cacheWrite ?? 0, c: m.usage.cost?.total ?? 0, calls: m.__calls ?? 1,
});
const isReply = m => m?.role === 'assistant' && m.usage && tokensOf(m.usage) > 0;
// Agent runs, each recorded once by whichever message reports it: the subagent call that waited for
// it, a reply to subagent_message, or the agent's report message (pidesk-agent:<id>:<run>).
const agentRuns = runs => runs.filter(r => r?.key && r.usage && tokensOf(r.usage) > 0).map(r => ({
  role: 'assistant', responseId: r.key, timestamp: r.at, provider: r.provider, model: r.model, usage: r.usage, __calls: r.turns,
}));
const usageMessages = message => {
  if (isReply(message)) return [message];
  if (Array.isArray(message?.details?.agentRuns)) return agentRuns(message.details.agentRuns);
  // Results from before agents could continue: one record per agent.
  if (message?.role !== 'toolResult' || message.toolName !== 'subagent' || message.details?.kind !== 'pidesk-subagents') return [];
  return (message.details.results ?? []).filter(r => r.id && r.usage && tokensOf(r.usage) > 0 && !['queued', 'running', 'retrying'].includes(r.status)).map(r => ({
    role: 'assistant', responseId: `pidesk-subagent:${r.id}`, timestamp: r.startedAt,
    provider: r.provider, model: r.model, usage: r.usage, __calls: r.turns,
  }));
};
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
    for (const reply of usageMessages(message)) {
      this.#ledger();
      const entry = entryOf(reply);
      if (this.seen.has(entry.k)) continue; // replayed after a reconnect
      this.seen.add(entry.k);
      this.entries.push(entry);
      try { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(entry) + '\n'); } catch { /* best effort */ }
    }
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
          if (!line.includes('"usage"')) continue;
          try {
            const record = JSON.parse(line);
            if (record.type === 'message') entries.push(...usageMessages(record.message).map(entryOf));
            else if (record.type === 'custom_message') entries.push(...usageMessages({ role: 'custom', details: record.details }).map(entryOf));
          } catch { /* torn line */ }
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
      totals.tokens += e.n; totals.input += e.i; totals.output += e.o; totals.cacheRead += e.cr; totals.cacheWrite += e.cw; totals.cost += e.c; totals.calls += e.calls ?? 1;
      first = first == null ? e.t : Math.min(first, e.t);
      const day = dayOf(e.t);
      days.set(day, (days.get(day) ?? 0) + e.n);
      const id = `${e.p}\n${e.m}`;
      const model = models.get(id) ?? { provider: e.p, model: e.m, tokens: 0, output: 0, cost: 0, calls: 0 };
      model.tokens += e.n; model.output += e.o; model.cost += e.c; model.calls += e.calls ?? 1;
      models.set(id, model);
    }
    return {
      totals, firstAt: first, today: dayOf(Date.now()),
      days: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b))),
      models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }
}
