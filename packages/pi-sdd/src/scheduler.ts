import { Type } from 'typebox';
import { check, IssueSchema, type Issue } from './beads-schema.ts';
import {
  actionChildren, assertExecutionBinding, checkApproval, isBoundAction,
  type ExecutionState, type PersistExecution,
} from './approval.ts';
import type { SessionState } from './session-state.ts';

const ReadySchema = Type.Array(IssueSchema);

export type NextAction = { kind: 'action'; actionId: string }
  | { kind: 'paused'; reason: 'blocked_or_claimed' }
  | { kind: 'complete' };

export function nextAction({ binding, state, actionIds, children, ready }: {
  binding: SessionState;
  state: ExecutionState;
  actionIds: readonly string[];
  children: unknown;
  ready: unknown;
}): NextAction {
  assertExecutionBinding(binding, state);
  const tasks = actionChildren(children);
  if (!check(ReadySchema, ready)) throw new Error('INVALID_READY');
  for (const task of ready) {
    if (!['open', 'in_progress', 'closed'].includes(task.status)) throw new Error(`INVALID_TASK_STATUS: ${task.id}`);
  }
  if (new Set(actionIds).size !== actionIds.length) throw new Error('DUPLICATE_ACTION_ID');
  const ordered = actionIds.map(id => {
    const task = tasks.find(child => child.id === id);
    if (!task) throw new Error(`TASK_MISSING: ${id}`);
    if (!isBoundAction(task, binding)) throw new Error(`TASK_NOT_BOUND_ACTION: ${id}`);
    return task;
  });
  if (ordered.every(task => task.status === 'closed')) return { kind: 'complete' };
  const readyIds = new Set(ready.filter(task => task.status === 'open').map(task => task.id));
  const claimed = new Set(state.claims.map(claim => claim.actionId));
  for (let offset = 0; offset < ordered.length; offset += 1) {
    const task = ordered[(state.cursor + offset) % ordered.length];
    if (task?.status === 'open' && readyIds.has(task.id) && !claimed.has(task.id)) {
      return { kind: 'action', actionId: task.id };
    }
  }
  return { kind: 'paused', reason: 'blocked_or_claimed' };
}

// Only the parent calls this after reviewing and verifying the action's evidence.
export async function checkpointAction({ binding, state, actionIds, actionId, claimId, reason, close, persist }: {
  binding: SessionState;
  state: ExecutionState;
  actionIds: readonly string[];
  actionId: string;
  claimId: string;
  reason: string;
  close: (id: string, reason: string) => Promise<Issue>;
  persist: PersistExecution;
}): Promise<void> {
  assertExecutionBinding(binding, state);
  if (!checkApproval({ binding, state, actionId, claimId })) throw new Error('CLAIM_REQUIRED');
  const index = actionIds.indexOf(actionId);
  if (index < 0 || new Set(actionIds).size !== actionIds.length) throw new Error('INVALID_ACTION_ORDER');
  if (!reason.trim()) throw new Error('CHECKPOINT_REASON_REQUIRED');
  const result: unknown = await close(actionId, reason);
  if (!check(IssueSchema, result) || result.id !== actionId || result.status !== 'closed'
    || !isBoundAction(result, binding)) throw new Error('CLOSE_NOT_CONFIRMED');
  if (!checkApproval({ binding, state, actionId, claimId })) throw new Error('CLAIM_CHANGED');
  const next = { ...state, claims: state.claims.filter(claim => claim.claimId !== claimId), cursor: index + 1 };
  persist(structuredClone(next));
  state.claims = next.claims;
  state.cursor = next.cursor;
}
