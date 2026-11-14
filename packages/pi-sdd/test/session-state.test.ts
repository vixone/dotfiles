import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  focusConflict,
  readLandFocus,
  reduceSession,
  SESSION_ENTRY_TYPE,
} from '../src/session-state.ts';

const stateA = { active: true, projectRoot: '/repo', specPath: '/repo/.start/specs/001-a', missionId: 'mission-a' };
const stateB = { active: true, projectRoot: '/repo', specPath: '/repo/.start/specs/001-a', missionId: 'mission-b' };

test('empty branch is inactive', () => {
  assert.equal(reduceSession([]).active, false);
  assert.deepEqual(reduceSession([]), { active: false, projectRoot: '', specPath: null, missionId: null });
});

test('latest own entry wins and foreign entries are ignored', () => {
  const session = SessionManager.inMemory('/repo');
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateB);
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateA);
  session.appendCustomEntry('other-extension', { active: false });
  assert.deepEqual(reduceSession(session.getBranch()), stateA);
});

test('malformed latest own entry fails closed instead of resuming an older one', () => {
  const session = SessionManager.inMemory('/repo');
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateA);
  session.appendCustomEntry(SESSION_ENTRY_TYPE, { active: 'yes', projectRoot: 1 });
  session.appendCustomEntry('other-extension', { active: false });
  assert.throws(() => reduceSession(session.getBranch()), /SESSION_STATE_CORRUPT/);
});

test('branch B does not see abandoned branch A entries', () => {
  const session = SessionManager.inMemory('/repo');
  const root = session.appendCustomEntry('other-extension', { keep: true });
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateA);
  assert.equal(reduceSession(session.getBranch()).missionId, 'mission-a');

  session.branch(root);
  assert.equal(reduceSession(session.getBranch()).active, false);
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateB);
  const branchB = session.getBranch();
  assert.equal(reduceSession(branchB).missionId, 'mission-b');
  assert.ok(session.getEntries().some(entry => entry.type === 'custom' && entry.customType === SESSION_ENTRY_TYPE
    && JSON.stringify(entry.data) === JSON.stringify(stateA)));
  assert.ok(!branchB.some(entry => entry.type === 'custom' && JSON.stringify(entry.data) === JSON.stringify(stateA)));
  assert.ok(branchB.some(entry => entry.type === 'custom' && entry.customType === 'other-extension'));
});

test('off entry keeps binding but deactivates', () => {
  const session = SessionManager.inMemory('/repo');
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateA);
  session.appendCustomEntry(SESSION_ENTRY_TYPE, { ...stateA, active: false });
  assert.deepEqual(reduceSession(session.getBranch()), { ...stateA, active: false });
});

test('land-focus is read from the branch and conflicts are explicit', () => {
  const session = SessionManager.inMemory('/repo');
  session.appendCustomEntry('land-focus', { id: 'mission-x', title: 'X' });
  session.appendCustomEntry('land-focus', { id: 'mission-a' });
  session.appendCustomEntry(SESSION_ENTRY_TYPE, stateA);
  const branch = session.getBranch();
  assert.deepEqual(readLandFocus(branch), { id: 'mission-a' });
  assert.equal(focusConflict(reduceSession(branch), readLandFocus(branch)), null);

  session.appendCustomEntry('land-focus', { id: 'mission-x' });
  const conflicted = session.getBranch();
  assert.deepEqual(focusConflict(reduceSession(conflicted), readLandFocus(conflicted)), {
    sddMissionId: 'mission-a',
    focusMissionId: 'mission-x',
  });

  session.appendCustomEntry('land-focus', null);
  assert.equal(readLandFocus(session.getBranch()), null);
  session.appendCustomEntry('land-focus', { id: 42 });
  assert.equal(readLandFocus(session.getBranch()), null);
  assert.equal(focusConflict(reduceSession([]), { id: 'mission-x' }), null);
});
