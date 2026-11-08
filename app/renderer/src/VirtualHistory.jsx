import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Keep lightweight height placeholders, but mount Markdown, diffs and tool cards only near the
// viewport. One observer serves the whole history; measured heights survive scrolling away.
export function VirtualHistory({ items, scroller, renderItem, onMeasure }) {
  const observer = useRef(null), nodes = useRef(new Map()), heights = useRef(new Map()), refs = useRef(new Map());
  const [visible, setVisible] = useState(() => new Set(items.slice(-20).map(item => item.key)));
  const [, setMeasured] = useState(0);
  const measureCallback = useRef(onMeasure); measureCallback.current = onMeasure;
  useLayoutEffect(() => { measureCallback.current?.(); }, [items, visible]);
  useEffect(() => {
    const io = new IntersectionObserver(entries => {
      setVisible(previous => {
        const next = new Set(previous);
        for (const entry of entries) {
          const key = entry.target.dataset.historyKey;
          if (entry.isIntersecting) next.add(key); else next.delete(key);
        }
        return next.size === previous.size && [...next].every(key => previous.has(key)) ? previous : next;
      });
    }, { root: scroller.current, rootMargin: '900px 0px' });
    observer.current = io;
    for (const node of nodes.current.values()) io.observe(node);
    return () => { observer.current = null; io.disconnect(); };
  }, [scroller]);
  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.dataset.historyKey;
        const height = entry.target.getBoundingClientRect().height;
        if (entry.target.dataset.mounted === 'true' && height >= 0 && heights.current.get(key) !== height) {
          heights.current.set(key, height); changed = true;
        }
      }
      if (changed) { setMeasured(n => n + 1); measureCallback.current?.(); }
    });
    for (const [key, node] of nodes.current) if (visible.has(key)) ro.observe(node);
    return () => ro.disconnect();
  }, [items, visible]);
  useEffect(() => {
    const keys = new Set(items.map(item => item.key));
    for (const key of heights.current.keys()) if (!keys.has(key)) { heights.current.delete(key); refs.current.delete(key); }
  }, [items]);
  const bind = key => {
    if (!refs.current.has(key)) refs.current.set(key, node => {
      const previous = nodes.current.get(key);
      if (previous) observer.current?.unobserve(previous);
      if (node) { nodes.current.set(key, node); observer.current?.observe(node); }
      else nodes.current.delete(key);
    });
    return refs.current.get(key);
  };
  return items.map(item => {
    const active = visible.has(item.key);
    const mounted = items.length <= 80 || active;
    return <div key={item.key} className="history-virtual-row" data-history-key={item.key} data-mounted={mounted}
      ref={bind(item.key)}
      style={mounted ? undefined : { height: heights.current.get(item.key) ?? (item.kind === 'text' ? 160 : 70) }}>
      {mounted ? renderItem(item, active) : null}
    </div>;
  });
}
