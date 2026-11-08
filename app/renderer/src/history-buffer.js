// Background pages are kept outside React state. Reading them must not move the
// viewport, change the composer, or expose a loading state until actually needed.
export class HistoryBuffer {
  constructor(read, prepare = async page => page) {
    this.read = read;
    this.prepare = prepare;
    this.entries = new Map();
    this.generation = 0;
  }
  key(cursor) { return JSON.stringify(cursor); }
  peek(cursor) { return this.entries.get(this.key(cursor))?.page; }
  get(cursor) {
    const key = this.key(cursor);
    const existing = this.entries.get(key);
    if (existing) return existing.pending;
    const generation = this.generation, entry = {};
    entry.pending = Promise.resolve().then(() => this.read(cursor)).then(page => this.generation === generation ? this.prepare(page) : page).then(page => {
      if (this.generation === generation) entry.page = page;
      return page;
    }).catch(error => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; });
    this.entries.set(key, entry);
    return entry.pending;
  }
  consume(cursor) { this.entries.delete(this.key(cursor)); }
  clear() { this.generation++; this.entries.clear(); }
  async prefetch(cursor, active = () => true) {
    const generation = this.generation;
    try {
      for (let n = 0; n < 2 && cursor && active() && generation === this.generation; n++) {
        const page = await this.get(cursor);
        cursor = page.next;
      }
    } catch { /* A speculative failure is retried if the reader actually needs that page. */ }
  }
}

// Warm unusually long prose near the next boundary, not large hidden tool results
// or image attachments. Bound both the count and the source bytes read speculatively.
export async function prepareHistoryPage(page, readEntry) {
  let budget = 1024 * 1024;
  const jobs = [];
  for (let i = page.messages.length - 1; i >= 0 && jobs.length < 8; i--) {
    const message = page.messages[i], history = message.__history;
    if (!['user', 'assistant'].includes(message.role) || !history?.truncated || !history.ref || history.ref.length > budget) continue;
    const content = message.content;
    const prose = typeof content === 'string' || (content ?? []).some((block, index) => block?.type === 'text' && (!history.deferredContent || history.deferredContent.includes(index)));
    if (!prose) continue;
    budget -= history.ref.length;
    jobs.push({ index: i, message, ref: history.ref });
  }
  const messages = page.messages.slice();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const full = await readEntry(job.ref);
        if (full?.__entryId === job.message.__entryId) messages[job.index] = { ...full, __retryOmitted: job.message.__retryOmitted };
      } catch { /* Visible content can retry through the normal detail loader. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
  return { ...page, messages };
}
