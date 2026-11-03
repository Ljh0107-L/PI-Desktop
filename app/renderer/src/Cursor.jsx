import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Modal, Spinner } from './ui.jsx';
import { api, notify, openSettings, setSettings, useStore } from './store.js';
import { favouriteModels } from './file-paths.js';

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
    } catch (reason) { setError(reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!auto || (!refreshOnOpen && state)) return;
    void load({ refresh: refreshOnOpen });
  }, [environmentId]);
  return { state, error, loading, load, settings };
}

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
  const save = async ({ key, enabled: nextEnabled = enabled } = {}) => {
    setBusy(true); setError(null);
    try {
      const updated = await api('saveCursorSettings', { enabled: nextEnabled, command, apiKey: key === 'remove' ? undefined : apiKey, clearKey: key === 'remove' });
      setSettings(updated); setApiKey('');
      if (key === 'remove') notify('Cursor API Key removed');
      return updated;
    } catch (reason) { setError(reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
    finally { setBusy(false); }
  };
  const saveFavourites = async ids => {
    try { setSettings(await api('saveCursorSettings', { enabled, command, favorites: ids })); return true; }
    catch (reason) { setError(reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return false; }
  };
  const toggle = async next => { setEnabled(next); if (!await save({ enabled: next })) setEnabled(!next); };
  return <section className="section cursor-settings">
    <div className="cursor-head">
      <div>
        <h2 className="section-title">Cursor</h2>
        <p className="row-meta">Cursor's agent, with your API key.</p>
      </div>
      <div className="cursor-toggle"><span>{enabled ? 'On' : 'Off'}</span><label className={`switch ${enabled ? 'on' : ''}`}><input type="checkbox" checked={enabled} disabled={busy} onChange={e => toggle(e.target.checked)} aria-label="Enable Cursor SDK" /><span /></label></div>
    </div>

    <div className="cursor-card">
      <div className="cursor-row">
        <div className="cursor-key">
          <label className="field"><span>API Key</span><input type="password" aria-label="Cursor API Key" autoComplete="new-password" value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} placeholder={settings?.hasKey ? 'Saved' : 'Paste Cursor API Key'} spellCheck={false} /></label>
          <button className="button primary small" disabled={busy} onClick={() => save()}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
        <div className="cursor-links">
          {settings?.hasKey ? <button className="link-button" disabled={busy} onClick={() => save({ key: 'remove' })}>Remove key</button> : <button className="link-button" onClick={() => api('openExternal', 'https://cursor.com/docs/cli/reference/authentication')}>Get a key</button>}
        </div>
      </div>

      <div className="cursor-row">
        <span className="cursor-label">Models</span>
        <span className="cursor-summary">{favorites.length ? `${favorites.length} selected` : settings?.models?.length ? `${settings.models.length} available` : 'Not loaded'}</span>
        <button className="button small" disabled={busy || !enabled} onClick={async () => { if (await save()) setPicker({ refresh: false }); }}>{favorites.length ? 'Choose' : 'Load models'}</button>
      </div>

      <div className="cursor-row">
        <label className="field cursor-env"><span>Machine</span><select value={environmentId} disabled={busy} onChange={e => setEnvironment(e.target.value)}>{environments.filter(e => e.kind === 'local' || (e.added && e.enabled)).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
        <button className="button small" disabled={busy || !enabled} onClick={async () => { const saved = await save(); if (saved) setPicker({ refresh: true }); }}>Check connection</button>
      </div>
      {favorites.length > 0 && <div className="cursor-chips">{favorites.map(model => <span key={model.id} className="cursor-chip">{model.name}</span>)}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      {busy && setup?.status === 'preparing' && <p className="cursor-progress" role="status">{setup.message}</p>}
    </div>

    <details className="cursor-advanced"><summary>Advanced</summary>
      <label className="field"><span>Cursor CLI</span><input aria-label="Cursor CLI executable" value={command} disabled={busy} onChange={e => setCommand(e.target.value)} placeholder="Installed by Pi Desktop" spellCheck={false} /></label>
      <p className="row-meta">Leave blank for the verified automatic installation. A custom path must be the official Cursor runtime.</p>
    </details>
    {picker && <CursorModelPicker environmentId={environmentId} refreshOnOpen={picker.refresh} selected={settings?.favorites ?? []} onSave={saveFavourites} onClose={() => setPicker(null)} />}
  </section>;
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

// Only render capabilities explicitly advertised by this live Cursor session. Never infer
// reasoning/Fast from a model name or recycle another model's available values.
export function CursorConfigControls({ session }) {
  const [busy, setBusy] = useState(false);
  const options = (session?.cursorConfigOptions ?? []).filter(option => option.id !== 'model' && option.category !== 'model' && ['select', 'boolean'].includes(option.type));
  const change = async (id, value) => {
    setBusy(true);
    try { await api('setCursorConfig', session.id, id, value); }
    catch (reason) { notify(reason.message, 'error'); }
    finally { setBusy(false); }
  };
  return options.map(option => {
    const name = option.name || option.id;
    const disabled = busy || session.streaming;
    if (option.type === 'boolean') return <button key={option.id} type="button" className="trigger cursor-config-trigger" aria-label={name} aria-pressed={option.currentValue === true} title={option.description || name} disabled={disabled} onClick={() => change(option.id, !option.currentValue)}>{name}<span className="muted">{option.currentValue === true ? 'On' : 'Off'}</span></button>;
    const values = (option.options ?? []).flatMap(value => value.options ?? [value]);
    if (!values.length) return null;
    return <label key={option.id} className="cursor-config-control" title={option.description || name}><span className="muted">{name}</span><select aria-label={name} value={option.currentValue ?? ''} disabled={disabled} onChange={event => change(option.id, event.target.value)}>
      {!values.some(value => value.value === option.currentValue) && <option value="" disabled>Not reported</option>}
      {values.map(value => <option key={value.value} value={value.value}>{value.name || value.value}</option>)}
    </select></label>;
  });
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
