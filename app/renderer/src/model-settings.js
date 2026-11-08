// Shared editable model values. Show exact counts; K/M suffixes are accepted when explicitly entered.
export const parseTokens = text => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(text ?? ''));
  if (!m) return undefined;
  const value = Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1048576 : m[2].toLowerCase() === 'k' ? 1024 : 1);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
export const tokenField = n => n == null ? '' : String(n);
export const toRow = m => ({
  base: m, id: m.id, name: m.name && m.name !== m.id ? m.name : '',
  contextWindow: tokenField(m.contextWindow ?? 131072), maxTokens: tokenField(m.maxTokens ?? 16384),
  input: m.input ?? ['text'], reasoning: m.reasoning ?? true,
  levels: Object.entries(m.thinkingLevelMap ?? {}).map(([level, value]) => ({ level, value: value ?? '' })), open: false,
});
export const fromRow = r => {
  const { provider, type, ...base } = r.base ?? {};
  const map = Object.fromEntries(r.levels.filter(l => l.level).map(l => [l.level, l.value.trim() || null]));
  return { ...base, id: r.id.trim(), name: r.name.trim() || r.id.trim(), contextWindow: parseTokens(r.contextWindow) ?? 131072,
    maxTokens: parseTokens(r.maxTokens) ?? 16384, input: r.input.length ? r.input : ['text'], reasoning: r.reasoning,
    thinkingLevelMap: r.reasoning && Object.keys(map).length ? map : undefined };
};
export function pickedRows(models, available, picked) {
  const keep = models.filter(m => picked.has(m.id));
  const added = available.filter(m => picked.has(m.id) && !keep.some(k => k.id === m.id)).map(toRow);
  const order = new Map(available.map((m, i) => [m.id, i]));
  return [...keep, ...added].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}
