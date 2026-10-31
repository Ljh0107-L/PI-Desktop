import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Modal, Popover, Spinner, baseName, envIcon, shortPath } from './ui.jsx';
import { api, getState, notify, openSettings, setDraft, setEnvironments, useStore } from './store.js';
import { cachedDir, listDir, prefetchDir } from './dirs.js';

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const effortLabel = level => ({ off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }[level] ?? level);
// Levels a model offers, per Pi: a thinkingLevelMap value of null removes a level; unmapped levels use the
// provider default up to high, and xhigh/max exist only when mapped.
const effortsFor = model => {
  const map = model?.thinkingLevelMap ?? {};
  return EFFORTS.filter(l => map[l] === null ? false : ['xhigh', 'max'].includes(l) ? map[l] != null : true);
};

// A text-style trigger (no chrome) that opens a popover — the controls under Claude's composer.
function Trigger({ children, menu, width = 300, placement = 'top-end', className = '', title, label }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={anchor} type="button" className={`trigger ${open ? 'active' : ''} ${className}`} onClick={() => setOpen(o => !o)} title={title} aria-label={label}>{children}</button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={width} placement={placement}>{menu(() => setOpen(false))}</Popover>
  </>;
}

// ---------------------------------------------------------------- environment menu (Claude-style, with a "More" flyout)
function EnvItem({ env, value, onPick, status }) {
  return <MenuItem icon={envIcon(env)} label={env.label} detail={status?.status === 'preparing' ? status.message : status?.status === 'error' ? 'Setup failed — see Settings' : null}
    checked={value === env.id} onClick={() => onPick(env.id)} trailing={status?.status === 'preparing' ? <Spinner /> : null} />;
}

export function EnvironmentMenu({ value, onChange, close }) {
  const environments = useStore(s => s.environments);
  const recent = useStore(s => s.settings?.recentEnvironments ?? []);
  const envStatus = useStore(s => s.envStatus);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rank = e => { const r = recent.indexOf(e.id); return r < 0 ? 1e3 : r; };
  // Only the connections the user added (Settings → Connections) are offered; searching also finds
  // other hosts from ~/.ssh/config, which get added when picked.
  const added = environments.filter(e => e.kind === 'ssh' && e.added && e.enabled).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const others = q ? environments.filter(e => e.kind === 'ssh' && !e.added && `${e.label} ${e.detail}`.toLowerCase().includes(q)).slice(0, 8) : [];
  const matchAdded = q ? added.filter(e => `${e.label} ${e.detail}`.toLowerCase().includes(q)) : added;
  const pick = id => { onChange(id); close(); };
  const pickNew = async id => { setEnvironments(await api('addConnections', [id])); pick(id); };
  return (
    <div className="env-menu">
      <input className="menu-search" autoFocus placeholder="Search environments…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="menu-scroll">
        {(!q || 'this computer local'.includes(q)) && <MenuSection><MenuItem icon="laptop" label="This computer" checked={value === 'local'} onClick={() => pick('local')} /></MenuSection>}
        {matchAdded.length > 0 && <MenuSection title="SSH">{matchAdded.map(env => <EnvItem key={env.id} env={env} value={value} onPick={pick} status={envStatus[env.id]} />)}</MenuSection>}
        {others.length > 0 && <MenuSection title="From ~/.ssh/config">{others.map(env => <EnvItem key={env.id} env={env} value={value} onPick={pickNew} />)}</MenuSection>}
        {q && !matchAdded.length && !others.length && !'this computer local'.includes(q) && <div className="menu-empty">No matching hosts</div>}
      </div>
      <div className="menu-foot">
        <MenuItem icon="plus" label="Add SSH connection…" onClick={() => { close(); openSettings(true, 'connections', { addConnection: true }); }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- folders
function RemoteBrowser({ environmentId, start, onPick, onClose }) {
  const initial = cachedDir(environmentId, start);
  const [dir, setDir] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!initial);
  const [typed, setTyped] = useState(initial?.path ?? start ?? '');
  const seq = useRef(0);
  const editing = useRef(false); // the user typed a path: a finishing refresh must not replace it
  // Show a cached listing at once and refresh it quietly; only the latest request may update the view.
  const load = async path => {
    const mine = ++seq.current;
    editing.current = false;
    const cached = cachedDir(environmentId, path);
    if (cached) { setDir(cached); setTyped(cached.path); setError(null); } else setLoading(true);
    try {
      const r = await listDir(environmentId, path);
      if (mine === seq.current && !editing.current) { setDir(r); setTyped(r.path); setError(null); }
      prefetchDir(environmentId, r.path);
    } catch (e) { if (mine === seq.current && !cached) setError(e.message); }
    finally { if (mine === seq.current) setLoading(false); }
  };
  useEffect(() => { load(start); }, []);
  const parent = dir?.path && dir.path !== '/' ? dir.path.replace(/\/[^/]+\/?$/, '') || '/' : null;
  const join = name => `${dir.path.replace(/\/$/, '')}/${name}`;
  return (
    <Modal title="Choose a folder" onClose={onClose} width={560} footer={<>
      <button className="button" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={!dir || loading} onClick={() => { onPick(dir.path); onClose(); }}>Use this folder</button>
    </>}>
      <form className="browse-path" onSubmit={e => { e.preventDefault(); load(typed); }}>
        <input value={typed} onChange={e => { editing.current = true; setTyped(e.target.value); }} spellCheck={false} aria-label="Folder path" />
        <button className="button" type="submit">Go</button>
      </form>
      <div className="browse-list">
        {loading && !dir && <div className="browse-empty"><Spinner /> Loading…</div>}
        {error && <div className="browse-empty error">{error}</div>}
        {dir && <>
          {parent && <button className="browse-item" onClick={() => load(parent)}><Icon name="back" size={16} /> Parent folder</button>}
          {dir.entries.map(name => <button key={name} className="browse-item" onClick={() => load(join(name))}><Icon name="folder" size={16} /> {name}</button>)}
          {!dir.entries.length && <div className="browse-empty">No sub-folders</div>}
        </>}
      </div>
    </Modal>
  );
}

function FolderMenu({ environmentId, value, onChange, close, onBrowse }) {
  const recents = useStore(s => s.settings?.recentFolders?.[environmentId] ?? []);
  const home = useStore(s => s.home);
  const env = useStore(s => s.environments.find(e => e.id === environmentId));
  const local = env?.kind !== 'ssh';
  return <>
    {recents.length > 0 && <MenuSection title="Recent folders">
      {recents.map(path => <MenuItem key={path} icon="folder" label={baseName(path)} detail={local ? shortPath(path, home) : path} checked={value === path} onClick={() => { onChange(path); close(); }} />)}
    </MenuSection>}
    <div className={recents.length ? 'menu-foot' : ''}>
      <MenuItem icon="plus" label={local ? 'Choose a folder…' : `Browse ${env?.label ?? 'host'}…`} onClick={async () => {
        close();
        if (local) { const path = await api('pickLocalFolder'); if (path) onChange(path); }
        else onBrowse();
      }} />
    </div>
  </>;
}

// ---------------------------------------------------------------- models
export function ModelMenu({ value, onChange, close }) {
  const catalog = useStore(s => s.catalog);
  const catalogError = useStore(s => s.catalogError);
  const providers = useStore(s => s.settings?.providers ?? []);
  const builtin = useStore(s => s.settings?.builtinProviders ?? {});
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map();
    for (const m of catalog) {
      if (q && !`${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q)) continue;
      if (!out.has(m.provider)) out.set(m.provider, []);
      out.get(m.provider).push(m);
    }
    return [...out.entries()];
  }, [catalog, q]);
  const providerName = id => providers.find(p => p.id === id)?.name ?? builtin[id] ?? id;
  return (
    <div className="model-menu">
      <input className="menu-search" autoFocus placeholder="Search models…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="menu-scroll">
        {catalogError && <div className="menu-empty error">{catalogError}</div>}
        {!catalog.length && !catalogError && <div className="menu-empty">No models yet — add a provider and its API key.</div>}
        {groups.map(([provider, models]) => (
          <MenuSection key={provider} title={providerName(provider)}>
            {models.map(m => <MenuItem key={m.id} label={m.name} detail={m.name !== m.id ? m.id : null} checked={value?.provider === m.provider && value?.id === m.id}
              onClick={() => { onChange({ provider: m.provider, id: m.id }); close(); }} />)}
          </MenuSection>
        ))}
      </div>
      <div className="menu-foot"><MenuItem icon="settings" label="Manage models…" onClick={() => { close(); openSettings(true, 'providers'); }} /></div>
    </div>
  );
}

export const modelLabel = (model, catalog) => {
  if (!model) return 'Choose a model';
  return catalog.find(x => x.provider === model.provider && x.id === model.id)?.name ?? model.id;
};

// ---------------------------------------------------------------- composer
export function Composer({ session, onSubmit, autoFocus, placeholder }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);
  const streaming = session?.streaming;
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus, session?.id]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);
  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try { await onSubmit(value); setText(''); }
    catch (e) { notify(e.message, 'error'); }
    finally { setSending(false); }
  };
  return (
    <div className="composer" onClick={e => { if (e.target === e.currentTarget) ref.current?.focus(); }}>
      <textarea ref={ref} rows={1} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)} aria-label="Message"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      {streaming && !text.trim()
        ? <button className="send-button stop" onClick={() => api('abort', session.id)} aria-label="Stop" title="Stop"><Icon name="stop" size={22} /></button>
        : <button className={`send-button ${text.trim() ? 'ready' : ''}`} disabled={!text.trim() || sending} onClick={submit} aria-label="Send">{sending ? <Spinner size={13} /> : <Icon name="arrowUp" size={17} stroke={2.4} />}</button>}
    </div>
  );
}

// A compact version of an environment error for the bar under the composer (full text in the tooltip).
const shortError = (message = '', label) => /disk .* is full/i.test(message) ? `${label}: disk full`
  : /could not connect/i.test(message) ? `Can’t reach ${label}` : `${label} unavailable`;

// The row under the composer: environment + folder on the left (new sessions), model / effort / permissions on the right.
export function ComposerBar({ session }) {
  const draft = useStore(s => s.draft);
  const catalog = useStore(s => s.catalog);
  const environments = useStore(s => s.environments);
  const envStatus = useStore(s => s.envStatus);
  const home = useStore(s => s.home);
  const [browsing, setBrowsing] = useState(false);
  const isNew = !session;
  const environmentId = isNew ? draft.environmentId : session.environmentId;
  const env = environments.find(e => e.id === environmentId) ?? { id: environmentId, label: session?.environmentLabel ?? 'This computer', kind: environmentId?.startsWith('ssh:') ? 'ssh' : 'local' };
  const model = isNew ? draft.model : session.model;
  const effort = isNew ? draft.thinkingLevel : session.thinkingLevel;
  const cwd = isNew ? draft.cwd : session.cwd;
  const modelInfo = catalog.find(m => m.provider === model?.provider && m.id === model?.id);
  const prep = envStatus[environmentId];

  const changeEnv = id => {
    const recents = getState().settings?.recentFolders?.[id] ?? [];
    setDraft({ environmentId: id, cwd: recents[0] ?? null });
    if (id !== 'local') api('prepareEnvironment', id);
  };
  const changeModel = m => isNew ? setDraft({ model: m }) : api('setModel', session.id, m.provider, m.id).catch(e => notify(e.message, 'error'));
  const changeEffort = l => isNew ? setDraft({ thinkingLevel: l }) : api('setThinking', session.id, l).catch(e => notify(e.message, 'error'));

  return (
    <div className="composer-bar">
      <div className="composer-bar-left">
        {isNew && <>
          <Trigger className="env-trigger" width={330} placement="top-start" label="Environment" menu={close => <EnvironmentMenu value={environmentId} onChange={changeEnv} close={close} />}>
            <Icon name={envIcon(env)} size={16} /><span>{env.label}</span>
          </Trigger>
          <Trigger className={`folder-trigger ${cwd ? '' : 'attention'}`} width={330} placement="top-start" label="Folder" title={cwd ? shortPath(cwd, home) : undefined}
            menu={close => <FolderMenu environmentId={environmentId} value={cwd} onChange={path => setDraft({ cwd: path })} close={close} onBrowse={() => setBrowsing(true)} />}>
            <Icon name="folder" size={16} /><span>{cwd ? baseName(cwd) : 'Choose folder'}</span>
          </Trigger>
          {prep?.status === 'preparing' && <span className="bar-status"><Spinner size={12} /> {prep.message}</span>}
          {prep?.status === 'error' && <button type="button" className="bar-status error" title={prep.message} onClick={() => api('prepareEnvironment', environmentId, true)}>
            <Icon name="alert" size={14} /> <span>{shortError(prep.message, env.label)}</span> <span className="bar-retry">Retry</span></button>}
        </>}
      </div>
      <div className="composer-bar-right">
        {catalog.length || model
          ? <Trigger width={320} label="Model" className="model-trigger" menu={close => <ModelMenu value={model} onChange={changeModel} close={close} />}>
              <span className="strong">{modelLabel(model, catalog)}</span>
            </Trigger>
          : <button type="button" className="trigger attention" onClick={() => openSettings(true, 'providers')}><Icon name="key" size={15} /><span>Add a model</span></button>}
        {modelInfo?.reasoning !== false && <Trigger width={210} label="Effort" className="effort-trigger" menu={close => <MenuSection title="Reasoning effort">{effortsFor(modelInfo).map(l => <MenuItem key={l} label={effortLabel(l)} checked={effort === l} onClick={() => { changeEffort(l); close(); }} />)}</MenuSection>}>
          <span className="muted">{effortLabel(effort)}</span>
        </Trigger>}
      </div>
      {browsing && <RemoteBrowser environmentId={environmentId} start={cwd ?? undefined} onPick={path => setDraft({ cwd: path })} onClose={() => setBrowsing(false)} />}
    </div>
  );
}
