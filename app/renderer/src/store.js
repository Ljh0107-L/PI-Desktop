// Client-side state for the renderer: one immutable snapshot, updated from IPC events.
import { useRef, useSyncExternalStore } from 'react';
import { applyEvent, emptyTranscript, fromHistory, rewindTo } from './transcript.js';

// Generation timing per reply (Pi's history keeps token counts but not timing), so tok/s survives reloads.
const TIMING_KEY = 'pidesk.timings.v1';
const timingStore = (() => { try { return JSON.parse(localStorage.getItem(TIMING_KEY)) ?? {}; } catch { return {}; } })();
const timingsOf = id => timingStore[id] ?? {};
function saveTiming(id, message) {
  if (!message?.__timing || !message.timestamp) return;
  (timingStore[id] ??= {})[message.timestamp] = message.__timing;
  const ids = Object.keys(timingStore); if (ids.length > 200) delete timingStore[ids[0]];
  try { localStorage.setItem(TIMING_KEY, JSON.stringify(timingStore)); } catch { /* full: speed just won't persist */ }
}

const listeners = new Set();
const deleting = new Set(); // Suppress stale session-list events while deletion is being acknowledged.
let state = {
  ready: false,
  settings: null, environments: [], sessions: [], catalog: [], catalogError: null,
  activeId: null, view: 'new',             // 'new' | 'session'
  transcripts: {},                          // session id -> transcript
  questions: {},
  goals: {},
  confirm: null,                            // { title, message, action, run }                                // session id -> { objective, status, turns } | null
  files: {},                                // session id -> { tabs: [path], active }
  filePaneOpen: false,
  filePaneMax: false,                            // session id -> [question waiting for an answer]
  stats: {},                                // session id -> stats
  envStatus: {},                            // environment id -> { status, message }
  notices: [],
  rightPanel: true,
  sidebar: true,
  settingsOpen: false, settingsTab: 'providers', addConnectionOpen: false,
  paletteOpen: false,
  branches: {},                             // session id -> git branch (or '')
  history: [], future: [],                  // back / forward navigation
  draft: { environmentId: 'local', cwd: null, model: null, thinkingLevel: 'medium' },
};

const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; for (const l of listeners) l(); };
export const getState = () => state;
const subscribe = cb => { listeners.add(cb); return () => listeners.delete(cb); };
function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.is(a[k], b[k]));
}
// Selectors may derive fresh arrays/objects (filters, `?? []`); return the previous value when shallow-equal
// so useSyncExternalStore sees a stable snapshot.
export function useStore(selector) {
  const cache = useRef({ has: false, value: undefined });
  const get = () => {
    const next = selector(state);
    if (cache.current.has && shallowEqual(cache.current.value, next)) return cache.current.value;
    cache.current = { has: true, value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, get);
}
export const api = (method, ...args) => window.pidesk.invoke(method, ...args);

const transcriptOf = id => state.transcripts[id] ?? emptyTranscript();
const setTranscript = (id, t) => set(s => ({ transcripts: { ...s.transcripts, [id]: t } }));

export function notify(message, level = 'info') {
  // The same message twice in a row just refreshes the existing toast.
  (window.__pideskNoticeLog ??= []).push(`${level}: ${message}`);
  if (state.notices.some(n => n.message === message)) return;
  const notice = { id: Math.random().toString(36).slice(2), message, level };
  set(s => ({ notices: [...s.notices, notice].slice(-3) }));
  setTimeout(() => set(s => ({ notices: s.notices.filter(n => n.id !== notice.id) })), 6000);
}

window.pidesk.subscribe(({ channel, payload }) => {
  switch (channel) {
    case 'event': {
      if (transcriptOf(payload.id).rewinding) break; // old branch, superseded by an edit
      { const next = applyEvent(transcriptOf(payload.id), payload.event);
        setTranscript(payload.id, next);
        if (payload.event.type === 'message_end' && payload.event.message?.role === 'assistant') saveTiming(payload.id, next.messages.at(-1));
        if (payload.event.type === 'compaction_end') reloadTranscript(payload.id); } // history now starts with the summary
      if (payload.event.type === 'agent_settled') refreshStats(payload.id);
      break;
    }
    case 'open-settings':
      openSettings(true);
      break;
    case 'update':
      set({ update: payload });
      break;
    case 'goal':
      set(s => ({ goals: { ...s.goals, [payload.id]: payload.goal } }));
      break;
    case 'status':
      set(s => ({ sessions: s.sessions.map(x => x.id === payload.id ? { ...x, status: payload.status, streaming: payload.streaming ?? (payload.status === 'connected' ? x.streaming : false), statusMessage: payload.message, compacting: payload.compacting ?? x.compacting } : x) }));
      if (payload.status === 'error' || (payload.status === 'disconnected' && payload.message)) notify(payload.message ?? 'Session disconnected', 'error');
      if (payload.status === 'disconnected') set(s => ({ questions: { ...s.questions, [payload.id]: [] } }));
      break;
    case 'sessions':
      set({ sessions: payload.filter(s => !deleting.has(s.id)) });
      break;
    case 'question':
      set(s => ({ questions: { ...s.questions, [payload.id]: [...(s.questions[payload.id] ?? []).filter(q => q.requestId !== payload.question.requestId), payload.question] } }));
      break;
    case 'questions-cleared':
      set(s => ({ questions: { ...s.questions, [payload.id]: [] } }));
      break;
    case 'rewound':
      setTranscript(payload.id, { ...transcriptOf(payload.id), rewinding: false });
      break;
    case 'resync':
      reloadTranscript(payload.id);
      break;
    case 'question-resolved':
      set(s => ({ questions: { ...s.questions, [payload.id]: (s.questions[payload.id] ?? []).filter(q => q.requestId !== payload.requestId) } }));
      break;
    case 'notice':
      notify(payload.message, payload.level);
      break;
    case 'environments':
      set({ environments: payload });
      break;
    case 'environment':
      set(s => ({ envStatus: { ...s.envStatus, [payload.id]: payload } }));
      if (payload.status === 'ready') import('./dirs.js').then(d => d.prefetchDir(payload.id)); // the folder browser opens instantly
      break;
  }
});

export async function bootstrap() {
  api('updateStatus').then(update => set({ update })).catch(() => {});
  const boot = await api('bootstrap');
  const d = boot.settings.defaults;
  set({
    ready: true, settings: boot.settings, environments: boot.environments, sessions: boot.sessions, home: boot.home, piVersion: boot.piVersion,
    questions: Object.fromEntries(boot.sessions.map(s => [s.id, s.pendingQuestions ?? []])),
    draft: { environmentId: d.environmentId ?? 'local', cwd: boot.settings.recentFolders?.[d.environmentId ?? 'local']?.[0] ?? null, model: d.model, thinkingLevel: d.thinkingLevel },
  });
  loadCatalog();
  api('resumeRemote').catch(() => {}); // re-attach SSH sessions still running on their hosts
  // A remembered environment that no longer exists (removed host, other SSH config) falls back to this computer.
  if (!state.environments.some(e => e.id === state.draft.environmentId)) set(s => ({ draft: { ...s.draft, environmentId: 'local', cwd: s.settings.recentFolders?.local?.[0] ?? null } }));
  else if (state.draft.environmentId !== 'local') api('prepareEnvironment', state.draft.environmentId);
}

// Drop the cached transcript and reload it from Pi (after a replay gap or for a fresh view).
export async function reloadTranscript(id) {
  try {
    const messages = await api('messages', id);
    setTranscript(id, { ...fromHistory(messages, timingsOf(id)), live: null });
  } catch (error) { setTranscript(id, { ...transcriptOf(id), error: error.message }); }
}

export async function loadCatalog() {
  try {
    const catalog = await api('catalog');
    set(s => {
      const draft = { ...s.draft };
      if (!draft.model || !catalog.some(m => m.provider === draft.model.provider && m.id === draft.model.id)) draft.model = catalog[0] ? { provider: catalog[0].provider, id: catalog[0].id } : null;
      return { catalog, catalogError: null, draft };
    });
  } catch (error) { set({ catalogError: error.message }); }
}

export const setDraft = patch => set(s => ({ draft: { ...s.draft, ...patch } }));
export const setView = patch => set(patch);
export const toggleRightPanel = () => set(s => ({ rightPanel: !s.rightPanel }));
export const openSettings = (open, tab, { addConnection = false } = {}) => set(s => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab, addConnectionOpen: addConnection, paletteOpen: false }));
export const setAddConnectionOpen = open => set({ addConnectionOpen: open });
export const openPalette = open => set({ paletteOpen: open });
export const toggleSidebar = () => set(s => ({ sidebar: !s.sidebar }));
const here = () => ({ view: state.view, activeId: state.activeId });
function navigate(target) {
  const cur = here();
  if (cur.view === target.view && cur.activeId === target.activeId) return false;
  set(s => ({ history: [...s.history, cur].slice(-50), future: [] }));
  return true;
}
export function goBack() {
  const prev = state.history.at(-1); if (!prev) return;
  set(s => ({ history: s.history.slice(0, -1), future: [here(), ...s.future] }));
  prev.view === 'session' && prev.activeId ? openSession(prev.activeId, { record: false }) : set({ view: 'new', activeId: null });
}
export function goForward() {
  const next = state.future[0]; if (!next) return;
  set(s => ({ future: s.future.slice(1), history: [...s.history, here()] }));
  next.view === 'session' && next.activeId ? openSession(next.activeId, { record: false }) : set({ view: 'new', activeId: null });
}
export async function loadBranch(id) {
  try { const branch = await api('gitBranch', id); set(s => ({ branches: { ...s.branches, [id]: branch ?? '' } })); } catch { /* ignore */ }
}
export function pickRecent(environmentId, cwd) { set(s => ({ draft: { ...s.draft, environmentId, cwd } })); if (environmentId !== 'local') api('prepareEnvironment', environmentId); }
export const setSettings = settings => set({ settings });
export const setEnvironments = environments => set({ environments });

export async function openSession(id, { record = true } = {}) {
  if (record) navigate({ view: 'session', activeId: id });
  set({ activeId: id, view: 'session', paletteOpen: false });
  loadBranch(id);
  const t = transcriptOf(id);
  if (t.loaded) return;
  try {
    const messages = await api('messages', id);
    // Live events may have arrived while history loaded; history is authoritative for completed messages.
    const current = transcriptOf(id);
    const history = fromHistory(messages, timingsOf(id));
    setTranscript(id, { ...history, live: current.live, tools: { ...history.tools, ...current.tools } });
    refreshStats(id);
    api('goal', id).then(goal => set(s => ({ goals: { ...s.goals, [id]: goal ?? s.goals[id] ?? null } }))).catch(() => {});
  } catch (error) {
    setTranscript(id, { ...transcriptOf(id), loaded: true, error: error.message });
  }
}

export async function refreshStats(id) {
  try { const stats = await api('stats', id); if (stats) set(s => ({ stats: { ...s.stats, [id]: stats } })); } catch { /* ignore */ }
}

export async function startSession(text, attachments = []) {
  const { draft } = state;
  if (!draft.model) throw new Error('Add a model provider in Settings first.');
  const pendingId = 'pending';
  set({ view: 'session', activeId: pendingId, transcripts: { ...state.transcripts, [pendingId]: { ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: [{ type: 'text', text }, ...attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image', data: a.data, mimeType: a.mimeType }))] }] } } });
  try {
    const session = await api('createSession', { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, thinkingLevel: draft.thinkingLevel });
    set(s => ({ activeId: session.id, transcripts: { ...s.transcripts, [session.id]: { ...emptyTranscript(), loaded: true }, [pendingId]: undefined }, sessions: s.sessions.some(x => x.id === session.id) ? s.sessions : [session, ...s.sessions] }));
    warnIfNoImages(draft.model, attachments);
    await api('prompt', session.id, text, attachments);
    api('updateDefaults', { environmentId: draft.environmentId, model: draft.model, thinkingLevel: draft.thinkingLevel }).then(setSettings);
  } catch (error) {
    set({ view: 'new', activeId: null });
    throw error;
  }
}

// Text sent while Pi is waiting on a question answers that question instead of starting a new turn.
export async function sendPrompt(id, text, attachments = []) {
  const pending = state.questions[id]?.find(q => q.method === 'select' || q.method === 'input' || q.method === 'editor');
  if (pending && text && !attachments.length) { await api('answer', id, pending.requestId, { value: text }); return; }
  // Desktop commands; anything else starting with "/" (goal, skills, prompt templates) goes to Pi.
  const command = /^\/(\w+)\s*$/.exec(text)?.[1];
  if (command === 'compact') { await api('compact', id); return; }
  if (command === 'fork') { await forkSession(id); return; }
  if (command === 'new') { newSession(); return; }
  const session = state.sessions.find(s => s.id === id);
  warnIfNoImages(session?.model, attachments);
  // Sent while Pi works: show it at once (dimmed) until Pi takes it before its next model call.
  const queued = session?.streaming && !text.startsWith('/') ? { id: Math.random().toString(36).slice(2), text, images: attachments.filter(a => a.kind === 'image') } : null;
  if (queued) setTranscript(id, { ...transcriptOf(id), queued: [...(transcriptOf(id).queued ?? []), queued] });
  try { await api('prompt', id, text, attachments); }
  catch (error) {
    if (queued) setTranscript(id, { ...transcriptOf(id), queued: (transcriptOf(id).queued ?? []).filter(q => q.id !== queued.id) });
    throw error;
  }
}

// Pi drops images for models without image input; say so instead of failing silently.
function warnIfNoImages(model, attachments) {
  if (!model || !attachments.some(a => a.kind === 'image')) return;
  const info = state.catalog?.find(m => m.provider === model.provider && m.id === model.id);
  if (info && !(info.input ?? ['text']).includes('image')) notify(`${info.name ?? model.id} doesn’t accept images, so they won’t be sent`, 'error');
}

export async function forkSession(id) {
  const session = await api('fork', id);
  set(s => ({ sessions: s.sessions.some(x => x.id === session.id) ? s.sessions : [session, ...s.sessions] }));
  openSession(session.id);
}

export async function deleteSession(id) {
  if (deleting.has(id)) return;
  const removed = state.sessions.find(s => s.id === id);
  const index = state.sessions.findIndex(s => s.id === id);
  deleting.add(id);
  // The click takes effect immediately; SSH/process cleanup must not hold the interface hostage.
  set(s => ({ sessions: s.sessions.filter(x => x.id !== id) }));
  if (state.activeId === id) newSession();
  try {
    await api('deleteSession', id);
    const without = object => Object.fromEntries(Object.entries(object).filter(([key]) => key !== id));
    set(s => ({ transcripts: without(s.transcripts), questions: without(s.questions), stats: without(s.stats), files: without(s.files),
      history: s.history.filter(v => v.activeId !== id), future: s.future.filter(v => v.activeId !== id) }));
  } catch (error) {
    // Don't silently lose the conversation or navigate away from whatever the user opened meanwhile.
    if (removed) set(s => {
      const sessions = s.sessions.filter(x => x.id !== id);
      sessions.splice(Math.max(0, index), 0, removed);
      return { sessions };
    });
    throw error;
  } finally { deleting.delete(id); }
}

export async function editMessage(id, ordinal, originalText, text, attachments = []) {
  // Show the rewound conversation immediately; events from the old branch (an aborted reply) are
  // ignored until Pi reports the branch switch.
  setTranscript(id, rewindTo(transcriptOf(id), ordinal, text, attachments.filter(a => a.kind === 'image')));
  try { await api('editMessage', id, ordinal, originalText, text, attachments); }
  catch (error) { reloadTranscript(id); throw error; }
}

export function newSession() { navigate({ view: 'new', activeId: null }); set({ view: 'new', activeId: null, paletteOpen: false }); }

// ---------------------------------------------------------------- file preview
// Paths inside the session folder are kept relative to it; anything else stays absolute.
const relToSession = (id, path) => {
  const cwd = state.sessions.find(s => s.id === id)?.cwd;
  let p = String(path).replace(/^file:\/\//, '').replace(/^\.\//, '');
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  p = p.split('#')[0];
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
};
export function openFile(id, path) {
  const rel = relToSession(id, path);
  set(s => {
    const cur = s.files[id] ?? { tabs: [], active: null };
    const tabs = cur.tabs.includes(rel) ? cur.tabs : [...cur.tabs, rel].slice(-8);
    return { files: { ...s.files, [id]: { tabs, active: rel, changes: null } }, filePaneOpen: true };
  });
}
export function closeFile(id, path) {
  set(s => {
    const cur = s.files[id] ?? { tabs: [], active: null };
    const tabs = cur.tabs.filter(t => t !== path);
    const active = cur.active === path ? tabs.at(-1) ?? null : cur.active;
    return { files: { ...s.files, [id]: { tabs, active } } };
  });
}
export const setFilePaneOpen = open => set({ filePaneOpen: open });
// Open the change review for one turn in the file pane.
export function openChanges(id, changes) {
  set(s => ({ files: { ...s.files, [id]: { ...(s.files[id] ?? { tabs: [] }), active: null, changes } }, filePaneOpen: true }));
}
export { set };

// Read-only access for tests and debugging.
window.__pideskState = () => state;

export const askConfirm = confirm => set({ confirm });
export const closeConfirm = () => set({ confirm: null });
