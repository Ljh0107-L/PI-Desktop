// present_files: the model hands the user finished files, shown as cards with Open and Download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pideskBridge from '../agent/pidesk-bridge.js';
import { displayBlocks } from '../app/renderer/src/transcript.js';

function setup(t) {
  const tools = new Map();
  pideskBridge({ on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerProvider() {}, registerCommand() {} });
  const dir = mkdtempSync(join(tmpdir(), 'pd-present-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'report.md'), '# Report\n');
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'chart.png'), Buffer.alloc(2048));
  const tool = tools.get('present_files');
  const run = params => tool.execute('call-1', params, undefined, undefined, { cwd: dir });
  return { tool, dir, run };
}

test('the tool tells the model when and how to hand over files', t => {
  const { tool } = setup(t);
  assert.match(tool.description, /open or download/);
  assert.ok(tool.promptGuidelines.some(line => /present_files with its path/.test(line)));
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['caption', 'paths']);
});

test('files are found on the machine Pi runs on, relative to its folder, with their sizes', async t => {
  const { dir, run } = setup(t);
  const result = await run({ paths: ['report.md', join(dir, 'out', 'chart.png'), './report.md'], caption: '  The report and its chart  ' });
  assert.deepEqual(result.details, { kind: 'pidesk-files', caption: 'The report and its chart', files: [
    { path: join(dir, 'report.md'), name: 'report.md', size: 9 },
    { path: join(dir, 'out', 'chart.png'), name: 'chart.png', size: 2048 },
  ] });
  assert.match(result.content[0].text, /these 2 files with Open and Download buttons/);
});

test('missing files and folders are reported; with nothing to show, the call fails', async t => {
  const { run } = setup(t);
  const partial = await run({ paths: ['report.md', 'missing.txt', 'out'] });
  assert.equal(partial.details.files.length, 1);
  assert.match(partial.content[0].text, /Not presented: missing\.txt: not found; out: not a file/);
  await assert.rejects(run({ paths: ['missing.txt'] }), /Nothing to present\. missing\.txt: not found/);
});

test('handed-over files get their own block in the conversation, never folded into tool steps', () => {
  const read = { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.txt' } };
  const present = { type: 'toolCall', id: 'p1', name: 'present_files', arguments: { paths: ['report.md'] } };
  const t = { messages: [
    { role: 'user', content: 'Write the report', timestamp: 1 },
    { role: 'assistant', content: [read, present], timestamp: 2, usage: { output: 10 }, stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'a' }], timestamp: 3 },
    { role: 'toolResult', toolCallId: 'p1', toolName: 'present_files', content: [{ type: 'text', text: 'shown' }], details: { kind: 'pidesk-files', files: [{ path: '/w/report.md', name: 'report.md', size: 9 }] }, timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: 5, usage: { output: 2 }, stopReason: 'stop' },
  ], tools: {}, live: null };
  const blocks = displayBlocks(t);
  const files = blocks.filter(b => b.kind === 'files');
  assert.equal(files.length, 1);
  assert.equal(files[0].call.id, 'p1');
  assert.ok(!blocks.some(b => b.kind === 'work' && b.items.some(item => item.kind === 'files')));
});
