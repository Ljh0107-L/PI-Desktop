import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('release verification uses a declared reusable-workflow input, not an unsupported jobs selector', () => {
  assert.equal(release.jobs.verify.uses, './.github/workflows/ci.yml');
  assert.equal(release.jobs.verify.jobs, undefined);
  assert.deepEqual(release.jobs.verify.with, { skip_ui: true });
  assert.equal(ci.on.workflow_call.inputs.skip_ui.type, 'boolean');
  assert.equal(ci.on.workflow_call.inputs.skip_ui.default, false);
  assert.equal(ci.jobs.ui.if, '${{ !inputs.skip_ui }}');
  assert.equal(ci.jobs.core.if, undefined);
  assert.equal(ci.jobs.bridge.if, undefined);
});

test('only publication is gated; downloaded assets and the release tag match the publish command', () => {
  assert.equal(release.jobs.mac.needs, undefined);
  assert.deepEqual(release.jobs.publish.needs, ['verify', 'mac']);
  assert.match(release.jobs.publish.if, /startsWith\(github.ref, 'refs\/tags\/v'\)/);
  const upload = release.jobs.mac.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = release.jobs.publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, 'release');
  const publish = release.jobs.publish.steps.find(step => step.name === 'Create GitHub release').run;
  assert.match(publish, /gh release create "\$GITHUB_REF_NAME" release\/\*\.dmg release\/\*\.zip release\/latest-mac\.yml/);
  assert.doesNotMatch(publish, /"\$GITHUB_REF_NAME#v"/);
});
