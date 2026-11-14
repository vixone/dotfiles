import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { createWorkerTool, denyStarts, WorkerRegistry, type AuthorizeStart, type WorkerToolDeps } from '../src/worker-tool.ts';
import { createSddExtension } from '../extensions/sdd.ts';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policiesDir = join(packageRoot, 'policies');

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const subagentParameters = Type.Object({
  action: Type.Union([Type.Literal('start'), Type.Literal('status'), Type.Literal('list'), Type.Literal('wait'), Type.Literal('cancel')]),
  id: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  workspace: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean()),
  startupMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3600000 })),
  wallMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3600000 })),
});

const roles = { 'feature, refactoring': 'p/feature', 'judgment and prose': 'p/judgment', 'hardest tasks': 'p/hardest' };
const usage = (input: number) => ({
  input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
});

type Payload = Record<string, unknown>;
interface Call { name: string; args: Record<string, unknown>; aborted: boolean }
type Reply = { isError?: boolean; payload?: unknown; structuredContent?: unknown; usage?: unknown; abortable?: boolean };

// Mirrors pi-subagent's report(): text content plus details and structuredContent {action,payload}.
function report(action: string, payload: unknown, isError = false, extra: Record<string, unknown> = {}) {
  return { isError, result: { content: [{ type: 'text', text: `${action}` }], details: { action, payload }, structuredContent: { action, payload }, ...extra } };
}

function terminal(id: string, workspace: string, outcome: string, more: Payload = {}): Payload {
  return {
    id, dir: `/runs/${id}`, workspace, model: 'p/feature', sessionId: 's', phase: 'terminal', groups: [], commandGroups: [],
    outcome, reason: outcome === 'succeeded' ? 'agent_settled' : outcome, cleanup: { workerExited: true, groupsAlive: [], cleanupMs: 3 },
    details: {}, terminalCount: 1, finishedAt: 1, ...more,
  };
}

function fakeSubagent(script: Partial<Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Reply | Promise<Reply>>> = {}) {
  const calls: Call[] = [];
  let lastId = '';
  const executeTool = async (name: string, rawArgs: unknown, options?: { signal?: AbortSignal }) => {
    const args = rawArgs as Record<string, unknown>;
    calls.push({ name, args, aborted: options?.signal?.aborted ?? false });
    if (name !== 'subagent') return { isError: true, result: { content: [{ type: 'text', text: `Tool ${name} not found` }], details: {} } };
    const action = String(args.action);
    const handler = script[action];
    if (action === 'start' && !handler) {
      lastId = randomUUID();
      return report('start', { id: lastId, dir: `/runs/${lastId}`, workspace: args.workspace, model: args.model, phase: 'starting' });
    }
    if (!handler) return report(action, { error: `Error: unscripted ${action}` }, true);
    const reply = await handler(args, options?.signal);
    if (reply.structuredContent !== undefined) return { isError: reply.isError ?? false, result: { content: [], details: {}, structuredContent: reply.structuredContent } };
    return report(action, reply.payload, reply.isError ?? false, reply.usage === undefined ? {} : { usage: reply.usage });
  };
  return { calls, executeTool, lastId: () => lastId };
}

const approve: AuthorizeStart = async request => ({ approved: true, claimId: `claim-${request.taskKey}` });

function harness(t: TestContext, workspace: string, fake: ReturnType<typeof fakeSubagent>, overrides: Partial<WorkerToolDeps> = {}, ctxExtra: Partial<{ tools: unknown[]; available: string[]; session: () => string }> = {}) {
  const deps: WorkerToolDeps = {
    registry: new WorkerRegistry(),
    owned: new Set(),
    authorizeStart: approve,
    loadModels: async () => ({ roles, overrides: {} }),
    policiesDir,
    ...overrides,
  };
  const tool = createWorkerTool(deps);
  const available = ctxExtra.available ?? ['p/feature', 'p/judgment', 'p/hardest'];
  const ctx = {
    cwd: packageRoot,
    sessionManager: { getSessionId: ctxExtra.session ?? (() => 'session-1') },
    tools: ctxExtra.tools ?? [{ name: 'subagent', parameters: subagentParameters }],
    modelRegistry: { getAvailable: () => available.map(id => ({ provider: id.split('/')[0], id: id.split('/')[1] })) },
    executeTool: fake.executeTool,
  } as unknown as ExtensionToolContext;
  const run = async (operation: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) => {
    const result = await tool.execute(`call-${randomUUID()}`, { operation } as never, signal, undefined, ctx);
    return { result, out: result.structuredContent as { op: string; status: string; data?: Record<string, unknown>; error?: string } };
  };
  t.after(() => deps.owned.clear());
  return { run, deps, workspace };
}

const startOp = (workspace: string, extra: Record<string, unknown> = {}) => ({
  op: 'start', taskKey: 'mission-x.3', revision: 'rev-1', workspace,
  input: { role: 'code', brief: 'Implement it. SOURCE_SECRET', projectInstructions: [], publicContext: [], feedback: [] },
  ...extra,
});

test('start is denied by default and never reaches the subagent', async t => {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent();
  const h = harness(t, workspace, fake, { authorizeStart: denyStarts });
  const { result, out } = await h.run(startOp(workspace));
  assert.equal(result.isError, true);
  assert.equal(out.status, 'blocked');
  assert.match(out.error ?? '', /START_NOT_AUTHORIZED/);
  assert.deepEqual(fake.calls, []);
  for (const decision of [{ approved: 'yes', claimId: 'c' }, { approved: true }, null, { approved: false, reason: 'not claimed' }]) {
    const loose = harness(t, workspace, fake, { authorizeStart: async () => decision as never });
    assert.equal((await loose.run(startOp(workspace))).out.status, 'blocked');
  }
  const throwing = harness(t, workspace, fake, { authorizeStart: async () => { throw new Error('gate down'); } });
  assert.match((await throwing.run(startOp(workspace))).out.error ?? '', /START_NOT_AUTHORIZED: gate down/);
  assert.deepEqual(fake.calls, []);
});

test('approved start calls subagent with exact model, bounded defaults and the built prompt', async t => {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent();
  const seen: unknown[] = [];
  const h = harness(t, workspace, fake, { authorizeStart: async request => { seen.push(request); return { approved: true, claimId: 'claim-1' }; } });
  const { result, out } = await h.run(startOp(workspace));
  assert.equal(result.isError, false, out.error ?? '');
  assert.deepEqual(seen, [{ sessionId: 'session-1', taskKey: 'mission-x.3', revision: 'rev-1', workspace, role: 'code' }]);
  assert.equal(fake.calls.length, 1);
  const args = fake.calls[0]?.args ?? {};
  assert.deepEqual(Object.keys(args).sort(), ['action', 'background', 'model', 'startupMs', 'task', 'wallMs', 'workspace']);
  assert.equal(args.action, 'start');
  assert.equal(args.model, 'p/feature');
  assert.equal(args.background, true);
  assert.equal(args.wallMs, 20 * 60 * 1000);
  assert.equal(args.startupMs, 10000);
  assert.equal(args.workspace, workspace);
  assert.match(String(args.task), /SOURCE_SECRET/);
  assert.match(String(args.task), /<worker-policy>/);
  assert.equal(out.data?.runId, fake.lastId());
  assert.equal(out.data?.claimId, 'claim-1');
  assert.deepEqual(h.deps.registry.list('session-1').map(entry => entry.runId), [fake.lastId()]);
});

test('start validates bounds, workspace, roles, prompt separation and duplicate active tasks', async t => {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent();
  const h = harness(t, workspace, fake);
  for (const wallMs of [99, 3600001, 1.5]) assert.match((await h.run(startOp(workspace, { wallMs }))).out.error ?? '', /WORKER_INPUT_INVALID/);
  assert.match((await h.run(startOp(workspace, { startupMs: 99 }))).out.error ?? '', /WORKER_INPUT_INVALID/);
  assert.match((await h.run(startOp('relative/ws'))).out.error ?? '', /WORKSPACE_INVALID/);
  assert.match((await h.run(startOp(join(workspace, 'missing')))).out.error ?? '', /WORKSPACE_INVALID/);
  assert.match((await h.run(startOp(dirname(packageRoot)))).out.error ?? '', /WORKSPACE_NOT_OWNED/);
  const hardest = startOp(workspace, { input: { role: 'hardest', brief: 'b', projectInstructions: [], publicContext: [], feedback: [] } });
  assert.match((await h.run(hardest)).out.error ?? '', /MODEL_ESCALATION_REQUIRED/);
  const leakingEval = startOp(workspace, { input: { role: 'eval', brief: 'SOURCE_SECRET', publicContext: [], scenarios: [{ id: 'S', text: 't' }] } });
  assert.match((await h.run(leakingEval)).out.error ?? '', /PROMPT_FIELD_FORBIDDEN/);
  const noRole = harness(t, workspace, fake, { loadModels: async () => ({ roles: {}, overrides: {} }) });
  assert.match((await noRole.run(startOp(workspace))).out.error ?? '', /MODEL_ROLE_MISSING/);
  const unavailable = harness(t, workspace, fake, {}, { available: [] });
  assert.match((await unavailable.run(startOp(workspace))).out.error ?? '', /MODEL_UNAVAILABLE/);
  assert.deepEqual(fake.calls, []);

  const escalated = await h.run({ ...hardest, escalation: 'two failed fix attempts' });
  assert.equal(escalated.out.status, 'ok', escalated.out.error ?? '');
  const calls: Call[] = fake.calls;
  assert.deepEqual(calls.map(call => call.args.model), ['p/hardest']);
  const other = await tempDir(t, 'pi-sdd-ws2-');
  assert.match((await h.run(startOp(other))).out.error ?? '', /WORKER_ALREADY_ACTIVE/);
  assert.equal(fake.calls.length, 1);
});

test('missing or incompatible subagent tools are explicit and never translated', async t => {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent();
  const missing = harness(t, workspace, fake, {}, { tools: [] });
  assert.match((await missing.run(startOp(workspace))).out.error ?? '', /SUBAGENT_UNAVAILABLE/);
  const old = harness(t, workspace, fake, {}, { tools: [{ name: 'subagent', parameters: Type.Object({ agent: Type.String(), task: Type.String() }) }] });
  assert.match((await old.run(startOp(workspace))).out.error ?? '', /SUBAGENT_INCOMPATIBLE/);
  assert.deepEqual(fake.calls, []);
});

test('subagent errors, malformed envelopes and mismatched starts are explicit', async t => {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const failing = fakeSubagent({ start: () => ({ isError: true, payload: { error: 'Error: MODEL_NOT_FOUND: p/feature' } }) });
  const failed = await harness(t, workspace, failing).run(startOp(workspace));
  assert.equal(failed.out.status, 'error');
  assert.match(failed.out.error ?? '', /SUBAGENT_ERROR: Error: MODEL_NOT_FOUND/);

  const blocked = fakeSubagent({ start: () => ({ isError: true, structuredContent: undefined }) });
  const plain = await harness(t, workspace, blocked).run(startOp(workspace));
  assert.match(plain.out.error ?? '', /SUBAGENT_/);

  const malformed = fakeSubagent({ start: () => ({ structuredContent: { action: 'start', payload: { id: 'not-a-uuid' } } }) });
  assert.match((await harness(t, workspace, malformed).run(startOp(workspace))).out.error ?? '', /SUBAGENT_MALFORMED/);

  const strayId = randomUUID();
  const mismatched = fakeSubagent({
    start: () => ({ payload: { id: strayId, dir: `/runs/${strayId}`, workspace: '/elsewhere', model: 'p/feature', phase: 'starting' } }),
    cancel: () => ({ payload: terminal(strayId, '/elsewhere', 'cancelled') }),
  });
  const result = await harness(t, workspace, mismatched).run(startOp(workspace));
  assert.match(result.out.error ?? '', /SUBAGENT_MISMATCH/);
  assert.deepEqual(mismatched.calls.map(call => call.args.action), ['start', 'cancel']);
});

async function started(t: TestContext, script: Parameters<typeof fakeSubagent>[0] = {}, extra: Partial<WorkerToolDeps> = {}) {
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent(script);
  const h = harness(t, workspace, fake, extra);
  const start = await h.run(startOp(workspace));
  assert.equal(start.out.status, 'ok', start.out.error ?? '');
  return { ...h, fake, id: fake.lastId(), workspace };
}

test('terminal success separates model completion from verification and counts invisible usage once', async t => {
  const h = await started(t, {
    wait: args => ({ payload: terminal(String(args.id), '', 'succeeded', { details: { summary: 'done', usage: [usage(10), usage(5)] } }) }),
    status: args => ({ payload: terminal(String(args.id), '', 'succeeded', { details: { summary: 'done', usage: [usage(10), usage(5)] } }) }),
  });
  const first = await h.run({ op: 'wait', runId: h.id });
  assert.equal(first.out.status, 'ok', first.out.error ?? '');
  assert.equal(first.out.data?.outcome, 'succeeded');
  assert.equal(first.out.data?.modelCompletion, 'completed');
  assert.equal(first.out.data?.verification, 'not_verified');
  assert.equal(first.out.data?.cleanup, 'confirmed');
  assert.deepEqual(first.result.usage, { input: 15, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 19, cost: { input: 0.02, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.06 } });
  assert.deepEqual(first.out.data?.usage, { source: 'terminal_details', accounted: 'this_result' });
  for (const op of ['wait', 'status']) {
    const again = await h.run({ op, runId: h.id });
    assert.equal(again.result.usage, undefined);
    assert.deepEqual(again.out.data?.usage, { source: 'terminal_details', accounted: 'earlier_result' });
  }
});

test('host-aggregated nested usage is never forwarded again', async t => {
  const h = await started(t, {
    wait: args => ({ payload: terminal(String(args.id), '', 'succeeded', { details: { usage: [usage(10)] } }), usage: usage(10) }),
  });
  const { result, out } = await h.run({ op: 'wait', runId: h.id });
  assert.equal(result.usage, undefined);
  assert.deepEqual(out.data?.usage, { source: 'host_nested', accounted: 'host' });
  const again = await h.run({ op: 'wait', runId: h.id });
  assert.equal(again.result.usage, undefined);
});

test('malformed terminal usage and outcomes are explicit errors', async t => {
  const bad = await started(t, { wait: args => ({ payload: terminal(String(args.id), '', 'succeeded', { details: { usage: [{ input: 'lots' }] } }) }) });
  const usageResult = await bad.run({ op: 'wait', runId: bad.id });
  assert.equal(usageResult.out.status, 'error');
  assert.match(usageResult.out.error ?? '', /USAGE_MALFORMED/);
  assert.equal(usageResult.result.usage, undefined);

  const odd = await started(t, { wait: args => ({ payload: terminal(String(args.id), '', 'finished') }) });
  assert.match((await odd.run({ op: 'wait', runId: odd.id })).out.error ?? '', /SUBAGENT_MALFORMED/);
  const other = await started(t, { status: () => ({ payload: terminal(randomUUID(), '', 'succeeded') }) });
  assert.match((await other.run({ op: 'status', runId: other.id })).out.error ?? '', /SUBAGENT_MISMATCH/);
});

test('failed, timed out and cancelled outcomes are reported as non-success results', async t => {
  for (const outcome of ['failed', 'timed_out', 'cancelled']) {
    const h = await started(t, { wait: args => ({ payload: terminal(String(args.id), '', outcome, { reason: `MODEL_AUTH: ${outcome}` }) }) });
    const { result, out } = await h.run({ op: 'wait', runId: h.id });
    assert.equal(result.isError, true);
    assert.equal(out.status, outcome === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(out.data?.outcome, outcome);
    assert.equal(out.data?.modelCompletion, 'not_completed');
    assert.match(String(out.data?.reason), /MODEL_AUTH/);
  }
});

test('incomplete cleanup keeps the task blocked and reports the run directory', async t => {
  const h = await started(t, {
    wait: args => ({ payload: terminal(String(args.id), '', 'failed', { reason: 'cleanup_incomplete: agent_settled', cleanup: { workerExited: false, groupsAlive: [42], cleanupMs: 2000 } }) }),
  });
  const { result, out } = await h.run({ op: 'wait', runId: h.id });
  assert.equal(result.isError, true);
  assert.equal(out.status, 'blocked');
  assert.match(out.error ?? '', /CLEANUP_UNKNOWN.*\/runs\//);
  assert.equal(h.deps.registry.get('session-1', h.id)?.state, 'cleanup_unknown');
});

test('only own run IDs are reachable and a new session adopts nothing', async t => {
  let session = 'session-1';
  const workspace = await tempDir(t, 'pi-sdd-ws-');
  const fake = fakeSubagent({ status: args => ({ payload: { id: args.id, dir: '/runs/x', workspace, model: 'p/feature', phase: 'running' } }) });
  const h = harness(t, workspace, fake, {}, { session: () => session });
  await h.run(startOp(workspace));
  const id = fake.lastId();
  const foreign = randomUUID();
  for (const op of ['status', 'wait', 'cancel']) assert.match((await h.run({ op, runId: foreign })).out.error ?? '', /WORKER_NOT_OWNED/);
  const status = await h.run({ op: 'status', runId: id });
  assert.equal(status.out.data?.phase, 'running');
  const listed = await h.run({ op: 'list' });
  assert.deepEqual((listed.out.data?.runs as { runId: string }[]).map(run => run.runId), [id]);
  session = 'session-2';
  assert.match((await h.run({ op: 'status', runId: id })).out.error ?? '', /WORKER_NOT_OWNED/);
  assert.deepEqual((await h.run({ op: 'list' })).out.data?.runs, []);
  assert.deepEqual(fake.calls.map(call => call.args.action), ['start', 'status']);
});

function abortableWait(args: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
  return new Promise(resolve => {
    const done = () => resolve({ payload: { id: args.id, dir: `/runs/${String(args.id)}`, workspace: '', model: 'p/feature', phase: 'running', waitingAborted: true } });
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

test('an interrupted wait explicitly cancels the owned worker and confirms cleanup', async t => {
  const h = await started(t, {
    wait: abortableWait,
    cancel: args => ({ payload: terminal(String(args.id), '', 'cancelled', { reason: 'cancelled_by_parent' }) }),
  });
  const controller = new AbortController();
  const pending = h.run({ op: 'wait', runId: h.id }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const { result, out } = await pending;
  assert.equal(result.isError, true);
  assert.equal(out.status, 'cancelled');
  assert.equal(out.data?.cleanup, 'confirmed');
  const cancel = h.fake.calls.find(call => call.args.action === 'cancel');
  assert.deepEqual(cancel?.args, { action: 'cancel', id: h.id });
  assert.equal(cancel?.aborted, false);
});

test('an interrupted wait with failed cancel remains blocked', async t => {
  const h = await started(t, { wait: abortableWait, cancel: () => ({ isError: true, payload: { error: 'Error: Supervisor lost' } }) });
  const controller = new AbortController();
  const pending = h.run({ op: 'wait', runId: h.id }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const { out } = await pending;
  assert.equal(out.status, 'blocked');
  assert.match(out.error ?? '', /CLEANUP_UNKNOWN.*Supervisor lost.*\/runs\//);
});

test('SDD shutdown aborts an in-flight wait and cancels its worker', async t => {
  const h = await started(t, {
    wait: abortableWait,
    cancel: args => ({ payload: terminal(String(args.id), '', 'cancelled') }),
  });
  const pending = h.run({ op: 'wait', runId: h.id });
  setTimeout(() => { for (const controller of h.deps.owned) controller.abort(); }, 10);
  const { out } = await pending;
  assert.equal(out.status, 'cancelled');
  assert.ok(h.fake.calls.some(call => call.args.action === 'cancel'));
});

test('explicit cancel validates the terminal result', async t => {
  const h = await started(t, { cancel: args => ({ payload: terminal(String(args.id), '', 'cancelled') }) });
  const { out } = await h.run({ op: 'cancel', runId: h.id });
  assert.equal(out.status, 'cancelled');
  assert.equal(out.data?.cleanup, 'confirmed');
});

async function sdkSession(t: TestContext, options: { block: boolean; authorize?: AuthorizeStart }) {
  const project = await tempDir(t, 'pi-sdd-sdk-project-');
  await mkdir(join(project, '.git'));
  const workspace = await tempDir(t, 'pi-sdd-sdk-ws-');
  const agentDir = await tempDir(t, 'pi-sdd-sdk-agent-');
  const settingsManager = SettingsManager.inMemory({});
  const faux = fauxProvider({ provider: 'sdd-faux', models: [{ id: 'coder' }] });
  const guardSeen: { toolName: string; parent: string | undefined; action: unknown }[] = [];
  const subagentRuns: unknown[] = [];
  const sddOptions = {
    loadModels: async () => ({ roles: { 'feature, refactoring': 'sdd-faux/coder' }, overrides: {} }),
    ...(options.authorize ? { authorizeStart: options.authorize } : {}),
  };
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.registerProvider(faux.provider);
        pi.on('tool_call', event => {
          const input = event.input as { action?: unknown };
          guardSeen.push({ toolName: event.toolName, parent: event.parentToolCallId, action: input.action });
          if (options.block && event.toolName === 'subagent' && input.action === 'start') return { block: true, reason: 'guard fixture blocked subagent start' };
          return undefined;
        });
        pi.registerTool({
          name: 'subagent', label: 'Subagent', description: 'fixture of the existing subagent boundary',
          parameters: subagentParameters, outputSchema: Type.Object({ action: Type.String(), payload: Type.Any() }),
          async execute(_id, args) {
            subagentRuns.push(args);
            const id = randomUUID();
            const payload = { id, dir: `/runs/${id}`, workspace: args.workspace ?? '', model: args.model ?? '', phase: 'starting' };
            return { content: [{ type: 'text', text: id }], details: { action: 'start', payload }, structuredContent: { action: 'start', payload } };
          },
        });
      },
      createSddExtension(sddOptions),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(project) });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: 'rpc' } as never);
  await session.setModel(faux.getModel());
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('sdd_worker', { operation: startOp(workspace) }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  await session.prompt('start the worker');
  const toolResult = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'sdd_worker');
  assert.ok(toolResult && toolResult.role === 'toolResult');
  return { guardSeen, subagentRuns, toolResult, faux };
}

test('real SDK: a blocking tool_call guard on the nested subagent call prevents start', async t => {
  const { guardSeen, subagentRuns, toolResult } = await sdkSession(t, { block: true, authorize: approve });
  assert.deepEqual(subagentRuns, []);
  const nested = guardSeen.find(entry => entry.toolName === 'subagent');
  assert.equal(nested?.action, 'start');
  assert.match(String(nested?.parent), /.+/);
  assert.equal(toolResult.isError, true);
  assert.match(JSON.stringify(toolResult.content), /guard fixture blocked subagent start/);
});

test('real SDK: an allowing guard sees the nested start and the fixture subagent runs', async t => {
  const { guardSeen, subagentRuns, toolResult } = await sdkSession(t, { block: false, authorize: approve });
  assert.equal(subagentRuns.length, 1);
  assert.ok(guardSeen.some(entry => entry.toolName === 'subagent' && entry.parent !== undefined));
  assert.equal(toolResult.isError, false, JSON.stringify(toolResult.content));
});

test('real SDK: the default extension denies starts before any nested call', async t => {
  const { guardSeen, subagentRuns, toolResult } = await sdkSession(t, { block: false });
  assert.deepEqual(subagentRuns, []);
  assert.deepEqual(guardSeen.map(entry => entry.toolName), ['sdd_worker']);
  assert.equal(toolResult.isError, true);
  assert.match(JSON.stringify(toolResult.content), /START_NOT_AUTHORIZED/);
});
