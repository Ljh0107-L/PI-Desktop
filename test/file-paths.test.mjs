import assert from 'node:assert/strict';
import test from 'node:test';
import { headingSlug, normalizeFilePath, relativeSessionPath, resolveMarkdownReference } from '../app/renderer/src/file-paths.js';

test('Markdown references resolve from the document, decode once and strip URL suffixes before decoding', () => {
  const doc = '/project/report/draft-zh.md';
  assert.deepEqual(resolveMarkdownReference('figures/wrf-call-tree.svg', doc), { kind: 'file', path: '/project/report/figures/wrf-call-tree.svg', fragment: '' });
  assert.deepEqual(resolveMarkdownReference('../a%20%E5%9B%BE%23%25.svg?raw=1#view', doc), { kind: 'file', path: '/project/a 图#%.svg', fragment: 'view' });
  assert.equal(resolveMarkdownReference('figures/100%25.svg', doc).path, '/project/report/figures/100%.svg');
  assert.equal(resolveMarkdownReference('figures/literal%2520.svg', doc).path, '/project/report/figures/literal%20.svg');
  assert.equal(resolveMarkdownReference('/absolute/image.png', doc).path, '/absolute/image.png');
  assert.equal(resolveMarkdownReference('~/image.png', doc).path, '~/image.png');
  assert.equal(resolveMarkdownReference('../figures/a.svg', 'report/nested/readme.md').path, 'report/figures/a.svg');
  assert.equal(resolveMarkdownReference('note.md').path, 'note.md');
  assert.equal(resolveMarkdownReference('bad%ZZ.png', doc).path, '/project/report/bad%ZZ.png');
});

test('literal file-tree/tool paths keep percent and hash characters and deduplicate dot paths', () => {
  assert.equal(relativeSessionPath('/project', '/project/./report/../100%20#test.md'), '100%20#test.md');
  assert.equal(relativeSessionPath('/project', 'new\nline.md'), 'new\nline.md');
  assert.equal(relativeSessionPath('/project/', '/project/file.md'), 'file.md');
  assert.equal(relativeSessionPath('/project', '/project-two/file.md'), '/project-two/file.md');
  assert.equal(relativeSessionPath('/project', 'file:///project/100%2520%23test.md'), '100%20#test.md');
  assert.equal(relativeSessionPath('/project', 'file://other-host/project/file.md'), null);
  assert.equal(normalizeFilePath('../../file.md'), '../../file.md');
  assert.equal(normalizeFilePath('/../../file.md'), '/file.md');
});

test('anchors, external destinations and unsafe schemes are classified explicitly', () => {
  assert.deepEqual(resolveMarkdownReference('#%E6%A0%87%E9%A2%98'), { kind: 'anchor', fragment: '标题' });
  assert.deepEqual(resolveMarkdownReference('//example.com/a.png'), { kind: 'external', url: 'https://example.com/a.png' });
  assert.equal(resolveMarkdownReference('https://example.com/a.png').kind, 'external');
  assert.equal(resolveMarkdownReference('mailto:user@example.com').kind, 'external');
  assert.equal(resolveMarkdownReference('data:image/svg+xml;base64,PHN2Zy8+').kind, 'image');
  for (const src of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:foo', 'file://evil/a', 'a%00.png', 'a\\b.svg', '']) {
    assert.equal(resolveMarkdownReference(src).kind, 'blocked', src);
  }
  assert.equal(headingSlug('Preview details'), 'preview-details');
  assert.equal(headingSlug('第一部分 · 拆解 WRF'), '第一部分--拆解-wrf');
});
