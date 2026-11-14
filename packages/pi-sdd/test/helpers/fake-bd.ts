import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BeadsError,
  type BeadsClient,
  type CommandTransport,
  type CreateActionInput,
  type UpdateFields,
} from '../../src/beads.ts';
import type { ChildIssue, Dependency, Issue } from '../../src/beads-schema.ts';

type WriteName = 'createAction' | 'update' | 'addDependency' | 'comment' | 'close';

export interface Operation {
  name: WriteName | 'show' | 'children';
  args: unknown[];
}

export interface WriteFailure {
  nth: number;
  mode: 'before' | 'after';
}

export interface FakeIssue extends Issue {
  dependencies: Dependency[];
}

export interface FakeBeads {
  client: BeadsClient;
  log: Operation[];
  issues(): FakeIssue[];
  actions(): FakeIssue[];
  dependencies(): Dependency[];
  writes(): Operation[];
  seed(issue: Omit<FakeIssue, 'dependencies'> & { dependencies?: Dependency[] }): void;
  failWrite(failure: WriteFailure): void;
}

const writeNames: ReadonlySet<string> = new Set([
  'createAction',
  'update',
  'addDependency',
  'comment',
  'close',
]);

export function createFakeBeads({ epicId }: { epicId: string }): FakeBeads {
  const store = new Map<string, FakeIssue>();
  const log: Operation[] = [];
  let failure: WriteFailure | null = null;
  let writeCount = 0;
  let sequence = 0;
  store.set(epicId, {
    id: epicId,
    title: 'Fixture mission',
    status: 'open',
    issue_type: 'epic',
    description: '',
    metadata: null,
    dependencies: [],
  });

  function copy<T>(value: T): T {
    return structuredClone(value);
  }

  function existing(id: string): FakeIssue {
    const issue = store.get(id);
    if (!issue) throw new BeadsError('BD_FAILED', { command: `show ${id}`, exitCode: 1, stderr: `no issue found: ${id}` });
    return issue;
  }

  async function write<T>(name: WriteName, args: unknown[], apply: () => T): Promise<T> {
    await Promise.resolve();
    log.push({ name, args: copy(args) });
    writeCount += 1;
    const current = failure;
    if (current && current.nth === writeCount) {
      failure = null;
      if (current.mode === 'after') apply();
      throw new BeadsError('BD_FAILED', { command: name, exitCode: 1, stderr: 'injected write failure' });
    }
    return apply();
  }

  async function read<T>(name: 'show' | 'children', args: unknown[], apply: () => T): Promise<T> {
    await Promise.resolve();
    log.push({ name, args: copy(args) });
    return apply();
  }

  const client: BeadsClient = {
    show: id => read('show', [id], () => {
      const { dependencies, ...issue } = copy(existing(id));
      return issue;
    }),
    children: epicId => read('children', [epicId], () => {
      existing(epicId);
      return [...store.values()].filter(issue => issue.parent === epicId).map(issue => copy<ChildIssue>(issue));
    }),
    createAction: (input: CreateActionInput) => write('createAction', [input], () => {
      existing(input.epicId);
      sequence += 1;
      const issue: FakeIssue = {
        id: `${input.epicId}.${sequence}`,
        title: input.title,
        status: 'open',
        issue_type: 'task',
        description: input.description,
        parent: input.epicId,
        spec_id: input.specPath,
        metadata: copy(input.metadata),
        dependencies: [],
      };
      store.set(issue.id, issue);
      const { dependencies, ...shown } = copy(issue);
      return shown;
    }),
    update: (id: string, fields: UpdateFields) => write('update', [id, fields], () => {
      const issue = existing(id);
      if (fields.title !== undefined) issue.title = fields.title;
      if (fields.description !== undefined) issue.description = fields.description;
      if (fields.status !== undefined) issue.status = fields.status;
      if (fields.metadata !== undefined) issue.metadata = copy(fields.metadata);
      const { dependencies, ...shown } = copy(issue);
      return shown;
    }),
    addDependency: ({ dependentId, prerequisiteId }) => write('addDependency', [{ dependentId, prerequisiteId }], () => {
      const issue = existing(dependentId);
      existing(prerequisiteId);
      if (issue.dependencies.some(dependency => dependency.depends_on_id === prerequisiteId)) {
        throw new BeadsError('BD_FAILED', { command: 'dep add', exitCode: 1, stderr: 'dependency already exists' });
      }
      issue.dependencies.push({
        issue_id: dependentId,
        depends_on_id: prerequisiteId,
        type: 'blocks',
        created_at: new Date(0).toISOString(),
        created_by: 'fixture',
        metadata: '{}',
      });
    }),
    comment: (id, text) => write('comment', [id, text], () => {
      existing(id);
    }),
    close: (id, reason) => write('close', [id, reason], () => {
      const issue = existing(id);
      issue.status = 'closed';
      const { dependencies, ...shown } = copy(issue);
      return shown;
    }),
  };

  return {
    client,
    log,
    issues: () => [...store.values()].map(issue => copy(issue)),
    actions: () => [...store.values()].filter(issue => issue.parent === epicId && issue.title.startsWith('[action]')).map(issue => copy(issue)),
    dependencies: () => [...store.values()].flatMap(issue => copy(issue.dependencies)),
    writes: () => log.filter(operation => writeNames.has(operation.name)),
    seed: issue => {
      store.set(issue.id, { ...copy(issue), dependencies: copy(issue.dependencies ?? []) });
    },
    failWrite: next => {
      failure = { nth: writeCount + next.nth, mode: next.mode };
    },
  };
}

const fakeBdSource = String.raw`
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const statePath = process.env.FAKE_BD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
appendFileSync(state.argvLog, JSON.stringify(process.argv.slice(2)) + '\n');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

if (process.env.BEADS_DIR !== state.beadsDir) fail('unexpected BEADS_DIR ' + process.env.BEADS_DIR);
if (state.malformed) {
  process.stdout.write('{not json');
  process.exit(0);
}
if (state.exitCode) fail('forced failure');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    json: { type: 'boolean' },
    title: { type: 'string' },
    type: { type: 'string' },
    parent: { type: 'string' },
    description: { type: 'string' },
    labels: { type: 'string' },
    'spec-id': { type: 'string' },
    metadata: { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
  },
});
if (!values.json) fail('json flag required');
const [command, ...rest] = positionals;
const save = () => writeFileSync(statePath, JSON.stringify(state));
const find = id => state.issues.find(issue => issue.id === id) ?? fail('no issue found: ' + id);
const print = value => process.stdout.write(JSON.stringify(value) + '\n');

if (command === 'show') print([find(rest[0])]);
else if (command === 'children') print(state.issues.filter(issue => issue.parent === rest[0]));
else if (command === 'create') {
  find(values.parent);
  const id = values.parent + '.' + (state.issues.length);
  state.issues.push({
    id,
    title: values.title,
    status: 'open',
    issue_type: values.type,
    description: values.description,
    parent: values.parent,
    spec_id: values['spec-id'],
    labels: values.labels.split(','),
    metadata: JSON.parse(values.metadata),
    dependencies: [],
  });
  save();
  print({ id });
} else if (command === 'update') {
  const issue = find(rest[0]);
  if (values.title !== undefined) issue.title = values.title;
  if (values.description !== undefined) issue.description = values.description;
  if (values.status !== undefined) issue.status = values.status;
  if (values.metadata !== undefined) issue.metadata = JSON.parse(values.metadata);
  save();
  print([issue]);
} else if (command === 'dep' && rest[0] === 'add') {
  const issue = find(rest[1]);
  find(rest[2]);
  issue.dependencies.push({ issue_id: rest[1], depends_on_id: rest[2], type: 'blocks', created_at: 'now', created_by: 'fake', metadata: '{}' });
  save();
  print({ status: 'added' });
} else if (command === 'comment') {
  find(rest[0]);
  state.comments.push({ id: rest[0], text: rest[1] });
  save();
  print({ id: rest[0] });
} else if (command === 'close') {
  const issue = find(rest[0]);
  if (!state.ignoreClose) issue.status = 'closed';
  save();
  print([issue]);
} else fail('unsupported command ' + command);
`;

export interface FakeBdState {
  beadsDir: string;
  argvLog: string;
  issues: Array<Record<string, unknown>>;
  comments: Array<{ id: string; text: string }>;
  malformed?: boolean;
  exitCode?: number;
  ignoreClose?: boolean;
}

export interface ExecutableFakeBd {
  transport: CommandTransport;
  commands: string[];
  state(): Promise<FakeBdState>;
  update(change: Partial<FakeBdState>): Promise<void>;
  argv(): Promise<string[][]>;
}

export async function createExecutableFakeBd({ directory, beadsDir, epicId }: {
  directory: string;
  beadsDir: string;
  epicId: string;
}): Promise<ExecutableFakeBd> {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'bd');
  await writeFile(script, `#!${process.execPath}\n${fakeBdSource}`);
  await chmod(script, 0o755);
  const statePath = join(directory, 'fake-bd-state.json');
  const argvLog = join(directory, 'fake-bd-argv.log');
  await writeFile(argvLog, '');
  const initial: FakeBdState = {
    beadsDir,
    argvLog,
    issues: [{ id: epicId, title: 'Fixture mission', status: 'open', issue_type: 'epic', metadata: null, dependencies: [] }],
    comments: [],
  };
  await writeFile(statePath, JSON.stringify(initial));
  const commands: string[] = [];
  const state = async (): Promise<FakeBdState> => JSON.parse(await readFile(statePath, 'utf8'));

  const transport: CommandTransport = {
    run: ({ command, timeout, signal }) => new Promise((resolve, reject) => {
      commands.push(command);
      const child = spawn('/bin/sh', ['-c', command], {
        env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_BD_STATE: statePath },
        timeout,
        ...(signal ? { signal } : {}),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    }),
  };

  return {
    transport,
    commands,
    state,
    update: async change => {
      await writeFile(statePath, JSON.stringify({ ...await state(), ...change }));
    },
    argv: async () => (await readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
