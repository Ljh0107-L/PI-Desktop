import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { EffortTrigger, MenuItem, MenuSection, Modal, Spinner, Trigger } from './ui.jsx';
import { cursorOtherSettings, cursorThought, cursorValues, effortLevels } from './cursor-options.js';
import { api, notify, openSettings, setSettings, useStore } from './store.js';
import { favouriteModels } from './file-paths.js';

const cleanError = reason => reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Cached list first; a refresh is only requested explicitly. This keeps menus instant
// after the models have been loaded once.
function useCursorModels(environmentId, { auto = true, refreshOnOpen = false } = {}) {
  const settings = useStore(s => s.settings.cursor);
  const [state, setState] = useState(() => settings?.models?.length ? { models: settings.models, currentModelId: settings.currentModelId, source: 'cache' } : null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = async ({ refresh = false } = {}) => {
    if (loading) return null;
    setLoading(true); if (refresh) setError(null);
    try {
      const result = await api('cursorModels', environmentId, undefined, { refresh });
      setState(result);
      return result;
    } catch (reason) { setError(cleanError(reason)); return null; }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!auto || (!refreshOnOpen && state)) return;
    void load({ refresh: refreshOnOpen });
  }, [environmentId]);
  return { state, error, loading, load, settings };
}

const ago = at => {
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toLocaleDateString();
};

export function CursorSettings() {
  const settings = useStore(s => s.settings.cursor);
  const environments = useStore(s => s.environments);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [apiKey, setApiKey] = useState('');
  const [command, setCommand] = useState(settings?.command || '');
  const [environmentId, setEnvironment] = useState('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [picker, setPicker] = useState(null);
  const setup = useStore(s => s.envStatus[environmentId]);
  const favorites = favouriteModels(settings);
  const models = settings?.models ?? [];
  const save = async ({ key, enabled: nextEnabled = enabled } = {}) => {
    setBusy(true); setError(null);
    try {
      const updated = await api('saveCursorSettings', { enabled: nextEnabled, command, apiKey: key === 'remove' ? undefined : apiKey, clearKey: key === 'remove' });
      setSettings(updated); setApiKey('');
      if (key === 'remove') notify('Cursor API Key removed');
      return updated;
    } catch (reason) { setError(cleanError(reason)); return null; }
    finally { setBusy(false); }
  };
  const saveFavourites = async ids => {
    try { setSettings(await api('saveCursorSettings', { enabled, command, favorites: ids })); return true; }
    catch (reason) { setError(cleanError(reason)); return false; }
  };
  const toggle = async next => { setEnabled(next); if (!await save({ enabled: next })) setEnabled(!next); };
  const preparing = busy && setup?.status === 'preparing' ? setup.message : null;
  return <div className="cursor-settings">
    <div className="cursor-card">
      <div className="cursor-row">
        <div className="cursor-row-main">
          <span className="cursor-row-title">Cursor CLI conversations</span>
          <p className="row-meta">Choose Cursor CLI under the message box to work with Cursor’s agent and your Cursor models.</p>
        </div>
        <label className={`switch ${enabled ? 'on' : ''}`}><input type="checkbox" checked={enabled} disabled={busy} onChange={e => toggle(e.target.checked)} aria-label="Enable Cursor SDK" /><span /></label>
      </div>
    </div>

    <section className={`cursor-group ${enabled ? '' : 'off'}`}>
      <div className="cursor-group-head">
        <h2 className="section-title">API key</h2>
        {!settings?.hasKey && <button className="link-button" onClick={() => api('openExternal', 'https://cursor.com/docs/cli/reference/authentication')}>Get a key <Icon name="externalLink" size={13} /></button>}
      </div>
      <div className="cursor-card">
        <form className="cursor-row cursor-key" onSubmit={e => { e.preventDefault(); save(); }}>
          <input type="password" aria-label="Cursor API Key" autoComplete="new-password" value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} placeholder={settings?.hasKey ? 'Saved' : 'Paste Cursor API Key'} spellCheck={false} />
          <button className="button small primary" type="submit" disabled={busy}>{busy && !picker ? <Spinner /> : 'Save'}</button>
        </form>
        <div className="cursor-row cursor-status">
          <span className={`credential-dot ${settings?.hasKey ? 'ok' : 'missing'}`} />
          <span className="row-meta">{settings?.hasKey ? 'Saved, encrypted in the Keychain' : 'Not set — Cursor CLI uses its own login, if any'}</span>
          {settings?.hasKey && <button className="link-button" disabled={busy} onClick={() => save({ key: 'remove' })}>Remove key</button>}
        </div>
      </div>
    </section>

    <section className={`cursor-group ${enabled ? '' : 'off'}`}>
      <div className="cursor-group-head">
        <h2 className="section-title">Models</h2>
        <button className="button small" disabled={busy || !enabled} onClick={async () => { if (await save()) setPicker({ refresh: false }); }}>{models.length ? 'Choose…' : 'Load models'}</button>
      </div>
      <div className="cursor-card">
        <div className="cursor-row">
          {favorites.length
            ? <div className="cursor-chips">{favorites.map(model => <span key={model.id} className="cursor-chip" title={model.id}>{model.name}</span>)}</div>
            : <p className="row-meta">{models.length ? `${models.length} models available. Choose the few to show in the model menu.` : 'Check the connection to load your Cursor models.'}</p>}
        </div>
      </div>
    </section>

    <section className={`cursor-group ${enabled ? '' : 'off'}`}>
      <div className="cursor-group-head"><h2 className="section-title">Connection</h2></div>
      <div className="cursor-card">
        <div className="cursor-row">
          <span className="cursor-label">Machine</span>
          <select className="cursor-select" aria-label="Machine" value={environmentId} disabled={busy} onChange={e => setEnvironment(e.target.value)}>{environments.filter(e => e.kind === 'local' || (e.added && e.enabled)).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
          <button className="button small" disabled={busy || !enabled} onClick={async () => { const saved = await save(); if (saved) setPicker({ refresh: true }); }}>Check connection</button>
        </div>
        {(error || preparing || settings?.modelsAt > 0) && <div className="cursor-row cursor-status" role={error ? 'alert' : 'status'}>
          {error ? <span className="cursor-error"><Icon name="alert" size={14} /> {error}</span>
            : preparing ? <><Spinner size={12} /><span className="row-meta">{preparing}</span></>
            : <><span className="status-dot connected" /><span className="row-meta">{models.length} models · checked {ago(settings.modelsAt)}</span></>}
        </div>}
      </div>
    </section>

    <details className="cursor-advanced"><summary>Advanced</summary>
      <label className="field"><span>Cursor CLI executable</span><input aria-label="Cursor CLI executable" value={command} disabled={busy} onChange={e => setCommand(e.target.value)} placeholder="Installed by Pi Desktop" spellCheck={false} /></label>
      <p className="row-meta">Leave blank for the verified automatic installation. A custom path must be the official Cursor runtime. Save applies it.</p>
    </details>
    {picker && <CursorModelPicker environmentId={environmentId} refreshOnOpen={picker.refresh} selected={settings?.favorites ?? []} onSave={saveFavourites} onClose={() => setPicker(null)} />}
  </div>;
}

export function CursorModelPicker({ environmentId, selected, onSave, onClose, refreshOnOpen = false }) {
  const models = useCursorModels(environmentId, { refreshOnOpen });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set(selected));
  const list = (models.state?.models ?? []).filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = id => setPicked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const close = async () => { if (await onSave([...picked]) !== false) onClose(); };
  return <Modal title="Choose Cursor models" onClose={onClose} width={560} footer={<>
    <span className="cursor-picked">{picked.size} selected</span>
    <button className="button" onClick={() => setPicked(new Set())}>Clear</button>
    <button className="button primary" disabled={!models.state} onClick={close}>Done</button>
  </>}>
    <div className="cursor-picker">
      <div className="search-field"><Icon name="search" size={15} /><input autoFocus placeholder="Search models" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search Cursor models" /></div>
      <div className="pick-list compact cursor-pick-list">
        {!models.state && !models.error && <div className="browse-empty"><Spinner /> Loading models…</div>}
        {models.error && <div className="browse-empty error">{models.error} <button className="link-button" onClick={() => models.load({ refresh: true })}>Retry</button></div>}
        {models.state && list.map(model => <label key={model.id} className="pick-row"><input type="checkbox" checked={picked.has(model.id)} onChange={() => toggle(model.id)} /><span className="pick-text"><span>{model.name}</span>{model.name !== model.id && <span className="row-meta">{model.id}</span>}</span></label>)}
        {models.state && !list.length && <div className="browse-empty">No matching models</div>}
      </div>
    </div>
    <div className="cursor-picker-foot"><button className="link-button" onClick={() => models.load({ refresh: true })} disabled={models.loading}>{models.loading ? 'Refreshing…' : 'Refresh from Cursor'}</button>{models.state?.durationMs != null && <span className="row-meta">{models.state.source === 'cache' ? 'Cached' : `${(models.state.durationMs / 1000).toFixed(1)}s`}</span>}</div>
  </Modal>;
}

// Only what this live Cursor session advertises: reasoning effort, the same control as Pi's, and any
// other model parameter Cursor offers (e.g. Fast). The mode is never offered: desktop conversations
// always run in Agent mode. Values are never inferred from a model name or reused from another model.
export function CursorConfigControls({ session }) {
  const [busy, setBusy] = useState(false);
  const options = session?.cursorConfigOptions ?? [];
  const thought = cursorThought(options);
  const disabled = busy || session.streaming;
  const change = async (id, value) => {
    setBusy(true);
    try { await api('setCursorConfig', session.id, id, value); }
    catch (reason) { notify(cleanError(reason), 'error'); }
    finally { setBusy(false); }
  };
  return <>
    {cursorOtherSettings(options).map(option => {
      const name = option.name || option.id;
      const values = cursorValues(option);
      if (!values.length) return null;
      const current = values.find(value => value.value === option.currentValue);
      return <Trigger key={option.id} width={220} label={name} title={option.description || name} className="cursor-config-trigger" disabled={disabled}
        menu={close => <MenuSection title={name}>{values.map(value => <MenuItem key={String(value.value)} label={value.name || String(value.value)} checked={value.value === option.currentValue} onClick={() => { close(); change(option.id, value.value); }} />)}</MenuSection>}>
        <span className="muted">{name}{current ? ` · ${current.name || current.value}` : ''}</span>
      </Trigger>;
    })}
    {thought && <EffortTrigger levels={effortLevels(thought)} value={thought.currentValue} disabled={disabled} onChange={value => change(thought.id, value)} />}
  </>;
}

export function CursorModelMenu({ environmentId, sessionId, value, onChange, close }) {
  const settings = useStore(s => s.settings.cursor);
  const favorites = useMemo(() => favouriteModels(settings), [settings]);
  const current = value?.id ?? (sessionId ? null : settings?.currentModelId);
  const shown = useMemo(() => {
    const list = favorites.length ? [...favorites] : [];
    if (current && !list.some(model => model.id === current)) list.unshift({ id: current, name: settings?.models?.find(model => model.id === current)?.name ?? value?.name ?? current });
    return list;
  }, [favorites, current, value?.name, settings?.models]);
  const choose = () => { close(); openSettings(true, 'cursor'); };
  return <div className="model-menu cursor-model-menu">
    <div className="menu-scroll">
      {shown.length ? <MenuSection title="Cursor">{shown.map(model => <MenuItem key={model.id} label={model.name} detail={model.name !== model.id ? model.id : null} checked={current === model.id} onClick={() => { onChange({ provider: 'cursor', id: model.id, name: model.name }); close(); }} />)}</MenuSection>
        : <div className="menu-empty">No models selected for Cursor.</div>}
    </div>
    <div className="menu-foot"><MenuItem icon="settings" label="Choose models…" onClick={choose} /></div>
  </div>;
}
