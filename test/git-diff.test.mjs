import test from 'node:test';
import assert from 'node:assert/strict';
import { gitDiffLines, reviewComment } from '../app/renderer/src/git-diff.js';

test('unified diff numbers additions, removals and context without counting file headers', () => {
  const rows = gitDiffLines('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +10,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n');
  assert.deepEqual(rows.filter(r => r.oldLine || r.newLine), [
    { type: 'ctx', text: 'same', oldLine: 10, newLine: 10 },
    { type: 'del', text: 'old', oldLine: 11 },
    { type: 'add', text: 'new', newLine: 11 },
    { type: 'add', text: 'extra', newLine: 12 },
  ]);
  assert.equal(rows.filter(r => r.type === 'add').length, 2);
  assert.equal(rows.at(-1).type, 'meta');
});

test('new/deleted files, multiple hunks and combined conflict diffs stay unambiguous', () => {
  const rows = gitDiffLines('@@ -0,0 +1 @@\n+new\n@@ -20 +0,0 @@\n-gone\n@@@ -1,1 -1,1 +1,5 @@@\n++conflict\n');
  assert.equal(rows[1].newLine, 1); assert.equal(rows[3].oldLine, 20);
  assert.equal(rows.at(-1).type, 'meta', 'combined conflict lines are displayed raw, not misnumbered');
});

test('review feedback retains path, layer, side, line and quoted content', () => {
  const text = reviewComment({ path: 'src/a\nb.js', group: 'staged' }, { oldLine: 12, text: 'removed' }, ' Keep this ');
  assert.match(text, /staged change/); assert.match(text, /"src\/a\\nb.js"/); assert.match(text, /old line 12:\n> removed\n\nKeep this$/);
});
