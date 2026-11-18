import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('release checks the exact main push CI and previews still run the reusable offline suites', () => {
  const verify = release.jobs.verify.steps[0].run;
  assert.equal(release.permissions.actions, 'read');
  assert.match(verify, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA&branch=main&event=push/);
  assert.match(verify, /\[\[ "\$conclusion" == success \]\]/);
  assert.match(verify, /exit 1/);
  assert.equal(release.jobs.verify_preview.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(release.jobs.verify_preview.uses, './.github/workflows/ci.yml');
  assert.deepEqual(release.jobs.verify_preview.with, { skip_ui: true });
  assert.equal(ci.on.workflow_call.inputs.skip_ui.type, 'boolean');
  assert.equal(ci.on.workflow_call.inputs.skip_ui.default, false);
  assert.equal(ci.jobs.ui.if, '${{ !inputs.skip_ui }}');
  assert.equal(ci.jobs.core.if, undefined);
  assert.equal(ci.jobs.bridge.if, undefined);
});

test('Electron downloads reuse versioned caches across app version bumps and retry only finitely', () => {
  for (const job of [ci.jobs.ui, release.jobs.mac]) {
    const cache = job.steps.find(step => step.uses?.startsWith('actions/cache@'));
    assert.match(cache.with['restore-keys'], /^electron-/);
    const install = job.steps.find(step => step.run?.includes('node_modules/electron/install.js')).run;
    assert.match(install, /for attempt in 1 2 3/);
    assert.match(install, /\[ "\$attempt" -lt 3 \] \|\| exit 1/);
    assert.doesNotMatch(install, /ELECTRON_MIRROR|skip.?checksum/i);
  }
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
