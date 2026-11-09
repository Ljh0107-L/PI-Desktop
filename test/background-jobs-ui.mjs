// Offline CI only: exercise the real tool -> bridge -> main -> IPC -> right-panel path.
export async function checkBackgroundJobs({ page, send, check, shot, remote = false, dropSsh }) {
  const jobs = () => page.locator('.right-panel .jobs');
  const card = () => page.locator('.right-panel .panel-card:has(.jobs)');
  const transcript = () => page.locator('.session-main .transcript');
  const idle = () => page.waitForFunction(() => {
    const s = window.__pideskState(), row = s.sessions.find(x => x.id === s.activeId);
    return row?.status === 'connected' && !row.streaming;
  }, undefined, { timeout: 30000 });
  const waitJob = (id, status) => page.waitForFunction(({ id, status }) => {
    const s = window.__pideskState();
    return s.jobs[s.activeId]?.jobs.some(job => job.id === id && job.status === status);
  }, { id, status }, { timeout: 30000 });
  const capture = async name => {
    await page.locator('.right-panel').evaluate(panel => { panel.scrollTop = 0; });
    const path = await shot(name);
    await page.locator('.right-panel').screenshot({ path: path.replace('.png', '-sidebar.png') });
    await card().screenshot({ path: path.replace('.png', '-card.png') });
  };
  await idle();
  await send('[[background-job]]');
  const running = jobs().locator('.job.running').first();
  await running.waitFor({ timeout: 20000 });
  const firstId = await running.getAttribute('data-job-id');
  await running.locator('.job-details-toggle').click();
  check(`${remote ? 'SSH' : 'local'} background task shows its command and Stop button`,
    await running.locator('.job-command').innerText() === 'echo started; sleep 4; echo job-done' &&
    await running.getByRole('button', { name: /Stop job/ }).isEnabled());
  if (remote) check('background command survives dropped SSH', dropSsh());
  await waitJob(firstId, 'exited');
  await card().waitFor({ state: 'detached', timeout: 30000 });
  check('finished background tasks remove the entire empty card', await card().count() === 0);
  const completion = transcript().getByText(/finished successfully[\s\S]*job-done/).last();
  await completion.waitFor({ timeout: 30000 });
  check('completion output stays in the conversation', (await completion.textContent()).includes('job-done'));
  check('completed jobs retain output and duration for background_status', await page.evaluate(id => {
    const s = window.__pideskState(), job = s.jobs[s.activeId].jobs.find(job => job.id === id);
    return job.exitCode === 0 && job.elapsedMs > 0 && job.tail.includes('job-done');
  }, firstId));
  await idle();

  const record = await page.evaluate(() => {
    const s = window.__pideskState(); return s.sessions.find(row => row.id === s.activeId);
  });
  const reload = async () => {
    await page.reload();
    await page.locator('.session-row-main').getByText(record.title, { exact: true }).click();
    await idle();
  };
  await reload();
  // Wait for the authoritative snapshot, not the initial empty renderer store.
  await waitJob(firstId, 'exited');
  check('a renderer reload does not resurrect completed rows', await card().count() === 0);
  await send('[[background-job-fail]]');
  const failure = transcript().getByText(/finished with exit code 7[\s\S]*failed/).last();
  await failure.waitFor({ timeout: 30000 });
  await card().waitFor({ state: 'detached', timeout: 30000 });
  check('failed tasks also leave the card and report their failure in chat',
    await card().count() === 0 && (await failure.textContent()).includes('failed'));
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
  check('task rows align with the standard card inset at the real sidebar width', await card().evaluate(element => {
    const box = element.getBoundingClientRect();
    const title = element.querySelector('.panel-card-head > span').getBoundingClientRect();
    return box.width <= 264 && [...element.querySelectorAll('.job')].every(row => {
      const heading = row.querySelector('.job-head').getBoundingClientRect();
      const actions = row.querySelector('.job-actions').getBoundingClientRect();
      return Math.abs(heading.left - title.left) < 1 && box.right - actions.right >= 14;
    }) && !element.querySelector('.panel-card-aside');
  }));
  await idle();
  if (!remote) {
    const liveId = await jobs().locator('.job').getAttribute('data-job-id');
    await reload();
    await waitJob(liveId, 'running');
    await jobs().locator('.job').waitFor({ timeout: 20000 });
    await capture('05g-background-tasks-collapsed');
    await jobs().locator('.job-details-toggle').click();
    await jobs().locator('.job-output').filter({ hasText: 'ready' }).waitFor({ timeout: 10000 });
    check('expanded details do not overflow the narrow card', await card().evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('.job-details, .job-cwd, .job-terminal, pre')].every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= box.left + 14 && rect.right <= box.right - 14;
      });
    }));
    await capture('05g-background-tasks-expanded');
    await jobs().locator('.job-details-toggle').click();
  } else {
    await shot('08g-background-tasks-running');
  }
  const assistantCount = () => page.evaluate(() => {
    const s = window.__pideskState(); return s.transcripts[s.activeId].messages.filter(m => m.role === 'assistant').length;
  });
  const beforeStop = await assistantCount();
  for (let index = 0; index < count; index++) {
    const row = jobs().locator('.job').first();
    const id = await row.getAttribute('data-job-id');
    await row.locator('.job-stop').click();
    await waitJob(id, 'stopped');
    await jobs().locator(`[data-job-id="${id}"]`).waitFor({ state: 'detached', timeout: 12000 });
    check('stopping one task preserves the remaining active rows', await jobs().locator('.job').count() === count - index - 1);
  }
  await card().waitFor({ state: 'detached', timeout: 12000 });
  check('Stop terminates the background command without a model turn', await assistantCount() === beforeStop);
  await idle();
  await shot(remote ? '08h-background-tasks-stopped' : '05h-background-tasks-stopped');
}
