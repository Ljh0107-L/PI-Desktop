import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons.jsx';
import { baseName } from './ui.jsx';
import { defaultFolder, newSession, openPalette, openSession, openSettings, pickRecent, useStore } from './store.js';

const TABS = ['All', 'Sessions', 'Projects', 'Environments'];

export function Palette() {
  const sessions = useStore(s => s.sessions);
  const environments = useStore(s => s.environments);
  const recentFolders = useStore(s => s.settings?.recentFolders ?? {});
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(0);
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const q = query.trim().toLowerCase();
  const match = text => !q || text.toLowerCase().includes(q);
  const envLabel = id => environments.find(e => e.id === id)?.label ?? (id === 'local' ? 'This computer' : id.replace(/^ssh:/, ''));

  const sections = useMemo(() => {
    const out = [];
    const kind = TABS[tab];
    if (kind === 'All' || kind === 'Sessions') {
      const items = sessions.filter(s => match(`${s.title} ${s.project} ${s.environmentLabel}`)).slice(0, kind === 'All' ? 6 : 50)
        .map(s => ({ key: s.id, icon: s.environmentId === 'local' ? 'laptop' : 'terminal', label: s.title, detail: `${s.project} · ${s.environmentLabel}`, run: () => openSession(s.id) }));
      if (items.length) out.push({ title: q ? 'Sessions' : 'Recents', items });
    }
    if (kind === 'All' || kind === 'Projects') {
      const items = Object.entries(recentFolders).flatMap(([envId, folders]) => folders.map(folder => ({ envId, folder })))
        .filter(({ envId, folder }) => match(`${folder} ${envLabel(envId)}`)).slice(0, kind === 'All' ? 4 : 50)
        .map(({ envId, folder }) => ({ key: envId + folder, icon: 'folder', label: baseName(folder), detail: `${envLabel(envId)} · ${folder}`, hint: 'New session', run: () => { newSession(); pickRecent(envId, folder); } }));
      if (items.length) out.push({ title: 'Projects', items });
    }
    if (kind === 'Environments' || (kind === 'All' && q)) {
      const items = environments.filter(e => match(`${e.label} ${e.detail ?? ''}`)).slice(0, kind === 'All' ? 4 : 100)
        .map(e => ({ key: e.id, icon: e.kind === 'ssh' ? 'terminal' : 'laptop', label: e.label, detail: e.kind === 'ssh' ? e.detail : 'Local', hint: 'New session', run: () => { newSession(); pickRecent(e.id, defaultFolder({ recentFolders }, e.id)); } }));
      if (items.length) out.push({ title: 'Environments', items });
    }
    if (kind === 'All') {
      const actions = [
        { key: 'new', icon: 'plus', label: 'New session', run: newSession },
        { key: 'models', icon: 'key', label: 'Models & API keys', run: () => openSettings(true, 'providers') },
        { key: 'envs', icon: 'server', label: 'SSH connections', run: () => openSettings(true, 'connections') },
      ].filter(a => match(a.label));
      if (actions.length) out.push({ title: 'Actions', items: actions });
    }
    return out;
  }, [sessions, environments, recentFolders, q, tab]);
  const flat = sections.flatMap(s => s.items);

  useEffect(() => { setIndex(0); }, [q, tab]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { list.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const close = () => openPalette(false);
  const run = item => { close(); item?.run(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[index]); }
    else if (e.key === 'Tab' || (e.key === 'ArrowRight' && e.metaKey)) { e.preventDefault(); setTab(t => (t + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length); }
  };
  let n = -1;
  return createPortal(
    <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Search" onKeyDown={onKey}>
        <div className="palette-search">
          <input ref={input} placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />
          <button className="icon-button" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="palette-tabs">{TABS.map((t, i) => <button key={t} className={i === tab ? 'on' : ''} onClick={() => { setTab(i); input.current?.focus(); }}>{t}</button>)}</div>
        <div className="palette-list" ref={list}>
          {sections.map(section => (
            <div key={section.title} className="palette-section">
              <div className="palette-section-title">{section.title}</div>
              {section.items.map(item => {
                n += 1; const i = n;
                return (
                  <button key={item.key} className={`palette-item ${i === index ? 'selected' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => run(item)}>
                    <Icon name={item.icon} size={18} />
                    <span className="palette-label">{item.label}</span>
                    {item.detail && <span className="palette-detail">{item.detail}</span>}
                    {i === index && <Icon name="enter" size={17} className="palette-enter" />}
                  </button>
                );
              })}
            </div>
          ))}
          {!flat.length && <div className="palette-empty">No results for “{query}”</div>}
        </div>
        <div className="palette-foot">
          <span>Close <kbd>Esc</kbd></span>
          <span>Change type <kbd>Tab</kbd></span>
          <span>Navigate <kbd>↑</kbd><kbd>↓</kbd></span>
          <span className="palette-foot-right">Open <kbd>↵</kbd></span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
