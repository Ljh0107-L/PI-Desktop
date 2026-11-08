// Keep the same displayed entry at the same pixel offset as older pages or late details arrive.
export function historyBookmark(scroller) {
  if (!scroller) return [];
  const top = scroller.getBoundingClientRect().top;
  return [...scroller.querySelectorAll('[data-history-key]')].filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > top && rect.top < top + scroller.clientHeight;
  }).map(node => ({ key: node.dataset.historyKey, offset: node.getBoundingClientRect().top - top }));
}

export function restoreHistoryBookmark(scroller, bookmark) {
  if (!scroller || !bookmark?.length) return;
  const nodes = new Map([...scroller.querySelectorAll('[data-history-key]')].map(node => [node.dataset.historyKey, node]));
  for (const anchor of bookmark) {
    const node = nodes.get(anchor.key);
    if (!node) continue;
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    break;
  }
}
