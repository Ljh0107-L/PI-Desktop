// Drive renderer events deterministically, without spending tokens or writing fake session history.
// Mirrors live calls → hidden reasoning on completion → another model call → streaming answer.
import assert from 'node:assert/strict';

export async function checkReading({ app, page, id }) {
  page.setDefaultTimeout(5000);
  let label = 'start';
  const step = name => { label = name; };
  const send = async events => {
    await app.evaluate(({ BrowserWindow }, { id, events }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const event of events) wc.send('pidesk:event', { channel: 'event', payload: { id, event } });
    }, { id, events });
    await page.waitForTimeout(80);
  };
  const stamp = Date.now();
  const call = { type: 'toolCall', id: 'reading-test-call', name: 'bash', arguments: { command: 'tail -100 test.log', description: 'Inspect test log' } };
  const assistant = { role: 'assistant', timestamp: stamp + 1, content: [call], usage: { output: 500, reasoning: 200 }, durationMs: 10000 };
  const changed = { type: 'toolCall', id: 'reading-test-write', name: 'write', arguments: { path: 'reading.txt', content: 'retained change' } };
  const result = { content: [{ type: 'text', text: Array.from({ length: 100 }, (_, i) => `log line ${i}`).join('\n') }] };
  try {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'status', payload: { id, status: 'connecting' } }), id);
    step('a loaded conversation is never covered by a spinner');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.transcript-loading').count(), 0, 'Pi starting must not hide history that is already loaded');
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'status', payload: { id, status: 'connected' } }), id);
    await send([
      { type: 'message_end', message: { role: 'user', content: 'Disclosure regression fixture', timestamp: stamp } },
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'assistant', timestamp: stamp + 0.5, content: [changed, { type: 'text', text: 'Change completed.' }], usage: { output: 10 }, durationMs: 1000 } },
      { type: 'tool_execution_end', toolCallId: changed.id, result: { content: [] }, isError: false },
      { type: 'message_start', message: assistant },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call } },
      { type: 'tool_execution_start', toolCallId: call.id },
      { type: 'tool_execution_update', toolCallId: call.id, partialResult: result },
    ]);
    step('changes pill rendered');
    const pill = page.locator('.changes-pill', { hasText: 'reading.txt' });
    await pill.evaluate(el => { window.__changesPill = el; });
    step('open the command group');
    await page.locator('.tool-group-head', { hasText: 'Inspect test log' }).click();
    const row = page.locator('[data-tool-id="reading-test-call"]');
    step('open the command row');
    const probe = async () => row.locator('.tool-call-head').evaluate(el => {
      const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { expanded: el.getAttribute('aria-expanded'), hit: top === el || el.contains(top) ? 'self' : `${top?.tagName}.${top?.className}`, follow: document.querySelectorAll('.transcript-follow').length };
    });
    const beforeClick = await probe();
    await row.locator('.tool-call-head').click();
    await page.waitForTimeout(150);
    const afterClick = await probe();
    if (afterClick.expanded !== 'true') throw new Error(`row did not open: before ${JSON.stringify(beforeClick)} after ${JSON.stringify(afterClick)}`);
    step('scroll the command output');
    await row.locator('.tool-output').evaluate(el => { el.scrollTop = 72; window.__readingRow = el.closest('.tool-call'); });
    step('API call ends');
    await send([{ type: 'message_end', message: assistant }]);
    assert.match(await page.locator('.usage-speed-value b').innerText(), /^~\d/, 'receipt-only completion still shows a speed');
    assert.equal(await page.locator('.usage-speed-kind').innerText(), 'Generation (estimated)', 'receipt-only timing is an estimate, not a measurement');
    assert.equal(await row.evaluate(el => el === window.__readingRow), true, 'final reasoning must not remount the tool row');
    assert.equal(await row.locator('.tool-call-head').getAttribute('aria-expanded'), 'true');
    assert.equal(await row.locator('.tool-output').evaluate(el => el.scrollTop), 72);
    assert.equal(await page.locator('.reasoning-tokens', { hasText: '200 tokens' }).count(), 1, 'hidden reasoning usage is visible even with no reasoning text');
    assert.equal(await pill.evaluate(el => el === window.__changesPill), true);

    step('next API call streams');
    const next = { role: 'assistant', timestamp: stamp + 2, content: [], usage: { output: 200 }, durationMs: 2000 };
    await send([
      { type: 'tool_execution_end', toolCallId: call.id, result, isError: false },
      { type: 'message_end', message: { role: 'toolResult', toolCallId: call.id, content: result.content } },
      { type: 'message_start', message: next },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Checking another detail.' } },
    ]);
    // New content appears below, but the opened command and both scroll positions stay put.
    const before = await page.locator('.transcript').evaluate(el => el.scrollTop);
    const answer = Array.from({ length: 50 }, (_, i) => `Answer paragraph ${i}`).join('\n\n');
    await send([
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: answer } },
    ]);
    assert.equal(await row.locator('.tool-call-head').getAttribute('aria-expanded'), 'true');
    assert.equal(await row.locator('.tool-output').evaluate(el => el.scrollTop), 72);
    assert.ok(Math.abs(await page.locator('.transcript').evaluate(el => el.scrollTop) - before) < 2, 'streaming must not drag the transcript to the bottom');
    const sourceTiming = { source: 'agent', complete: true, start: stamp, first: stamp + 500, last: stamp + 1500, end: stamp + 2000,
      chars: answer.length + 'Checking another detail.'.length, thinkingChars: 'Checking another detail.'.length, deltas: 3, weight: 100, firstWeight: 10 };
    await send([{ type: 'message_end', message: { ...next, __timing: sourceTiming, content: [{ type: 'thinking', thinking: 'Checking another detail.' }, { type: 'text', text: answer }] } }]);
    assert.equal(await pill.evaluate(el => el === window.__changesPill), true, 'changes pill must not disappear/reappear at API call boundaries');
    assert.equal(await page.locator('.usage-speed-value b').innerText(), '~180', 'generation TPS excludes TTFT and the first chunk’s 10% of output');
    assert.equal(await page.locator('.usage-speed-kind').innerText(), 'Generation');
    step('jump to latest');
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    assert.ok(await page.locator('.transcript').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2));
    // A standalone thought changes into a work card: retain its open state too.
    step('thought becomes a work card');
    const thinking = { role: 'assistant', timestamp: stamp + 3, content: [] };
    await send([
      { type: 'message_start', message: thinking },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'A thought to inspect' } },
    ]);
    await page.locator('.thinking .tool-group-head', { hasText: 'A thought to inspect' }).click();
    await send([{ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { ...call, id: 'second-reading-call' } } }]);
    assert.equal(await page.locator('.work-body .step-markdown', { hasText: 'A thought to inspect' }).count(), 1);
    await send([{ type: 'message_end', message: { ...thinking, content: [{ type: 'text', text: 'Untimed history' }], usage: { output: 10 } } }]);
    // Without source timing the call gets its own estimate (or none), never the previous call's speed.
    assert.notEqual(await page.locator('.usage-speed-value b').innerText(), '~180', 'untimed call must not inherit a previous speed');
    assert.ok(['Generation (estimated)', 'Speed unavailable'].includes(await page.locator('.usage-speed-kind').innerText()));

    step('hidden reasoning uses answer-only generation');
    const answerWindow = { first: stamp + 4000, last: stamp + 5000, chars: 400, deltas: 3, weight: 100, firstWeight: 10 };
    const hiddenAnswer = { role: 'assistant', timestamp: stamp + 4, content: [{ type: 'text', text: 'Answer. '.repeat(50) }],
      usage: { output: 500, reasoning: 400 }, durationMs: 6000,
      __timing: { source: 'agent', complete: true, start: stamp, end: stamp + 6000, thinkingChars: 0, ...answerWindow, answer: answerWindow } };
    await send([{ type: 'message_end', message: hiddenAnswer }]);
    assert.equal(await page.locator('.usage-speed-value b').innerText(), '~90.0', 'answer TPS uses (500 − 400) × 90%, not all 500 billed output tokens');
    assert.equal(await page.locator('.usage-speed-kind').innerText(), 'Answer generation');

    step('hidden reasoning without first-answer-chunk evidence is estimated');
    await send([{ type: 'message_end', message: { ...hiddenAnswer, timestamp: stamp + 5,
      __timing: { ...hiddenAnswer.__timing, answer: { ...answerWindow, firstWeight: undefined } } } }]);
    assert.equal(await page.locator('.usage-speed-value b').innerText(), '~83.3', 'incomplete answer timing estimates all 500 output tokens ÷ the 6 s response, marked as an estimate');
    assert.equal(await page.locator('.usage-speed-kind').innerText(), 'Generation (estimated)');
    assert.equal(await page.locator('.usage').getByText('Request avg', { exact: true }).count(), 0);

    step('LaTeX math renders with its fonts');
    await send([{ type: 'message_end', message: { role: 'assistant', timestamp: stamp + 6, usage: { output: 20 }, durationMs: 1000,
      content: [{ type: 'text', text: 'Two projections:\n\n\\[ 5120 \\rightarrow 1280 \\rightarrow 64\\times512 \\]\n\nand inline $\\sqrt{d_k}$, while $5 and $10 stay text.' }] } }]);
    const math = page.locator('.markdown').filter({ hasText: 'Two projections' });
    await math.locator('.katex-display').waitFor();
    assert.equal(await math.locator('.katex').count(), 2, 'one display and one inline formula');
    assert.ok((await math.innerText()).includes('$5 and $10'), 'prices are not formulas');
    // The renderer's CSP allows fonts from 'self' only: a font inlined as a data: URI would fail to load.
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.family.startsWith('KaTeX')).map(f => f.status); });
    assert.ok(fonts.includes('loaded') && !fonts.includes('error'), `KaTeX fonts load: ${fonts.join(',')}`);
  } catch (error) {
    await page.screenshot({ path: `/tmp/pidesk-e2e/shots/zz-reading-${label.replace(/\W+/g, '-')}.png` }).catch(() => {});
    const dom = await page.locator('.transcript-inner').innerHTML().catch(() => '');
    throw new Error(`reading fixture failed at "${label}": ${error.message.split('\n')[0]}\n${dom.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-1500)}`);
  } finally {
    page.setDefaultTimeout(30000);
    await send([{ type: 'agent_settled' }]);
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel: 'resync', payload: { id } });
    }, id);
    await page.locator('.user-bubble', { hasText: 'Disclosure regression fixture' }).waitFor({ state: 'detached' });
    const latest = page.getByRole('button', { name: 'Jump to latest' });
    if (await latest.count()) await latest.click();
  }
}
