// LaTeX math in replies and Markdown previews: the four delimiters models use, and what must stay text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { mathExtension, withMath } from '../app/renderer/src/markdown-math.js';

const md = new Marked({ gfm: true }, mathExtension);
const render = (text, sanitize = html => html) => withMath(() => md.parse(text), sanitize);
const count = (html, cls) => (html.match(new RegExp(`class="${cls}"`, 'g')) ?? []).length;

test('display math: \\[ \\] and $$ $$ on their own lines, also right after a paragraph line', () => {
  const html = render('所以 Q 的两级投影是：\n\n\\[ 5120 \\rightarrow 1280 \\rightarrow 64\\times512 \\]\n\n**SWA KV 路径**');
  assert.equal(count(html, 'katex-display'), 1);
  assert.ok(!html.includes('\\rightarrow'), 'no raw TeX left in the reply');
  assert.match(html, /<strong>SWA KV 路径<\/strong>/);
  const block = render('Before\n$$\n\\frac{a}{b}\n$$\nAfter');
  assert.equal(count(block, 'katex-display'), 1);
  assert.match(block, /<p>Before<\/p>/); assert.match(block, /<p>After<\/p>/);
});

test('inline math: $ $ and \\( \\), and $$ $$ within a line as display math', () => {
  assert.equal(count(render('Energy $E=mc^2$ and \\(a_1 + b_1\\) here.'), 'katex'), 2);
  const html = render('so $$x^2$$ here');
  assert.equal(count(html, 'katex-display'), 1);
});

test('prices, escaped dollars and code stay text', () => {
  for (const text of ['It costs $5 and $10, and $HOME is set.', 'between $a and $b', 'A literal \\$5 price.', 'Code `$x$` and `\\(y\\)`', '```\n$$ not math $$\n\\[ x \\]\n```']) {
    assert.equal(count(render(text), 'katex'), 0, text);
  }
  assert.match(render('A literal \\$5 price.'), /A literal \$5 price/);
});

test('an unfinished formula while streaming stays text, and invalid TeX shows its source', () => {
  assert.equal(count(render('Streaming $$ x^2 + '), 'katex'), 0);
  const bad = render('$\\frac{a}{$ oops');
  assert.match(bad, /katex-error/);
});

test('formulas are inserted after sanitizing, and only the ones this parse produced', () => {
  const seen = [];
  const html = render('Inline $\\sqrt{x}$ and a forged <span data-math-slot="x-0"></span> slot.', h => { seen.push(h); return h; });
  assert.ok(!seen[0].includes('katex'), 'the sanitizer never sees KaTeX markup, so its strict profile needs no SVG');
  assert.equal(count(html, 'katex'), 1);
  assert.match(html, /<svg/, 'the square root keeps its SVG');
  assert.match(html, /data-math-slot="x-0"/, 'a placeholder written in the source is not filled');
  assert.ok(!/data-math-slot="[a-z0-9]{8}-/.test(html), 'every real placeholder was filled');
});
