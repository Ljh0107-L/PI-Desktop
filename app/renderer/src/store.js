// Client-side state for the renderer: one immutable snapshot, updated from IPC events.
import { createComposerDraft, draftReadToken, updateComposerDraft, takeComposerDraft as takeDraft, restoreComposerDraft as restoreDraft, recoverComposerDraft as recoverDraft } from './composer-draft.js';
import { backgroundSnapshot } from './background-jobs.js';
import { relativeSessionPath } from './file-paths.js';
import { isRetiredProvider, RETIRED_PROVIDER_MESSAGE } from '../../../core/retired-providers.mjs';
import { clampEffort, claudeEffortsFor, effortsFor, modelForEnvironment, modelsForEnvironment } from './model-catalog.js';
import { readAppearance, applyAppearance } from './appearance.js';
import { useRef, useSyncExternalStore } from 'react';
import { applyEvent, emptyTranscript, fromHistory, rewindTo } from './transcript.js';
import { historyKey, mergeHistory, mergeReloadedHistory } from './history.js';
import { HistoryBuffer, prepareHistoryPage } from './history-buffer.js';
import { isSubagentFinished, subagentBatches, subagentHistoryId, visibleSubagentBatches } from './subagent-state.js';

// Source timing per reply, so request TPS survives reloads.
const TIMING_KEY = 'pidesk.timings.v1';
const timingStore = (() => { try { return JSON.parse(localStorage.getItem(TIMING_KEY)) ?? {}; } catch { return {}; } })();
const timingsOf = id => timingStore[id] ?? {};
function saveTiming(id, message) {
  if (!message?.__timing || !message.timestamp) return;
  (timingStore[id] ??= {})[message.timestamp] = message.__timing;
  const ids = Object.keys(timingStore); if (ids.length > 200) delete timingStore[ids[0]];
  try { localStorage.setItem(TIMING_KEY, JSON.stringify(timingStore)); } catch { /* full: speed just won't persist */ }
}

// A new conversation on this Mac starts with No folder; on an SSH host, in its most recent folder.
export const defaultFolder = (settings, environmentId) => environmentId === 'local' ? null : settings?.recentFolders?.[environmentId]?.[0] ?? null;

const listeners = new Set();
const deleting = new Set(); // Suppress stale session-list events while deletion is being acknowledged.
let nextPendingId = 0;
export const isPendingSession = id => typeof id === 'string' && id.startsWith('pending:');
let state = {
  appearance: readAppearance(),
  ready: false,
  settings: null, environments: [], sessions: [], catalog: [], catalogError: null,
  activeId: null, view: 'new',             // 'new' | 'session'
  transcripts: {},                          // session id -> transcript
  questions: {},
  goals: {},
  ultra: {},                                // session id -> { enabled, task } from its Pi (Ultra mode)
  agents: {},                               // session id -> { agent id -> live state from its Pi }
  jobs: {},                                 // session id -> versioned background-job snapshot
  confirm: null,                            // { title, message, action, run }                                // session id -> { objective, status, turns } | null
  files: {},                                // session id -> { tabs: [path], active }
  filePaneOpen: false,
  gitReviewOpen: false,
  filePaneMax: false,                            // session id -> [question waiting for an answer]
  stats: {},                                // session id -> stats
  envStatus: {},                            // environment id -> { status, message }
  claudeStatus: {},                         // environment id -> { status, message, version }
  notices: [],
  rightPanel: (() => { try { return localStorage.getItem('pidesk.rightPanel') === 'true'; } catch { return false; } })(),
  subagentSelection: {},                    // session id -> { callId, taskIndex }; changes only on user navigation
  sidebar: true,
  settingsOpen: false, settingsTab: 'providers', addConnectionOpen: false,
  paletteOpen: false,
  history: [], future: [],                  // back / forward navigation
  composerDrafts: {},                       // in-memory text/images per conversation; never written to settings
  draft: { environmentId: 'local', cwd: null, model: null, engine: 'pi', thinkingLevel: 'medium', effort: 'medium', speed: 'standard', ultra: false, ultracode: false },
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

export function setAppearance(value) {
  const appearance = applyAppearance(value);
  set({ appearance });
  api('appearance', appearance).catch(() => {});
}

const transcriptOf = id => state.transcripts[id] ?? emptyTranscript();
const setTranscript = (id, t) => set(s => ({ transcripts: { ...s.transcripts, [id]: t } }));

// action: an optional { label, run } button on the toast, which then stays a little longer.
export function notify(message, level = 'info', action = null) {
  // The same message twice in a row just refreshes the existing toast.
  (window.__pideskNoticeLog ??= []).push(`${level}: ${message}`);
  if (state.notices.some(n => n.message === message)) return;
  const notice = { id: Math.random().toString(36).slice(2), message, level, action };
  set(s => ({ notices: [...s.notices, notice].slice(-3) }));
  setTimeout(() => dismissNotice(notice.id), action ? 10000 : 6000);
}
export const dismissNotice = id => set(s => ({ notices: s.notices.filter(n => n.id !== id) }));

// Save a file from the session's machine to this Mac (the main process asks where).
export async function downloadFile(sessionId, path) {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  try {
    const saved = await api('downloadFile', sessionId, path);
    if (saved) notify(`Downloaded ${saved.path.split('/').pop()}`, 'info', { label: 'Show in Finder', run: () => api('showInFolder', saved.path) });
    return saved;
  } catch (error) {
    notify(`Couldn't download ${name}: ${error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    return null;
  }
}

window.pidesk.subscribe(({ channel, payload }) => {
  switch (channel) {
    case 'event': {
      if (transcriptOf(payload.id).rewinding) break; // old branch, superseded by an edit
      { const next = applyEvent(transcriptOf(payload.id), payload.event);
        setTranscript(payload.id, next);
        if (payload.event.type === 'message_end' && payload.event.message?.role === 'assistant') {
          saveTiming(payload.id, next.messages.at(-1));
          // Context grows with every model call, not only when the whole agent run settles.
          // Update it on the same boundary as the usage/TPS card.
          scheduleStats(payload.id);
        }
        if (payload.event.type === 'compaction_end') { reloadTranscript(payload.id); refreshStats(payload.id); } } // history now starts with the summary
      if (payload.event.type === 'agent_settled') {
        if (state.activeId === payload.id && !transcriptOf(payload.id).history?.viewingOlder) reloadTranscript(payload.id);
        scheduleStats(payload.id);
        if (transcriptOf(payload.id).queued?.length) setTranscript(payload.id, { ...transcriptOf(payload.id), queued: [] });
      }
      break;
    }
    case 'settings':
      setSettings(payload); loadCatalog();
      break;
    case 'open-settings':
      openSettings(true);
      break;
    case 'update':
      set({ update: payload });
      break;
    case 'goal':
      set(s => ({ goals: { ...s.goals, [payload.id]: payload.goal } }));
      break;
    case 'ultra':
      set(s => ({ ultra: { ...s.ultra, [payload.id]: payload.ultra } }));
      break;
    case 'open-session':
      openSession(payload.id).catch(() => {});
      break;
    case 'agents':
      set(s => ({ agents: { ...s.agents, [payload.id]: Object.fromEntries((payload.agents ?? []).map(agent => [agent.id, agent])) } }));
      break;
    case 'jobs':
      receiveJobs(payload.id, payload);
      break;
    case 'status':
      set(s => ({ sessions: s.sessions.map(x => x.id === payload.id ? { ...x, status: payload.status, phase: Object.hasOwn(payload, 'phase') ? payload.phase : x.phase, streaming: payload.streaming ?? (payload.status === 'connected' ? x.streaming : false), statusMessage: payload.message, compacting: payload.compacting ?? x.compacting } : x) }));
      if (payload.status === 'connected' && state.activeId === payload.id) refreshStats(payload.id);
      if (payload.status === 'error' || (payload.status === 'disconnected' && payload.message)) notify(payload.message ?? 'Session disconnected', 'error');
      if (payload.status === 'error' || payload.status === 'disconnected') {
        if (transcriptOf(payload.id).queued?.length) setTranscript(payload.id, { ...transcriptOf(payload.id), queued: [] });
      }
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
    case 'claude-code':
      set(s => ({ claudeStatus: { ...s.claudeStatus, [payload.id]: payload } }));
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
    draft: {
      environmentId: d.environmentId ?? 'local',
      cwd: defaultFolder(boot.settings, d.environmentId ?? 'local'),
      model: d.model,
      engine: d.engine === 'claude-code' ? 'claude-code' : 'pi',
      thinkingLevel: d.thinkingLevel ?? 'medium',
      effort: d.effort ?? 'medium',
      speed: d.speed ?? 'standard',
      ultra: false,
      ultracode: false,
    },
  });
  loadCatalog();
  api('resumeRemote').catch(() => {}); // re-attach SSH sessions still running on their hosts
  // A remembered environment that no longer exists (removed host, other SSH config) falls back to this computer.
  if (!state.environments.some(e => e.id === state.draft.environmentId)) set(s => ({ draft: { ...s.draft, environmentId: 'local', cwd: defaultFolder(s.settings, 'local') } }));
  else if (state.draft.environmentId !== 'local') api('prepareEnvironment', state.draft.environmentId);
}

// Page generations prevent a slow response from restoring a deleted/edited branch.
const historySeq = new Map();
const historyBuffers = new Map();
function historyBuffer(id) {
  if (!historyBuffers.has(id)) {
    if (historyBuffers.size >= 4) {
      const oldest = historyBuffers.keys().next().value;
      historyBuffers.get(oldest).clear(); historyBuffers.delete(oldest);
    }
    historyBuffers.set(id, new HistoryBuffer(cursor => api('historyPage', id, { cursor, prefetch: true }), page => prepareHistoryPage(page, ref => api('historyPage', id, { ref, prefetch: true }))));
  }
  return historyBuffers.get(id);
}
export function prefetchHistory(id) {
  const cursor = transcriptOf(id).history?.next;
  if (!cursor || state.activeId !== id || deleting.has(id)) return;
  const buffer = historyBuffer(id);
  void buffer.prefetch(cursor, () => state.activeId === id && historyBuffers.get(id) === buffer && !deleting.has(id));
}
export async function reloadTranscript(id) {
  const seq = (historySeq.get(id) ?? 0) + 1; historySeq.set(id, seq);
  const initial = transcriptOf(id);
  const baseline = new Set(initial.messages.map(historyKey));
  try {
    const page = await api('historyPage', id);
    if (historySeq.get(id) !== seq || deleting.has(id)) return;
    const current = transcriptOf(id);
    const arrived = current.messages.filter(message => !baseline.has(historyKey(message)));
    const pageState = mergeReloadedHistory(page, current);
    if (JSON.stringify(current.history?.next) !== JSON.stringify(pageState.history.next)) historyBuffers.get(id)?.clear();
    const history = fromHistory(mergeHistory(pageState.messages, arrived), timingsOf(id));
    const updatedTools = Object.fromEntries(Object.entries(current.tools)
      .filter(([key, tool]) => {
        const persisted = history.tools[key];
        if (tool.status === 'running') return !persisted;
        return initial.tools[key] !== tool && (!persisted || persisted.historyRef);
      }));
    const completed = current.live?.timestamp != null
      && history.messages.some(message => message.role === 'assistant' && historyKey(message) === historyKey(current.live));
    setTranscript(id, { ...current, ...history, live: completed ? null : current.live,
      tools: { ...history.tools, ...updatedTools }, history: pageState.history });
    prefetchHistory(id);
  } catch (error) {
    if (historySeq.get(id) === seq && !deleting.has(id)) setTranscript(id, { ...transcriptOf(id), loaded: true, error: error.message });
  }
}

export async function loadEarlierHistory(id, { background = false } = {}) {
  const current = transcriptOf(id), cursor = current.history?.next;
  if (!cursor || current.history.loading) return;
  const seq = historySeq.get(id), buffer = historyBuffer(id), ready = buffer.peek(cursor);
  if (!ready) setTranscript(id, { ...current, history: { ...current.history, loading: true, error: null, viewingOlder: current.history.viewingOlder || !background } });
  try {
    const page = ready ?? await buffer.get(cursor);
    if (historySeq.get(id) !== seq || deleting.has(id)) return;
    const now = transcriptOf(id);
    const history = fromHistory(mergeHistory(page.messages, now.messages), timingsOf(id));
    setTranscript(id, { ...now, messages: history.messages, tools: { ...history.tools, ...now.tools },
      history: { ...now.history, next: page.next, warning: page.warning ?? now.history.warning, loading: false, error: null, viewingOlder: now.history.viewingOlder || !background } });
    buffer.consume(cursor);
    prefetchHistory(id);
  } catch (error) {
    if (historySeq.get(id) !== seq || deleting.has(id)) return;
    const now = transcriptOf(id);
    setTranscript(id, { ...now, history: { ...now.history, loading: false, error: error.message } });
    notify(error.message, 'error');
  }
}

const historyDetails = new Map();
export function loadHistoryEntry(id, ref) {
  const current = transcriptOf(id).messages.find(m => m.__entryId === ref.id);
  if (!current?.__history?.truncated) return Promise.resolve();
  const key = JSON.stringify([id, ref.snapshot.identity, ref.offset, ref.length, ref.id]);
  if (historyDetails.has(key)) return historyDetails.get(key);
  const pending = (async () => {
    const message = await api('historyPage', id, { ref });
    if (deleting.has(id)) return;
    const now = transcriptOf(id);
    const target = now.messages.find(m => m.__entryId === ref.id);
    const locator = target?.__history?.ref;
    if (now.rewinding || !target?.__history?.truncated || locator?.snapshot.identity !== ref.snapshot.identity || locator.offset !== ref.offset || locator.length !== ref.length) return;
    const messages = now.messages.map(m => m.__entryId === message.__entryId ? { ...message, __retryOmitted: m.__retryOmitted } : m);
    const history = fromHistory(messages, timingsOf(id));
    const active = Object.fromEntries(Object.entries(now.tools).filter(([, tool]) => tool.status === 'running'));
    setTranscript(id, { ...now, messages: history.messages, tools: { ...now.tools, ...history.tools, ...active } });
  })().finally(() => { historyDetails.delete(key); });
  historyDetails.set(key, pending);
  return pending;
}

function clampDraftEfforts(catalog, draft) {
  const modelInfo = catalog?.find(m => m.provider === draft.model?.provider && m.id === draft.model?.id);
  if (!modelInfo) return draft;
  const piLevels = effortsFor(modelInfo);
  const ccLevels = claudeEffortsFor(modelInfo);
  return {
    ...draft,
    ...(piLevels.length ? { thinkingLevel: clampEffort(piLevels, draft.thinkingLevel) } : {}),
    ...(ccLevels.length ? { effort: clampEffort(ccLevels, draft.effort) } : {}),
  };
}

export async function loadCatalog() {
  try {
    const catalog = await api('catalog');
    set(s => {
      let draft = { ...s.draft };
      draft.model = modelForEnvironment(catalog, draft.environmentId, draft.model, draft.engine);
      draft = clampDraftEfforts(catalog, draft);
      return { catalog, catalogError: null, draft };
    });
  } catch (error) { set({ catalogError: error.message }); }
}

export const setDraft = patch => set(s => {
  let draft = { ...s.draft, ...patch };
  if (Object.hasOwn(patch, 'environmentId') || Object.hasOwn(patch, 'engine')) {
    draft.model = modelForEnvironment(s.catalog, draft.environmentId, draft.model, draft.engine);
  }
  if (Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'environmentId') || Object.hasOwn(patch, 'engine')) {
    draft = clampDraftEfforts(s.catalog, draft);
  }
  return { draft };
});
// Retain empty entries as lifetime/revision guards. Only session deletion removes them.
const changeComposerDraft = (key, transform) => {
  let result;
  set(s => {
    const previous = s.composerDrafts[key];
    result = transform(previous);
    return result === previous ? {} : { composerDrafts: { ...s.composerDrafts, [key]: result } };
  });
  return result;
};
// Beginning a read counts as an edit for failure recovery, but keeps the generation
// so parallel reads (and reads across navigation) can still complete together.
export const captureComposerDraft = key => draftReadToken(changeComposerDraft(key, draft =>
  updateComposerDraft(draft ?? createComposerDraft(), 'attachments', list => list)));
export const setComposerDraft = (key, field, update, token) => changeComposerDraft(key, draft =>
  updateComposerDraft(token ? draft : draft ?? createComposerDraft(), field, update, token));
export const takeComposerDraft = key => {
  let receipt;
  changeComposerDraft(key, draft => {
    const taken = takeDraft(draft);
    receipt = taken?.receipt;
    return taken?.next ?? draft;
  });
  return receipt;
};
export const restoreComposerDraft = (key, receipt) => changeComposerDraft(key, draft => restoreDraft(draft, receipt));
export const recoverComposerDraft = key => changeComposerDraft(key, recoverDraft);
export const setView = patch => set(patch);
// Inspect child activity in the existing right panel, only after an explicit click.
// Keep file tabs/selection intact so closing a preview returns to the same child.
export function openSubagent(id, callId, taskIndex = null) {
  const result = transcriptOf(id).messages.find(m => m.role === 'toolResult' && m.toolCallId === callId && m.__history?.truncated);
  if (result) loadHistoryEntry(id, result.__history.ref).catch(error => notify(error.message, 'error'));
  set(s => ({ subagentSelection: { ...s.subagentSelection, [id]: { callId, taskIndex } }, rightPanel: true, filePaneOpen: false, filePaneMax: false, gitReviewOpen: false }));
}
// The inspector's controls for an agent running in this session's Pi.
export function stopAgent(id, agentId) {
  return api('stopAgent', id, agentId).catch(error => notify(error.message, 'error'));
}
export function stopBackgroundJob(id, jobId, startedAt) {
  return api('stopBackgroundJob', id, jobId, startedAt).catch(error => { notify(error.message, 'error'); throw error; });
}
function receiveJobs(id, payload) {
  if (deleting.has(id) || !state.sessions.some(session => session.id === id)) return;
  set(s => ({ jobs: { ...s.jobs, [id]: backgroundSnapshot(s.jobs[id], payload) } }));
}
function refreshJobs(id) {
  api('jobs', id).then(payload => receiveJobs(id, payload)).catch(() => {});
}
export function messageAgent(id, agentId, text) {
  return api('messageAgent', id, agentId, text).catch(error => { notify(error.message, 'error'); throw error; });
}
export function closeSubagent(id) {
  set(s => ({ subagentSelection: { ...s.subagentSelection, [id]: null } }));
}

export function clearSubagentRecords(id, onlyIds) {
  const current = state.sessions.find(session => session.id === id);
  const all = visibleSubagentBatches(subagentBatches(transcriptOf(id)), current?.clearedSubagentIds);
  const requested = onlyIds ? new Set(onlyIds) : null;
  const ids = all.flatMap(batch => batch.tasks).filter(task => isSubagentFinished(task) && (!requested || requested.has(subagentHistoryId(task)))).map(subagentHistoryId);
  if (!ids.length) return;
  askConfirm({ title: 'Clear subagent records?', action: 'Clear records',
    message: `Remove ${ids.length} finished ${ids.length === 1 ? 'task' : 'tasks'} from this session’s task history. Running tasks, main conversation, usage and files are kept. Original tool records remain in the conversation.`,
    run: async () => {
      try {
        // No optimistic removal: a failed durable save must not pretend history was cleared.
        let clearedSubagentIds;
        for (let offset = 0; offset < ids.length; offset += 10000) {
          ({ clearedSubagentIds } = await api('clearSubagentHistory', id, ids.slice(offset, offset + 10000)));
          set(s => ({ sessions: s.sessions.map(session => session.id === id ? { ...session, clearedSubagentIds: [...new Set([...(session.clearedSubagentIds ?? []), ...clearedSubagentIds])] } : session) }));
        }
        const remaining = visibleSubagentBatches(subagentBatches(transcriptOf(id)), state.sessions.find(session => session.id === id)?.clearedSubagentIds);
        const selection = state.subagentSelection[id];
        if (selection && !remaining.some(batch => batch.callId === selection.callId && (selection.taskIndex == null || batch.tasks.some(task => task.index === selection.taskIndex)))) closeSubagent(id);
      } catch (error) { notify(`Could not clear task history: ${error.message}`, 'error'); }
    },
  });
}
export const toggleRightPanel = () => set(s => {
  const rightPanel = !s.rightPanel;
  try { localStorage.setItem('pidesk.rightPanel', String(rightPanel)); } catch {}
  return { rightPanel };
});
export const openSettings = (open, tab, { addConnection = false } = {}) => set(s => ({ settingsOpen: open, settingsTab: tab ?? s.settingsTab, addConnectionOpen: addConnection, paletteOpen: false }));
export const setAddConnectionOpen = open => set({ addConnectionOpen: open });
export const openPalette = (open, tab = 'All') => set({ paletteOpen: open, paletteTab: tab });
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
export function pickRecent(environmentId, cwd) {
  set(s => {
    let draft = { ...s.draft, environmentId, cwd };
    draft.model = modelForEnvironment(s.catalog, environmentId, draft.model, draft.engine);
    draft = clampDraftEfforts(s.catalog, draft);
    return { draft };
  });
  if (environmentId !== 'local') api('prepareEnvironment', environmentId);
}
export const setSettings = settings => set({ settings });
export const setEnvironments = environments => set({ environments });

// Hovering a conversation in the sidebar starts its Pi, so it is usually running by the time it opens.
const warmed = new Map();
export function warmSession(id) {
  if (state.activeId === id || Date.now() - (warmed.get(id) ?? 0) < 60000) return;
  warmed.set(id, Date.now());
  api('warmSession', id).catch(() => {});
}

export async function openSession(id, { record = true } = {}) {
  if (record) navigate({ view: 'session', activeId: id });
  set({ activeId: id, view: 'session', paletteOpen: false });
  // Once it is open, keep a spare Pi in its folder so Fork (or a new session there) needn't start one.
  setTimeout(() => { if (state.activeId === id) api('warmFolder', id).catch(() => {}); }, 1500);
  const t = transcriptOf(id);
  const isClaude = state.sessions.find(s => s.id === id)?.engine === 'claude-code';
  refreshJobs(id);
  if (t.loaded) { api('focusSession', id).catch(() => {}); prefetchHistory(id); return; } // the sweep never stops the open conversation
  try {
    await reloadTranscript(id);
    refreshStats(id);
    if (!isClaude) {
      api('goal', id).then(goal => set(s => ({ goals: { ...s.goals, [id]: goal ?? s.goals[id] ?? null } }))).catch(() => {});
      api('ultra', id).then(ultra => set(s => ({ ultra: { ...s.ultra, [id]: ultra ?? s.ultra[id] ?? null } }))).catch(() => {});
      api('agents', id).then(list => { if (list?.length) set(s => ({ agents: { ...s.agents, [id]: { ...Object.fromEntries(list.map(agent => [agent.id, agent])), ...s.agents[id] } } })); }).catch(() => {});
    }
  } catch (error) {
    setTranscript(id, { ...transcriptOf(id), loaded: true, error: error.message });
  }
}

const statsSeq = new Map();
const statsTimers = new Map();
export async function refreshStats(id) {
  const seq = (statsSeq.get(id) ?? 0) + 1;
  statsSeq.set(id, seq);
  try {
    const stats = await api('stats', id);
    // A slower request from an earlier turn must not overwrite a newer context figure.
    if (stats && statsSeq.get(id) === seq) set(s => ({ stats: { ...s.stats, [id]: stats } }));
  } catch { /* ignore */ }
}
// Let Pi persist the finished message before asking for its context figure; coalesce a
// burst of message_end events (tool loops) into one request.
function scheduleStats(id) {
  if (typeof window === 'undefined') return;
  clearTimeout(statsTimers.get(id));
  statsTimers.set(id, setTimeout(() => { statsTimers.delete(id); refreshStats(id); }, 120));
}

export async function startSession(text, attachments = []) {
  const { draft } = state;
  const claude = draft.engine === 'claude-code';
  if (!draft.model) throw new Error(claude ? 'Choose an Anthropic Messages model in Settings → Models first.' : 'Choose a model in Settings → Models first.');
  if (isRetiredProvider(draft.model.provider)) throw new Error(RETIRED_PROVIDER_MESSAGE);
  const pendingId = `pending:${++nextPendingId}`;
  set({ view: 'session', activeId: pendingId, transcripts: { ...state.transcripts, [pendingId]: { ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: [{ type: 'text', text }, ...attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image', data: a.data, mimeType: a.mimeType }))] }] } } });
  try {
    const session = await api('createSession', claude
      ? { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, engine: 'claude-code', effort: draft.effort, ultracode: draft.ultracode, speed: draft.speed, prompt: text }
      : { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, thinkingLevel: draft.thinkingLevel, speed: draft.speed, ultra: draft.ultra, prompt: text });
    set(s => ({ ...(s.activeId === pendingId ? { activeId: session.id } : {}),
      ...(draft.ultra && !claude && s.draft === draft ? { draft: { ...draft, ultra: false } } : {}),
      transcripts: { ...s.transcripts, [session.id]: s.transcripts[session.id] ?? { ...emptyTranscript(), loaded: true }, [pendingId]: undefined },
      history: s.history.map(v => v.activeId === pendingId ? { ...v, activeId: session.id } : v),
      future: s.future.map(v => v.activeId === pendingId ? { ...v, activeId: session.id } : v),
      sessions: s.sessions.some(x => x.id === session.id) ? s.sessions : [session, ...s.sessions] }));
    warnIfNoImages(draft.model, attachments);
    await api('prompt', session.id, text, attachments);
    api('updateDefaults', { environmentId: draft.environmentId, model: draft.model, engine: draft.engine, thinkingLevel: draft.thinkingLevel, effort: draft.effort, speed: draft.speed }).then(setSettings).catch(() => {});
  } catch (error) {
    set(s => ({ ...(s.activeId === pendingId ? { view: 'new', activeId: null } : {}), transcripts: { ...s.transcripts, [pendingId]: undefined },
      history: s.history.filter(v => v.activeId !== pendingId), future: s.future.filter(v => v.activeId !== pendingId) }));
    throw error;
  }
}

// Text sent while Pi is waiting on a question answers that question instead of starting a new turn.
export async function sendPrompt(id, text, attachments = []) {
  const pending = state.questions[id]?.find(q => q.method === 'select' || q.method === 'input' || q.method === 'editor');
  if (pending && text && !attachments.length) { await api('answer', id, pending.requestId, { value: pending.multiSelect ? [text] : text }); return; }
  // Desktop commands; anything else starting with "/" (goal, skills, prompt templates) goes to Pi.
  const command = /^\/(\w+)\s*$/.exec(text)?.[1];
  if (command === 'compact') { await api('compact', id); return; }
  if (command === 'fork') { await forkSession(id); return; }
  if (command === 'new') { newSession(); return; }
  const session = state.sessions.find(s => s.id === id);
  warnIfNoImages(session?.model, attachments);
  // A message sent while Pi works interrupts the active run and starts a fresh turn. Show it as an
  // optimistic user message at once; Pi's message_end replaces it, and a failed send removes it again.
  const streaming = !!session?.streaming;
  // Let the main process decide from Pi's real state: the renderer's streaming flag can lag a moment.
  // A normal message always asks to interrupt; main only aborts if Pi is actually running.
  const interrupt = !text.startsWith('/');
  const images = attachments.filter(a => a.kind === 'image').map(a => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
  const optimistic = streaming && interrupt ? { role: 'user', content: [{ type: 'text', text }, ...images], timestamp: Date.now(), __optimistic: true } : null;
  if (optimistic) setTranscript(id, { ...transcriptOf(id), messages: [...transcriptOf(id).messages, optimistic] });
  try { await api('prompt', id, text, attachments, { interrupt }); }
  catch (error) {
    if (optimistic) setTranscript(id, { ...transcriptOf(id), messages: transcriptOf(id).messages.filter(m => m !== optimistic) });
    throw error;
  }
}

export function clearQueued(id) {
  if (!transcriptOf(id).queued?.length) return;
  setTranscript(id, { ...transcriptOf(id), queued: [] });
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
  historySeq.set(id, (historySeq.get(id) ?? 0) + 1);
  historyBuffers.get(id)?.clear(); historyBuffers.delete(id);
  // The click takes effect immediately; SSH/process cleanup must not hold the interface hostage.
  set(s => ({ sessions: s.sessions.filter(x => x.id !== id) }));
  if (state.activeId === id) newSession();
  try {
    await api('deleteSession', id);
    const without = object => Object.fromEntries(Object.entries(object).filter(([key]) => key !== id));
    set(s => ({ composerDrafts: without(s.composerDrafts), transcripts: without(s.transcripts), questions: without(s.questions), stats: without(s.stats), files: without(s.files), subagentSelection: without(s.subagentSelection), agents: without(s.agents), jobs: without(s.jobs),
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
  historySeq.set(id, (historySeq.get(id) ?? 0) + 1);
  historyBuffers.get(id)?.clear();
  // Show the rewound conversation immediately; events from the old branch (an aborted reply) are
  // ignored until Pi reports the branch switch.
  setTranscript(id, rewindTo(transcriptOf(id), ordinal, text, attachments.filter(a => a.kind === 'image')));
  try { await api('editMessage', id, ordinal, originalText, text, attachments); }
  catch (error) { reloadTranscript(id); throw error; }
}

export function newSession() { navigate({ view: 'new', activeId: null }); set({ view: 'new', activeId: null, paletteOpen: false }); }

// ---------------------------------------------------------------- file preview
// Paths inside the session folder are kept relative to it; anything else stays absolute.
const relToSession = (id, path) => relativeSessionPath(state.sessions.find(s => s.id === id)?.cwd, path);
export function openFile(id, path) {
  const rel = relToSession(id, path);
  if (!rel) return;
  set(s => {
    const cur = s.files[id] ?? { tabs: [], active: null };
    const tabs = cur.tabs.includes(rel) ? cur.tabs : [...cur.tabs, rel].slice(-8);
    return { files: { ...s.files, [id]: { tabs, active: rel, changes: null } }, filePaneOpen: true, gitReviewOpen: false };
  });
}
export function closeFile(id, path) {
  set(s => {
    const cur = s.files[id] ?? { tabs: [], active: null };
    const tabs = cur.tabs.filter(t => t !== path);
    const active = cur.active === path ? tabs.at(-1) ?? null : cur.active;
    return { files: { ...s.files, [id]: { ...cur, tabs, active } } };
  });
}
export const setFilePaneOpen = open => set({ filePaneOpen: open, ...(open ? { gitReviewOpen: false } : {}) });
// Open the change review for one turn in the file pane.
export function openChanges(id, changes) {
  set(s => ({ files: { ...s.files, [id]: { ...(s.files[id] ?? { tabs: [] }), active: null, changes } }, filePaneOpen: true, gitReviewOpen: false }));
}
export { set };

// Read-only access for tests and debugging.
window.__pideskState = () => state;

export const askConfirm = confirm => set({ confirm });
export const closeConfirm = () => set({ confirm: null });
