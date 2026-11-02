import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSessions } from '../app/renderer/src/session-groups.js';

const chat = (id, cwd, rest = {}) => ({ id, cwd, noFolder: true, project: 'No folder', environmentId: 'local', environmentLabel: 'This computer', ...rest });

test('No folder combines different generated directories, legacy roots and forks', () => {
  const sessions = [chat('new', '/Pi/2026-11-02/new-chat'), chat('old', '/Pi/2026-11-01/old-chat'), chat('legacy', '/Pi'), chat('fork', '/Pi/2026-11-01/old-chat')];
  const before = structuredClone(sessions);
  const groups = groupSessions(sessions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].project, 'No folder');
  assert.equal(groups[0].cwd, undefined, 'do not advertise one chat directory as the whole group');
  assert.deepEqual(groups[0].items.map(s => s.id), ['new', 'old', 'legacy', 'fork']);
  groups[0].items.forEach((s, i) => assert.equal(s, sessions[i]));
  assert.deepEqual(sessions, before, 'grouping must not change persisted records or directories');
});

test('No folder is one group per environment, not one group across all machines', () => {
  const remote = host => ({ environmentId: `ssh:${host}`, environmentLabel: host });
  const groups = groupSessions([chat('local', '/Pi/a'), chat('r1', '/pi/a', remote('host-a')), chat('r2', '/pi/b', remote('host-a')), chat('r3', '/pi/a', remote('host-b'))]);
  assert.deepEqual(groups.map(g => [g.env, g.remote, g.items.length]), [['This computer', false, 1], ['host-a', true, 2], ['host-b', true, 1]]);
  assert.equal(new Set(groups.map(g => g.key)).size, 3);
});

test('ordinary projects retain directory grouping, even a real folder named No folder', () => {
  const sessions = [chat('p1', '/projects/demo', { noFolder: undefined, project: 'demo' }), chat('p2', '/projects/demo', { noFolder: false, project: 'demo' }),
    chat('p3', '/elsewhere/demo', { noFolder: undefined, project: 'demo' }), chat('named', '/projects/No folder', { noFolder: undefined }), chat('unfiled', '/projects/No folder')];
  const groups = groupSessions(sessions);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0].items.map(s => s.id), ['p1', 'p2']);
  assert.equal(groups[1].cwd, '/elsewhere/demo');
  assert.equal(groups[2].cwd, '/projects/No folder');
  assert.equal(groups[2].noFolder, false);
  assert.notEqual(groups[2].key, groups[3].key);
});

test('No folder group identity stays stable when the newest conversation changes', () => {
  const a = chat('a', '/Pi/day/a'), b = chat('b', '/Pi/day/b');
  assert.equal(groupSessions([a, b])[0].key, groupSessions([b, a])[0].key);
  assert.equal(groupSessions([a, b])[0].key, groupSessions([b])[0].key);
  assert.deepEqual(groupSessions([]), []);
});

test('group keys do not collide on delimiter characters in hosts or paths', () => {
  const sessions = [chat('a', '/b|/c', { noFolder: false, environmentId: 'ssh:a' }), chat('b', '/c', { noFolder: false, environmentId: 'ssh:a|/b' })];
  assert.equal(groupSessions(sessions).length, 2);
});
