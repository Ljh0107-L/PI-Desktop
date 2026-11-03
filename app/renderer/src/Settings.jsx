// Full-window Settings, modelled on DSH's settings sections and Codex's Connections page.
import { CursorSettings } from './Cursor.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, Modal, Popover, Spinner } from './ui.jsx';
import { api, loadCatalog, openSettings, setAddConnectionOpen, setEnvironments, setSettings, useStore } from './store.js';
import { formatTokens as fmtTokens } from './transcript.js';

const CUSTOM_APIS = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions compatible' },
  { id: 'openai-responses', label: 'OpenAI Responses compatible' },
  { id: 'anthropic-messages', label: 'Anthropic Messages compatible' },
];
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';

// ---------------------------------------------------------------- models
// "128K" / "1M" / "200000" <-> numbers, the way DSH shows token limits.
const parseTokens = text => {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(text ?? ''));
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1048576 : m[2].toLowerCase() === 'k' ? 1024 : 1));
};
const formatTokens = n => !n ? '' : n % 1048576 === 0 ? `${n / 1048576}M` : n % 1024 === 0 ? `${n / 1024}K` : n >= 1000000 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Editable form of a model; `base` keeps the provider's original fields (compat, cost, …) for built-ins.
const toRow = m => ({
  base: m, id: m.id, name: m.name && m.name !== m.id ? m.name : '',
  contextWindow: formatTokens(m.contextWindow ?? 131072), maxTokens: formatTokens(m.maxTokens ?? 16384),
  input: m.input ?? ['text'], reasoning: m.reasoning ?? true,
  levels: Object.entries(m.thinkingLevelMap ?? {}).map(([level, value]) => ({ level, value: value ?? '' })),
  open: false,
});
const fromRow = r => {
  const { provider, type, ...base } = r.base ?? {};
  const map = Object.fromEntries(r.levels.filter(l => l.level).map(l => [l.level, l.value.trim() || null]));
  return { ...base, id: r.id.trim(), name: r.name.trim() || r.id.trim(), contextWindow: parseTokens(r.contextWindow) ?? 131072, maxTokens: parseTokens(r.maxTokens) ?? 16384,
    input: r.input.length ? r.input : ['text'], reasoning: r.reasoning, thinkingLevelMap: r.reasoning && Object.keys(map).length ? map : undefined };
};

function ModelRow({ model, onChange, onRemove }) {
  const set = patch => onChange({ ...model, ...patch });
  const toggleInput = kind => set({ input: model.input.includes(kind) ? model.input.filter(k => k !== kind) : [...model.input, kind] });
  const setLevel = (i, patch) => set({ levels: model.levels.map((l, j) => j === i ? { ...l, ...patch } : l) });
  const unused = LEVELS.filter(l => !model.levels.some(x => x.level === l));
  return (
    <div className={`model-entry ${model.open ? 'open' : ''}`}>
      <div className="model-row">
        <input value={model.id} onChange={e => set({ id: e.target.value })} placeholder="model-id" spellCheck={false} />
        <input value={model.name} onChange={e => set({ name: e.target.value })} placeholder={model.id || 'Display name'} />
        <button type="button" className="icon-button" onClick={() => set({ open: !model.open })} aria-label="Parameters"><Icon name="chevronDown" size={16} className={model.open ? 'flip' : ''} /></button>
        <button type="button" className="icon-button danger" onClick={onRemove} aria-label="Remove model"><Icon name="trash" size={15} /></button>
      </div>
      {model.open && <div className="model-advanced">
        <div className="field-pair">
          <label className="field"><span className="field-label">Context window</span><input value={model.contextWindow} onChange={e => set({ contextWindow: e.target.value })} placeholder="128K" /></label>
          <label className="field"><span className="field-label">Max output tokens</span><input value={model.maxTokens} onChange={e => set({ maxTokens: e.target.value })} placeholder="16K" /></label>
        </div>
        <div className="field"><span className="field-label">Input</span>
          <div className="check-group">
            <label className="check"><input type="checkbox" checked={model.input.includes('text')} onChange={() => toggleInput('text')} /> Text</label>
            <label className="check"><input type="checkbox" checked={model.input.includes('image')} onChange={() => toggleInput('image')} /> Image</label>
          </div>
        </div>
        <div className="setting-line"><span className="field-label">Reasoning</span><Toggle on={model.reasoning} label="Reasoning" onChange={on => set({ reasoning: on })} /></div>
        {model.reasoning && <div className="levels">
          {model.levels.length > 0 && <div className="levels-head"><span>Level</span><span>API value</span><span /></div>}
          {model.levels.map((l, i) => (
            <div key={i} className="level-row">
              <select value={l.level} onChange={e => setLevel(i, { level: e.target.value })}>
                {[l.level, ...unused].map(x => <option key={x} value={x}>{x}</option>)}
              </select>
              <input value={l.value} onChange={e => setLevel(i, { value: e.target.value })} placeholder="unsupported" spellCheck={false} />
              <button type="button" className="icon-button danger" onClick={() => set({ levels: model.levels.filter((_, j) => j !== i) })} aria-label="Remove level"><Icon name="trash" size={15} /></button>
            </div>
          ))}
          {unused.length > 0 && <button type="button" className="button small" onClick={() => set({ levels: [...model.levels, { level: unused.find(x => x !== 'off') ?? unused[0], value: unused.find(x => x !== 'off') ?? '' }] })}><Icon name="plus" size={14} /> Add level</button>}
        </div>}
      </div>}
    </div>
  );
}

// Choose models from what the provider offers.
function ModelPicker({ available, selected, onDone, onClose }) {
  const [picked, setPicked] = useState(() => new Set(selected));
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = available.filter(m => !q || `${m.id} ${m.name ?? ''}`.toLowerCase().includes(q));
  const allShown = shown.length > 0 && shown.every(m => picked.has(m.id));
  const toggleAll = () => setPicked(set => { const n = new Set(set); for (const m of shown) allShown ? n.delete(m.id) : n.add(m.id); return n; });
  const toggle = id => setPicked(set => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title="Choose models" onClose={onClose} width={560} footer={<>
      <button className="link-button" onClick={toggleAll}>{allShown ? 'Deselect all' : 'Select all'}</button>
      <span className="spacer" />
      <span className="picker-count">{picked.size} of {available.length}</span>
      <button className="button primary" onClick={() => onDone(picked)}>Done</button>
    </>}>
      <div className="search-field"><Icon name="search" size={15} /><input autoFocus placeholder="Search models" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="pick-list">
        {shown.map(m => (
          <label key={m.id} className={`pick-row ${picked.has(m.id) ? 'on' : ''}`}>
            <span className="pick-text" title={m.id}><span className="pick-name">{m.name && m.name !== m.id ? m.name : m.id}</span></span>
            {m.contextWindow && <span className="pick-meta">{formatTokens(m.contextWindow)}</span>}
            <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
          </label>
        ))}
        {!shown.length && <div className="grouped-empty">No matching models</div>}
      </div>
    </Modal>
  );
}

function ProviderEditor({ initial, onDone }) {
  const builtin = useStore(s => s.settings.builtinProviders);
  const existing = useStore(s => s.settings.providers);
  const editing = !!initial;
  const [kind, setKind] = useState(initial?.kind ?? 'builtin');
  const [builtinId, setBuiltinId] = useState(initial?.kind === 'builtin' ? initial.id : Object.keys(builtin).find(id => !existing.some(p => p.id === id)) ?? 'deepseek');
  const [name, setName] = useState(initial?.name ?? '');
  const [apiType, setApiType] = useState(initial?.api ?? 'openai-completions');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [models, setModels] = useState(() => (initial?.models ?? []).map(toRow));
  const [key, setKey] = useState('');
  const [available, setAvailable] = useState(null);
  const [picking, setPicking] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const draft = () => kind === 'builtin' ? { kind, id: builtinId } : { kind, id: initial?.id ?? slug(name || 'custom'), api: apiType, baseUrl: baseUrl.trim() };
  const reset = () => { setAvailable(null); setModels([]); setError(null); };

  const fetchModels = async ({ autoSelect = false } = {}) => {
    setFetching(true); setError(null);
    try {
      const list = await api('listProviderModels', draft(), key.trim() || undefined);
      setAvailable(list);
      if (!list.length) setError({ message: 'The provider returned no models.' });
      else if (autoSelect && !models.length) setModels(list.map(toRow));
      else setPicking(true);
    } catch (err) { setError({ message: err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    finally { setFetching(false); }
  };
  // A built-in provider saved before model lists existed: load its catalog so it can be edited.
  useEffect(() => { if (editing && initial.kind === 'builtin' && initial.hasKey && !models.length) fetchModels({ autoSelect: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPicked = picked => {
    const keep = models.filter(m => picked.has(m.id));
    const added = (available ?? []).filter(m => picked.has(m.id) && !keep.some(k => k.id === m.id)).map(toRow);
    const order = new Map((available ?? []).map((m, i) => [m.id, i]));
    setModels([...keep, ...added].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)));
    setPicking(false);
  };

  const save = async e => {
    e.preventDefault();
    setError(null);
    const rows = models.filter(m => m.id.trim());
    let provider;
    if (kind === 'builtin') {
      provider = { id: builtinId, name: builtin[builtinId], kind: 'builtin', models: rows.length ? rows.map(fromRow) : undefined };
    } else {
      if (!name.trim()) return setError({ field: 'name', message: 'Give this provider a name.' });
      if (!/^https?:\/\//.test(baseUrl.trim())) return setError({ field: 'baseUrl', message: 'Enter a URL starting with https://' });
      if (!rows.length) return setError({ message: 'Add at least one model.' });
      provider = { id: initial?.id ?? slug(name), name: name.trim(), kind: 'custom', api: apiType, baseUrl: baseUrl.trim().replace(/\/$/, ''), models: rows.map(fromRow) };
    }
    if (!editing && !key.trim()) return setError({ field: 'key', message: 'Paste the API key for this provider.' });
    setBusy(true);
    try {
      setSettings(await api('saveProvider', provider, key.trim() || undefined));
      await loadCatalog();
      onDone();
    } catch (err) { setError({ message: err.message }); }
    finally { setBusy(false); }
  };
  const fieldError = f => error?.field === f && <span className="field-error">{error.message}</span>;
  const keyField = (
    <label className={`field ${error?.field === 'key' ? 'invalid' : ''}`}><span className="field-label">API key</span>
      <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={editing ? '•••••••• saved' : 'sk-…'} autoComplete="off" spellCheck={false} />{fieldError('key')}</label>
  );
  return (
    <form className="editor" onSubmit={save}>
      {!editing && <div className="segmented">
        <button type="button" className={kind === 'builtin' ? 'on' : ''} onClick={() => { setKind('builtin'); reset(); }}>Built-in provider</button>
        <button type="button" className={kind === 'custom' ? 'on' : ''} onClick={() => { setKind('custom'); reset(); }}>Custom endpoint</button>
      </div>}
      {kind === 'builtin' ? (
        <div className="field-pair">
          <label className="field"><span className="field-label">Provider</span>
            <select value={builtinId} onChange={e => { setBuiltinId(e.target.value); reset(); }} disabled={editing}>
              {Object.entries(builtin).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {keyField}
        </div>
      ) : <>
        <div className="field-pair">
          <label className={`field ${error?.field === 'name' ? 'invalid' : ''}`}><span className="field-label">Name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Company relay" />{fieldError('name')}</label>
          <label className="field"><span className="field-label">API protocol</span>
            <select value={apiType} onChange={e => setApiType(e.target.value)}>{CUSTOM_APIS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
          </label>
        </div>
        <div className="field-pair">
          <label className={`field ${error?.field === 'baseUrl' ? 'invalid' : ''}`}><span className="field-label">Base URL</span><input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" spellCheck={false} />{fieldError('baseUrl')}</label>
          {keyField}
        </div>
      </>}

      <div className="model-catalog">
        <div className="model-catalog-head">
          <span className="model-catalog-title">Models{models.length ? ` · ${models.length}` : ''}</span>
          <div className="model-catalog-actions">
            {models.length > 0 && <button type="button" className="link-button" onClick={() => setModels(list => list.map(m => ({ ...m, open: false })))}>Collapse all</button>}
            <button type="button" className="link-button" onClick={() => available ? setPicking(true) : fetchModels()} disabled={fetching}>{fetching ? <Spinner size={12} /> : <Icon name="list" size={14} />} Choose models</button>
          </div>
        </div>
        <div className="model-list">
          {models.map((m, i) => <ModelRow key={m.base?.id ?? i + ':' + m.id} model={m} onChange={next => setModels(list => list.map((x, j) => j === i ? next : x))} onRemove={() => setModels(list => list.filter((_, j) => j !== i))} />)}
          {!models.length && <button type="button" className="add-button slim" onClick={() => fetchModels({ autoSelect: false })} disabled={fetching}>{fetching ? <Spinner size={13} /> : <Icon name="refresh" size={15} />} Fetch available models</button>}
          <button type="button" className="button small add-model" onClick={() => setModels(list => [...list.map(m => ({ ...m, open: false })), { ...toRow({ id: '' }), open: true }])}><Icon name="plus" size={14} /> Add model</button>
        </div>
      </div>
      {picking && available && <ModelPicker available={available} selected={models.map(m => m.id)} onDone={applyPicked} onClose={() => setPicking(false)} />}

      {error && !error.field && <div className="form-error"><Icon name="alert" size={14} /> {error.message}</div>}
      <div className="editor-actions">
        <button type="button" className="button ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? <Spinner size={13} /> : editing ? 'Save' : 'Add provider'}</button>
      </div>
    </form>
  );
}

function ModelsPage() {
  const providers = useStore(s => s.settings.providers);
  const builtin = useStore(s => s.settings.builtinProviders);
  const [editing, setEditing] = useState(null); // provider id | 'new'
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Model providers</h2>
      </div>
      <ul className="rows">
        {providers.map(p => {
          return (
            <li key={p.id} className="row-card">
              <div className="row-head">
                <span className={`credential-dot ${p.hasKey ? 'ok' : 'missing'}`} title={p.hasKey ? 'Key saved' : 'No key'} />
                <div className="row-identity">
                  <span className="row-name">{p.name ?? builtin[p.id] ?? p.id}</span>
                </div>
                <div className="row-actions">
                  <button className="button small" onClick={() => setEditing(editing === p.id ? null : p.id)}>Edit</button>
                  <button className="button small danger" onClick={async () => { setSettings(await api('deleteProvider', p.id)); loadCatalog(); }}>Remove</button>
                </div>
              </div>
              {editing === p.id && <ProviderEditor initial={p} onDone={() => setEditing(null)} />}
            </li>
          );
        })}
        {editing === 'new'
          ? <li className="row-card adding"><div className="row-head"><span className="row-name">New provider</span></div><ProviderEditor onDone={() => setEditing(null)} /></li>
          : <li><button className="add-button" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add provider</button></li>}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- connections
function Toggle({ on, onChange, label }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span /></button>;
}

function ConnectionCard({ env }) {
  const st = useStore(s => s.envStatus[env.id]);
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const state = !env.enabled ? 'off' : st?.status ?? (env.root ? 'known' : 'idle');
  const status = {
    off: { dot: '', text: 'Turned off' },
    preparing: { dot: 'connecting', text: st?.message ?? 'Setting up…' },
    ready: { dot: 'connected', text: `Ready · Node ${st?.facts?.nodeVersion?.replace(/^v/, '') ?? ''}${st?.facts?.unreachable?.length ? ' · models via this Mac' : ''}` },
    error: { dot: 'error', text: st?.message },
    known: { dot: 'connected', text: 'Set up' },
    idle: { dot: '', text: 'Not set up yet' },
  }[state];
  return (
    <li className={`row-card connection ${state}`}>
      <div className="row-head">
        <Toggle on={env.enabled} label={`Use ${env.label}`} onChange={async on => { setEnvironments(await api('setConnectionEnabled', env.id, on)); if (on) api('prepareEnvironment', env.id); }} />
        <div className="connection-main">
          <div className="row-identity"><Icon name={env.source === 'manual' ? 'globe' : 'terminal'} size={15} className="connection-icon" /><span className="row-name" title={env.detail}>{env.label}</span></div>
        </div>
        <div className="row-actions">
          <span className={`connection-state ${state}`} title={status.text}>{state === 'preparing' ? <Spinner size={12} /> : <span className={`status-dot ${status.dot}`} />}</span>
          {state === 'error' && <button className="button small" title={status.text} onClick={() => api('prepareEnvironment', env.id, true)}>Retry</button>}
          <button ref={anchor} className="icon-button" aria-label="More" onClick={() => setMenu(m => !m)}><Icon name="more" size={16} /></button>
          <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={210} placement="bottom-end">
            <MenuItem icon="refresh" label="Check again" disabled={!env.enabled} onClick={() => { setMenu(false); api('prepareEnvironment', env.id, true); }} />
            <MenuItem icon="trash" label="Remove" className="danger" onClick={async () => { setMenu(false); setEnvironments(await api('removeConnection', env.id)); }} />
          </Popover>
        </div>
      </div>
    </li>
  );
}

function AddConnectionDialog({ onClose }) {
  const environments = useStore(s => s.environments);
  const candidates = environments.filter(e => e.kind === 'ssh' && !e.added && e.source === 'config');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState({ label: '', host: '', port: '', identityFile: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => candidates.filter(e => !q || `${e.label} ${e.detail}`.toLowerCase().includes(q))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), [candidates, q]);
  const toggle = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      setEnvironments(manual ? await api('addManualConnection', form) : await api('addConnections', [...picked]));
      onClose();
    } catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); setBusy(false); }
  };
  return (
    <Modal title="Add SSH connection" onClose={onClose} width={520} footer={<>
      <button className="link-button" onClick={() => { setManual(m => !m); setError(null); }}>{manual ? <><Icon name="back" size={15} /> Choose from SSH config</> : <><Icon name="edit" size={14} /> Add manually</>}</button>
      <span className="spacer" />
      <button className="button primary" disabled={busy || (manual ? !form.host.trim() : !picked.size)} onClick={submit}>{busy ? <Spinner size={13} /> : manual || picked.size < 2 ? 'Add' : `Add ${picked.size}`}</button>
    </>}>
      {manual ? (
        <div className="manual-form">
          <label className="field"><span className="field-label">SSH host</span><input autoFocus value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder="user@hostname" spellCheck={false} /></label>
          <div className="field-pair">
            <label className="field"><span className="field-label">Name</span><input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Optional" /></label>
            <label className="field small"><span className="field-label">Port</span><input value={form.port} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} placeholder="22" /></label>
          </div>
          <label className="field"><span className="field-label">SSH key</span><input value={form.identityFile} onChange={e => setForm({ ...form, identityFile: e.target.value })} placeholder="~/.ssh/id_ed25519" spellCheck={false} /></label>
        </div>
      ) : <>
        <div className="search-field"><Icon name="search" size={15} /><input autoFocus placeholder="Search ~/.ssh/config" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="pick-list">
          {shown.map(env => (
            <label key={env.id} className={`pick-row ${picked.has(env.id) ? 'on' : ''}`}>
              <Icon name="terminal" size={17} />
              <span className="pick-text" title={env.detail}><span className="pick-name">{env.label}</span></span>
              <input type="checkbox" checked={picked.has(env.id)} onChange={() => toggle(env.id)} />
            </label>
          ))}
          {!shown.length && <div className="grouped-empty">{candidates.length ? 'No matching hosts' : 'Every host in ~/.ssh/config is already added'}</div>}
        </div>
      </>}
      {error && <div className="form-error"><Icon name="alert" size={14} /> {error}</div>}
    </Modal>
  );
}

function ConnectionsPage() {
  const environments = useStore(s => s.environments);
  const adding = useStore(s => s.addConnectionOpen);
  const added = environments.filter(e => e.kind === 'ssh' && e.added);
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">SSH connections from this Mac</h2>
        <button className="button pill" onClick={() => setAddConnectionOpen(true)}>Add</button>
      </div>
      <ul className="rows">
        {added.map(env => <ConnectionCard key={env.id} env={env} />)}
        {!added.length && <li><button className="add-button" onClick={() => setAddConnectionOpen(true)}><Icon name="plus" size={16} /> Add an SSH connection</button></li>}
      </ul>
      {adding && <AddConnectionDialog onClose={() => setAddConnectionOpen(false)} />}
    </section>
  );
}

// ---------------------------------------------------------------- usage
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKS = 53;

// A year of daily token counts, one column per week (Sunday on top), like a contribution graph.
function Heatmap({ days }) {
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const { columns, months, max } = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
    const columns = [], months = [];
    let max = 0;
    for (let w = 0; w < WEEKS; w++) {
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start); date.setDate(start.getDate() + w * 7 + d);
        const key = dayKey(date), tokens = days[key] ?? 0;
        if (date <= today) max = Math.max(max, tokens);
        cells.push({ key, date, tokens, future: date > today });
      }
      if (w === 0 || cells[0].date.getMonth() !== columns[w - 1][0].date.getMonth()) months.push({ column: w, label: MONTHS[cells[0].date.getMonth()] });
      columns.push(cells);
    }
    return { columns, months: months.filter((m, i) => i === months.length - 1 || months[i + 1].column - m.column >= 3), max };
  }, [days]);
  const level = t => !t || !max ? 0 : Math.max(1, Math.ceil(4 * Math.log1p(t) / Math.log1p(max)));
  const show = (e, cell) => {
    const r = box.current.getBoundingClientRect(), c = e.currentTarget.getBoundingClientRect();
    setHover({ ...cell, x: c.left - r.left + c.width / 2, y: c.top - r.top });
  };
  return (
    <div className="heatmap" ref={box} onMouseLeave={() => setHover(null)}>
      <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${WEEKS}, 1fr)` }}>
        {columns.map((cells, w) => cells.map((cell, d) => (
          <span key={cell.key} className={`heat-cell l${level(cell.tokens)} ${cell.future ? 'future' : ''}`} style={{ gridColumn: w + 1, gridRow: d + 1 }}
            onMouseEnter={cell.future ? undefined : e => show(e, cell)} />
        )))}
      </div>
      <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${WEEKS}, 1fr)` }}>
        {months.map(m => <span key={m.column} style={{ gridColumn: `${m.column + 1} / span 3` }}>{m.label}</span>)}
      </div>
      {hover && <div className="heat-tip" style={{ left: hover.x, top: hover.y }}>
        <span>{MONTHS[hover.date.getMonth()]} {hover.date.getDate()}</span>
        <b>{hover.tokens ? `${fmtTokens(hover.tokens)} tokens` : 'No usage'}</b>
      </div>}
    </div>
  );
}

function UsagePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const providers = useStore(s => s.settings.providers);
  const catalog = useStore(s => s.catalog);
  useEffect(() => { api('usageSummary').then(setData, e => setError(e.message)); }, []);
  if (error) return <div className="form-error"><Icon name="alert" size={14} /> {error}</div>;
  if (!data) return <div className="usage-loading"><Spinner size={14} /> Reading conversations…</div>;
  const { totals, days, models, today } = data;
  const activeDays = Object.values(days).filter(Boolean).length;
  const modelName = m => catalog.find(c => c.provider === m.provider && c.id === m.model)?.name ?? m.model;
  const providerName = id => providers.find(p => p.id === id)?.name ?? id;
  const top = models[0]?.tokens || 1;
  const stats = [
    { label: 'Total tokens', value: fmtTokens(totals.tokens) },
    { label: 'Today', value: fmtTokens(days[today] ?? 0) },
    { label: 'Active days', value: String(activeDays) },
  ];
  return <>
    <section className="section">
      <div className="usage-stats">
        {stats.map(s => <div key={s.label} className="usage-stat"><span className="usage-stat-label">{s.label}</span><span className="usage-stat-value">{s.value}</span></div>)}
      </div>
      <div className="usage-split">
        <span>Input <b>{fmtTokens(totals.input)}</b></span>
        <span>Cache read <b>{fmtTokens(totals.cacheRead)}</b></span>
        <span>Cache write <b>{fmtTokens(totals.cacheWrite)}</b></span>
        <span>Output <b>{fmtTokens(totals.output)}</b></span>
      </div>
    </section>
    <section className="section">
      <div className="section-head"><h2 className="section-title">Token activity</h2></div>
      <Heatmap days={days} />
    </section>
    <section className="section">
      <div className="section-head"><h2 className="section-title">Models</h2></div>
      {models.length ? <ol className="model-rank">
        {models.map((m, i) => (
          <li key={`${m.provider}/${m.model}`} className="model-rank-row">
            <span className="model-rank-n">{i + 1}</span>
            <span className="model-rank-name" title={`${m.provider}/${m.model}`}>{modelName(m)}<span className="model-rank-provider">{providerName(m.provider)}</span></span>
            <span className="model-rank-bar"><span style={{ width: `${Math.max(2, 100 * m.tokens / top)}%` }} /></span>
            <span className="model-rank-tokens">{fmtTokens(m.tokens)}</span>
            <span className="model-rank-share">{Math.round(100 * m.tokens / (totals.tokens || 1))}%</span>
          </li>
        ))}
      </ol> : <div className="grouped-empty">No usage yet — it appears here after your first reply.</div>}
    </section>
  </>;
}

// ---------------------------------------------------------------- page
export function SettingsPage() {
  const tab = useStore(s => s.settingsTab);
  const pages = [
    { id: 'providers', label: 'Models', icon: 'sparkle', title: 'Models' },
    { id: 'cursor', label: 'Cursor SDK', icon: 'terminal', title: 'Cursor SDK' },
    { id: 'connections', label: 'Connections', icon: 'server', title: 'Connections' },
    { id: 'usage', label: 'Usage', icon: 'gauge', title: 'Usage' },
  ];
  const page = pages.find(p => p.id === tab) ?? pages[0];
  return (
    <div className="settings-page-root">
      <aside className="settings-sidebar">
        <div className="sidebar-top drag" />
        <button className="nav-item back no-drag" onClick={() => openSettings(false)}><Icon name="arrowLeft" size={17} /> Back to app</button>
        <nav className="settings-sidebar-nav">
          {pages.map(p => <button key={p.id} className={`nav-item ${p.id === page.id ? 'active' : ''}`} onClick={() => openSettings(true, p.id)}><Icon name={p.icon} size={17} /> {p.label}</button>)}
        </nav>
      </aside>
      <main className="settings-main">
        <div className="settings-drag drag" />
        <div className="settings-content">
          <h1 className="settings-title">{page.title}</h1>
          {page.id === 'providers' ? <ModelsPage /> : page.id === 'cursor' ? <CursorSettings /> : page.id === 'usage' ? <UsagePage /> : <ConnectionsPage />}
        </div>
      </main>
    </div>
  );
}
