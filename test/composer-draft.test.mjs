import assert from 'node:assert/strict';
import { createComposerSizer } from '../app/renderer/src/composer-size.js';
import test from 'node:test';
import {
  createComposerDraft, draftReadToken, updateComposerDraft,
  takeComposerDraft, restoreComposerDraft, recoverComposerDraft,
} from '../app/renderer/src/composer-draft.js';

test('composer sizing never collapses the focused editor to measure it', () => {
  const writes = [];
  let removed = false;
  const mirror = { style: {}, value: '', setAttribute() {}, remove() { removed = true; }, get scrollHeight() { return this.value.split('\n').length * 22 + 10; } };
  const editor = { value: 'one\ntwo\nthree', clientWidth: 400, style: new Proxy({}, { set(target, key, value) { writes.push(value); target[key] = value; return true; } }), ownerDocument: {
    createElement: () => mirror, body: { append() {} }, defaultView: { getComputedStyle: () => ({ minHeight: '32px', maxHeight: '240px', font: '15px sans-serif', letterSpacing: '0px' }) },
  } };
  const sizing = createComposerSizer(editor);
  sizing.update();
  assert.equal(editor.style.height, '76px');
  editor.value += ' more text'; sizing.update();
  assert.deepEqual(writes, ['76px']);
  editor.value = 'short'; sizing.update();
  assert.equal(editor.style.height, '32px');
  assert.ok(!writes.includes('auto'));
  sizing.destroy(); assert.ok(removed);
});

const image = { kind: 'image', key: 'old', data: 'old image' };
const message = () => updateComposerDraft(createComposerDraft(' original text '), 'attachments', [image]);
const append = (draft, token, attachment = image) => updateComposerDraft(draft, 'attachments', list => [...list, attachment], token);

test('navigation keeps a pending read bound to its originating draft', async () => {
  const drafts = { first: createComposerDraft('first'), second: createComposerDraft('second') };
  const token = draftReadToken(drafts.first);
  let finish;
  const read = new Promise(resolve => { finish = resolve; }).then(() => { drafts.first = append(drafts.first, token); });
  // A navigation switches the visible key, not the lifetime of either draft.
  const visibleKey = 'second';
  drafts.first = updateComposerDraft(drafts.first, 'text', 'edited while reading');
  finish();
  await read;
  assert.deepEqual(drafts.first.attachments, [image]);
  assert.equal(drafts.first.text, 'edited while reading');
  assert.deepEqual(drafts[visibleKey].attachments, []);
});

test('consuming the fixed new key invalidates all old batch reads and duplicate submits', () => {
  const draft = message();
  const token = draftReadToken(draft);
  const { next } = takeComposerDraft(draft);
  assert.equal(takeComposerDraft(next), null);
  assert.equal(append(next, token), next);
  const edited = updateComposerDraft(next, 'text', 'next conversation');
  assert.equal(append(edited, token), edited);
  assert.equal(append(edited, token), edited, 'later files in the same batch stay invalid');
  assert.deepEqual(append(edited, draftReadToken(edited)).attachments, [image], 'new reads remain allowed');
});

test('failed submit restores the exact complete message atomically', () => {
  const draft = message();
  const { next, receipt } = takeComposerDraft(draft);
  const restored = restoreComposerDraft(next, receipt);
  assert.equal(restored.text, draft.text, 'preserve whitespace in the recovered editor');
  assert.deepEqual(restored.attachments, [image]);
  assert.deepEqual(restored.recoveries, []);
  assert.equal(append(restored, draftReadToken(next)), restored, 'reads started in successor cannot blend into restored message');
});

for (const field of ['text', 'attachments']) {
  test(`failed submit keeps newer ${field} separate and recovery preserves both drafts`, () => {
    const { next, receipt } = takeComposerDraft(message());
    const edited = updateComposerDraft(next, field, field === 'text' ? 'new text' : [{ ...image, key: 'new' }]);
    const failed = restoreComposerDraft(edited, receipt);
    assert.equal(failed.text, edited.text);
    assert.deepEqual(failed.attachments, edited.attachments);
    assert.equal(failed.recoveries.length, 1);
    const recovered = recoverComposerDraft(failed);
    assert.equal(recovered.text, receipt.text);
    assert.deepEqual(recovered.attachments, receipt.attachments);
    const swappedBack = recoverComposerDraft(recovered);
    assert.equal(swappedBack.text, edited.text);
    assert.deepEqual(swappedBack.attachments, edited.attachments);
    assert.equal(swappedBack.recoveries.length, 1);
  });
}

test('editing then clearing still prevents automatic restoration over a newer revision', () => {
  const { next, receipt } = takeComposerDraft(message());
  const edited = updateComposerDraft(updateComposerDraft(next, 'text', 'new'), 'text', '');
  const failed = restoreComposerDraft(edited, receipt);
  assert.equal(failed.text, '');
  assert.equal(failed.recoveries.length, 1);
  assert.equal(recoverComposerDraft(failed).text, receipt.text);
});

test('a new pending attachment read counts as an edit before it completes', () => {
  const { next, receipt } = takeComposerDraft(message());
  const reading = updateComposerDraft(next, 'attachments', list => list);
  const token = draftReadToken(reading);
  const failed = restoreComposerDraft(reading, receipt);
  assert.equal(failed.text, '');
  assert.equal(failed.recoveries.length, 1);
  const completed = append(failed, token, { ...image, key: 'new' });
  assert.equal(completed.attachments[0].key, 'new');
  assert.equal(completed.recoveries[0].attachments[0].key, 'old');
});

test('out-of-order failed sends preserve each message independently', () => {
  const first = takeComposerDraft(message());
  const second = takeComposerDraft(updateComposerDraft(first.next, 'text', 'second'));
  const olderFailure = restoreComposerDraft(second.next, first.receipt);
  const both = restoreComposerDraft(olderFailure, second.receipt);
  assert.equal(both.text, 'second');
  assert.equal(both.recoveries[0].text, first.receipt.text);
  assert.equal(recoverComposerDraft(both).recoveries[0].text, 'second');
});

test('late reads and failures cannot resurrect a deleted or recreated key', () => {
  const draft = message();
  const token = draftReadToken(draft);
  const { receipt } = takeComposerDraft(draft);
  assert.equal(append(undefined, token), undefined);
  assert.equal(restoreComposerDraft(undefined, receipt), undefined);
  const recreated = createComposerDraft();
  assert.equal(append(recreated, token), recreated);
  assert.equal(restoreComposerDraft(recreated, receipt), recreated);
});
