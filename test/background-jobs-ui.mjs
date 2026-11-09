// Offline CI only: exercise the real tool -> bridge -> main -> IPC -> right-panel path.
export async function checkBackgroundJobs({ page, send, check, shot, remote = false, dropSsh }) {
  const jobs = () => page.locator('.right-panel .jobs');
  const idle = () => page.waitForFunction(() => {
    const s = window.__pideskState(), row = s.sessions.find(x => x.id === s.activeId);
    return row?.status === 'connected' && !row.streaming;
  }, undefined, { timeout: 30000 });
  await idle();
  await send('[[background-job]]');
  const running = jobs().locator('.job.running').first();
  await running.waitFor({ timeout: 20000 });
  await running.locator('summary').click();
  check(`${remote ? 'SSH' : 'local'} background task shows its command and Stop button`,
    await running.locator('.job-command').innerText() === 'echo started; sleep 4; echo job-done' &&
    await running.getByRole('button', { name: /Stop job/ }).isEnabled());
  if (remote) check('background command survives dropped SSH', dropSsh());
  const done = jobs().locator('.job.done').first();
  await done.waitFor({ timeout: 30000 });
  check('background task completion has its output and a nonzero duration',
    (await done.locator('.job-output').textContent()).includes('job-done') &&
    (await done.locator('.job-elapsed').innerText()) !== '0s');
  await idle();

  // A renderer reload must fetch completed jobs even though no output events will arrive anymore.
  const record = await page.evaluate(() => {
    const s = window.__pideskState(); return s.sessions.find(row => row.id === s.activeId);
  });
  await page.reload();
  await page.locator('.session-row-main').getByText(record.title, { exact: true }).click();
  await jobs().locator('.job.done').first().waitFor({ timeout: 20000 });
  check('finished background tasks survive a renderer reload',
    (await jobs().locator('.job-output').first().textContent()).includes('job-done'));
  await idle();
  await send('[[background-job-fail]]');
  await jobs().locator('.job.failed').waitFor({ timeout: 20000 });
  check('nonzero exit is a failure, not a green completion',
    await jobs().locator('.job.failed .job-state').innerText() === 'Exit 7');
  await idle();

  await send(remote ? '[[background-job-many]]' : '[[background-job-stop]]');
  const count = remote ? 8 : 1;
  await page.waitForFunction(n => document.querySelectorAll('.right-panel .job-stop').length === n, count, { timeout: 20000 });
  check('all concurrent background tasks have reachable Stop buttons', await jobs().locator('.job-stop').count() === count);
  check('background tasks appear before the potentially long subagent list', await page.evaluate(() => {
    const taskCard = document.querySelector('.right-panel .jobs').closest('section');
    const subagents = document.querySelector('.right-panel .subagent-list');
    return !!(taskCard.compareDocumentPosition(subagents) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await shot(remote ? '08g-background-tasks-running' : '05g-background-tasks-running');
  if (remote) await jobs().getByRole('button', { name: /earlier tasks/ }).click();
  await idle();
  const assistantCount = () => page.evaluate(() => {
    const s = window.__pideskState(); return s.transcripts[s.activeId].messages.filter(m => m.role === 'assistant').length;
  });
  const beforeStop = await assistantCount();
  while (await jobs().locator('.job-stop').count()) {
    const row = jobs().locator('.job').filter({ has: page.locator('.job-stop') }).first();
    const id = await row.getAttribute('data-job-id');
    await row.locator('.job-stop').click();
    await jobs().locator(`[data-job-id="${id}"].stopped`).waitFor({ timeout: 12000 });
  }
  check('Stop terminates the background command without a model turn', await jobs().locator('.job.stopped').count() === count && await assistantCount() === beforeStop);
  await idle();
  if (remote) {
    check('earlier completed tasks can be expanded', await jobs().locator('.job').count() === 10);
    await jobs().getByRole('button', { name: 'Show fewer' }).click();
  }
  await shot(remote ? '08h-background-tasks-stopped' : '05h-background-tasks-stopped');
}
