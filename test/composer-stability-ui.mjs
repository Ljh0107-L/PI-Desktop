import assert from 'node:assert/strict';

// Keep typing while a reply streams and an older page is inserted. Check actual
// painted geometry, caret ownership, and transient style mutations, not just value.
export async function checkComposerStability({ app, page, id }) {
  const input = page.locator('.dock textarea[aria-label="Message"]');
  const prefix = 'first line\nsecond line\nthird ';
  const addition = 'steady typing without movement';
  await input.fill(prefix);
  await input.focus();
  await page.waitForTimeout(100);
  await app.evaluate(({ BrowserWindow }, id) => {
    const send = (channel, payload) => BrowserWindow.getAllWindows()[0].webContents.send('pidesk:event', { channel, payload });
    send('status', { id, status: 'connected', streaming: true });
    send('event', { id, event: { type: 'message_start', message: { role: 'assistant' } } });
    let tick = 0;
    globalThis.__composerStream = setInterval(() => send('event', { id, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `live ${++tick} ` } } }), 30);
  }, id);
  await page.evaluate(() => {
    const input = document.querySelector('.dock textarea[aria-label="Message"]');
    const probe = { frames: [], styles: [], active: true };
    probe.observer = new MutationObserver(records => { for (const record of records) probe.styles.push(record.oldValue ?? ''); });
    probe.observer.observe(input, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    const frame = () => {
      if (!probe.active) return;
      const rect = input.getBoundingClientRect();
      probe.frames.push({ top: rect.top, height: rect.height, focused: document.activeElement === input, connected: input.isConnected });
      requestAnimationFrame(frame);
    };
    frame(); window.__composerProbe = probe;
    probe.timer = setTimeout(() => {
      const scroller = document.querySelector('.session-main .transcript');
      scroller.scrollTop = 40;
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    }, 120);
  });
  try {
    await input.pressSequentially(addition, { delay: 20 });
    await page.waitForTimeout(120);
    const probe = await page.evaluate(() => {
      const p = window.__composerProbe; p.active = false; p.observer.disconnect(); clearTimeout(p.timer);
      const input = document.querySelector('.dock textarea[aria-label="Message"]');
      return { frames: p.frames, styles: p.styles, text: input.value, caret: input.selectionEnd };
    });
    assert.equal(probe.text, prefix + addition);
    assert.equal(probe.caret, probe.text.length);
    assert.ok(probe.frames.length > 3);
    const first = probe.frames[0];
    assert.ok(probe.frames.every(frame => frame.connected && frame.focused), 'typing lost the editor or focus');
    assert.ok(probe.frames.every(frame => Math.abs(frame.height - first.height) < 1 && Math.abs(frame.top - first.top) < 1), 'composer moved while typing within the same line');
    assert.ok(probe.styles.every(style => !/height:\s*auto/.test(style)), 'the focused editor collapsed for measurement');
    console.log(`PASS composer steady through ${probe.frames.length} frames while typing, streaming and paging`);
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => {
      clearInterval(globalThis.__composerStream);
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.send('pidesk:event', { channel: 'event', payload: { id, event: { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: 'Stream finished during typing fixture' }] } } } });
      contents.send('pidesk:event', { channel: 'status', payload: { id, status: 'connected', streaming: false } });
    }, id);
    await page.evaluate(() => { const p = window.__composerProbe; if (p) { p.active = false; p.observer.disconnect(); clearTimeout(p.timer); delete window.__composerProbe; } });
    await input.fill('');
  }
}
