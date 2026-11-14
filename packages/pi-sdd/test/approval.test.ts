import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAction, checkApproval, createExecutionState } from '../src/approval.ts';

const binding = { active: true, projectRoot: '/repo', specPath: '/repo/spec', missionId: 'mission-a' };
const action = { id: 'mission-a.1', title: '[action] First', status: 'open', issue_type: 'task', parent: 'mission-a' };

test('claim open action records a synchronous approval and returns claimId', () => {
  const state = createExecutionState(binding);
  const writes: unknown[] = [];
  const claimId = claimAction({ binding, state, actionId: action.id, children: [action], persist: s => writes.push(structuredClone(s)) });
  assert.equal(typeof claimId, 'string');
  assert.equal(state.claims[0]?.claimId, claimId);
  assert.equal(checkApproval({ binding, state, actionId: action.id, claimId }), true);
  assert.equal(checkApproval({ binding, state, actionId: action.id, claimId: 'forged' }), false);
  assert.equal(writes.length, 1);
  assert.throws(() => claimAction({ binding, state, actionId: action.id, children: [action], persist: () => {} }), /ALREADY_CLAIMED/);
});

for (const [name, children, bound] of [
  ['closed', [{ ...action, status: 'closed' }], binding],
  ['missing', [], binding],
  ['non-child', [{ ...action, parent: 'mission-b' }], binding],
  ['non-action', [{ ...action, title: 'First' }], binding],
  ['wrong-type', [{ ...action, issue_type: 'epic' }], binding],
  ['in-progress', [{ ...action, status: 'in_progress' }], binding],
  ['unbound', [action], { ...binding, missionId: null }],
  ['inactive', [action], { ...binding, active: false }],
] as const) {
  test(`claim ${name} fails without recording state`, () => {
    const state = createExecutionState(binding);
    assert.throws(() => claimAction({ binding: bound, state, actionId: action.id, children, persist: () => assert.fail('unexpected write') }));
    assert.deepEqual(state.claims, []);
  });
}

test('failed persistence does not claim locally and foreign binding cannot approve', () => {
  const state = createExecutionState(binding);
  assert.throws(() => claimAction({ binding, state, actionId: action.id, children: [action], persist: () => { throw new Error('write failed'); } }), /write failed/);
  assert.deepEqual(state.claims, []);
  const claimId = claimAction({ binding, state, actionId: action.id, children: [action], persist: () => {} });
  assert.equal(checkApproval({ binding: { ...binding, missionId: 'mission-b' }, state, actionId: action.id, claimId }), false);
});
