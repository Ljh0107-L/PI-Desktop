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
  const label = status === 'missing' ? 'Install Antigravity' : status === 'signedOut' ? 'Sign in to Antigravity' : 'Antigravity account';
  return <button type="button" className={`trigger ${status === 'missing' || status === 'signedOut' ? 'attention' : ''}`}
    onClick={() => openAntigravitySettings(environmentId)} title={`${label} on ${machine}`}>
    <Icon name="key" size={14} /><span>{label}</span>
  </button>;
}

export function AntigravityLogin({ session }) {
  const bypass = useStore(s => s.settings?.defaults?.antigravityBypassPermissions !== false);
  const state = session.antigravity;
  if (session.status !== 'connected' || !state) return null;
  if (state.authRequired) return <div className="conn-banner">
    <Icon name="key" size={14} />
    <span className="conn-text">Sign in to Antigravity on <b>{session.environmentLabel}</b> to send a message.</span>
    <button type="button" className="button small" onClick={() => openAntigravitySettings(session.environmentId)}>Sign in</button>
  </div>;
  if ((state.permissionMode ?? 'confirm') !== (bypass ? 'bypassPermissions' : 'confirm') && !session.streaming) {
    return <div className="conn-banner"><Icon name="shield" size={14} /><span className="conn-text">The new permission setting applies on your next message.</span></div>;
  }
  return null;
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
  const bypass = state?.permissionMode === 'bypassPermissions';
  return <>
    {options.map(option => <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
      disabled={changing || session.streaming || session.status !== 'connected'}
      menu={close => <MenuSection title={option.name}>
        {option.options.map(choice => <MenuItem key={choice.value} label={choice.name} checked={choice.value === option.currentValue}
          onClick={() => { close(); if (choice.value !== option.currentValue) void change(option.id, choice.value); }} />)}
      </MenuSection>}>
      <span className={option.category === 'model' ? 'strong' : undefined}>{option.options.find(choice => choice.value === option.currentValue)?.name ?? option.name}</span><Icon name="chevronDown" size={11} />
    </Trigger>)}
    {state && !state.authRequired && <button type="button" className={`trigger agy-mode ${bypass ? 'bypass' : ''}`}
      onClick={() => openAntigravitySettings(session.environmentId)} title={bypass ? 'Antigravity can run tools without asking. Open permission settings.' : 'Antigravity can ask before running tools. Open permission settings.'}>
      <Icon name={bypass ? 'shieldAlert' : 'shield'} size={14} /><span>{bypass ? 'Bypass' : 'Ask'}</span>
    </button>}
  </>;
}

function CopyUsageCommand() {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="button small" onClick={async () => {
    try { await navigator.clipboard.writeText('/usage'); setCopied(true); }
    catch { notify('Could not copy. Type /usage in the terminal instead.', 'error'); }
  }}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy /usage'}</button>;
}

function AccountCard({ environmentId }) {
  const [account, setAccount] = useState(null);
  const [busy, setBusy] = useState('check');
  const [error, setError] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const check = useCallback(async () => {
    setBusy('check'); setError(null);
    try {
      const result = await api('antigravityAccount', environmentId, false);
      setAccount(result);
      reportAntigravityAccount(environmentId, result);
    } catch (err) {
      setError(cleanError(err));
      // A failed auth-status check shouldn't hide the CLI's own login/usage controls.
      try { setAccount(await api('antigravityInfo', environmentId)); } catch { /* already showing the connection error */ }
    }
    finally { setBusy(null); }
  }, [environmentId]);
  useEffect(() => { void check(); }, [check]);
  const action = async task => {
    setBusy(task); setError(null);
    try {
      if (task === 'install') {
        await api('antigravityInstall', environmentId);
        await check();
      } else {
        const result = await api('antigravityAccount', environmentId, true);
        setAccount(result);
        reportAntigravityAccount(environmentId, result);
        if (!result.signedIn) setError('Google sign-in did not complete. Try again or use Terminal sign-in.');
      }
    } catch (err) { setError(cleanError(err)); }
    finally { setBusy(null); }
  };
  const terminalExited = useCallback((code) => { if (!code && terminal === 'login') void check(); }, [check, terminal]);
  const status = busy === 'install' ? 'Installing CLI…' : busy === 'login' ? 'Finish sign-in in your browser…'
    : busy === 'check' ? 'Checking CLI and sign-in…' : account?.installed === false ? 'CLI not installed'
      : !account ? 'Status unavailable' : account.signedIn === true ? 'Signed in' : account.signedIn === false ? 'Sign-in required' : 'Sign-in status not reported';
  return <div className="agy-account">
    <div className="agy-setting-row">
      <div className="agy-setting-copy">
        <span className="agy-setting-label">Antigravity CLI</span>
        <span className="agy-setting-status" role="status">{busy ? <Spinner size={12} /> : account?.signedIn && <Icon name="check" size={13} />}{status}</span>
      </div>
      <div className="agy-setting-actions">
        {account?.installed === false && <button type="button" className="button primary" disabled={!!busy} onClick={() => void action('install')}>Install CLI</button>}
        {account?.installed && account.signedIn !== true && environmentId === 'local' && account.canSignIn &&
          <button type="button" className="button primary" disabled={!!busy} onClick={() => void action('login')}>Sign in with Google</button>}
        {account?.installed && account.signedIn !== true && <button type="button" className={`button ${environmentId !== 'local' || !account.canSignIn ? 'primary' : ''}`}
          disabled={!!busy || terminal === 'login'} onClick={() => setTerminal('login')}>Sign in using Terminal</button>}
        <button type="button" className="button" disabled={!!busy} onClick={check}>Refresh</button>
      </div>
    </div>
    {error && <p className="agy-settings-error" role="alert">{error}</p>}
    <div className="agy-setting-row">
      <div className="agy-setting-copy">
        <span className="agy-setting-label">Quota and credits</span>
        <span className="muted">Check your remaining allowance in the Antigravity CLI.</span>
      </div>
      <button type="button" className="button" disabled={!account?.installed || account.signedIn === false || terminal === 'usage' || !!busy}
        onClick={() => setTerminal('usage')}>View quota in Terminal</button>
    </div>
    {terminal && <section className="agy-terminal-card" aria-label="Antigravity terminal">
      <div className="agy-setting-row">
        <div className="agy-setting-copy">
          <span className="agy-setting-label">{terminal === 'login' ? 'Google sign-in' : 'Antigravity quota'}</span>
          <span className="muted">{terminal === 'login' ? 'Open the Google link shown below and paste the code into this terminal.' : <>Type or paste <code>/usage</code> below and press Enter.</>}</span>
        </div>
        <div className="agy-setting-actions">
          {terminal === 'usage' && <CopyUsageCommand />}
          <button type="button" className="button small" onClick={() => setTerminal(null)}>Close terminal</button>
        </div>
      </div>
      <AntigravityTerminal key={terminal} environmentId={environmentId} action={terminal} onExit={terminalExited} />
    </section>}
  </div>;
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
  return <div className="agy-settings">
    <section className="section">
      <div className="section-head"><h2 className="section-title">Account</h2></div>
      <p className="muted">Install and sign in on the machine that runs your conversations. Credentials are never copied between this Mac and SSH hosts.</p>
      <label className="field agy-environment"><span className="field-label">Machine</span>
        <select value={environmentId} onChange={e => select(e.target.value)}>{environments.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
      </label>
      <AccountCard key={environmentId} environmentId={environmentId} />
    </section>
    <section className="section">
      <div className="section-head"><h2 className="section-title">Tool permissions</h2></div>
      <div className="agy-setting-row">
        <div className="agy-setting-copy">
          <span className="agy-setting-label">Bypass tool permissions</span>
          <span className="muted">Antigravity may run commands and edit files with your account’s access without asking. Applies on your next message; active turns are unchanged.</span>
        </div>
        <button type="button" role="switch" aria-checked={bypass} aria-label="Bypass tool permissions" className={`switch ${bypass ? 'on' : ''}`} disabled={saving} onClick={toggle}><span /></button>
      </div>
    </section>
  </div>;
}
