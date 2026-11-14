import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionToolContext,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { parseSddCommand } from '../src/commands.ts';
import { ControlOutputSchema, ControlParamsSchema } from '../src/control-tool.ts';
import { reduceSession, SESSION_ENTRY_TYPE } from '../src/session-state.ts';
import { createSddExtension } from '../extensions/sdd.ts';
import type { BeadsClient } from '../src/beads.ts';
import { createFakeBeads } from './helpers/fake-bd.ts';
import { makeSpec } from './helpers/spec.ts';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(packageRoot, 'extensions', 'sdd.ts');
const policyText = (await readFile(join(packageRoot, 'policies', 'workflow.md'), 'utf8')).trim();
const beadsDir = '/nonexistent-home/.missions/.beads';

test('parser returns discriminated commands with shell-like quoting', () => {
  assert.deepEqual(parseSddCommand('review "src/a b.ts"'), { kind: 'workflow', verb: 'review', args: ['src/a b.ts'] });
  assert.equal(parseSddCommand('off').kind, 'off');
  assert.throws(() => parseSddCommand('start'));
  assert.deepEqual(parseSddCommand("debug 'it''s' \"say \\\"hi\\\"\" $HOME;rm"), {
    kind: 'workflow',
    verb: 'debug',
    args: ['its', 'say "hi"', '$HOME;rm'],
  });
  assert.deepEqual(parseSddCommand('  status  '), { kind: 'status', target: null });
  assert.deepEqual(parseSddCommand('status "001"'), { kind: 'status', target: '001' });
  assert.deepEqual(parseSddCommand('doctor'), { kind: 'doctor' });
  assert.deepEqual(parseSddCommand('specify'), { kind: 'workflow', verb: 'specify', args: [] });
  for (const bad of ['', 'focus x', 'land', 'off now', 'doctor x', 'status a b', 'review "open', 'toString', 'constructor']) {
    assert.throws(() => parseSddCommand(bad), /SDD_USAGE/, bad);
  }
});

interface Notice { message: string; type: string | undefined }

interface Harness {
  sm: SessionManager;
  sent: Array<{ content: unknown; options: unknown }>;
  notices: Notice[];
  selects: Array<{ title: string; options: string[] }>;
  commandNames: string[];
  toolNames: string[];
  eventNames: string[];
  registered: { name: string; sourceInfo: { path: string } }[];
  run(args: string, overrides?: Partial<CommandCtxOptions>): Promise<void>;
  emit(event: string, payload: Record<string, unknown>): Promise<unknown[]>;
  prompt(force?: string): Promise<{ sections: Record<string, string>; results: unknown[] }>;
  tool(params: unknown, options?: ToolCtxOptions): Promise<ToolOutcome>;
}

interface CommandCtxOptions {
  hasUI: boolean;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  cwd: string;
}

interface ToolCtxOptions {
  hasUI?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  tools?: string[];
  executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<{ isError: boolean; result: unknown }>;
}

interface ToolOutcome {
  isError: boolean | undefined;
  structuredContent: unknown;
  text: string;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type Tool = {
  name: string;
  outputSchema?: unknown;
  parameters: unknown;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionToolContext) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
};

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function projectWithSpec(t: TestContext): Promise<{ root: string; specDir: string }> {
  const root = await tempDir(t, 'pi-sdd-commands-');
  await mkdir(join(root, '.git'));
  const spec = makeSpec();
  const specDir = join(root, '.start', 'specs', '001-sample');
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'requirements.md'), 'Return a greeting.');
  await writeFile(join(specDir, 'solution.md'), 'Add src/core.ts.');
  await writeFile(join(specDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  return { root, specDir };
}

async function skillsRoot(t: TestContext): Promise<string> {
  const root = await tempDir(t, 'pi-sdd-skills-');
  for (const name of ['sdd-review', 'sdd-debug']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
  }
  return root;
}

function harness({ cwd, skills, client, sm = SessionManager.inMemory(cwd), extraCommands = [] }: {
  cwd: string;
  skills?: string;
  client?: BeadsClient;
  sm?: SessionManager;
  extraCommands?: Array<{ name: string; path: string }>;
}): Harness {
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const sent: Harness['sent'] = [];
  const notices: Notice[] = [];
  const selects: Harness['selects'] = [];
  const registered: Harness['registered'] = [];
  const api = {
    registerCommand(name: string, options: Command) {
      commands.set(name, options);
      registered.push({ name, sourceInfo: { path: extensionPath } });
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
      return () => {};
    },
    appendEntry(customType: string, data: unknown) {
      sm.appendCustomEntry(customType, data);
    },
    sendUserMessage(content: unknown, options: unknown) {
      sent.push({ content, options });
    },
    getAllTools() {
      return [];
    },
    getCommands() {
      return [...registered, ...extraCommands.map(command => ({ name: command.name, sourceInfo: { path: command.path } }))]
        .map(command => ({ ...command, source: 'extension' }));
    },
  };
  createSddExtension({
    beadsDir,
    agentDir: join(cwd, '.no-agent'),
    rolesPath: join(cwd, '.no-agent', 'models.json'),
    overridesPath: join(cwd, '.no-agent', 'config.json'),
    ...(skills ? { skillsRoot: skills } : {}),
    ...(client ? { createClient: () => client } : {}),
  })(api as unknown as ExtensionAPI);

  const ui = (hasUI: boolean, select: CommandCtxOptions['select']) => ({
    notify: (message: string, type?: string) => notices.push({ message, type }),
    select: async (title: string, options: string[]) => {
      selects.push({ title, options });
      return hasUI ? select(title, options) : undefined;
    },
  });
  const baseCtx = (hasUI: boolean, ctxCwd: string, select: CommandCtxOptions['select']) => ({
    cwd: ctxCwd,
    hasUI,
    mode: hasUI ? 'tui' : 'print',
    ui: ui(hasUI, select),
    sessionManager: sm,
    signal: undefined,
    isIdle: () => true,
    modelRegistry: { getAvailable: () => [] },
  });

  const emit = async (event: string, payload: Record<string, unknown>) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, baseCtx(false, cwd, async () => undefined)));
    }
    return results;
  };

  return {
    sm,
    sent,
    notices,
    selects,
    registered,
    commandNames: [...commands.keys()],
    toolNames: [...tools.keys()],
    eventNames: [...handlers.keys()],
    run: async (args, overrides = {}) => {
      const command = commands.get('sdd');
      if (!command) throw new Error('sdd command missing');
      const ctx = baseCtx(overrides.hasUI ?? true, overrides.cwd ?? cwd, overrides.select ?? (async () => undefined));
      await command.handler(args, ctx as unknown as ExtensionCommandContext);
    },
    emit,
    prompt: async force => {
      const options: { sections: Record<string, string>; forceSystemPrompt?: string } = {
        sections: { other: 'keep me' },
        ...(force === undefined ? {} : { forceSystemPrompt: force }),
      };
      const results = await emit('before_agent_start', { prompt: 'hi', systemPrompt: 'base', systemPromptOptions: options });
      return { sections: options.sections, results };
    },
    tool: async (params, options = {}) => {
      const tool = tools.get('sdd_control');
      if (!tool) throw new Error('sdd_control missing');
      const executeTool = options.executeTool ?? (async () => {
        throw new Error('executeTool must not be called');
      });
      const ctx = {
        ...baseCtx(options.hasUI ?? false, options.cwd ?? cwd, async () => undefined),
        tools: (options.tools ?? ['bash']).map(name => ({ name })),
        executeTool,
      };
      const result = await tool.execute('call-1', params, options.signal, undefined, ctx as unknown as ExtensionToolContext);
      return {
        isError: result.isError,
        structuredContent: result.structuredContent,
        text: result.content.map(part => part.text ?? '').join('\n'),
      };
    },
  };
}

function customEntries(sm: SessionManager, type: string): unknown[] {
  return sm.getBranch().flatMap(entry => entry.type === 'custom' && entry.customType === type ? [entry.data] : []);
}

test('registers only /sdd, sdd_control and sdd_worker with no takeover hooks', async t => {
  const root = await tempDir(t, 'pi-sdd-reg-');
  const h = harness({ cwd: root });
  assert.deepEqual(h.commandNames, ['sdd']);
  assert.deepEqual(h.toolNames.sort(), ['sdd_control', 'sdd_evaluate', 'sdd_worker']);
  for (const event of h.eventNames) {
    assert.ok(['session_start', 'session_tree', 'session_shutdown', 'before_agent_start'].includes(event), event);
  }
});

test('workflow dispatch sends a read-skill user message with arguments as data', async t => {
  const root = await tempDir(t, 'pi-sdd-wf-');
  const skills = await skillsRoot(t);
  const h = harness({ cwd: root, skills });
  await h.run('review "src/a b.ts" \'$ARGUMENTS; rm -rf /\'');
  assert.equal(h.sent.length, 1);
  const message = h.sent[0]?.content;
  assert.equal(typeof message, 'string');
  const text = String(message);
  assert.ok(text.includes(join(skills, 'sdd-review', 'SKILL.md')));
  assert.ok(text.includes(JSON.stringify(['src/a b.ts', '$ARGUMENTS; rm -rf /'])));
  assert.ok(!text.includes('Skill tool'));
  assert.deepEqual(reduceSession(h.sm.getBranch()), { active: true, projectRoot: root, specPath: null, missionId: null });
});

test('missing skill file is an honest error and does not activate', async t => {
  const root = await tempDir(t, 'pi-sdd-missing-');
  const h = harness({ cwd: root });
  await h.run('nonexistent x');
  assert.equal(h.sent.length, 0);
  assert.deepEqual(customEntries(h.sm, SESSION_ENTRY_TYPE), []);
  const notice = h.notices.at(-1);
  assert.equal(notice?.type, 'error');
  assert.match(notice?.message ?? '', /Usage: \/sdd/);
});

test('unknown commands return usage without dispatch', async t => {
  const root = await tempDir(t, 'pi-sdd-usage-');
  const h = harness({ cwd: root, skills: await skillsRoot(t) });
  await h.run('start something');
  await h.run('');
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.length, 2);
  for (const notice of h.notices) {
    assert.equal(notice.type, 'error');
    assert.match(notice.message, /Usage: \/sdd/);
  }
});

test('status and doctor are read-only and doctor reports missing prerequisites', async t => {
  const { root } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  const before = await readdir(root, { recursive: true });
  await h.run('status 001');
  assert.equal(h.sm.getBranch().length, 0);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(h.notices[0]?.type, 'info');
  assert.match(h.notices[0]?.message ?? '', /SDD inactive/);
  assert.match(h.notices[0]?.message ?? '', /001-sample/);

  await h.run('doctor');
  assert.equal(h.notices[1]?.type, 'error');
  assert.match(h.notices[1]?.message ?? '', /no providers contacted/);
  assert.match(h.notices[1]?.message ?? '', /SUBAGENT_UNAVAILABLE/);
  assert.match(h.notices[1]?.message ?? '', /MODEL_CONFIG_MISSING/);
  assert.equal(h.sm.getBranch().length, 0);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(h.sent.length, 0);
});

test('command collisions are refused at activation and doctor', async t => {
  const root = await tempDir(t, 'pi-sdd-collide-');
  const h = harness({ cwd: root, skills: await skillsRoot(t), extraCommands: [{ name: 'sdd:2', path: '/other/package/index.ts' }] });
  await h.run('review x');
  assert.equal(h.sent.length, 0);
  assert.match(h.notices.at(-1)?.message ?? '', /COMMAND_COLLISION/);
  await h.run('doctor');
  assert.match(h.notices.at(-1)?.message ?? '', /COMMAND_COLLISION/);
  assert.equal(h.notices.at(-1)?.type, 'error');
});

test('off clears only SDD context and keeps binding and other entries', async t => {
  const root = await tempDir(t, 'pi-sdd-off-');
  const h = harness({ cwd: root });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-a' });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: null, missionId: 'mission-a' });
  await h.emit('session_start', { reason: 'startup' });
  assert.equal((await h.prompt()).sections['pi-sdd-workflow'], policyText);
  await h.run('off');
  assert.deepEqual(reduceSession(h.sm.getBranch()), { active: false, projectRoot: root, specPath: null, missionId: 'mission-a' });
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-a' }]);
  const after = await h.prompt();
  assert.equal(after.sections['pi-sdd-workflow'], undefined);
  assert.equal(after.sections.other, 'keep me');
});

test('explicit off recovers corrupt latest own state without changing files or other entries', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const fake = createFakeBeads({ epicId: 'mission-a' });
  const h = harness({ cwd: root, client: fake.client });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: '/untrusted-old-root', specPath: specDir, missionId: 'mission-a' });
  await h.emit('session_start', { reason: 'startup' });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: 'yes' });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-b' });
  h.sm.appendCustomEntry('other-extension', { keep: true });
  const before = h.sm.getBranch();
  const paths = await readdir(root, { recursive: true });
  const descriptor = await readFile(join(specDir, 'spec.json'), 'utf8');
  await assert.rejects(h.run('status'), /SESSION_STATE_CORRUPT/);
  await h.run('off', { cwd: specDir });
  assert.deepEqual(h.sm.getBranch().slice(0, before.length), before);
  assert.equal(h.sm.getBranch().length, before.length + 1);
  assert.deepEqual(reduceSession(h.sm.getBranch()), { active: false, projectRoot: root, specPath: null, missionId: null });
  assert.deepEqual((await h.prompt()).sections, { other: 'keep me' });
  assert.deepEqual(await readdir(root, { recursive: true }), paths);
  assert.equal(await readFile(join(specDir, 'spec.json'), 'utf8'), descriptor);
  assert.equal(fake.writes().length, 0);
});

test('reused prompt options lose only the SDD section after off', async t => {
  const root = await tempDir(t, 'pi-sdd-reuse-');
  const h = harness({ cwd: root });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-a' });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: null, missionId: 'mission-a' });
  await h.emit('session_start', { reason: 'startup' });
  const options: { sections: Record<string, string> } = { sections: { other: 'keep me' } };
  const event = { prompt: 'hi', systemPrompt: 'base', systemPromptOptions: options };
  await h.emit('before_agent_start', event);
  assert.equal(options.sections['pi-sdd-workflow'], policyText);
  await h.run('off');
  await h.emit('before_agent_start', event);
  assert.deepEqual(options.sections, { other: 'keep me' });
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-a' }]);
});

test('corrupt latest session state clears active context before failing', async t => {
  const root = await tempDir(t, 'pi-sdd-corrupt-');
  const h = harness({ cwd: root });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: null, missionId: 'mission-a' });
  await h.emit('session_start', { reason: 'startup' });
  assert.equal((await h.prompt()).sections['pi-sdd-workflow'], policyText);
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: 'yes' });
  h.sm.appendCustomEntry('other-extension', { keep: true });
  const before = h.sm.getEntries().length;
  await assert.rejects(h.emit('session_tree', {}), /SESSION_STATE_CORRUPT/);
  assert.equal((await h.prompt()).sections['pi-sdd-workflow'], undefined);
  assert.equal(h.sm.getEntries().length, before);
  assert.deepEqual(customEntries(h.sm, 'other-extension'), [{ keep: true }]);
});

test('focus conflict stops for an explicit choice with at most four options', async t => {
  const root = await tempDir(t, 'pi-sdd-conflict-');
  const skills = await skillsRoot(t);
  const h = harness({ cwd: root, skills });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: false, projectRoot: root, specPath: null, missionId: 'mission-a' });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-x' });
  const entries = h.sm.getEntries().length;

  await h.run('debug crash', { hasUI: true, select: async () => undefined });
  assert.equal(h.sent.length, 0);
  assert.equal(h.sm.getEntries().length, entries);
  assert.ok((h.selects[0]?.options.length ?? 99) <= 4);
  assert.ok(h.selects[0]?.options.includes('Cancel'));
  assert.match(h.notices.at(-1)?.message ?? '', /cancel/i);

  await h.run('debug crash', { hasUI: false });
  assert.equal(h.sent.length, 0);
  assert.equal(h.selects.length, 1);
  assert.match(h.notices.at(-1)?.message ?? '', /FOCUS_CONFLICT/);

  await h.run('debug crash', { hasUI: true, select: async (_title, options) => options.find(option => option.startsWith('Cancel')) });
  assert.equal(h.sent.length, 0);

  await h.run('debug crash', { hasUI: true, select: async (_title, options) => options[0] });
  assert.equal(h.sent.length, 1);
  assert.equal(reduceSession(h.sm.getBranch()).missionId, 'mission-a');
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-x' }]);
});

test('policy is absent while inactive and follows tree, reload and fork', async t => {
  const root = await tempDir(t, 'pi-sdd-policy-');
  const sm = SessionManager.inMemory(root);
  const h = harness({ cwd: root, sm });
  await h.emit('session_start', { reason: 'startup' });
  const inactive = await h.prompt();
  assert.deepEqual(inactive.sections, { other: 'keep me' });
  assert.deepEqual(inactive.results, [undefined]);

  const forkPoint = sm.appendCustomEntry('other-extension', { n: 1 });
  sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: null, missionId: 'mission-a' });
  const leafA = sm.appendCustomEntry('other-extension', { n: 2 });
  await h.emit('session_tree', { newLeafId: leafA, oldLeafId: forkPoint });
  assert.equal((await h.prompt()).sections['pi-sdd-workflow'], policyText);
  const forced = await h.prompt('forced by another extension');
  assert.deepEqual(forced.results, [{ systemPrompt: `forced by another extension\n\n<pi-sdd-workflow>\n${policyText}\n</pi-sdd-workflow>` }]);

  sm.branch(forkPoint);
  await h.emit('session_tree', { newLeafId: forkPoint, oldLeafId: leafA });
  assert.equal((await h.prompt()).sections['pi-sdd-workflow'], undefined);
  sm.branch(leafA);
  await h.emit('session_tree', { newLeafId: leafA, oldLeafId: forkPoint });

  const reloaded = harness({ cwd: root, sm });
  assert.equal((await reloaded.prompt()).sections['pi-sdd-workflow'], undefined);
  await reloaded.emit('session_start', { reason: 'reload' });
  assert.equal((await reloaded.prompt()).sections['pi-sdd-workflow'], policyText);

  sm.createBranchedSession(leafA);
  const forked = harness({ cwd: root, sm });
  await forked.emit('session_start', { reason: 'fork' });
  assert.equal((await forked.prompt()).sections['pi-sdd-workflow'], policyText);
  assert.deepEqual(customEntries(sm, 'other-extension'), [{ n: 1 }, { n: 2 }]);

  const fresh = harness({ cwd: root });
  await fresh.emit('session_start', { reason: 'new' });
  assert.equal((await fresh.prompt()).sections['pi-sdd-workflow'], undefined);
});

function fakeBash(responses: Record<string, unknown>, log: string[] = []) {
  return async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
    assert.equal(name, 'bash');
    assert.ok(options?.signal, 'signal must be propagated');
    const command = typeof args === 'object' && args !== null && 'command' in args ? String(args.command) : '';
    log.push(command);
    const marker = /'(__SDD_STDERR_[^']+__)'/.exec(command)?.[1];
    const match = Object.entries(responses).find(([pattern]) => command.includes(pattern));
    if (!marker || !match) throw new Error(`unexpected command ${command}`);
    return {
      isError: false,
      result: {
        content: [],
        structuredContent: { output: `${JSON.stringify(match[1])}\n${marker}\n`, truncated: false, exit_code: 0 },
      },
    };
  };
}

const epic = (id: string, overrides: Record<string, unknown> = {}) => [{
  id,
  title: 'Mission',
  status: 'open',
  issue_type: 'epic',
  ...overrides,
}];

test('sdd_control declares discriminated params and an output schema', async t => {
  const root = await tempDir(t, 'pi-sdd-schema-');
  harness({ cwd: root });
  assert.ok(Value.Check(ControlParamsSchema, { operation: { op: 'read', projectRoot: root, target: '001' } }));
  assert.ok(!Value.Check(ControlParamsSchema, { operation: { op: 'read', projectRoot: root } }));
  assert.ok(!Value.Check(ControlParamsSchema, { operation: { op: 'bind', projectRoot: root, target: '001' } }));
  assert.ok(!Value.Check(ControlParamsSchema, { operation: { op: 'approve', projectRoot: root, target: '001' } }));
  assert.ok(!Value.Check(ControlParamsSchema, { operation: { op: 'create', projectRoot: root, name: 'x', extra: 1 } }));
});

test('sdd_control read, create and status are structured', async t => {
  const { root } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  const read = await h.tool({ operation: { op: 'read', projectRoot: root, target: '001' } });
  assert.equal(read.isError, false);
  assert.ok(Value.Check(ControlOutputSchema, read.structuredContent));
  assert.deepEqual(read.structuredContent, {
    op: 'read',
    status: 'ok',
    data: { kind: 'descriptor', path: join(root, '.start/specs/001-sample'), spec: makeSpec() },
  });

  const created = await h.tool({ operation: { op: 'create', projectRoot: join(root, '.start'), name: 'Second thing' } });
  assert.equal(created.isError, false);
  assert.deepEqual(await readdir(join(root, '.start/specs')), ['001-sample', '002-second-thing']);
  assert.deepEqual(await readdir(join(root, '.pi/sdd/locks')), []);

  const status = await h.tool({ operation: { op: 'status', projectRoot: root } });
  assert.equal(status.isError, false);
  assert.deepEqual(status.structuredContent, {
    op: 'status',
    status: 'ok',
    data: { session: { active: false, projectRoot: '', specPath: null, missionId: null }, focus: null, conflict: null, spec: null, tasks: null },
  });
});

test('sdd_control rejects foreign project roots and aborted signals', async t => {
  const { root } = await projectWithSpec(t);
  const other = await tempDir(t, 'pi-sdd-other-');
  const h = harness({ cwd: root });
  const foreign = await h.tool({ operation: { op: 'create', projectRoot: other, name: 'x' } });
  assert.equal(foreign.isError, true);
  assert.equal(Value.Check(ControlOutputSchema, foreign.structuredContent), true);
  assert.match(foreign.text, /PROJECT_ROOT_MISMATCH/);
  assert.deepEqual(await readdir(other), []);

  const controller = new AbortController();
  controller.abort();
  const aborted = await h.tool({ operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } }, { signal: controller.signal });
  assert.equal(aborted.isError, true);
  assert.match(aborted.text, /ABORTED/);
});

test('bind validates an explicit epic through executeTool and records the session binding', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  const log: string[] = [];
  const bound = await h.tool(
    { operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } },
    { executeTool: fakeBash({ 'show mission-a --json': epic('mission-a') }, log), signal: new AbortController().signal },
  );
  assert.equal(bound.isError, false, bound.text);
  assert.equal(log.length, 1);
  assert.match(log[0] ?? '', /BEADS_DIR='\/nonexistent-home\/\.missions\/\.beads' bd show mission-a --json/);
  assert.deepEqual(reduceSession(h.sm.getBranch()), { active: true, projectRoot: root, specPath: specDir, missionId: 'mission-a' });
  assert.deepEqual(await readdir(join(root, '.pi/sdd/locks')), []);

  const task = await h.tool(
    { operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-t' } },
    { executeTool: fakeBash({ 'show mission-t --json': epic('mission-t', { issue_type: 'task' }) }) },
  );
  assert.equal(task.isError, true);
  assert.match(task.text, /MISSION_NOT_EPIC/);
  assert.equal(reduceSession(h.sm.getBranch()).missionId, 'mission-a');
});

test('host error outcomes are not treated as success', async t => {
  const { root } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  const failed = await h.tool(
    { operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } },
    { executeTool: async () => ({ isError: true, result: { content: [{ type: 'text', text: 'blocked by guard' }] } }) },
  );
  assert.equal(failed.isError, true);
  assert.match(failed.text, /blocked by guard/);
  assert.deepEqual(customEntries(h.sm, SESSION_ENTRY_TYPE), []);
});

test('bind focus conflicts require approval and never deadlock headless', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-x' });
  const bash = fakeBash({ 'show mission-a --json': epic('mission-a') });
  const params = { operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } };

  const headless = await h.tool(params, { executeTool: bash, hasUI: false, tools: ['bash', 'ask_user_question'] });
  assert.equal(headless.isError, true);
  assert.equal((headless.structuredContent as { status: string }).status, 'approval_required');
  assert.deepEqual(customEntries(h.sm, SESSION_ENTRY_TYPE), []);

  const noTool = await h.tool(params, { executeTool: bash, hasUI: true });
  assert.equal((noTool.structuredContent as { status: string }).status, 'approval_required');

  const questions: unknown[] = [];
  const ask = (answer: unknown) => async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
    if (name !== 'ask_user_question') return bash(name, args, options);
    questions.push(args);
    return { isError: false, result: { content: [{ type: 'text', text: 'x' }], details: answer } };
  };
  const cancelled = await h.tool(params, {
    executeTool: ask({ answers: [], cancelled: true }),
    hasUI: true,
    tools: ['bash', 'ask_user_question'],
  });
  assert.equal(cancelled.isError, true);
  assert.equal((cancelled.structuredContent as { status: string }).status, 'cancelled');
  assert.deepEqual(customEntries(h.sm, SESSION_ENTRY_TYPE), []);
  const options = (questions[0] as { questions: Array<{ options: unknown[] }> }).questions[0]?.options ?? [];
  assert.ok(options.length >= 2 && options.length <= 4);

  const approved = await h.tool(params, {
    executeTool: ask({ answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: 'Bind mission-a' }], cancelled: false }),
    hasUI: true,
    tools: ['bash', 'ask_user_question'],
  });
  assert.equal(approved.isError, false, approved.text);
  assert.deepEqual(reduceSession(h.sm.getBranch()), { active: true, projectRoot: root, specPath: specDir, missionId: 'mission-a' });
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-x' }]);
});

test('malformed or unavailable question responses pause instead of reporting cancellation', async t => {
  const { root } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-x' });
  const bash = fakeBash({ 'show mission-a --json': epic('mission-a') });
  const params = { operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } };
  const ask = (result: unknown) => async (name: string, args: unknown, options?: { signal?: AbortSignal }) =>
    name === 'ask_user_question' ? { isError: false, result } : bash(name, args, options);
  const responses = [
    { content: [{ type: 'text', text: 'User has answered your questions: "q"="Bind mission-a".' }] },
    { content: [], details: { answers: 'Bind mission-a', cancelled: false } },
    { content: [], details: { answers: [], cancelled: true, error: 'no_custom_ui' } },
  ];
  for (const response of responses) {
    const outcome = await h.tool(params, { executeTool: ask(response), hasUI: true, tools: ['bash', 'ask_user_question'] });
    assert.equal((outcome.structuredContent as { status: string }).status, 'approval_required', JSON.stringify(response));
    assert.match(outcome.text, /ASK_USER_UNSUPPORTED_RESPONSE/);
  }
  assert.deepEqual(customEntries(h.sm, SESSION_ENTRY_TYPE), []);
});

test('materialize stops for an explicit choice when land-focus drifts after binding', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const fake = createFakeBeads({ epicId: 'mission-a' });
  const h = harness({ cwd: root, client: fake.client });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-a' });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: specDir, missionId: 'mission-a' });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-b' });
  const params = { operation: { op: 'materialize', projectRoot: root, target: '001', missionId: 'mission-a' } };

  const headless = await h.tool(params, { hasUI: false, tools: ['ask_user_question'] });
  assert.equal((headless.structuredContent as { status: string }).status, 'approval_required');
  assert.match(headless.text, /FOCUS_CONFLICT/);
  assert.equal(fake.writes().length, 0);

  const cancelled = await h.tool(params, {
    hasUI: true,
    tools: ['ask_user_question'],
    executeTool: async () => ({ isError: false, result: { content: [], details: { answers: [], cancelled: true } } }),
  });
  assert.equal((cancelled.structuredContent as { status: string }).status, 'cancelled');
  assert.equal(fake.writes().length, 0);
  assert.equal(JSON.parse(await readFile(join(specDir, 'spec.json'), 'utf8')).binding, null);
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-a' }, { id: 'mission-b' }]);
});

test('materialize focus drift accepts only the exact option, not a custom answer', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const fake = createFakeBeads({ epicId: 'mission-a' });
  const h = harness({ cwd: root, client: fake.client });
  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: specDir, missionId: 'mission-a' });
  h.sm.appendCustomEntry('land-focus', { id: 'mission-b' });
  const params = { operation: { op: 'materialize', projectRoot: root, target: '001', missionId: 'mission-a' } };
  const questions: unknown[] = [];
  const ask = (answer: unknown) => async (name: string, args: unknown) => {
    assert.equal(name, 'ask_user_question');
    questions.push(args);
    return { isError: false, result: { content: [{ type: 'text', text: 'x' }], details: answer } };
  };
  const response = (kind: string) => ({ answers: [{ questionIndex: 0, question: 'q', kind, answer: 'Materialize into mission-a' }], cancelled: false });
  const descriptor = await readFile(join(specDir, 'spec.json'), 'utf8');
  const before = h.sm.getBranch();
  const custom = await h.tool(params, { executeTool: ask(response('custom')), hasUI: true, tools: ['ask_user_question'] });
  assert.equal(custom.isError, true);
  assert.equal((custom.structuredContent as { status: string }).status, 'cancelled');
  assert.equal(fake.writes().length, 0);
  assert.equal(await readFile(join(specDir, 'spec.json'), 'utf8'), descriptor);
  assert.deepEqual(h.sm.getBranch(), before);
  const approved = await h.tool(params, {
    executeTool: ask(response('option')),
    hasUI: true, tools: ['ask_user_question'],
  });
  assert.equal(approved.isError, false, approved.text);
  assert.equal(questions.length, 2);
  assert.equal(fake.actions().length, 1);
  assert.equal(JSON.parse(await readFile(join(specDir, 'spec.json'), 'utf8')).binding.missionId, 'mission-a');
  assert.deepEqual(customEntries(h.sm, 'land-focus'), [{ id: 'mission-b' }]);
});

test('materialize requires the explicit session binding and uses the validated service', async t => {
  const { root, specDir } = await projectWithSpec(t);
  const fake = createFakeBeads({ epicId: 'mission-a' });
  const h = harness({ cwd: root, client: fake.client });
  const params = { operation: { op: 'materialize', projectRoot: root, target: '001', missionId: 'mission-a' } };
  const unbound = await h.tool(params);
  assert.equal(unbound.isError, true);
  assert.match(unbound.text, /BINDING_REQUIRED/);
  assert.equal(fake.writes().length, 0);

  h.sm.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: root, specPath: specDir, missionId: 'mission-a' });
  const done = await h.tool(params);
  assert.equal(done.isError, false, done.text);
  assert.equal(fake.actions().length, 1);
  const spec = JSON.parse(await readFile(join(specDir, 'spec.json'), 'utf8'));
  assert.equal(spec.binding.missionId, 'mission-a');

  const status = await h.tool({ operation: { op: 'status', projectRoot: root, target: '001' } });
  assert.equal(status.isError, false, status.text);
  assert.deepEqual((status.structuredContent as { data: { tasks: unknown } }).data.tasks, { core: 'open' });
});

test('session shutdown cancels owned in-flight work', { timeout: 10_000 }, async t => {
  const { root } = await projectWithSpec(t);
  const h = harness({ cwd: root });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const pending = h.tool({ operation: { op: 'bind', projectRoot: root, target: '001', missionId: 'mission-a' } }, {
    executeTool: (_name, _args, options) => new Promise((_resolve, reject) => {
      started();
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
    }),
  });
  await running;
  await h.emit('session_shutdown', { reason: 'reload' });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.text, /abort/i);
  assert.deepEqual(await readdir(join(root, '.pi/sdd/locks')), []);
});

test('real SDK resource loader loads the package extension beside unchanged commands without a provider', async t => {
  const project = await tempDir(t, 'pi-sdd-sdk-project-');
  await mkdir(join(project, '.git'));
  const agentDir = await tempDir(t, 'pi-sdd-sdk-agent-');
  const settingsManager = SettingsManager.inMemory({});
  const fixtureCalls: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [packageRoot],
    extensionFactories: [(pi: ExtensionAPI) => {
      for (const name of ['start', 'focus', 'land']) {
        pi.registerCommand(name, { description: `fixture ${name}`, handler: async args => { fixtureCalls.push(`${name}:${args}`); } });
      }
    }],
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const sdd = loaded.extensions.find(extension => extension.commands.has('sdd'));
  assert.ok(sdd, 'package extension loaded');
  assert.equal(await realpath(sdd.resolvedPath), await realpath(extensionPath));
  assert.deepEqual([...sdd.commands.keys()], ['sdd']);
  assert.deepEqual([...sdd.tools.keys()].sort(), ['sdd_control', 'sdd_evaluate', 'sdd_worker']);
  assert.ok(sdd.tools.get('sdd_control')?.definition.outputSchema);

  const { session } = await createAgentSession({
    cwd: project,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(project),
  });
  t.after(() => session.dispose());
  const notices: Notice[] = [];
  const errors: unknown[] = [];
  const uiContext = {
    notify: (message: string, type?: string) => { notices.push({ message, type }); },
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    setStatus: () => {},
  };
  await session.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext, mode: 'rpc', onError: error => { errors.push(error); } });

  const names = session.extensionRunner.getRegisteredCommands().map(command => command.invocationName);
  assert.deepEqual(names.filter(name => ['sdd', 'start', 'focus', 'land'].includes(name.split(':')[0] ?? '')).sort(), ['focus', 'land', 'sdd', 'start']);
  assert.ok(session.getAllTools().some(tool => tool.name === 'sdd_control'));

  await session.prompt('/start "keep me"');
  await session.prompt('/focus x');
  await session.prompt('/land');
  assert.deepEqual(fixtureCalls, ['start:"keep me"', 'focus:x', 'land:']);

  session.sessionManager.appendCustomEntry(SESSION_ENTRY_TYPE, { active: true, projectRoot: project, specPath: null, missionId: 'mission-a' });
  await session.prompt('/sdd status');
  await session.prompt('/sdd doctor');
  await session.prompt('/sdd nonexistent missing');
  await session.prompt('/sdd off');
  assert.deepEqual(reduceSession(session.sessionManager.getBranch()), { active: false, projectRoot: project, specPath: null, missionId: 'mission-a' });
  const messages = session.sessionManager.getBranch().filter(entry => entry.type === 'message');
  assert.deepEqual(messages.filter(entry => entry.message.role === 'assistant' || entry.message.role === 'user'), []);
  assert.deepEqual(errors, []);
  assert.match(notices[0]?.message ?? '', /SDD active/);
  assert.equal(notices[1]?.type, 'error');
  assert.match(notices[1]?.message ?? '', /SDD doctor: FAILURES found/);
  assert.match(notices[1]?.message ?? '', /SUBAGENT_UNAVAILABLE/);
  assert.doesNotMatch(notices[1]?.message ?? '', /COMMAND_COLLISION/);
  assert.match(notices[2]?.message ?? '', /Usage: \/sdd/);
  assert.match(notices[3]?.message ?? '', /SDD off/);
});
