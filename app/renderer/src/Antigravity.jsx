import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Spinner, Trigger } from './ui.jsx';
import { AntigravityTerminal } from './TerminalPanel.jsx';
import { api, notify, openSettings, refreshAntigravityReadiness, reportAntigravityAccount, setSettings, useStore } from './store.js';
import './antigravity.css';

const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const showError = error => notify(cleanError(error), 'error');
export const openAntigravitySettings = environmentId => openSettings(true, 'antigravity', { environmentId });

export function AntigravitySetup({ environmentId }) {
  const status = useStore(s => s.antigravityReadiness[environmentId]);
  const machine = useStore(s => s.environments.find(env => env.id === environmentId)?.label) ?? 'the selected machine';
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const check = () => void refreshAntigravityReadiness(environmentId);
    const timer = setTimeout(check, 250);
    window.addEventListener('focus', check);
    return () => { clearTimeout(timer); window.removeEventListener('focus', check); };
  }, [environmentId]);
  if (status === 'unreachable') return <button type="button" className="trigger attention" disabled={retrying}
    title={`Can’t reach ${machine}. Try connecting again.`} onClick={async () => {
      setRetrying(true);
      try { await refreshAntigravityReadiness(environmentId); } finally { setRetrying(false); }
    }}>
    {retrying ? <Spinner size={13} /> : <Icon name="unplug" size={14} />}
    <span>{retrying ? 'Connecting…' : 'Can’t connect · Retry'}</span>
  </button>;
  const label = status === 'missing' ? 'Install CLI' : status === 'signedOut' ? 'Sign in' : 'Account';
  return <button type="button" className={`trigger ${status === 'missing' || status === 'signedOut' ? 'attention' : ''}`}
    onClick={() => openAntigravitySettings(environmentId)} title={`${label} on ${machine}`}>
    <Icon name="key" size={14} /><span>{label}</span>
  </button>;
}

export function AntigravityLogin({ session }) {
  if (session.status !== 'connected' || !session.antigravity?.authRequired) return null;
  return <div className="conn-banner">
    <Icon name="key" size={14} />
    <span className="conn-text">Sign in to send a message.</span>
    <button type="button" className="button small" onClick={() => openAntigravitySettings(session.environmentId)}>Sign in</button>
  </div>;
}

export function AntigravityOptions({ session }) {
  const [changing, setChanging] = useState(false);
  const state = session.antigravity;
  const options = state?.authRequired ? [] : state?.options ?? [];
  const change = async (configId, value) => {
    setChanging(true);
    try { await api('antigravitySetConfig', session.id, configId, value); }
    catch (error) { showError(error); }
    finally { setChanging(false); }
  };
  return <>
    {options.map(option => <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
      disabled={changing || session.streaming || session.status !== 'connected'}
      menu={close => <MenuSection title={option.name}>
        {option.options.map(choice => <MenuItem key={choice.value} label={choice.name} checked={choice.value === option.currentValue}
          onClick={() => { close(); if (choice.value !== option.currentValue) void change(option.id, choice.value); }} />)}
      </MenuSection>}>
      <span className={option.category === 'model' ? 'strong' : undefined}>{option.options.find(choice => choice.value === option.currentValue)?.name ?? option.name}</span><Icon name="chevronDown" size={11} />
    </Trigger>)}
  </>;
}

function CopyUsageCommand() {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="button small" onClick={async () => {
    try { await navigator.clipboard.writeText('/usage'); setCopied(true); }
    catch { notify('Could not copy. Type /usage in the terminal instead.', 'error'); }
  }}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy /usage'}</button>;
}

const installLabels = { preparing: 'Preparing…', downloading: 'Downloading…', uploading: 'Uploading…', installing: 'Installing…' };

function InstallProgress({ progress }) {
  const label = installLabels[progress?.stage] ?? installLabels.preparing;
  const percent = progress?.percent ?? undefined;
  return <div className="agy-install">
    <div role="status"><span>{label}</span>{percent !== undefined && <span>{percent}%</span>}</div>
    <progress aria-label={label} max={100} value={percent} />
  </div>;
}

function AccountRow({ environmentId }) {
  const progress = useStore(s => s.antigravityInstalls[environmentId]);
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(false);
  const [error, setError] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const installing = requesting || !!installLabels[progress?.stage];
  const check = useCallback(async () => {
    setChecking(true); setError(null);
    try {
      const info = await api('antigravityInfo', environmentId);
      setAccount(previous => info.installed && previous?.installed ? previous : info);
      const result = info.installed ? await api('antigravityAccount', environmentId, false) : info;
      setAccount(result);
      reportAntigravityAccount(environmentId, result);
      if (result.signedIn) setTerminal(open => open === 'login' ? null : open);
    } catch (err) { setError(cleanError(err)); }
    finally { setChecking(false); }
  }, [environmentId]);
  useEffect(() => { if (!installing) void check(); }, [check, installing]);
  const install = async () => {
    setRequesting(true);
    try { await api('antigravityInstall', environmentId); }
    catch { /* the progress event carries the error, including across navigation */ }
    finally { setRequesting(false); }
  };
  const signIn = async () => {
    if (!account?.canSignIn || browserFailed) { setTerminal('login'); return; }
    setSigningIn(true); setError(null);
    try {
      const result = await api('antigravityAccount', environmentId, true);
      setAccount(result);
      reportAntigravityAccount(environmentId, result);
      if (!result.signedIn) throw new Error('Sign-in did not complete. Try again in Terminal.');
    } catch (err) { setBrowserFailed(true); setError(cleanError(err)); }
    finally { setSigningIn(false); }
  };
  const terminalExited = useCallback(code => { if (!code && terminal === 'login') void check(); }, [check, terminal]);
  const signedIn = account?.signedIn === true;
  const message = progress?.stage === 'error' ? progress.message : error;
  return <>
    <div className="agy-setting-row">
      <span>Antigravity CLI</span>
      {!installing && <div className="agy-setting-actions">
        {signingIn ? <span role="status">Finish in your browser…</span> : account?.installed ? <>
          {signedIn ? <span className="agy-account-state"><Icon name="check" size={14} /> Signed in</span>
            : <button type="button" className="button primary" disabled={terminal === 'login' || (environmentId === 'local' && checking)} onClick={signIn}>{browserFailed ? 'Sign in using Terminal' : 'Sign in'}</button>}
          {(signedIn || (!checking && account.signedIn == null)) && <button type="button" className="button" title="View quota in Terminal" disabled={terminal === 'usage'} onClick={() => setTerminal('usage')}>View quota</button>}
        </> : checking ? <span className="agy-account-state" role="status"><Spinner size={14} /> Checking…</span>
          : account?.installed === false ? <button type="button" className="button primary" onClick={install}>Install CLI</button>
            : <button type="button" className="button" onClick={check}>Retry</button>}
      </div>}
      {installing && <InstallProgress progress={progress} />}
    </div>
    {message && !installing && <p className="agy-settings-error" role="alert">{message}</p>}
    {terminal && <div className="agy-terminal-card">
      <div className="agy-terminal-head">
        <span>{terminal === 'login' ? 'Google sign-in' : <>Run <code>/usage</code></>}</span>
        <div className="agy-setting-actions">
          {terminal === 'usage' && <CopyUsageCommand />}
          <button type="button" className="button small ghost" aria-label="Close terminal" title="Close terminal" onClick={() => setTerminal(null)}><Icon name="x" size={14} /></button>
        </div>
      </div>
      <AntigravityTerminal key={terminal} environmentId={environmentId} action={terminal} onExit={terminalExited} />
    </div>}
  </>;
}

export function AntigravitySettings() {
  const initialEnv = useStore(s => s.settingsEnvironmentId ?? s.draft.environmentId);
  const environments = useStore(s => s.environments.filter(e => e.kind === 'local' || (e.added && e.enabled)));
  const [selected, select] = useState(initialEnv);
  const environmentId = environments.some(e => e.id === selected) ? selected : 'local';
  const bypass = useStore(s => s.settings?.defaults?.antigravityBypassPermissions !== false);
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    try { setSettings(await api('updateDefaults', { antigravityBypassPermissions: !bypass })); }
    catch (err) { showError(err); }
    finally { setSaving(false); }
  };
  return <section className="agy-settings" aria-label="Antigravity settings">
    <label className="agy-setting-row">
      <span>Machine</span>
      <select className="inline-select" value={environmentId} onChange={e => select(e.target.value)}>{environments.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
    </label>
    <AccountRow key={environmentId} environmentId={environmentId} />
    <div className="agy-setting-row" title="When off, Antigravity can run commands and edit files without asking. Applies on your next message, on all machines.">
      <span>Ask before running tools</span>
      <button type="button" role="switch" aria-checked={!bypass} aria-label="Ask before running tools" className={`switch ${!bypass ? 'on' : ''}`} disabled={saving} onClick={toggle}><span /></button>
    </div>
  </section>;
}
