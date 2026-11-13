#!/usr/bin/env node
// A small stand-in for the Claude Code binary in headless stream-json mode, for offline tests of the
// Claude Code engine. It follows the records the real binary (2.1.x) writes: control requests and
// responses, system init/status, raw stream events, assistant/user records with uuids, replays of the
// prompts it takes up, and one result per turn. Behaviour is driven by the prompt:
//   [[bash:CMD]]           a Bash tool call (result: "ran: CMD")
//   [[edit:PATH|OLD|NEW]]  an Edit tool call, asked through can_use_tool, applied to PATH
//   [[ask]]                AskUserQuestion through can_use_tool; replies with the chosen answer
//   [[task]]               a Task call with agent records (parent_tool_use_id) and their usage
//   [[slow]]               a long reply streamed slowly until interrupted
//   [[error]]              an API error message and a failed result
//   /context               a synthetic reply (a local command's output)
//   /compact               compaction (status, boundary, summary)
//   anything else          "echo: <prompt>"
// FAKE_CLAUDE_LOG appends one JSON line per start: argv and the environment variables tests check.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = name => args.includes(name);
if (has('--version')) { process.stdout.write('2.1.322 (Claude Code)\n'); process.exit(0); }
if (process.env.FAKE_CLAUDE_LOG) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CLAUDE_|DISABLE_|PIDESK_|HTTPS?_PROXY)/.test(k)));
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, env, cwd: process.cwd() }) + '\n');
}
const resumed = flag('--resume');
let sessionId = resumed && !has('--fork-session') ? resumed : randomUUID();
let model = flag('--model') ?? 'claude-default';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = record => process.stdout.write(JSON.stringify(record) + '\n');
const pending = new Map(); // our control request id -> resolver
let busy = null;           // the running turn's promise
const queue = [];
let interrupted = false;
let n = 0;

function answerControl(request_id, response) { out({ type: 'control_response', response: { subtype: 'success', request_id, response } }); }
function failControl(request_id, error) { out({ type: 'control_response', response: { subtype: 'error', request_id, error } }); }
function ask(request) {
  const request_id = randomUUID();
  return new Promise(resolve => { pending.set(request_id, resolve); out({ type: 'control_request', request_id, request }); });
}

async function streamMessage(blocks, { delay = 2, stop = 'end_turn' } = {}) {
  const id = `msg_fake_${++n}`;
  const usage = { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 };
  out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: randomUUID() });
  await sleep(5);
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], usage } }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() });
  let output = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, session_id: sessionId, parent_tool_use_id: null });
      for (let i = 0; i < block.text.length; i += 6) {
        if (interrupted) { stop = null; break; }
        await sleep(delay);
        out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(i, i + 6) } }, session_id: sessionId, parent_tool_use_id: null });
        output += 1;
      }
    } else if (block.type === 'thinking') {
      out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }, session_id: sessionId, parent_tool_use_id: null });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }, session_id: sessionId, parent_tool_use_id: null });
      output += 3;
    } else if (block.type === 'tool_use') {
      out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }, session_id: sessionId, parent_tool_use_id: null });
      const json = JSON.stringify(block.input);
      for (let i = 0; i < json.length; i += 12) out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 12) } }, session_id: sessionId, parent_tool_use_id: null });
      output += 5;
    }
    out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: null, usage }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
    out({ type: 'stream_event', event: { type: 'content_block_stop', index }, session_id: sessionId, parent_tool_use_id: null });
  }
  out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output + 7 } }, session_id: sessionId, parent_tool_use_id: null });
  out({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId, parent_tool_use_id: null });
  return { ...usage, output_tokens: output + 7 };
}

function toolResult(id, content, extra = {}) {
  out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(extra.is_error ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), tool_use_result: extra.structured ?? null });
}

function result(usage, { is_error = false, subtype = 'success', text = '' } = {}) {
  out({ type: 'result', subtype, is_error, duration_ms: 10, duration_api_ms: 8, num_turns: 1, result: text, stop_reason: is_error ? null : 'end_turn', session_id: sessionId, total_cost_usd: 0.001,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 }, modelUsage: { [model]: { contextWindow: 200000, maxOutputTokens: 32000 } } });
}

async function turn(content) {
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  out({ type: 'user', message: { role: 'user', content }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), isReplay: true });
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model, tools: ['Task', 'Bash', 'Edit', 'Read', 'Write', 'AskUserQuestion'], slash_commands: ['compact', 'context', 'review', 'goal', '__remote-x'], permissionMode: 'default' });
  interrupted = false;
  if (text.trim() === '/context') {
    out({ type: 'assistant', message: { id: `msg_synth_${++n}`, type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: '## Context Usage\n\n**Tokens:** 1.2k / 200k' }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
    return result(null);
  }
  if (text.trim() === '/compact') {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: randomUUID() });
    await sleep(20);
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId, uuid: randomUUID() });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 5000, post_tokens: 900 } });
    out({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: fake work so far.' }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), isCompactSummary: true });
    out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), isReplay: true });
    return result(null, { subtype: 'success' });
  }
  if (/\[\[error\]\]/.test(text)) {
    out({ type: 'assistant', message: { id: `msg_err_${++n}`, type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 401 {"error":"invalid x-api-key"}' }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), isApiErrorMessage: true, error: 'authentication_failed' });
    return result(null, { is_error: true, subtype: 'success', text: 'API Error: 401' });
  }
  const bash = /\[\[bash:([^\]]+)\]\]/.exec(text);
  const edit = /\[\[edit:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]\]/.exec(text);
  if (bash) {
    const id = `toolu_${++n}`;
    const u1 = await streamMessage([{ type: 'tool_use', id, name: 'Bash', input: { command: bash[1], description: 'Run it' } }], { stop: 'tool_use' });
    toolResult(id, `ran: ${bash[1]}`, { structured: { stdout: `ran: ${bash[1]}`, stderr: '', interrupted: false } });
    const u2 = await streamMessage([{ type: 'text', text: `Tool result: ran: ${bash[1]}` }]);
    return result({ input_tokens: u1.input_tokens + u2.input_tokens, output_tokens: u1.output_tokens + u2.output_tokens });
  }
  if (edit) {
    const id = `toolu_${++n}`;
    const input = { file_path: edit[1], old_string: edit[2], new_string: edit[3], replace_all: false };
    const u1 = await streamMessage([{ type: 'tool_use', id, name: 'Edit', input }], { stop: 'tool_use' });
    const decision = await ask({ subtype: 'can_use_tool', tool_name: 'Edit', input, tool_use_id: id, permission_suggestions: [] });
    if (decision.behavior === 'allow') {
      const before = readFileSync(edit[1], 'utf8');
      writeFileSync(edit[1], before.replace(edit[2], edit[3]));
      toolResult(id, `The file ${edit[1]} has been updated successfully.`, { structured: { filePath: edit[1], oldString: edit[2], newString: edit[3], structuredPatch: [] } });
    } else toolResult(id, decision.message ?? 'denied', { is_error: true });
    const u2 = await streamMessage([{ type: 'text', text: 'Edited.' }]);
    return result({ input_tokens: u1.input_tokens + u2.input_tokens, output_tokens: u1.output_tokens + u2.output_tokens });
  }
  if (/\[\[ask-multi\]\]/.test(text)) {
    const id = `toolu_${++n}`;
    const input = {
      questions: [
        { question: 'Which features?', header: 'Features', description: 'Pick one or more', multiSelect: true, options: [{ label: 'Auth', description: 'JWT login' }, { label: 'Search, full-text', description: 'FTS5 index' }, { label: 'Cache', description: 'In-memory' }] },
        { question: 'Which port?', header: 'Port', kind: 'number', min: 1024, max: 65535, defaultValue: 3000, unit: 'tcp' },
      ],
    };
    await streamMessage([{ type: 'tool_use', id, name: 'AskUserQuestion', input }], { stop: 'tool_use' });
    const decision = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: id });
    const answers = decision.behavior === 'allow' ? decision.updatedInput?.answers : null;
    const summary = answers ? `${answers['Which features?']} @ ${answers['Which port?']}` : 'declined';
    toolResult(id, `User answered: ${summary}`, answers ? {} : { is_error: true });
    const u = await streamMessage([{ type: 'text', text: `Configured: ${summary}` }]);
    return result(u);
  }
  if (/\[\[ask\]\]/.test(text)) {
    const id = `toolu_${++n}`;
    const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] };
    await streamMessage([{ type: 'tool_use', id, name: 'AskUserQuestion', input }], { stop: 'tool_use' });
    const decision = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: id });
    const answer = decision.behavior === 'allow' ? decision.updatedInput?.answers?.['Which color?'] : null;
    toolResult(id, answer ? `User answered: ${answer}` : 'User declined', answer ? {} : { is_error: true });
    const u = await streamMessage([{ type: 'text', text: answer ? `You chose ${answer}` : 'No answer' }]);
    return result(u);
  }
  if (/\[\[task\]\]/.test(text)) {
    const id = `toolu_${++n}`;
    await streamMessage([{ type: 'tool_use', id, name: 'Task', input: { description: 'Explore', prompt: 'look around', subagent_type: 'Explore' } }], { stop: 'tool_use' });
    out({ type: 'assistant', message: { id: `msg_sub_${++n}`, role: 'assistant', model, content: [{ type: 'tool_use', id: `toolu_sub_${n}`, name: 'Glob', input: { pattern: '**/*.js' } }], usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, parent_tool_use_id: id, session_id: sessionId, uuid: randomUUID() });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_sub_${n}`, content: 'a.js' }] }, parent_tool_use_id: id, session_id: sessionId, uuid: randomUUID() });
    out({ type: 'assistant', message: { id: `msg_sub_${++n}`, role: 'assistant', model, content: [{ type: 'text', text: 'Found a.js' }], usage: { input_tokens: 60, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, parent_tool_use_id: id, session_id: sessionId, uuid: randomUUID() });
    toolResult(id, [{ type: 'text', text: 'Found a.js' }]);
    const u = await streamMessage([{ type: 'text', text: 'The agent found a.js' }]);
    return result(u);
  }
  if (/\[\[slow\]\]/.test(text)) {
    const u = await streamMessage([{ type: 'text', text: 'slow '.repeat(400) }], { delay: 30 });
    if (interrupted) {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
      return result(null, { is_error: true, subtype: 'error_during_execution' });
    }
    return result(u);
  }
  const blocks = /\[\[think\]\]/.test(text) ? [{ type: 'thinking', thinking: 'Let me think.' }, { type: 'text', text: `echo: ${text}` }] : [{ type: 'text', text: `echo: ${text}` }];
  return result(await streamMessage(blocks));
}

async function pump() {
  if (busy) return;
  while (queue.length) {
    busy = turn(queue.shift());
    await busy;
    busy = null;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === 'control_response') { pending.get(record.response?.request_id)?.(record.response?.response ?? {}); pending.delete(record.response?.request_id); continue; }
    if (record.type === 'control_request') {
      const r = record.request ?? {};
      if (r.subtype === 'initialize') answerControl(record.request_id, {
        commands: [{ name: 'compact', description: 'Compact the conversation' }, { name: 'review', description: 'Review the diff', argumentHint: '[target]' }, { name: 'goal', description: 'Set a goal' }, { name: '__remote-x', description: 'internal' }],
        models: [{ value: 'default', resolvedModel: model, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        account: process.env.FAKE_CLAUDE_OAUTH ? { tokenSource: 'claude.ai', apiKeySource: 'none' } : { tokenSource: 'none', apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none' },
        claude_code_version: '2.1.322',
      });
      else if (r.subtype === 'interrupt') { interrupted = true; answerControl(record.request_id, { still_queued: [] }); }
      else if (r.subtype === 'apply_flag_settings') {
        if (r.settings?.ultracode === true && process.env.FAKE_NO_ULTRACODE) failControl(record.request_id, 'apply_flag_settings: ultracode is not available for this session (custom-model does not support it)');
        else { if (r.settings?.model) model = r.settings.model; if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ applied: r.settings }) + '\n'); answerControl(record.request_id, {}); }
      }
      else if (r.subtype === 'get_context_usage') answerControl(record.request_id, { totalTokens: 1234, maxTokens: 200000 });
      else if (r.subtype === 'set_permission_mode') answerControl(record.request_id, {});
      else failControl(record.request_id, `unsupported ${r.subtype}`);
      continue;
    }
    if (record.type === 'user') { queue.push(record.message.content); pump(); }
  }
});
process.stdin.on('end', async () => { while (busy) await busy; process.exit(0); });
