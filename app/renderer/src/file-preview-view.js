// Pure helpers for deciding when FilePane source previews should highlight, wrap, or bound initial DOM size.
export const HIGHLIGHT_MAX_CHARS = 150_000;
export const HIGHLIGHT_MAX_LINE_LENGTH = 4_000;
export const AUTO_WRAP_LINE_LENGTH = 2_000;
export const LONG_LINE_PREVIEW_CHARS = 65_536;
export const LARGE_TEXT_PREVIEW_CHARS = 300_000;

export function inspectPreviewText(text = '') {
  const value = String(text);
  const length = value.length;
  if (!length) return { length: 0, lineCount: 1, maxLineLength: 0 };
  let lineCount = 1;
  let maxLineLength = 0;
  let start = 0;
  while (start <= length) {
    const nl = value.indexOf('\n', start);
    const end = nl === -1 ? length : nl;
    const len = end - start;
    if (len > maxLineLength) maxLineLength = len;
    if (nl === -1) break;
    lineCount += 1;
    start = nl + 1;
  }
  return { length, lineCount, maxLineLength };
}

export function sliceUtf16Safe(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  // Avoid cutting between a high surrogate (0xD800..0xDBFF) and its low surrogate.
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return text.slice(0, Math.max(0, end));
}

export function prepareCodePreview(text = '', { expanded = false, wrapOverride = null } = {}) {
  const stats = inspectPreviewText(text);
  const longLines = stats.maxLineLength > HIGHLIGHT_MAX_LINE_LENGTH;
  const autoWrap = stats.maxLineLength > AUTO_WRAP_LINE_LENGTH;
  const wrapped = wrapOverride ?? autoWrap;
  const defaultLimit = longLines ? LONG_LINE_PREVIEW_CHARS : LARGE_TEXT_PREVIEW_CHARS;
  const previewLimited = !expanded && stats.length > defaultLimit;
  const displayedText = previewLimited ? sliceUtf16Safe(text, defaultLimit) : text;
  const displayedStats = previewLimited ? inspectPreviewText(displayedText) : stats;
  const highlight = stats.length <= HIGHLIGHT_MAX_CHARS && stats.maxLineLength <= HIGHLIGHT_MAX_LINE_LENGTH;
  return {
    displayedText,
    lineCount: displayedStats.lineCount,
    totalLength: stats.length,
    totalLines: stats.lineCount,
    maxLineLength: stats.maxLineLength,
    longLines,
    autoWrap,
    wrapped,
    previewLimited,
    highlight,
  };
}

export function shouldAutoRefreshPreview(currentFile, manualRefresh) {
  if (manualRefresh) return true;
  if (currentFile?.truncated && (currentFile.kind === 'text' || currentFile.kind === 'binary')) return false;
  return true;
}
