import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createBeadsClient, createToolTransport, type BeadsClient, type ExecuteTool } from './beads.ts';
import { materialize, readTaskStates } from './materialize.ts';
import { acquireProjectLock, repositoryRoot } from './project-lock.ts';
import { createSpec, resolveSpec } from './spec-store.ts';
import { focusConflict, readLandFocus, reduceSession, type SessionState } from './session-state.ts';

import { createWorkspace, type Workspace } from './workspace.ts';
import { collectPatch, integratePatch, type Patch } from './patch.ts';

const ProjectRoot = Type.String({ minLength: 1, description: 'Project directory; must resolve to the current session repository root.' });
const Target = Type.String({ minLength: 1, description: 'Spec id such as "001" or a path inside .start/specs or docs/specs.' });
const MissionId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', description: 'Existing mission epic id, chosen explicitly.' });
const strict = { additionalProperties: false } as const;

export const OperationSchema = Type.Union([
  Type.Object({ op: Type.Literal('workspace_prepare'), projectRoot: ProjectRoot, target: Target, taskKey: Type.String({minLength:1}) }, strict),
  Type.Object({ op: Type.Literal('workspace_collect'), projectRoot: ProjectRoot, workspaceId: Type.String() }, strict),
  Type.Object({ op: Type.Literal('workspace_integrate'), projectRoot: ProjectRoot, workspaceId: Type.String(), approvedFiles: Type.Array(Type.String()) }, strict),
  Type.Object({ op: Type.Literal('read'), projectRoot: ProjectRoot, target: Target }, strict),
  Type.Object({ op: Type.Literal('status'), projectRoot: ProjectRoot, target: Type.Optional(Target) }, strict),
  Type.Object({ op: Type.Literal('create'), projectRoot: ProjectRoot, name: Type.String({ minLength: 1 }) }, strict),
  Type.Object({ op: Type.Literal('bind'), projectRoot: ProjectRoot, target: Target, missionId: MissionId }, strict),
  Type.Object({ op: Type.Literal('materialize'), projectRoot: ProjectRoot, target: Target, missionId: MissionId }, strict),
]);
export type Operation = Static<typeof OperationSchema>;

export const ControlParamsSchema = Type.Object({ operation: OperationSchema }, strict);

export const ControlOutputSchema = Type.Object({
  op: Type.String(),
  status: Type.Union([
    Type.Literal('ok'),
    Type.Literal('error'),
    Type.Literal('approval_required'),
    Type.Literal('cancelled'),
  ]),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
}, strict);
export type ControlOutput = Static<typeof ControlOutputSchema>;

const AnswerSchema = Type.Object({
  cancelled: Type.Boolean(),
  answers: Type.Array(Type.Object({ kind: Type.String(), answer: Type.Union([Type.String(), Type.Null()]) })),
  error: Type.Optional(Type.String()),
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === 'object') return Object.values(value).every(isJson);
  return false;
}

function toJson(value: ControlOutput): Json {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  if (!isJson(plain)) throw new Error('SDD_OUTPUT_NOT_JSON');
  return plain;
}

export interface ControlDeps {
  beadsDir: string;
  // Parent adapter must check persisted current user approval, beads claim and
  // worker cleanup/review evidence. Missing adapter fails closed, never passes.
  workspaceAuthority?: (op: Operation, ctx: ExtensionToolContext) => Promise<{runRoot:string}>;
  workspaces?: Map<string, {sessionId:string;root:string;workspace:Workspace;patch?:Patch}>;
  createClient?: ((executeTool: ExecuteTool) => BeadsClient) | undefined;
  appendState(state: SessionState): void;
  owned: Set<AbortController>;
}

class Stop extends Error {
  readonly status: 'approval_required' | 'cancelled';
  readonly data: unknown;

  constructor(status: 'approval_required' | 'cancelled', message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('ABORTED: sdd_control operation was cancelled');
}

async function canonicalRoot(projectRoot: string, cwd: string): Promise<string> {
  const [root, sessionRoot] = await Promise.all([repositoryRoot(projectRoot), repositoryRoot(cwd)]);
  if (root !== sessionRoot) throw new Error(`PROJECT_ROOT_MISMATCH: ${root} is not the session project ${sessionRoot}`);
  return root;
}

async function descriptor(root: string, target: string) {
  const resolved = await resolveSpec({ projectRoot: root, target });
  if (resolved.kind !== 'descriptor') throw new Error(`LEGACY_SPEC_REQUIRES_IMPORT: ${resolved.path}`);
  return resolved;
}

interface FocusChoice {
  action: 'bind' | 'materialize';
  missionId: string;
  focusId: string;
}

async function confirmFocusConflict(ctx: ExtensionToolContext, signal: AbortSignal, choice: FocusChoice): Promise<void> {
  const { action, missionId, focusId } = choice;
  const data = { action, requestedMissionId: missionId, focusMissionId: focusId };
  const message = `FOCUS_CONFLICT: land-focus is ${focusId} but SDD ${action} requested ${missionId}. Ask the user which mission owns this work.`;
  if (!ctx.hasUI || !ctx.tools.some(tool => tool.name === 'ask_user_question')) throw new Stop('approval_required', message, data);
  const label = action === 'bind' ? `Bind ${missionId}` : `Materialize into ${missionId}`;
  const effect = action === 'bind'
    ? `Record ${missionId} as this branch's SDD mission.`
    : `Create or update ${missionId} tasks from this spec.`;
  const outcome = await ctx.executeTool('ask_user_question', {
    questions: [{
      question: `This session is focused on ${focusId}. ${action === 'bind' ? 'Bind SDD work to' : 'Materialize tasks into'} ${missionId} anyway?`,
      header: `SDD ${action}`,
      options: [
        { label, description: `${effect} land-focus stays ${focusId}.` },
        { label: 'Cancel', description: 'Change nothing and stop.' },
      ],
    }],
  }, { signal });
  if (outcome.isError) throw new Error(`ASK_USER_FAILED: ${JSON.stringify(outcome.result.content)}`);
  const answer: unknown = outcome.result.details;
  if (!Value.Check(AnswerSchema, answer)) {
    throw new Stop('approval_required', `ASK_USER_UNSUPPORTED_RESPONSE: no structured answer was returned. ${message}`, data);
  }
  if (answer.error !== undefined) {
    throw new Stop('approval_required', `ASK_USER_UNSUPPORTED_RESPONSE: question unavailable (${answer.error}). ${message}`, data);
  }
  const approved = !answer.cancelled && answer.answers[0]?.kind === 'option' && answer.answers[0].answer === label;
  if (!approved) throw new Stop('cancelled', `SDD ${action} for ${missionId} cancelled by the user.`, data);
}

async function run(operation: Operation, ctx: ExtensionToolContext, signal: AbortSignal, deps: ControlDeps): Promise<unknown> {
  checkSignal(signal);
  const root = await canonicalRoot(operation.projectRoot, ctx.cwd);
  const executeTool: ExecuteTool = (name, args) => ctx.executeTool(name, args, { signal });
  const client = () => deps.createClient?.(executeTool)
    ?? createBeadsClient({ transport: createToolTransport(executeTool), beadsDir: deps.beadsDir });
  const sessionId = ctx.sessionManager.getSessionId();

  switch (operation.op) {
    case 'workspace_prepare':
    case 'workspace_collect':
    case 'workspace_integrate': {
      if (!deps.workspaceAuthority || !deps.workspaces) throw new Error('WORKSPACE_AUTHORITY_REQUIRED');
      const lock = await acquireProjectLock({projectRoot:root,sessionId});
      try {
        const authority = await deps.workspaceAuthority(operation,ctx);
        checkSignal(signal);
        await lock.verify();
        if (operation.op === 'workspace_prepare') {
          const resolved = await descriptor(root,operation.target);
          const task = resolved.spec.tasks.find(t=>t.key===operation.taskKey);
          if (!task || !resolved.spec.binding?.taskIds[task.key]) throw new Error('BOUND_TASK_REQUIRED');
          const workspace = await createWorkspace({projectRoot:root,runRoot:authority.runRoot,taskKey:resolved.path+':'+task.key,allowedFiles:task.files,role:'coder',transport:createToolTransport(executeTool)});
          deps.workspaces.set(workspace.workspaceId,{sessionId,root,workspace});
          return workspace;
        }
        const entry = deps.workspaces.get(operation.workspaceId);
        if (!entry || entry.sessionId !== sessionId || entry.root !== root) throw new Error('WORKSPACE_NOT_OWNED');
        if (operation.op === 'workspace_collect') {
          entry.patch = await collectPatch(entry.workspace);
          return entry.patch;
        }
        if (!entry.patch) throw new Error('PATCH_REVIEW_REQUIRED');
        await integratePatch({projectRoot:root,patch:entry.patch,approvedFiles:operation.approvedFiles});
        delete entry.patch;
        return {integrated:true,checkpointRequired:true};
      } finally {await lock.release();}
    }
    case 'read':
      return resolveSpec({ projectRoot: root, target: operation.target });
    case 'status': {
      const branch = ctx.sessionManager.getBranch();
      const session = reduceSession(branch);
      const focus = readLandFocus(branch);
      const spec = operation.target === undefined ? null : await resolveSpec({ projectRoot: root, target: operation.target });
      const tasks = spec?.kind === 'descriptor' && spec.spec.binding
        ? await readTaskStates({ client: client(), projectRoot: root, spec: spec.spec })
        : null;
      return { session, focus, conflict: focusConflict(session, focus), spec, tasks };
    }
    case 'create': {
      const lock = await acquireProjectLock({ projectRoot: root, sessionId });
      try {
        checkSignal(signal);
        return await createSpec({ projectRoot: root, name: operation.name });
      } finally {
        await lock.release();
      }
    }
    case 'bind': {
      const lock = await acquireProjectLock({ projectRoot: root, sessionId });
      try {
        const resolved = await descriptor(root, operation.target);
        const existing = resolved.spec.binding;
        if (existing && existing.missionId !== operation.missionId) {
          throw new Error(`BINDING_CONFLICT: spec is bound to ${existing.missionId}`);
        }
        const epic = await client().show(operation.missionId);
        if (epic.issue_type !== 'epic') throw new Error(`MISSION_NOT_EPIC: ${epic.id} is ${epic.issue_type}`);
        if (epic.status === 'closed') throw new Error(`MISSION_CLOSED: ${epic.id}`);
        const focus = readLandFocus(ctx.sessionManager.getBranch());
        if (focus && focus.id !== operation.missionId) {
          await confirmFocusConflict(ctx, signal, { action: 'bind', missionId: operation.missionId, focusId: focus.id });
        }
        checkSignal(signal);
        await lock.verify();
        const state: SessionState = { active: true, projectRoot: root, specPath: resolved.path, missionId: operation.missionId };
        deps.appendState(state);
        return state;
      } finally {
        await lock.release();
      }
    }
    case 'materialize': {
      const resolved = await descriptor(root, operation.target);
      const branch = ctx.sessionManager.getBranch();
      const state = reduceSession(branch);
      const bound = state.active && state.projectRoot === root
        && state.specPath === resolved.path && state.missionId === operation.missionId;
      if (!bound) throw new Error(`BINDING_REQUIRED: bind ${resolved.path} to ${operation.missionId} first`);
      const focus = readLandFocus(branch);
      if (focus && focus.id !== operation.missionId) {
        await confirmFocusConflict(ctx, signal, { action: 'materialize', missionId: operation.missionId, focusId: focus.id });
      }
      checkSignal(signal);
      const result = await materialize({
        client: client(),
        projectRoot: root,
        spec: resolved.spec,
        missionId: operation.missionId,
        sessionId,
      });
      return { specPath: resolved.path, binding: result.spec.binding, createdIds: result.createdIds, reusedIds: result.reusedIds };
    }
  }
}

function result(output: ControlOutput, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: output,
    structuredContent: toJson(output),
    isError: output.status !== 'ok',
  };
}

export function createControlTool(deps: ControlDeps): ToolDefinition<typeof ControlParamsSchema, ControlOutput> {
  return {
    name: 'sdd_control',
    label: 'SDD control',
    description: [
      'Read or change spec-driven development state for the current project.',
      'operation.op: read | status (read-only), create | bind | materialize (mutating).',
      'Mutations need an explicit projectRoot, target and existing mission epic id; nothing is inferred.',
      'Results with status approval_required or cancelled mean stop and ask the user.',
    ].join(' '),
    parameters: ControlParamsSchema,
    outputSchema: ControlOutputSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { operation } = params;
      const owned = new AbortController();
      deps.owned.add(owned);
      const combined = signal ? AbortSignal.any([signal, owned.signal]) : owned.signal;
      try {
        const data = await run(operation, ctx, combined, deps);
        return result({ op: operation.op, status: 'ok', data }, JSON.stringify(data, null, 2));
      } catch (error) {
        if (error instanceof Stop) {
          return result({ op: operation.op, status: error.status, data: error.data, error: error.message }, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return result({ op: operation.op, status: 'error', error: message }, message);
      } finally {
        deps.owned.delete(owned);
      }
    },
  };
}
