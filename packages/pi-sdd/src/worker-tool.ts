import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { AgentToolResult, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveModel, type ModelOverrides, type WorkerRole } from './models.ts';
import { buildWorkerPrompt, loadWorkerPolicy, parseWorkerTask } from './worker-prompt.ts';

export const DEFAULT_WALL_MS = 20 * 60 * 1000;
export const DEFAULT_STARTUP_MS = 10_000;
const WAIT_MARGIN_MS = 30_000;
const CANCEL_TIMEOUT_MS = 30_000;

const strict = { additionalProperties: false } as const;
const Limit = Type.Integer({ minimum: 100, maximum: 3_600_000 });
const RunId = Type.String({ pattern: '^[a-f0-9-]{36}$' });
const Key = Type.String({ minLength: 1, maxLength: 200 });

export const WorkerOperationSchema = Type.Union([
  Type.Object({
    op: Type.Literal('start'),
    taskKey: Key,
    revision: Key,
    workspace: Type.String({ minLength: 1, description: 'Absolute path to the separate workspace owned by this approved action.' }),
    input: Type.Unknown({ description: 'Role-specific worker task: unit roles take brief, projectInstructions, publicContext, feedback; eval takes publicContext and scenarios only.' }),
    escalation: Type.Optional(Type.String({ minLength: 1, description: 'Required reason when role is hardest.' })),
    wallMs: Type.Optional(Limit),
    startupMs: Type.Optional(Limit),
  }, strict),
  Type.Object({ op: Type.Literal('status'), runId: RunId }, strict),
  Type.Object({ op: Type.Literal('wait'), runId: RunId }, strict),
  Type.Object({ op: Type.Literal('cancel'), runId: RunId }, strict),
  Type.Object({ op: Type.Literal('list') }, strict),
]);
export const WorkerParamsSchema = Type.Object({ operation: WorkerOperationSchema }, strict);
type WorkerOperation = Static<typeof WorkerOperationSchema>;
type StartOperation = Extract<WorkerOperation, { op: 'start' }>;

const Status = Type.Union([Type.Literal('ok'), Type.Literal('error'), Type.Literal('blocked'), Type.Literal('failed'), Type.Literal('cancelled')]);
export const WorkerOutputSchema = Type.Object({
  op: Type.String(),
  status: Status,
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
}, strict);
export type WorkerOutput = Static<typeof WorkerOutputSchema>;
type OutputStatus = WorkerOutput['status'];

export interface StartRequest {
  sessionId: string;
  taskKey: string;
  revision: string;
  workspace: string;
  role: WorkerRole;
}
const DecisionSchema = Type.Object({ approved: Type.Literal(true), claimId: Type.String({ minLength: 1 }) });
export type StartDecision = { approved: true; claimId: string } | { approved: false; reason: string };
export type AuthorizeStart = (request: StartRequest) => Promise<StartDecision>;

export const denyStarts: AuthorizeStart = async () => ({
  approved: false,
  reason: 'no approved claimed-action gate is configured; worker starts stay denied until one is injected',
});

export interface WorkerEntry {
  runId: string;
  sessionId: string;
  taskKey: string;
  revision: string;
  workspace: string;
  role: WorkerRole;
  model: string;
  claimId: string;
  dir: string;
  wallMs: number;
  startupMs: number;
  state: 'active' | 'terminal' | 'cleanup_unknown';
  usage: 'pending' | 'host_nested' | 'terminal_details' | 'unreported' | 'malformed';
}

export class WorkerRegistry {
  #sessionId: string | undefined;
  readonly #runs = new Map<string, WorkerEntry>();

  #scope(sessionId: string): void {
    if (this.#sessionId === sessionId) return;
    this.#runs.clear();
    this.#sessionId = sessionId;
  }

  add(entry: WorkerEntry): void {
    this.#scope(entry.sessionId);
    this.#runs.set(entry.runId, entry);
  }

  get(sessionId: string, runId: string): WorkerEntry | undefined {
    this.#scope(sessionId);
    return this.#runs.get(runId);
  }

  list(sessionId: string): WorkerEntry[] {
    this.#scope(sessionId);
    return [...this.#runs.values()];
  }

  clear(): void {
    this.#runs.clear();
    this.#sessionId = undefined;
  }
}

export interface WorkerToolDeps {
  registry: WorkerRegistry;
  owned: Set<AbortController>;
  authorizeStart: AuthorizeStart;
  loadModels(): Promise<{ roles: Readonly<Record<string, unknown>>; overrides: ModelOverrides }>;
  policiesDir: string;
}

const Typed = (type: string) => Type.Object({ type: Type.Literal(type) });
const SubagentShape = Type.Object({
  properties: Type.Object({
    action: Type.Object({ anyOf: Type.Array(Type.Object({ const: Type.String() })) }),
    id: Typed('string'),
    task: Typed('string'),
    workspace: Typed('string'),
    model: Typed('string'),
    background: Typed('boolean'),
    startupMs: Typed('integer'),
    wallMs: Typed('integer'),
  }),
});
const subagentActions = ['start', 'status', 'list', 'wait', 'cancel'];

export function subagentIncompatibility(parameters: unknown): string | null {
  if (!Value.Check(SubagentShape, parameters)) {
    return 'SUBAGENT_INCOMPATIBLE: the registered subagent tool does not take action/id/task/workspace/model/background/startupMs/wallMs';
  }
  const actions = parameters.properties.action.anyOf.map(option => option.const);
  const missing = subagentActions.filter(action => !actions.includes(action));
  return missing.length ? `SUBAGENT_INCOMPATIBLE: subagent lacks actions ${missing.join(', ')}` : null;
}

const Envelope = Type.Object({ action: Type.String(), payload: Type.Unknown() });
const ErrorPayload = Type.Object({ error: Type.String() });
const StartPayload = Type.Object({ id: RunId, dir: Type.String({ minLength: 1 }), workspace: Type.String(), model: Type.String(), phase: Type.Literal('starting') });
const RunPayload = Type.Object({ id: RunId, dir: Type.String({ minLength: 1 }), phase: Type.String(), waitingAborted: Type.Optional(Type.Boolean()) });
const Outcome = Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('timed_out')]);
const TerminalPayload = Type.Object({
  id: RunId,
  dir: Type.String({ minLength: 1 }),
  phase: Type.Literal('terminal'),
  outcome: Outcome,
  reason: Type.String(),
  cleanup: Type.Object({ workerExited: Type.Boolean(), groupsAlive: Type.Array(Type.Number()) }),
  terminalCount: Type.Literal(1),
  details: Type.Unknown(),
});
type Terminal = Static<typeof TerminalPayload>;
const Count = Type.Number({ minimum: 0 });
const UsageSchema = Type.Object({
  input: Count, output: Count, cacheRead: Count, cacheWrite: Count, totalTokens: Count,
  cacheWrite1h: Type.Optional(Count), reasoning: Type.Optional(Count),
  cost: Type.Object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, total: Count }),
});
type Usage = Static<typeof UsageSchema>;
const Details = Type.Object({ usage: Type.Optional(Type.Unknown()), summary: Type.Optional(Type.String()) });

function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}

class WorkerError extends Error {
  readonly status: OutputStatus;
  readonly data: unknown;

  constructor(status: OutputStatus, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

interface Reply {
  status: OutputStatus;
  data: unknown;
  error?: string;
  usage?: Usage;
}

type Nested = Awaited<ReturnType<ExtensionToolContext['executeTool']>>;

function nestedText(outcome: Nested): string {
  const content: unknown = outcome.result.content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('\n').trim();
}

function payloadOf(outcome: Nested, action: string): unknown {
  const envelope: unknown = outcome.result.structuredContent;
  if (!check(Envelope, envelope)) {
    if (outcome.isError) throw new WorkerError('error', `SUBAGENT_ERROR: ${nestedText(outcome) || `subagent ${action} failed without a result`}`);
    throw new WorkerError('error', `SUBAGENT_MALFORMED: subagent ${action} returned no {action,payload} result`);
  }
  if (envelope.action !== action) throw new WorkerError('error', `SUBAGENT_MALFORMED: expected a ${action} result, got ${envelope.action}`);
  if (check(ErrorPayload, envelope.payload)) throw new WorkerError('error', `SUBAGENT_ERROR: ${envelope.payload.error}`);
  return envelope.payload;
}

function sumUsage(list: readonly Usage[]): Usage {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const usage of list) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}

function identity(entry: WorkerEntry) {
  const { runId, taskKey, revision, role, model, workspace, dir, claimId, wallMs, startupMs, state } = entry;
  return { runId, taskKey, revision, role, model, workspace, dir, claimId, wallMs, startupMs, state };
}

function account(entry: WorkerEntry, outcome: Nested, details: unknown): { report: { source: string; accounted: string }; usage?: Usage } {
  if (entry.usage === 'pending') {
    const reported = check(Details, details) ? details.usage : undefined;
    if (outcome.result.usage !== undefined) entry.usage = 'host_nested';
    else if (reported === undefined) entry.usage = 'unreported';
    else if (Array.isArray(reported) && reported.every(item => check(UsageSchema, item))) {
      entry.usage = 'terminal_details';
      return { report: { source: 'terminal_details', accounted: 'this_result' }, usage: sumUsage(reported) };
    } else entry.usage = 'malformed';
    return account(entry, outcome, details);
  }
  switch (entry.usage) {
    case 'host_nested': return { report: { source: 'host_nested', accounted: 'host' } };
    case 'terminal_details': return { report: { source: 'terminal_details', accounted: 'earlier_result' } };
    case 'unreported': return { report: { source: 'unreported', accounted: 'none' } };
    case 'malformed': return { report: { source: 'malformed', accounted: 'none' } };
  }
}

function settle(entry: WorkerEntry, outcome: Nested, payload: unknown): Reply {
  if (!check(RunPayload, payload)) throw new WorkerError('error', 'SUBAGENT_MALFORMED: run status lacks id, dir or phase');
  if (payload.id !== entry.runId) throw new WorkerError('error', `SUBAGENT_MISMATCH: asked for ${entry.runId}, got ${payload.id}`);
  if (payload.phase !== 'terminal' && !('outcome' in payload)) {
    return { status: 'ok', data: { ...identity(entry), phase: payload.phase } };
  }
  if (!check(TerminalPayload, payload)) throw new WorkerError('error', `SUBAGENT_MALFORMED: terminal result for ${entry.runId} has an invalid outcome, reason or cleanup record`);
  return terminalReply(entry, outcome, payload);
}

function terminalReply(entry: WorkerEntry, outcome: Nested, payload: Terminal): Reply {
  const confirmed = payload.cleanup.workerExited && payload.cleanup.groupsAlive.length === 0 && !payload.reason.startsWith('cleanup_incomplete');
  entry.state = confirmed ? 'terminal' : 'cleanup_unknown';
  const { report, usage } = account(entry, outcome, payload.details);
  const summary = check(Details, payload.details) ? payload.details.summary : undefined;
  const data = {
    ...identity(entry),
    phase: 'terminal',
    outcome: payload.outcome,
    reason: payload.reason,
    cleanup: confirmed ? 'confirmed' : 'incomplete',
    modelCompletion: payload.outcome === 'succeeded' ? 'completed' : 'not_completed',
    verification: 'not_verified',
    ...(summary === undefined ? {} : { summary }),
    usage: report,
  };
  const withUsage = (reply: Reply): Reply => (usage ? { ...reply, usage } : reply);
  if (!confirmed) {
    return withUsage({ status: 'blocked', data, error: `CLEANUP_UNKNOWN: run ${entry.runId} stopped without confirmed cleanup (${payload.reason}); the task stays open. Inspect ${entry.dir}` });
  }
  if (entry.usage === 'malformed') {
    return { status: 'error', data, error: `USAGE_MALFORMED: run ${entry.runId} reported usage that does not match the usage schema; its spend is unaccounted` };
  }
  if (payload.outcome === 'succeeded') return withUsage({ status: 'ok', data });
  return withUsage({ status: payload.outcome === 'cancelled' ? 'cancelled' : 'failed', data, error: `WORKER_${payload.outcome.toUpperCase()}: ${payload.reason}` });
}

function cleanupUnknown(entry: WorkerEntry, cause: string): WorkerError {
  entry.state = 'cleanup_unknown';
  return new WorkerError('blocked', `CLEANUP_UNKNOWN: ${cause}; run ${entry.runId} may still hold its workspace and the task stays open. Inspect ${entry.dir}`, identity(entry));
}

async function cancelOwned(entry: WorkerEntry, ctx: ExtensionToolContext, interrupted?: string): Promise<Reply> {
  let outcome: Nested;
  let payload: unknown;
  try {
    outcome = await ctx.executeTool('subagent', { action: 'cancel', id: entry.runId }, { signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) });
    payload = payloadOf(outcome, 'cancel');
  } catch (error) {
    throw cleanupUnknown(entry, `cancel failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!check(TerminalPayload, payload) || payload.id !== entry.runId) throw cleanupUnknown(entry, 'cancel returned no valid terminal result');
  const reply = terminalReply(entry, outcome, payload);
  return interrupted ? { ...reply, data: { ...(reply.data as object), interrupted } } : reply;
}

async function ownedWorkspace(workspace: string, cwd: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new WorkerError('error', `WORKSPACE_INVALID: ${workspace} is not absolute`);
  let resolved: string;
  try {
    resolved = await realpath(workspace);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new WorkerError('error', `WORKSPACE_INVALID: ${workspace} (${error instanceof Error ? error.message : String(error)})`);
  }
  const session = await realpath(cwd);
  if (session === resolved || session.startsWith(resolved + sep)) {
    throw new WorkerError('blocked', `WORKSPACE_NOT_OWNED: ${resolved} contains the parent session directory`);
  }
  return resolved;
}

function requireSubagent(ctx: ExtensionToolContext): void {
  const tool = ctx.tools.find(candidate => candidate.name === 'subagent');
  if (!tool) throw new WorkerError('error', 'SUBAGENT_UNAVAILABLE: the subagent tool is not callable in this session; install and load pi-subagent');
  const problem = subagentIncompatibility(tool.parameters);
  if (problem) throw new WorkerError('error', problem);
}

function blockedOn(error: unknown, prefix: string): never {
  throw new WorkerError('blocked', `${prefix}${error instanceof Error ? error.message : String(error)}`);
}

async function start(operation: StartOperation, ctx: ExtensionToolContext, signal: AbortSignal, deps: WorkerToolDeps): Promise<Reply> {
  requireSubagent(ctx);
  let task;
  try {
    task = parseWorkerTask(operation.input);
  } catch (error) {
    throw new WorkerError('error', error instanceof Error ? error.message : String(error));
  }
  const sessionId = ctx.sessionManager.getSessionId();
  const workspace = await ownedWorkspace(operation.workspace, ctx.cwd);
  const active = deps.registry.list(sessionId).find(entry => entry.taskKey === operation.taskKey && entry.state !== 'terminal');
  if (active) throw new WorkerError('blocked', `WORKER_ALREADY_ACTIVE: ${operation.taskKey} has run ${active.runId} (${active.state})`);

  const request: StartRequest = { sessionId, taskKey: operation.taskKey, revision: operation.revision, workspace, role: task.role };
  let decision: unknown;
  try {
    decision = await deps.authorizeStart(request);
  } catch (error) {
    blockedOn(error, 'START_NOT_AUTHORIZED: ');
  }
  if (!check(DecisionSchema, decision)) {
    const reason = typeof decision === 'object' && decision !== null && 'reason' in decision ? String(decision.reason) : 'the start gate did not approve this claimed action';
    throw new WorkerError('blocked', `START_NOT_AUTHORIZED: ${reason}`);
  }

  let model: string;
  try {
    const { roles, overrides } = await deps.loadModels();
    const available = ctx.modelRegistry.getAvailable().map(entry => `${entry.provider}/${entry.id}`);
    model = resolveModel({ role: task.role, roles, overrides, available, escalation: operation.escalation });
  } catch (error) {
    blockedOn(error, '');
  }
  const prompt = buildWorkerPrompt({ ...task, policy: await loadWorkerPolicy(task.role, deps.policiesDir) });
  const wallMs = operation.wallMs ?? DEFAULT_WALL_MS;
  const startupMs = operation.startupMs ?? DEFAULT_STARTUP_MS;
  const outcome = await ctx.executeTool('subagent', {
    action: 'start', model, task: prompt, workspace, background: true, startupMs, wallMs,
  }, { signal });
  const payload = payloadOf(outcome, 'start');
  if (!check(RunPayload, payload)) throw new WorkerError('error', 'SUBAGENT_MALFORMED: start returned no run id or directory');
  const id = payload.id;
  const entry: WorkerEntry = {
    runId: id, sessionId, taskKey: operation.taskKey, revision: operation.revision, workspace, role: task.role, model,
    claimId: decision.claimId, dir: payload.dir, wallMs, startupMs, state: 'active', usage: 'pending',
  };
  deps.registry.add(entry);
  if (check(TerminalPayload, payload)) return terminalReply(entry, outcome, payload);
  if (!check(StartPayload, payload) || payload.workspace !== workspace || payload.model !== model) {
    const cancelled = await cancelOwned(entry, ctx);
    throw new WorkerError('error', `SUBAGENT_MISMATCH: start did not echo the requested workspace and model; run ${id} was cancelled`, cancelled.data);
  }
  return { status: 'ok', data: { ...identity(entry), phase: 'starting' } };
}

function owned(deps: WorkerToolDeps, ctx: ExtensionToolContext, runId: string): WorkerEntry {
  const entry = deps.registry.get(ctx.sessionManager.getSessionId(), runId);
  if (!entry) throw new WorkerError('error', `WORKER_NOT_OWNED: run ${runId} was not started by sdd_worker in this session`);
  return entry;
}

async function wait(entry: WorkerEntry, ctx: ExtensionToolContext, signal: AbortSignal, deps: WorkerToolDeps): Promise<Reply> {
  const stopping = new AbortController();
  deps.owned.add(stopping);
  const deadline = AbortSignal.timeout(entry.wallMs + entry.startupMs + WAIT_MARGIN_MS);
  const waitSignal = AbortSignal.any([signal, stopping.signal, deadline]);
  let outcome: Nested;
  try {
    outcome = await ctx.executeTool('subagent', { action: 'wait', id: entry.runId }, { signal: waitSignal });
  } finally {
    deps.owned.delete(stopping);
  }
  let payload: unknown;
  try {
    payload = payloadOf(outcome, 'wait');
  } catch (error) {
    if (!waitSignal.aborted) throw cleanupUnknown(entry, `wait failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (check(TerminalPayload, payload)) return settle(entry, outcome, payload);
  if (waitSignal.aborted) {
    const why = deadline.aborted && !signal.aborted && !stopping.signal.aborted ? 'wait deadline passed' : 'wait was interrupted';
    return cancelOwned(entry, ctx, why);
  }
  throw new WorkerError('error', 'SUBAGENT_MALFORMED: wait returned without a terminal result');
}

async function run(operation: WorkerOperation, ctx: ExtensionToolContext, signal: AbortSignal, deps: WorkerToolDeps): Promise<Reply> {
  switch (operation.op) {
    case 'start':
      return start(operation, ctx, signal, deps);
    case 'list':
      return { status: 'ok', data: { runs: deps.registry.list(ctx.sessionManager.getSessionId()).map(identity) } };
    case 'status': {
      const entry = owned(deps, ctx, operation.runId);
      const outcome = await ctx.executeTool('subagent', { action: 'status', id: entry.runId }, { signal });
      return settle(entry, outcome, payloadOf(outcome, 'status'));
    }
    case 'wait':
      return wait(owned(deps, ctx, operation.runId), ctx, signal, deps);
    case 'cancel':
      return cancelOwned(owned(deps, ctx, operation.runId), ctx);
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === 'object') return Object.values(value).every(isJson);
  return false;
}

function toResult(output: WorkerOutput, text: string, usage?: Usage): AgentToolResult<WorkerOutput> {
  const structured: unknown = JSON.parse(JSON.stringify(output));
  if (!isJson(structured)) throw new Error('SDD_OUTPUT_NOT_JSON');
  return {
    content: [{ type: 'text', text }],
    details: output,
    structuredContent: structured,
    isError: output.status !== 'ok',
    ...(usage ? { usage } : {}),
  };
}

export function createWorkerTool(deps: WorkerToolDeps): ToolDefinition<typeof WorkerParamsSchema, WorkerOutput> {
  return {
    name: 'sdd_worker',
    label: 'SDD worker',
    description: [
      'Run an SDD role worker through the existing subagent tool for one approved, claimed task in its own workspace.',
      'operation.op: start | status | wait | cancel | list. Only runs started by sdd_worker in this session are reachable.',
      'start needs taskKey, revision, an absolute owned workspace and a role-specific input; models come from exact role configuration.',
      'A succeeded run means the model finished, not that the task is verified. blocked or cleanup errors mean stop and report to the user.',
    ].join(' '),
    parameters: WorkerParamsSchema,
    outputSchema: WorkerOutputSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const op = typeof params === 'object' && params !== null && typeof params.operation?.op === 'string' ? params.operation.op : 'unknown';
      if (!check(WorkerParamsSchema, params)) {
        const first = Value.Errors(WorkerParamsSchema, params)[0];
        const message = `WORKER_INPUT_INVALID: ${first?.instancePath || '/'} ${first?.message ?? 'invalid parameters'}`;
        return toResult({ op, status: 'error', error: message }, message);
      }
      try {
        const reply = await run(params.operation, ctx, signal ?? new AbortController().signal, deps);
        const output: WorkerOutput = { op, status: reply.status, data: reply.data, ...(reply.error ? { error: reply.error } : {}) };
        return toResult(output, reply.error ?? JSON.stringify(reply.data, null, 2), reply.usage);
      } catch (error) {
        const status = error instanceof WorkerError ? error.status : 'error';
        const message = error instanceof Error ? error.message : String(error);
        const data = error instanceof WorkerError && error.data !== undefined ? { data: error.data } : {};
        return toResult({ op, status, ...data, error: message }, message);
      }
    },
  };
}
