import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beadsCommand,
  createBeadsClient,
  createToolTransport,
  mergeSddMetadata,
  quoteShell,
  type CommandTransport,
} from '../src/beads.ts';
import { acquireProjectLock } from '../src/project-lock.ts';
import { createExecutableFakeBd, createFakeBeads } from './helpers/fake-bd.ts';

const epicId = 'mission-fixture';
const revision = 'a'.repeat(64);

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sdd-beads '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function executable(t: TestContext) {
  const directory = await temporary(t);
  const beadsDir = join(directory, 'home', '.missions', '.beads');
  const fake = await createExecutableFakeBd({ directory, beadsDir, epicId });
  return { directory, beadsDir, fake, client: createBeadsClient({ transport: fake.transport, beadsDir }) };
}

function sdd(specPath: string, taskKey = 'core') {
  return { schemaVersion: 1, specPath, taskKey, revision };
}

test('shell quoting preserves apostrophes, newlines and substitutions literally', async t => {
  const { client, fake } = await executable(t);
  const title = `[action] Bob's "task" $(touch pwned) \`id\``;
  const description = `line one\nit's line two\n'quoted' \\ end`;
  const created = await client.createAction({
    epicId,
    title,
    description,
    specPath: "/tmp/it's spaced/.start/specs/001-sample",
    metadata: { sdd: sdd('/x') },
  });
  assert.equal(created.title, title);
  assert.equal(created.description, description);
  assert.equal(quoteShell("it's"), `'it'\\''s'`);
  await client.comment(created.id, "--not-a-flag\nBob's note");
  assert.deepEqual((await fake.state()).comments, [{ id: created.id, text: "--not-a-flag\nBob's note" }]);
});

test('every command sets the explicit global BEADS_DIR and stays literal bd', async t => {
  const { client, fake, beadsDir } = await executable(t);
  await client.show(epicId);
  await client.children(epicId);
  const created = await client.createAction({ epicId, title: '[action] A', description: 'd', specPath: '/s', metadata: {} });
  await client.update(created.id, { status: 'in_progress' });
  await client.addDependency({ dependentId: created.id, prerequisiteId: epicId });
  await client.close(created.id, 'done');
  assert.equal(fake.commands.length, 9);
  for (const command of fake.commands) {
    assert.ok(command.startsWith(`BEADS_DIR=${quoteShell(beadsDir)} bd `), command);
    assert.doesNotMatch(command, /\bbd (edit|init)\b|--current|--db|--directory|(^| )-C /);
  }
  assert.match(fake.commands[2] ?? '', / bd create /);
});

test('wrong or project-local BEADS_DIR is refused before any command', async t => {
  const transport: CommandTransport = {
    run: async () => assert.fail('transport must not run'),
  };
  for (const beadsDir of ['', 'relative/.missions/.beads', '/repo/.beads', '/home/u/.missions/../.beads', '/home/u/.missions/.beads/']) {
    assert.throws(() => createBeadsClient({ transport, beadsDir }), /INVALID_BEADS_DIR/, beadsDir);
  }
  const { fake, directory } = await executable(t);
  const mismatched = createBeadsClient({ transport: fake.transport, beadsDir: join(directory, 'other', '.missions', '.beads') });
  await assert.rejects(mismatched.show(epicId), (error: Error & { details?: { stderr: string } }) => {
    assert.match(error.message, /BD_FAILED/);
    assert.match(error.details?.stderr ?? '', /unexpected BEADS_DIR/);
    return true;
  });
});

test('forbidden bd subcommands and global overrides are rejected', () => {
  const dir = '/home/u/.missions/.beads';
  for (const args of [['edit', 'x'], ['init'], ['show', '--current'], ['show', 'x', '--db', '/tmp/db'], ['show', 'x', '--db=/tmp'], ['-C', '/tmp', 'show'], ['show', '--directory=/tmp']]) {
    assert.throws(() => beadsCommand(dir, args), /FORBIDDEN_BD_ARGUMENT/, args.join(' '));
  }
});

test('issue ids that look like flags are refused', async t => {
  const { client, fake } = await executable(t);
  await assert.rejects(client.show('--db=/tmp/x'), /INVALID_ISSUE_ID/);
  await assert.rejects(client.close("x' ; rm -rf ~ ; '", 'r'), /INVALID_ISSUE_ID/);
  assert.equal(fake.commands.length, 0);
});

test('nonzero bd results preserve exit code and stderr', async t => {
  const { client, fake } = await executable(t);
  await fake.update({ exitCode: 3 });
  await assert.rejects(client.show(epicId), (error: Error & { details?: { exitCode: number; stderr: string } }) => {
    assert.match(error.message, /BD_FAILED/);
    assert.equal(error.details?.exitCode, 1);
    assert.match(error.details?.stderr ?? '', /forced failure/);
    return true;
  });
  await assert.rejects(client.show('missing-1'), /BD_FAILED/);
});

test('malformed JSON output is a validation failure', async t => {
  const { client, fake } = await executable(t);
  await fake.update({ malformed: true });
  await assert.rejects(client.show(epicId), /BD_INVALID_OUTPUT/);
  await assert.rejects(client.children(epicId), /BD_INVALID_OUTPUT/);
});

test('schema-invalid rows are rejected at the boundary', async t => {
  const { client, fake } = await executable(t);
  await fake.update({ issues: [{ id: epicId, title: 'no status', issue_type: 'epic' }] });
  await assert.rejects(client.show(epicId), /BD_INVALID_OUTPUT/);
  await fake.update({
    issues: [
      { id: epicId, title: 'm', status: 'open', issue_type: 'epic' },
      { id: `${epicId}.1`, title: 'c', status: 'open', issue_type: 'task', parent: epicId, dependencies: [{ issue_id: 1 }] },
    ],
  });
  await assert.rejects(client.children(epicId), /BD_INVALID_OUTPUT/);
});

test('children accept the real shape with omitted or null metadata', async t => {
  const { client, fake } = await executable(t);
  await fake.update({
    issues: [
      { id: epicId, title: 'm', status: 'open', issue_type: 'epic' },
      { id: `${epicId}.1`, title: 'a', status: 'open', issue_type: 'task', parent: epicId, spec_id: null, metadata: null },
      {
        id: `${epicId}.2`,
        title: 'b',
        status: 'closed',
        issue_type: 'task',
        parent: epicId,
        dependencies: [{ issue_id: `${epicId}.2`, depends_on_id: `${epicId}.1`, type: 'blocks', created_at: 't', created_by: 'u', metadata: '{}' }],
      },
    ],
  });
  const rows = await client.children(epicId);
  assert.deepEqual(rows.map(row => row.id), [`${epicId}.1`, `${epicId}.2`]);
  assert.equal(rows[1]?.dependencies?.[0]?.depends_on_id, `${epicId}.1`);
});

test('close is confirmed by a fresh show, never assumed', async t => {
  const { client, fake } = await executable(t);
  const created = await client.createAction({ epicId, title: '[action] A', description: 'd', specPath: '/s', metadata: {} });
  await fake.update({ ignoreClose: true });
  await assert.rejects(client.close(created.id, 'done'), /CLOSE_NOT_CONFIRMED/);
  await fake.update({ ignoreClose: false });
  assert.equal((await client.close(created.id, 'done')).status, 'closed');
});

test('tool transport runs nested bash and separates stdout, stderr and exit code', async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const transport = createToolTransport(async (name, args) => {
    calls.push({ name, args });
    const command = typeof args === 'object' && args !== null && 'command' in args ? String(args.command) : '';
    const marker = /printf '\\n%s\\n' '([^']+)'/.exec(command)?.[1] ?? '';
    return {
      isError: true,
      result: {
        content: [{ type: 'text', text: 'ignored' }],
        structuredContent: { output: `[{"id":"x"}]\n${marker}\nwarning text\n`, truncated: false, exit_code: 2, wall_time_seconds: 0.1 },
      },
    };
  });
  const result = await transport.run({ command: "BEADS_DIR='/h/.missions/.beads' bd show 'x' --json", timeout: 1500 });
  assert.deepEqual(result, { exitCode: 2, stdout: '[{"id":"x"}]', stderr: 'warning text' });
  assert.equal(calls[0]?.name, 'bash');
  assert.match(String((calls[0]?.args as { command: string }).command), /BEADS_DIR='\/h\/\.missions\/\.beads' bd show 'x' --json/);
  assert.equal((calls[0]?.args as { timeout: number }).timeout, 2);
});

test('tool transport fails on blocked calls and truncated output', async () => {
  const blocked = createToolTransport(async () => ({ isError: true, result: { content: [{ type: 'text', text: 'blocked by guard' }] } }));
  await assert.rejects(blocked.run({ command: 'bd show x --json', timeout: 1000 }), /BD_TOOL_FAILED: blocked by guard/);
  const truncated = createToolTransport(async () => ({
    isError: false,
    result: { content: [], structuredContent: { output: 'x', truncated: true, exit_code: 0, wall_time_seconds: 0 } },
  }));
  await assert.rejects(truncated.run({ command: 'bd show x --json', timeout: 1000 }), /BD_OUTPUT_TRUNCATED/);
});

test('receipt metadata merge preserves unrelated metadata and requires the project lock', async t => {
  const root = await temporary(t);
  const fake = createFakeBeads({ epicId });
  const created = await fake.client.createAction({
    epicId,
    title: '[action] A',
    description: 'd',
    specPath: '/s',
    metadata: { owner: 'team', sdd: { ...sdd('/s'), note: 'kept' } },
  });
  const lock = await acquireProjectLock({ projectRoot: root, sessionId: 'session-a' });
  const merged = await mergeSddMetadata({ client: fake.client, id: created.id, lock, revision, patch: { approval: { by: 'user' } } });
  assert.deepEqual(merged.metadata, { owner: 'team', sdd: { ...sdd('/s'), note: 'kept', approval: { by: 'user' } } });
  await assert.rejects(
    mergeSddMetadata({ client: fake.client, id: created.id, lock, revision: 'b'.repeat(64), patch: { approval: {} } }),
    /RECEIPT_REVISION_MISMATCH/,
  );
  await assert.rejects(
    mergeSddMetadata({ client: fake.client, id: created.id, lock, revision, patch: { schemaVersion: 2 } }),
    /RESERVED_SDD_FIELD/,
  );
  await lock.release();
  await assert.rejects(
    mergeSddMetadata({ client: fake.client, id: created.id, lock, revision, patch: { approval: {} } }),
    /PROJECT_LOCK_NOT_HELD/,
  );
  assert.equal(fake.writes().length, 2);
});

test('tool transport refuses a host error that reports exit code zero', async () => {
  const transport = createToolTransport(async (_name, args) => {
    const command = typeof args === 'object' && args !== null && 'command' in args ? String(args.command) : '';
    const marker = /printf '\\n%s\\n' '([^']+)'/.exec(command)?.[1] ?? '';
    return {
      isError: true,
      result: { content: [{ type: 'text', text: 'blocked by guard' }], structuredContent: { output: `[]\n${marker}\n`, truncated: false, exit_code: 0 } },
    };
  });
  await assert.rejects(
    transport.run({ command: "BEADS_DIR='/home/u/.missions/.beads' bd show mission-fixture --json", timeout: 1000 }),
    /BD_TOOL_FAILED: blocked by guard/,
  );
});

test('a host error with a nonzero bash exit stays a failed bd result', async () => {
  const transport = createToolTransport(async (_name, args) => {
    const command = typeof args === 'object' && args !== null && 'command' in args ? String(args.command) : '';
    const marker = /printf '\\n%s\\n' '([^']+)'/.exec(command)?.[1] ?? '';
    return {
      isError: true,
      result: { content: [], structuredContent: { output: `[]\n${marker}\nno issue found\n`, truncated: false, exit_code: 1 } },
    };
  });
  const client = createBeadsClient({ transport, beadsDir: '/home/u/.missions/.beads' });
  await assert.rejects(client.show(epicId), (error: Error & { details?: { exitCode: number; stderr: string } }) => {
    assert.match(error.message, /BD_FAILED/);
    assert.equal(error.details?.exitCode, 1);
    assert.equal(error.details?.stderr, 'no issue found');
    return true;
  });
});

test('receipt merge refuses when the lock owner file was replaced or removed', async t => {
  const root = await temporary(t);
  const fake = createFakeBeads({ epicId });
  const created = await fake.client.createAction({
    epicId,
    title: '[action] A',
    description: 'd',
    specPath: '/s',
    metadata: { sdd: sdd('/s') },
  });
  const ownerFile = join(root, '.pi', 'sdd', 'locks', 'project.lock');
  const writes = fake.writes().length;

  const replaced = await acquireProjectLock({ projectRoot: root, sessionId: 'a' });
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  await writeFile(ownerFile, JSON.stringify({ ...owner, token: 'someone-else' }));
  await assert.rejects(
    mergeSddMetadata({ client: fake.client, id: created.id, lock: replaced, revision, patch: { approval: {} } }),
    /PROJECT_LOCK_OWNER_CHANGED/,
  );
  await rm(ownerFile);

  const removed = await acquireProjectLock({ projectRoot: root, sessionId: 'b' });
  await rm(ownerFile);
  await assert.rejects(
    mergeSddMetadata({ client: fake.client, id: created.id, lock: removed, revision, patch: { approval: {} } }),
    /PROJECT_LOCK_OWNER_CHANGED/,
  );
  assert.equal(fake.writes().length, writes);
});
