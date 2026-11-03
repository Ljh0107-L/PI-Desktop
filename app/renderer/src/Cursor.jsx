import { useEffect, useState } from 'react';
import { MenuItem, MenuSection, Spinner } from './ui.jsx';
import { api, notify, openSettings, setSettings, useStore } from './store.js';

export function CursorSettings() {
  const settings = useStore(s => s.settings.cursor);
  const environments = useStore(s => s.environments);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [apiKey, setApiKey] = useState('');
  const [command, setCommand] = useState(settings?.command || '');
  const [environmentId, setEnvironment] = useState('local');
  const setup = useStore(s => s.envStatus[environmentId]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const save = async (action = 'save') => {
    setBusy(true); setResult(null);
    try {
      const updated = await api('saveCursorSettings', { enabled, command, apiKey: action === 'remove' ? undefined : apiKey, clearKey: action === 'remove' });
      setSettings(updated); setApiKey('');
      if (action === 'check') setResult(await api('cursorModels', environmentId));
      else notify(action === 'remove' ? 'Saved Cursor API Key removed' : 'Cursor SDK settings saved');
    } catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  };
  return <section className="section cursor-settings">
    <h2 className="section-title">Cursor API Key</h2>
    <p className="row-meta">Enter a Cursor API Key. Pi Desktop installs the official Cursor runtime in its own directory on this Mac or the selected SSH host. It never replaces your global agent or Grok command.</p>
    <label className="check"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} /> Enable Cursor SDK</label>
    <label className="field">Cursor API Key<input type="password" autoComplete="new-password" value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} placeholder={settings?.hasKey ? 'Key saved — leave blank to keep it' : 'Paste your Cursor API Key'} spellCheck={false} /></label>
    <p className="row-meta">The key is encrypted on this Mac and sent only to the Cursor process on the selected local or SSH machine. Saving an empty field keeps the saved key. Key changes apply between turns without interrupting running work.</p>
    {settings?.hasKey && <button className="link-button" disabled={busy} onClick={() => save('remove')}>Remove saved key</button>}
    <button className="link-button" onClick={() => api('openExternal', 'https://cursor.com/docs/cli/reference/authentication')}>Get a Cursor API Key</button>
    <details className="cursor-advanced"><summary>Advanced · custom Cursor installation</summary>
      <label className="field">Cursor CLI executable<input value={command} disabled={busy} onChange={e => setCommand(e.target.value)} placeholder="Automatic — installed and managed by Pi Desktop" spellCheck={false} /></label>
      <p className="row-meta">Leave this blank for automatic setup. A custom path must point to the official cursor-agent runtime, not a generic agent/Grok executable. The package identity is checked before providing any key.</p>
      <button className="link-button" onClick={() => api('openExternal', 'https://cursor.com/docs/cli/installation')}>Cursor CLI installation</button>
    </details>
    <label className="field">Check on<select value={environmentId} disabled={busy} onChange={e => setEnvironment(e.target.value)}>{environments.filter(e => e.kind === 'local' || (e.added && e.enabled)).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
    <div className="row-actions">
      <button className="button primary" disabled={busy} onClick={() => save()}>Save</button>
      <button className="button" disabled={busy || !enabled} onClick={() => save('check')}>{busy ? <Spinner /> : null} Check connection and models</button>
    </div>
    {busy && setup?.status === 'preparing' && <p className="row-meta" role="status">{setup.message}</p>}
    {result?.error && <p className="error" role="alert">{result.error.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}</p>}
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
      {state?.models && <MenuSection title="Cursor CLI">{state.models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase())).map(m => <MenuItem key={m.id} label={m.name} detail={m.name !== m.id ? m.id : null} checked={(value?.id ?? state.currentModelId) === m.id} onClick={() => { onChange({ provider: 'cursor', id: m.id, name: m.name }); close(); }} />)}</MenuSection>}
      {state?.models?.length === 0 && <div className="menu-empty">This Cursor CLI did not advertise models. Update the CLI and check your login.</div>}
    </div>
    <div className="menu-foot"><MenuItem icon="refresh" label="Refresh models" onClick={() => setVersion(v => v + 1)} /><MenuItem icon="settings" label="Cursor SDK settings…" onClick={() => { close(); openSettings(true, 'cursor'); }} /></div>
  </div>;
}
