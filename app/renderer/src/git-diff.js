// Parse Git's unified patch without treating file headers as additions/deletions.
export function gitDiffLines(patch) {
  let oldLine = 0, newLine = 0, inHunk = false;
  return String(patch ?? '').split('\n').flatMap((text, index, all) => {
    if (index === all.length - 1 && !text) return [];
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; return [{ type: 'hunk', text }]; }
    if (text.startsWith('diff --git ') || text.startsWith('@@@')) inHunk = false;
    if (inHunk && text.startsWith('+')) return [{ type: 'add', text: text.slice(1), newLine: newLine++ }];
    if (inHunk && text.startsWith('-')) return [{ type: 'del', text: text.slice(1), oldLine: oldLine++ }];
    if (inHunk && text.startsWith(' ')) return [{ type: 'ctx', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ }];
    return [{ type: 'meta', text }];
  });
}
export function reviewComment(file, row, comment) {
  const side = row.newLine != null ? 'new' : 'old';
  const line = row.newLine ?? row.oldLine;
  return `Review ${file.group} change in ${JSON.stringify(file.path)}, ${side} line ${line}:\n> ${row.text}\n\n${comment.trim()}`;
}
