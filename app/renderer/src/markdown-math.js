// LaTeX math in Markdown, rendered with KaTeX: $…$ and \(…\) inline, $$…$$ and \[…\] as display math.
// Models write all four. Without this, Markdown read \[ as an escaped bracket and showed the raw TeX.
//
// KaTeX output is generated here from the TeX alone (trust: false: no links, classes or styles from
// the source), so it is inserted after sanitizing: the Markdown's own HTML is sanitized as before,
// with each formula as a placeholder, and the placeholders are then filled in.
import katex from 'katex';

const cache = new Map(); // streaming re-renders the whole reply on every update
export function renderMath(tex, display) {
  const key = (display ? 'D' : 'I') + tex;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      // A formula that does not parse shows its source, marked as an error, instead of failing the reply.
      html = katex.renderToString(tex, { displayMode: display, output: 'html', throwOnError: false, strict: 'ignore', trust: false, errorColor: '#f39a8a' });
    } catch {
      html = `<code>${tex.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</code>`;
    }
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(key, html);
  }
  return html;
}

let slots = null; // formulas of the Markdown being parsed
const place = html => {
  if (!slots) return html;
  slots.push(html);
  return `<span data-math-slot="${slots.nonce}-${slots.length - 1}"></span>`;
};

// Parse Markdown (parse() runs marked with mathExtension), sanitize its HTML, then insert the formulas.
export function withMath(parse, sanitize) {
  const own = Object.assign([], { nonce: Math.random().toString(36).slice(2, 10) });
  const outer = slots;
  slots = own;
  let html;
  try { html = parse(); } finally { slots = outer; }
  return sanitize(html).replace(new RegExp(`<span data-math-slot="${own.nonce}-(\\d+)"></span>`, 'g'), (_, i) => own[i] ?? '');
}

// A display formula on its own lines: $$…$$ or \[…\].
const BLOCK = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/;
// Within a line. A $…$ formula follows Pandoc: no space just inside either $, and no digit right
// after the closing one, so prices ("$5 and $10") stay text; \$ is a literal dollar.
const INLINE = [
  [/^\$\$(?!\$)([\s\S]+?)\$\$/, true],
  [/^\\\[([\s\S]+?)\\\]/, true],
  [/^\\\(([\s\S]+?)\\\)/, false],
  [/^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)(?<!\s)\$(?!\d)/, false],
];

export const mathExtension = {
  extensions: [
    {
      name: 'math', level: 'block',
      start: src => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
      tokenizer(src) {
        const m = BLOCK.exec(src);
        const text = m && (m[1] ?? m[2]).trim();
        if (text) return { type: 'math', raw: m[0], text };
      },
      renderer: token => `<div class="math-block">${place(renderMath(token.text, true))}</div>\n`,
    },
    {
      name: 'inlineMath', level: 'inline',
      start(src) { const i = src.search(/\$|\\[([]/); return i < 0 ? undefined : i; },
      tokenizer(src) {
        for (const [pattern, display] of INLINE) {
          const m = pattern.exec(src);
          if (m && m[1].trim()) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display };
        }
      },
      renderer: token => place(renderMath(token.text, token.display)),
    },
  ],
};
