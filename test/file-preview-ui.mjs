// Real file-preview regressions, shared by the local and loopback-SSH E2E sessions.
// Fixtures live on the same host as test/sshd.sh; reads still go through each session's API.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const svg = width => `<svg xmlns="http://www.w3.org/2000/svg" id="preview-diagram" width="${width}" height="900" viewBox="0 0 ${width} 900"><rect width="100%" height="100%" fill="#42a5f5"/></svg>`;

export async function checkFilePreview({ page, id, project, environmentId, shots = '/tmp/pidesk-e2e/shots' }) {
  const fixture = 'file-preview-fixture';
  const guide = `${fixture}/docs/nested/guide.md`;
  const next = `${fixture}/docs/nested/next.md`;
  const linked = `${fixture}/targets/linked 文件.md`;
  const diagram = `${fixture}/docs/assets/图 表/diagram one.svg`;
  const pixel = `${fixture}/docs/assets/图 表/pixel one.png`;
  const broken = `${fixture}/docs/nested/broken.md`;
  const source = `${fixture}/complete.unknownext`;
  const heading = 'File preview regression guide';
  const nextHeading = 'Fresh second file';
  const markdown = [
    `# ${heading}`,
    '[Jump to details](#preview-details)',
    '[Open related document](../../targets/linked%20%E6%96%87%E4%BB%B6.md)',
    '![Nested SVG](../assets/%E5%9B%BE%20%E8%A1%A8/diagram%20one.svg)',
    '![Nested PNG](../assets/%E5%9B%BE%20%E8%A1%A8/pixel%20one.png)',
    ...Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1}: space before the heading anchor.`),
    '## Preview details',
    'The anchor must scroll the file preview, not the conversation.',
  ].join('\n\n');
  const longText = `${'Unknown extension plain text line.\n'.repeat(7000)}UNKNOWN_EXTENSION_LAST_LINE <tail> & intact\n`;
  const put = (path, content) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  };
  // Make re-runs deterministic without modifying any of the existing conversation fixtures.
  rmSync(join(project, fixture), { recursive: true, force: true });
  put(guide, markdown);
  put(next, `# ${nextHeading}\n\nOnly this file's content belongs here.\n`);
  put(linked, '# Relative document opened\n\nThe link is relative to the guide, not the project root.\n');
  put(diagram, svg(1800));
  put(pixel, Buffer.from(PNG, 'base64'));
  put(`${fixture}/docs/assets/corrupt.svg`, 'This is not valid SVG data.');
  put(broken, '# Image failure feedback\n\n![Missing asset](../assets/missing.svg)\n\n![Corrupt asset](../assets/corrupt.svg)\n');
  put(source, longText);

  let step = 'start';
  const open = path => page.evaluate(path => window.dispatchEvent(new CustomEvent('pidesk:open-file', { detail: path })), path);
  const waitHeading = text => page.locator('.file-pane .fp-markdown h1', { hasText: text }).waitFor({ timeout: 30000 });
  const waitImages = (svgWidth = 1800) => page.waitForFunction(width => {
    const svg = document.querySelector('.fp-markdown img[alt="Nested SVG"]');
    const png = document.querySelector('.fp-markdown img[alt="Nested PNG"]');
    return svg?.complete && svg.naturalWidth === width && svg.naturalHeight === 900 && png?.complete && png.naturalWidth === 1;
  }, svgWidth, { timeout: 30000 });
  const observeSwitch = async (target, oldHeading, oldImage = null) => page.evaluate(({ target, oldHeading, oldImage }) => {
    window.__filePreviewProbe?.observer.disconnect();
    const probe = { stale: [] };
    probe.observer = new MutationObserver(() => {
      const pane = document.querySelector('.file-pane');
      if (pane?.querySelector('.fp-crumb-path .last')?.textContent !== target) return;
      const content = pane.querySelector('.fp-content');
      if (content && (content.textContent.includes(oldHeading) || (oldImage && [...content.querySelectorAll('img')].some(img => img.alt === oldImage)))) {
        probe.stale.push(content.textContent.slice(0, 160));
      }
    });
    probe.observer.observe(document.querySelector('.file-pane'), { subtree: true, childList: true, characterData: true, attributes: true });
    window.__filePreviewProbe = probe;
  }, { target, oldHeading, oldImage });
  const assertNoStale = async () => {
    const stale = await page.evaluate(() => {
      const probe = window.__filePreviewProbe;
      probe.observer.disconnect();
      delete window.__filePreviewProbe;
      return probe.stale;
    });
    assert.deepEqual(stale, [], 'a new file must never render the previous file under its breadcrumbs, even while loading');
  };

  try {
    step = 'session identity';
    const session = await page.evaluate(async id => {
      if (window.__pideskState().activeId !== id) throw new Error('file preview fixture is not in the requested session');
      return (await window.pidesk.invoke('listSessions')).find(s => s.id === id);
    }, id);
    assert.equal(session?.environmentId, environmentId, 'the fixture must exercise the requested local/SSH environment');

    step = 'nested encoded SVG and PNG';
    await open(guide);
    await waitHeading(heading);
    await waitImages();
    const images = await page.locator('.fp-markdown img').evaluateAll(imgs => imgs.map(img => ({ alt: img.alt, src: img.getAttribute('src') })));
    assert.match(images.find(img => img.alt === 'Nested SVG')?.src ?? '', /^data:image\/svg\+xml[;,]/, 'SVG must use the session readFile data URL, not a renderer-relative URL');
    assert.match(images.find(img => img.alt === 'Nested PNG')?.src ?? '', /^data:image\/png[;,]/);
    assert.equal(await page.locator('.fp-markdown svg#preview-diagram').count(), 0, 'file SVG must never be injected as inline DOM');
    const layout = await page.locator('.fp-markdown img[alt="Nested SVG"]').evaluate(img => {
      const markdown = img.closest('.markdown'), scroller = img.closest('.fp-content');
      return { width: img.getBoundingClientRect().width, available: markdown.clientWidth, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth };
    });
    assert.ok(layout.width > 0 && layout.width <= layout.available + 1, `oversized Markdown images must fit the preview: ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'the large SVG must not create sideways preview scrolling');
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `file-preview-images-${environmentId.replace(/\W+/g, '-')}.png`) });

    step = 'image-only refresh';
    const oldImage = await page.locator('.fp-markdown img[alt="Nested SVG"]').getAttribute('src');
    put(diagram, svg(900));
    assert.equal(readFileSync(join(project, guide), 'utf8'), markdown, 'refresh fixture must leave Markdown text unchanged');
    await page.getByRole('button', { name: 'More file actions', exact: true }).click();
    await page.locator('.popover .menu-item', { hasText: /^Refresh$/ }).click();
    await waitImages(900);
    assert.notEqual(await page.locator('.fp-markdown img[alt="Nested SVG"]').getAttribute('src'), oldImage, 'Refresh must reload image bytes even when the Markdown text is identical');

    step = 'heading anchor';
    await page.locator('.fp-markdown').getByRole('link', { name: 'Jump to details', exact: true }).click();
    await page.waitForFunction(() => {
      const content = document.querySelector('.file-pane .fp-content');
      const heading = [...document.querySelectorAll('.fp-markdown h2')].find(el => el.textContent === 'Preview details');
      if (!content || !heading || content.scrollTop < 100) return false;
      const view = content.getBoundingClientRect(), target = heading.getBoundingClientRect();
      return target.top >= view.top - 1 && target.bottom <= view.bottom + 1;
    }, undefined, { timeout: 10000 });
    assert.equal(await page.locator('.fp-tab.active .fp-tab-name').innerText(), 'guide.md', 'same-document anchors must not open another file tab');

    step = 'document-relative link';
    await page.locator('.fp-markdown').getByRole('link', { name: 'Open related document', exact: true }).click();
    await waitHeading('Relative document opened');
    assert.equal(await page.locator('.fp-tab.active .fp-tab-name').innerText(), 'linked 文件.md');

    step = 'switching files hides stale content';
    await page.locator('.fp-tabs').getByRole('button', { name: 'guide.md', exact: true }).click();
    await waitHeading(heading);
    await waitImages(900);
    await observeSwitch('next.md', heading, 'Nested SVG');
    await open(next);
    await waitHeading(nextHeading);
    await assertNoStale();
    await observeSwitch('guide.md', nextHeading);
    await page.locator('.fp-tabs').getByRole('button', { name: 'guide.md', exact: true }).click();
    await waitHeading(heading);
    await assertNoStale();
    await waitImages(900);

    step = 'read and decode failures are readable';
    await open(broken);
    await waitHeading('Image failure feedback');
    await page.waitForFunction(() => document.querySelectorAll('.fp-markdown .markdown-image-error').length === 2, undefined, { timeout: 30000 });
    const errors = page.locator('.fp-markdown .markdown-image-error');
    for (let i = 0; i < 2; i++) {
      assert.equal(await errors.nth(i).isVisible(), true, 'failed images need visible feedback');
      const description = await errors.nth(i).evaluate(el => `${el.getAttribute('title') ?? ''} ${el.textContent}`.trim());
      assert.match(description, /could not|unable|fail|error|unavailable|load|missing|invalid|not (?:found|a file)|ENOENT/i, 'feedback must explain the image failure rather than silently showing a broken icon');
    }

    step = 'complete unknown-extension source';
    await open(source);
    await page.waitForFunction(() => document.querySelector('.file-pane .fp-source')?.textContent.includes('UNKNOWN_EXTENSION_LAST_LINE'), undefined, { timeout: 30000 });
    assert.equal(await page.locator('.file-pane .fp-source').textContent(), longText, 'unknown extensions must not lose text after the highlighting cutoff');
    assert.equal(await page.locator('.fp-truncated').count(), 0, 'the fixture is below the backend preview limit');
  } catch (error) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `zz-file-preview-${environmentId.replace(/\W+/g, '-')}-${step.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    throw new Error(`file preview (${environmentId}) failed at "${step}": ${error.message}`, { cause: error });
  } finally {
    await page.evaluate(() => {
      window.__filePreviewProbe?.observer.disconnect();
      delete window.__filePreviewProbe;
    });
    // Close earlier tests' retained tabs too: their later selectors assume a clean file pane.
    if (await page.locator('.file-pane').count()) {
      for (let i = 0; i < 12 && await page.locator('.fp-tab-close').count(); i++) await page.locator('.fp-tab-close').first().click();
      assert.equal(await page.locator('.fp-tab-close').count(), 0, 'file preview fixture must leave no open tabs');
      await page.getByRole('button', { name: 'Close files', exact: true }).click();
      await page.locator('.file-pane').waitFor({ state: 'detached' });
    }
  }
}
