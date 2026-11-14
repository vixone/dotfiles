import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAction, createExecutionState, EXECUTION_ENTRY_TYPE, reduceExecutionSession } from '../src/approval.ts';
import { nextAction, checkpointAction } from '../src/scheduler.ts';

const binding = { active: true, projectRoot: '/repo', specPath: '/repo/spec', missionId: 'mission-a' };
const a = { id: 'mission-a.1', title: '[action] A', status: 'open', issue_type: 'task', parent: 'mission-a' };
const b = { ...a, id: 'mission-a.2', title: '[action] B', dependencies: [{ issue_id: 'mission-a.2', depends_on_id: a.id, type: 'blocks' }] };
const actionIds = [b.id, a.id];

test('scheduler selects dependency-ready next, then dependent after close', () => {
  const state = createExecutionState(binding);
  assert.deepEqual(nextAction({ binding, state, actionIds, children: [b, a], ready: [a] }), { kind: 'action', actionId: a.id });
  assert.deepEqual(nextAction({ binding, state, actionIds, children: [b, { ...a, status: 'closed' }], ready: [b] }), { kind: 'action', actionId: b.id });
});

test('scheduler skips claimed and completed actions, pauses when all blocked', () => {
  const state = createExecutionState(binding);
  claimAction({ binding, state, actionId: a.id, children: [a], persist: () => {} });
  assert.deepEqual(nextAction({ binding, state, actionIds, children: [a, b], ready: [a] }), { kind: 'paused', reason: 'blocked_or_claimed' });
  assert.deepEqual(nextAction({ binding, state, actionIds, children: [a, b], ready: [a, b] }), { kind: 'action', actionId: b.id });
  assert.deepEqual(nextAction({ binding, state: createExecutionState(binding), actionIds, children: [a, b], ready: [] }), { kind: 'paused', reason: 'blocked_or_claimed' });
  assert.deepEqual(nextAction({ binding, state, actionIds, children: [{ ...a, status: 'closed' }, { ...b, status: 'closed' }], ready: [] }), { kind: 'complete' });
});

test('checkpoint closes, unclaims and persists cursor; resumed state starts there', async () => {
  const state = createExecutionState(binding);
  const entries: unknown[] = [];
  const persist = (data: typeof state) => { entries.push({ type: 'custom', customType: EXECUTION_ENTRY_TYPE, data: structuredClone(data) }); };
  const claimId = claimAction({ binding, state, actionId: a.id, children: [a], persist });
  const ids = [a.id, b.id];
  await checkpointAction({ binding, state, actionIds: ids, actionId: a.id, claimId, reason: 'Parent verified', close: async (id, reason) => {
    assert.equal(id, a.id); assert.equal(reason, 'Parent verified'); assert.equal(state.claims.length, 1);
    return { ...a, status: 'closed' };
  }, persist });
  assert.equal(state.cursor, 1);
  assert.deepEqual(state.claims, []);
  const resumed = reduceExecutionSession(entries, binding);
  assert.equal(resumed.cursor, 1);
  assert.deepEqual(nextAction({ binding, state: resumed, actionIds: ids, children: [a, b], ready: [a, b] }), { kind: 'action', actionId: b.id });
  assert.deepEqual(nextAction({ binding, state: resumed, actionIds: ids, children: [a, b], ready: [a] }), { kind: 'action', actionId: a.id });
});

test('close failure leaves claim and cursor intact', async () => {
  const state = createExecutionState(binding);
  const claimId = claimAction({ binding, state, actionId: a.id, children: [a], persist: () => {} });
  await assert.rejects(checkpointAction({ binding, state, actionIds, actionId: a.id, claimId, reason: 'Verified', close: async () => { throw new Error('close failed'); }, persist: () => assert.fail() }), /close failed/);
  assert.equal(state.cursor, 0);
  assert.equal(state.claims.length, 1);
});

test('checkpoint persistence failure retains claim and retries an already closed action', async () => {
  const state = createExecutionState(binding);
  const claimId = claimAction({ binding, state, actionId: a.id, children: [a], persist: () => {} });
  const input = { binding, state, actionIds: [a.id, b.id], actionId: a.id, claimId, reason: 'Parent verified', close: async () => ({ ...a, status: 'closed' }) };
  await assert.rejects(checkpointAction({ ...input, persist: () => { throw new Error('journal failed'); } }), /journal failed/);
  assert.equal(state.claims.length, 1);
  assert.equal(state.cursor, 0);
  await checkpointAction({ ...input, persist: () => {} });
  assert.equal(state.claims.length, 0);
  assert.equal(state.cursor, 1);
});

test('restored claims block redispatch and foreign bindings reset only their own execution', () => {
  const state = createExecutionState(binding);
  claimAction({ binding, state, actionId: a.id, children: [a], persist: () => {} });
  const entries = [{ type: 'custom', customType: EXECUTION_ENTRY_TYPE, data: state }];
  const resumed = reduceExecutionSession(entries, binding);
  assert.deepEqual(nextAction({ binding, state: resumed, actionIds: [a.id], children: [a], ready: [a] }), { kind: 'paused', reason: 'blocked_or_claimed' });
  const foreign = { ...binding, missionId: 'mission-b' };
  assert.deepEqual(reduceExecutionSession(entries, foreign), createExecutionState(foreign));
});

test('malformed status and ready envelope fail closed; corrupt session cannot resume', () => {
  const state = createExecutionState(binding);
  assert.throws(() => nextAction({ binding, state, actionIds, children: [{ ...a, status: 'mystery' }, b], ready: [] }), /STATUS/);
  assert.throws(() => nextAction({ binding, state, actionIds, children: [a, b], ready: { tasks: [a] } }), /READY/);
  assert.throws(() => reduceExecutionSession([{ type: 'custom', customType: EXECUTION_ENTRY_TYPE, data: {} }], binding), /CORRUPT/);
});
