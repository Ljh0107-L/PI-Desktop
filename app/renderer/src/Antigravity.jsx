import { useEffect, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Spinner, Trigger } from './ui.jsx';
import { api, notify, set, startSession } from './store.js';

const installGuide = 'https://antigravity.google/docs/getting-started?tab=cli';
const loginGuide = 'https://antigravity.google/docs/ide/extensions/acp/#authentication';
const showError = error => notify(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
const openGuide = url => api('openExternal', url).catch(showError);

export function AntigravitySetup({ environmentId }) {
  const [check, setCheck] = useState({}), [attempt, retry] = useState(0);
  const remote = environmentId !== 'local';
  useEffect(() => {
    let mounted = true, seq = 0;
    const refresh = async () => {
      const req = ++seq;
      try {
        const { installed } = await api('antigravityInfo', environmentId);
        if (mounted && req === seq) setCheck({ installed });
      } catch (error) { if (mounted && req === seq) setCheck({ error: error.message }); }
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { mounted = false; window.removeEventListener('focus', refresh); };
  }, [attempt, environmentId]);
  const recheck = () => { setCheck({}); retry(n => n + 1); };
  if (check.error) return <button type="button" className="trigger attention" onClick={recheck} title={check.error}><Icon name="alert" size={14} /><span>Retry CLI check</span></button>;
  if (check.installed === false) return <>
    <button type="button" className="trigger attention" onClick={() => openGuide(installGuide)} title="Install the official Google Antigravity CLI"><Icon name="console" size={14} /><span>{remote ? 'Install Antigravity on host' : 'Install Antigravity CLI'}</span></button>
    <button type="button" className="trigger" onClick={recheck}>Recheck</button>
  </>;
  return <button type="button" className="trigger" disabled={!check.installed} onClick={() => startSession('').catch(showError)} title="Use Google sign-in managed by Antigravity CLI">
    {check.installed ? <Icon name="key" size={14} /> : <Spinner size={13} />}<span>{check.installed ? 'Open Antigravity' : 'Checking Antigravity CLI…'}</span>
  </button>;
}

export function AntigravityLogin({ session }) {
  const [signingIn, setSigningIn] = useState(false);
  const state = session.antigravity;
  if (session.status !== 'connected' || !state?.authRequired) return null;
  if (session.environmentId !== 'local') return <div className="conn-banner">
    <Icon name="key" size={14} /><span className="conn-text">On <b>{session.environmentLabel}</b>, run <code>agy acp --login</code> in the terminal. Complete sign-in, then reconnect.</span>
    <button type="button" className="button small" onClick={() => set({ terminalOpen: true })}>Open Terminal</button>
    <button type="button" className="button small" onClick={() => api('reconnect', session.id).catch(showError)}>Reconnect</button>
  </div>;
  const login = async () => {
    setSigningIn(true);
    try {
      const result = await api('antigravityLogin', session.id);
      if (result.authRequired) notify('Antigravity sign-in did not complete. Try again or sign in with agy in Terminal.', 'error');
    } catch (error) { showError(error); }
    finally { setSigningIn(false); }
  };
  return <div className="conn-banner">
    {signingIn ? <Spinner size={13} /> : <Icon name="key" size={14} />}
    <span className="conn-text">{signingIn ? 'Finish signing in to Antigravity in your browser…'
      : state.canSignIn ? 'Sign in with your Google account to use Antigravity CLI.' : 'Sign in with agy in Terminal, then reconnect.'}</span>
    {state.canSignIn
      ? <button type="button" className="button small" disabled={signingIn} onClick={login}>Sign in with Google</button>
      : <><button type="button" className="button small" onClick={() => openGuide(loginGuide)}>Login guide</button>
        <button type="button" className="button small" onClick={() => api('reconnect', session.id).catch(showError)}>Reconnect</button></>}
  </div>;
}

export function AntigravityOptions({ session }) {
  const [changing, setChanging] = useState(false);
  const state = session.antigravity;
  const options = state?.options ?? [];
  if (!options.length || state.authRequired) return <span className="trigger" title="Uses the models and settings from Antigravity CLI"><Icon name="console" size={14} /><span>Antigravity CLI</span></span>;
  const change = async (configId, value) => {
    setChanging(true);
    try { await api('antigravitySetConfig', session.id, configId, value); }
    catch (error) { showError(error); }
    finally { setChanging(false); }
  };
  return options.map(option => <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
    disabled={changing || session.streaming || session.status !== 'connected'}
    menu={close => <MenuSection title={option.name}>
      {option.options.map(choice => <MenuItem key={choice.value} label={choice.name} checked={choice.value === option.currentValue}
        onClick={() => { close(); if (choice.value !== option.currentValue) void change(option.id, choice.value); }} />)}
    </MenuSection>}>
    <span className={option.category === 'model' ? 'strong' : undefined}>{option.options.find(choice => choice.value === option.currentValue)?.name ?? option.name}</span><Icon name="chevronDown" size={11} />
  </Trigger>);
}
