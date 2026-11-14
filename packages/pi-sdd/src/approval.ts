import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { check, ChildrenOutputSchema, IssueIdSchema, type ChildIssue } from './beads-schema.ts';
import type { SessionState } from './session-state.ts';

export const EXECUTION_ENTRY_TYPE = 'pi-sdd-execution-v1';
export const ExecutionStateSchema = Type.Object({
  projectRoot: Type.String(),
  specPath: Type.Union([Type.String(), Type.Null()]),
  missionId: Type.Union([IssueIdSchema, Type.Null()]),
  claims: Type.Array(Type.Object({ actionId: IssueIdSchema, claimId: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  cursor: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type ExecutionState = Static<typeof ExecutionStateSchema>;
export type PersistExecution = (state: ExecutionState) => void;

export function createExecutionState(binding: SessionState): ExecutionState {
  return { projectRoot: binding.projectRoot, specPath: binding.specPath, missionId: binding.missionId, claims: [], cursor: 0 };
}

function matchesBinding(binding: SessionState, state: ExecutionState): boolean {
  return binding.projectRoot === state.projectRoot && binding.specPath === state.specPath && binding.missionId === state.missionId;
}

export function assertExecutionBinding(binding: SessionState, state: ExecutionState): void {
  if (!binding.active || !binding.projectRoot || !binding.specPath || !binding.missionId) throw new Error('TASK_UNBOUND');
  if (!matchesBinding(binding, state)) throw new Error('EXECUTION_BINDING_MISMATCH');
}

export function reduceExecutionSession(entries: readonly unknown[], binding: SessionState): ExecutionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'custom'
      || !('customType' in entry) || entry.customType !== EXECUTION_ENTRY_TYPE) continue;
    if (!('data' in entry) || !check(ExecutionStateSchema, entry.data)) throw new Error('EXECUTION_STATE_CORRUPT');
    const state = entry.data;
    if (new Set(state.claims.map(claim => claim.actionId)).size !== state.claims.length
      || new Set(state.claims.map(claim => claim.claimId)).size !== state.claims.length) throw new Error('EXECUTION_STATE_CORRUPT');
    return matchesBinding(binding, state) ? structuredClone(state) : createExecutionState(binding);
  }
  return createExecutionState(binding);
}

export function actionChildren(children: unknown): ChildIssue[] {
  if (!check(ChildrenOutputSchema, children)) throw new Error('INVALID_CHILDREN');
  if (new Set(children.map(child => child.id)).size !== children.length) throw new Error('DUPLICATE_CHILD_ID');
  for (const child of children) {
    if (!['open', 'in_progress', 'closed'].includes(child.status)) throw new Error(`INVALID_TASK_STATUS: ${child.id}`);
  }
  return children;
}

export function isBoundAction(child: ChildIssue, binding: SessionState): boolean {
  return child.parent === binding.missionId && child.issue_type === 'task' && child.title.startsWith('[action] ');
}

export function claimAction({ binding, state, actionId, children, persist }: {
  binding: SessionState;
  state: ExecutionState;
  actionId: string;
  children: unknown;
  persist: PersistExecution;
}): string {
  assertExecutionBinding(binding, state);
  const action = actionChildren(children).find(child => child.id === actionId);
  if (!action) throw new Error(`TASK_MISSING: ${actionId}`);
  if (!isBoundAction(action, binding)) throw new Error(`TASK_NOT_BOUND_ACTION: ${actionId}`);
  if (action.status !== 'open') throw new Error(`TASK_NOT_OPEN: ${actionId}`);
  if (state.claims.some(claim => claim.actionId === actionId)) throw new Error(`TASK_ALREADY_CLAIMED: ${actionId}`);
  const claimId = randomUUID();
  const next = { ...state, claims: [...state.claims, { actionId, claimId }] };
  persist(structuredClone(next));
  state.claims = next.claims;
  return claimId;
}

export function checkApproval({ binding, state, actionId, claimId }: {
  binding: SessionState;
  state: ExecutionState;
  actionId: string;
  claimId: string;
}): boolean {
  return binding.active && Boolean(binding.projectRoot && binding.specPath && binding.missionId)
    && matchesBinding(binding, state)
    && state.claims.some(claim => claim.actionId === actionId && claim.claimId === claimId);
}
