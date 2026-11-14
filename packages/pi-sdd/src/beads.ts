import { isAbsolute, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, type TSchema, type Static } from 'typebox';
import {
  check,
  ChildrenOutputSchema,
  CreateOutputSchema,
  IssueIdSchema,
  readSddMetadata,
  reservedSddFields,
  ShowOutputSchema,
  WriteOutputSchema,
  type ChildIssue,
  type Issue,
  type Metadata,
} from './beads-schema.ts';
import type { ProjectLock } from './project-lock.ts';

export interface CommandRequest {
  command: string;
  timeout: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandTransport {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface CreateActionInput {
  epicId: string;
  title: string;
  description: string;
  specPath: string;
  metadata: Metadata;
}

export interface UpdateFields {
  title?: string;
  description?: string;
  status?: string;
  metadata?: Metadata;
}

export interface BeadsClient {
  show(id: string): Promise<Issue>;
  children(epicId: string): Promise<ChildIssue[]>;
  createAction(input: CreateActionInput): Promise<Issue>;
  update(id: string, fields: UpdateFields): Promise<Issue>;
  addDependency(edge: { dependentId: string; prerequisiteId: string }): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  close(id: string, reason: string): Promise<Issue>;
}

export interface BeadsErrorDetails {
  command: string;
  exitCode: number;
  stderr: string;
}

export class BeadsError extends Error {
  readonly details: BeadsErrorDetails;

  constructor(code: string, details: BeadsErrorDetails) {
    super(`${code}: ${details.command} exited ${details.exitCode}: ${details.stderr.trim()}`);
    this.name = 'BeadsError';
    this.details = details;
  }
}

const forbiddenFlags = ['--db', '--directory', '-C', '--current', '--global'];

export function quoteShell(value: string): string {
  if (value.includes('\0')) throw new Error('INVALID_SHELL_ARGUMENT');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertBeadsDir(beadsDir: string): void {
  const valid = isAbsolute(beadsDir)
    && normalize(beadsDir) === beadsDir
    && beadsDir.endsWith('/.missions/.beads');
  if (!valid) throw new Error(`INVALID_BEADS_DIR: ${JSON.stringify(beadsDir)}`);
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9._\/=:,@%+-]+$/.test(value) ? value : quoteShell(value);
}

export function beadsCommand(beadsDir: string, args: string[]): string {
  assertBeadsDir(beadsDir);
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  const [subcommand] = options;
  const forbidden = subcommand === 'edit'
    || subcommand === 'init'
    || options.some(arg => forbiddenFlags.some(flag => arg === flag || arg.startsWith(`${flag}=`) || (flag === '-C' && arg.startsWith('-C'))));
  if (forbidden) throw new Error(`FORBIDDEN_BD_ARGUMENT: ${options.join(' ')}`);
  return `BEADS_DIR=${quoteShell(beadsDir)} bd ${args.map(shellArgument).join(' ')}`;
}

function assertId(id: string): string {
  if (!check(IssueIdSchema, id)) throw new Error(`INVALID_ISSUE_ID: ${JSON.stringify(id)}`);
  return id;
}

export function createBeadsClient({ transport, beadsDir, timeout = 30_000 }: {
  transport: CommandTransport;
  beadsDir: string;
  timeout?: number;
}): BeadsClient {
  assertBeadsDir(beadsDir);

  async function run<T extends TSchema>(args: string[], schema: T): Promise<Static<T>> {
    const command = beadsCommand(beadsDir, args);
    const result = await transport.run({ command, timeout });
    const details = { command, exitCode: result.exitCode, stderr: result.stderr };
    if (result.exitCode !== 0) throw new BeadsError('BD_FAILED', details);
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new BeadsError('BD_INVALID_OUTPUT', { ...details, stderr: `unparseable JSON: ${result.stderr}` });
    }
    if (!check(schema, output)) {
      throw new BeadsError('BD_INVALID_OUTPUT', { ...details, stderr: `unexpected shape: ${result.stderr}` });
    }
    return output;
  }

  async function show(id: string): Promise<Issue> {
    const [issue] = await run(['show', assertId(id), '--json'], ShowOutputSchema);
    if (!issue || issue.id !== id) throw new Error(`SHOW_ID_MISMATCH: ${id}`);
    return issue;
  }

  return {
    show,
    children: async epicId => run(['children', assertId(epicId), '--json'], ChildrenOutputSchema),
    createAction: async ({ epicId, title, description, specPath, metadata }) => {
      if (!title.startsWith('[action] ')) throw new Error('ACTION_TITLE_PREFIX');
      const output = await run([
        'create',
        `--title=${title}`,
        '--type=task',
        `--parent=${assertId(epicId)}`,
        `--description=${description}`,
        '--labels=action',
        `--spec-id=${specPath}`,
        `--metadata=${JSON.stringify(metadata)}`,
        '--json',
      ], CreateOutputSchema);
      const created = Array.isArray(output) ? output[0] : output;
      if (!created) throw new Error('CREATE_NOT_CONFIRMED');
      const issue = await show(created.id);
      if (issue.parent !== epicId) throw new Error(`CREATE_NOT_CONFIRMED: ${created.id}`);
      return issue;
    },
    update: async (id, fields) => {
      const flags = [
        ...(fields.title === undefined ? [] : [`--title=${fields.title}`]),
        ...(fields.description === undefined ? [] : [`--description=${fields.description}`]),
        ...(fields.status === undefined ? [] : [`--status=${fields.status}`]),
        ...(fields.metadata === undefined ? [] : [`--metadata=${JSON.stringify(fields.metadata)}`]),
      ];
      if (flags.length === 0) throw new Error('EMPTY_UPDATE');
      await run(['update', assertId(id), ...flags, '--json'], WriteOutputSchema);
      return show(id);
    },
    addDependency: async ({ dependentId, prerequisiteId }) => {
      await run(['dep', 'add', assertId(dependentId), assertId(prerequisiteId), '--json'], WriteOutputSchema);
    },
    comment: async (id, text) => {
      await run(['comment', assertId(id), '--json', '--', text], WriteOutputSchema);
    },
    close: async (id, reason) => {
      await run(['close', assertId(id), `--reason=${reason}`, '--json'], WriteOutputSchema);
      const issue = await show(id);
      if (issue.status !== 'closed') throw new Error(`CLOSE_NOT_CONFIRMED: ${id} is ${issue.status}`);
      return issue;
    },
  };
}

const BashOutputSchema = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  exit_code: Type.Number(),
});

const ToolResultSchema = Type.Object({
  content: Type.Optional(Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))),
  structuredContent: Type.Optional(Type.Unknown()),
});

export type ExecuteTool = (
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
) => Promise<{ isError: boolean; result: unknown }>;

export function createToolTransport(executeTool: ExecuteTool): CommandTransport {
  return {
    run: async ({ command, timeout, signal }) => {
      const marker = `__SDD_STDERR_${randomUUID()}__`;
      const wrapped = [
        'sdd_err=$(mktemp) || exit 125',
        `${command} 2>"$sdd_err"`,
        'sdd_status=$?',
        `printf '\\n%s\\n' '${marker}'`,
        'cat "$sdd_err"',
        'rm -f "$sdd_err"',
        'exit "$sdd_status"',
      ].join('\n');
      const outcome = await executeTool(
        'bash',
        { command: wrapped, timeout: Math.max(1, Math.ceil(timeout / 1000)) },
        signal ? { signal } : {},
      );
      const result = outcome.result;
      if (!check(ToolResultSchema, result)) throw new Error('BD_TOOL_FAILED: malformed tool result');
      const bash = result.structuredContent;
      const failed = !check(BashOutputSchema, bash) || (outcome.isError && bash.exit_code === 0);
      if (failed) {
        const text = (result.content ?? []).map(part => part.text ?? '').join('\n').trim();
        throw new Error(`BD_TOOL_FAILED: ${text || 'no bash result'}`);
      }
      if (bash.truncated) throw new Error('BD_OUTPUT_TRUNCATED');
      const split = bash.output.lastIndexOf(`\n${marker}\n`);
      if (split === -1) throw new Error('BD_TOOL_FAILED: missing stderr marker');
      return {
        exitCode: bash.exit_code,
        stdout: bash.output.slice(0, split),
        stderr: bash.output.slice(split + marker.length + 2).replace(/\n$/, ''),
      };
    },
  };
}

export async function mergeSddMetadata({ client, id, lock, revision, patch }: {
  client: BeadsClient;
  id: string;
  lock: ProjectLock;
  revision: string;
  patch: Metadata;
}): Promise<Issue> {
  if (!lock.held()) throw new Error('PROJECT_LOCK_NOT_HELD');
  await lock.verify();
  const reserved = Object.keys(patch).filter(key => reservedSddFields.has(key));
  if (reserved.length > 0) throw new Error(`RESERVED_SDD_FIELD: ${reserved.join(', ')}`);
  const issue = await client.show(id);
  const sdd = readSddMetadata(issue);
  if (!sdd) throw new Error(`MISSING_SDD_METADATA: ${id}`);
  if (sdd.revision !== revision) throw new Error(`RECEIPT_REVISION_MISMATCH: ${id}`);
  await lock.verify();
  return client.update(id, { metadata: { ...issue.metadata, sdd: { ...sdd, ...patch } } });
}
