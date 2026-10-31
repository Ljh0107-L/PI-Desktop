// Line diffs for the change review.
import { diffLines } from 'diff';

const splitLines = text => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

// One hunk → display lines, with unchanged lines trimmed to `context` around changes.
export function hunkLines({ oldText, newText }, context = 3) {
  if (oldText === null) return splitLines(newText).map(text => ({ type: 'add', text }));
  const lines = [];
  for (const part of diffLines(oldText, newText)) {
    const type = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const text of splitLines(part.value)) lines.push({ type, text });
  }
  const keep = lines.map((l, i) => l.type !== 'ctx' || lines.slice(Math.max(0, i - context), i + context + 1).some(x => x.type !== 'ctx'));
  const out = [];
  lines.forEach((l, i) => { if (keep[i]) out.push(l); else if (out.at(-1)?.type !== 'gap') out.push({ type: 'gap', text: '' }); });
  return out;
}

export function changeStats(change) {
  let added = 0, removed = 0;
  for (const h of change.hunks) for (const l of hunkLines(h, 0)) { if (l.type === 'add') added++; if (l.type === 'del') removed++; }
  return { added, removed };
}
