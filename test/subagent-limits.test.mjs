// Delegation restraint: guidance that keeps the main work with the model, a per-request limit on new
// agents, and Settings → Subagents (off / limited / more) applied to running Pis.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { AGENT_LIMITS, createSubagentTool, subagentPrompt } from '../agent/pidesk-subagent.mjs';
import pideskBridge from '../agent/pidesk-bridge.js';
import { subagentBatch, subagentTaskStatus } from '../app/renderer/src/subagent-state.js';
import { SessionManager } from '../app/main/session-manager.mjs';

const model = { id: 'test-model', provider: 'mock', api: 'openai-completions', name: 'Test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reply = () => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' });
const ctx = {
  cwd: '/workspace', model, thinkingLevel: 'medium', getSystemPrompt: () => 'PARENT',
  sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) },
  tools: ['read', 'grep'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}) })),
  modelRegistry: { streamSimple() { const s = new AssistantMessageEventStream(); queueMicrotask(() => { s.push({ type: 'done', reason: 'stop', message: reply() }); s.end(); }); return s; } },
  executeTool: async () => ({ result: { content: [{ type: 'text', text: 'ok' }], details: {} }, isError: false }),
};
const tasks = n => Array.from({ length: n }, (_, i) => ({ name: `Look up part ${i}`, task: `Find where part ${i} is defined and report the path.` }));
const text = result => result.content.map(c => c.text).join('\n');
function controller(t) {
  const c = createSubagentTool({ notify() {}, publish() {}, isIdle: () => false });
  t.after(() => c.shutdown());
  return { c, start: n => c.tool.execute(`call-${Math.random()}`, { tasks: tasks(n) }, undefined, undefined, ctx) };
}

test('a request starts at most 2 new agents by default, and the next request starts over', async t => {
  const { c, start } = controller(t);
  assert.equal(c.mode, 'limited');
  assert.ok(!(await start(2)).isError);
  const refused = await start(1);
  assert.equal(refused.isError, true);
  assert.match(text(refused), /Not started: at most 2 new agents per user request \(Settings → Subagents\), and this request has already started 2\. Do this work yourself/);
  assert.equal(refused.details.refused, text(refused));
  c.newRequest();
  assert.ok(!(await start(1)).isError, 'a new user message starts over');
  const partial = await start(2);
  assert.match(text(partial), /already started 1\. You can start 1 more\./, 'a call that would go past the limit starts none of its agents');
});

test('More allows 5; Off starts none and drops the guidance', async t => {
  const { c, start } = controller(t);
  c.setMode('more');
  assert.ok(!(await start(5)).isError);
  assert.ok((await start(1)).isError);
  c.setMode('off'); c.newRequest();
  assert.match(text(await start(1)), /subagents are off in Settings/);
  assert.equal(c.promptSection('/workspace'), null);
  c.setMode('nonsense');
  assert.equal(c.mode, 'off', 'unknown modes are ignored');
  assert.deepEqual(AGENT_LIMITS, { off: 0, limited: 2, more: 5 });
});

test('the guidance keeps the main work with the model: a short note in the prompt, the rest with the tool', () => {
  const asked = subagentPrompt(), free = subagentPrompt('more');
  for (const guidance of [asked, free]) assert.ok(guidance.length < 400, 'a short note, not a section that dominates the system prompt');
  assert.equal(subagentPrompt('limited'), asked, 'Limited is the default');
  assert.match(asked, /Start agents only when the user, the project's instructions or a skill asks for them/);
  assert.match(asked, /Otherwise do the work yourself, however large, and never redo or chase work you have handed off/);
  assert.match(free, /Most requests need none, so do the work yourself, and never redo or chase work you have handed off/);
  assert.doesNotMatch(free, /only when/, 'More leaves the call to the model');
  const { tool, messageTool } = createSubagentTool({});
  assert.match(tool.description, /Most requests need none: do the work yourself by default, and when unsure, don't start one/);
  assert.match(tool.description, /Keep for yourself the main task \(understanding, changing, verifying and explaining\)/);
  assert.match(tool.description, /One small task is never worth splitting across several agents/);
  assert.match(tool.description, /Brief it fully, the first time/);
  assert.match(tool.description, /started on a thin brief and corrected afterwards costs more than doing the work yourself/);
  assert.match(tool.description, /of finished work you verified, given the diff rather than your conclusion, with background false/);
  assert.match(tool.description, /leave its work and files alone and don't message it for status; to wait, end your turn/);
  assert.match(messageTool.description, /Not for status checks/);
  for (const text of [asked, free, tool.description, tool.promptSnippet]) {
    assert.doesNotMatch(text, /At most \d|independent review/, 'no number to use as a budget, and review is not advertised');
  }
  assert.equal(tool.promptGuidelines, undefined, 'no extra rules line');
  assert.match(tool.promptSnippet, /do the main task yourself/);
  assert.doesNotMatch(tool.promptSnippet, /search/, 'the tools list advertises no use: by default agents are for when they are asked for');
  assert.match(tool.parameters.properties.tasks.items.properties.name.description, /3 to 6 words/);
  assert.match(tool.parameters.properties.tasks.items.properties.type.description, /explore \(read-only: finds code and answers where and how/);
});

test('the bridge starts the count over on each user message, and Off removes the tools', () => {
  const handlers = new Map(), commands = new Map(), tools = [];
  let active = [];
  pideskBridge({
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { tools.push(tool.name); active.push(tool.name); },
    registerProvider() {}, registerCommand(name, command) { commands.set(name, command); },
    getActiveTools: () => [...active], setActiveTools(names) { active = [...names]; },
  });
  const apply = config => commands.get('pidesk-config').handler(Buffer.from(JSON.stringify(config)).toString('base64'));
  const prompt = messageType => { const event = { messageType, prompt: 'hi', systemPromptOptions: { cwd: '/workspace', sections: {} } }; for (const h of handlers.get('before_agent_start')) h(event); return event.systemPromptOptions.sections; };
  assert.match(prompt('user').subagents, /Start agents only when the user, the project's instructions or a skill asks for them/, 'by default, agents only when asked');
  apply({ subagents: 'off' });
  assert.ok(!active.some(name => name.startsWith('subagent')), 'the tools are no longer declared');
  assert.equal(prompt('user').subagents, undefined);
  apply({ subagents: 'more' });
  assert.ok(['subagent', 'subagent_message', 'subagent_stop'].every(name => active.includes(name)));
  assert.match(prompt('user').subagents, /Most requests need none/);
  assert.doesNotMatch(prompt('user').subagents, /At most \d/, 'the cap is enforced, not stated as a number to use');
});

test('a refused delegation shows its tasks as not started', () => {
  const call = { id: 'c1', arguments: { tasks: tasks(1) } };
  const batch = subagentBatch(call, { status: 'error', result: { details: { kind: 'pidesk-subagents', refused: 'Not started: limit', results: [] } } });
  assert.equal(batch.tasks[0].status, 'cancelled');
  assert.equal(subagentTaskStatus(batch.tasks[0]), 'Not started');
  assert.equal(batch.tasks[0].error, 'Not started: limit');
});

test('Settings → Subagents reaches running Pis once, and new Pis in their boot record', async () => {
  const store = { settings: { providers: [], defaults: { subagents: 'more' } }, sessions: [], getKey: () => null };
  const manager = new SessionManager({ store, environments: () => [], local: {} });
  assert.deepEqual(manager.bootConfig(), { subagents: 'more', speed: 'standard', ultra: false });
  const sent = [];
  manager.runtimes.set('s1', { status: 'connected', configKey: null, session: { prompt: async line => { sent.push(line); } } });
  manager.configChanged(); await new Promise(r => setTimeout(r, 0));
  manager.configChanged(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent, [`/pidesk-config ${Buffer.from(JSON.stringify({ subagents: 'more', speed: 'standard', ultra: false })).toString('base64')}`], 'sent once, not again while unchanged');
  store.settings.defaults.subagents = 'off';
  manager.configChanged(); await new Promise(r => setTimeout(r, 0));
  assert.equal(sent.length, 2);
});
