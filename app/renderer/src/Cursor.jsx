import { useEffect, useState } from 'react';
import { MenuItem, MenuSection, Spinner } from './ui.jsx';
import { api, notify, openSettings, setSettings, useStore } from './store.js';

export function CursorSettings() {
  const settings = useStore(s => s.settings.cursor);
  const environments = useStore(s => s.environments);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [command, setCommand] = useState(settings?.command || '~/.local/bin/agent');
  const [environmentId, setEnvironment] = useState('local');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const save = async () => setSettings(await api('saveCursorSettings', { enabled, command }));
  const check = async () => {
    setBusy(true); setResult(null);
    try { await save(); const response = await api('cursorModels', environmentId); setResult(response); }
    catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  };
  return <section className="section cursor-settings">
    <h2 className="section-title">Official Cursor CLI · ACP</h2>
    <p className="row-meta">Independent Cursor sessions in Pi Desktop. Cursor runs its own agent and tools; no quota bridge or private API is used.</p>
    <label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable Cursor SDK</label>
    <label className="field">Cursor CLI executable<input value={command} onChange={e => setCommand(e.target.value)} placeholder="~/.local/bin/agent" spellCheck={false} /></label>
    <p className="row-meta">Install the official Cursor CLI and run <code>agent login</code> in a terminal on each machine you use. Credentials stay with Cursor on that machine. Pi Desktop does not install it or sign you in automatically.</p>
    <button className="link-button" onClick={() => api('openExternal', 'https://cursor.com/docs/cli/installation')}>Cursor CLI installation and login</button>
    <label className="field">Check on<select value={environmentId} onChange={e => setEnvironment(e.target.value)}>{environments.filter(e => e.kind === 'local' || (e.added && e.enabled)).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
    <div className="row-actions">
      <button className="button primary" disabled={busy || !command.trim()} onClick={() => save().then(() => notify('Cursor SDK settings saved'), e => notify(e.message, 'error'))}>Save</button>
      <button className="button" disabled={busy || !enabled || !command.trim()} onClick={check}>{busy ? <Spinner /> : null} Check connection and models</button>
    </div>
    {result?.error && <p className="error" role="alert">{result.error}</p>}
    {result?.models && <div className="cursor-model-list"><p>{result.models.length} models available</p>{result.models.map(model => <div key={model.id}>{model.name} <span className="muted">{model.id}</span></div>)}</div>}
    <p className="row-meta">Create a new conversation, choose Cursor CLI, then select a model normally. Existing Pi conversations are unchanged. Cursor owns compaction and tool approvals; Pi goals, history editing, fork and Pi subagent controls are not available. Unreported token usage stays unavailable.</p>
  </section>;
}

export function CursorModelMenu({ environmentId, sessionId, value, onChange, close }) {
  const [state, setState] = useState(null);
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true; setState(null);
    api('cursorModels', environmentId, sessionId).then(result => { if (alive) setState(result); }, error => { if (alive) setState({ error: error.message }); });
    return () => { alive = false; };
  }, [environmentId, sessionId, version]);
  return <div className="model-menu cursor-model-menu">
    <input className="menu-search" autoFocus placeholder="Search Cursor models…" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="menu-scroll">
      {!state && <div className="menu-empty"><Spinner /> Loading Cursor models…</div>}
      {state?.error && <div className="menu-empty error">{state.error}</div>}
      {state?.models && <MenuSection title="Cursor CLI">{state.models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase())).map(m => <MenuItem key={m.id} label={m.name} detail={m.name !== m.id ? m.id : null} checked={(value?.id ?? state.currentModelId) === m.id} onClick={() => { onChange({ provider: 'cursor', id: m.id }); close(); }} />)}</MenuSection>}
      {state?.models?.length === 0 && <div className="menu-empty">This Cursor CLI did not advertise models. Update the CLI and check your login.</div>}
    </div>
    <div className="menu-foot"><MenuItem icon="refresh" label="Refresh models" onClick={() => setVersion(v => v + 1)} /><MenuItem icon="settings" label="Cursor SDK settings…" onClick={() => { close(); openSettings(true, 'cursor'); }} /></div>
  </div>;
}
