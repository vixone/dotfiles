import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBeadsClient, type BeadsClient } from '../src/beads.ts';
import { materialize, readTaskStates } from '../src/materialize.ts';
import { acquireProjectLock, ProjectLockError } from '../src/project-lock.ts';
import type { SpecDescriptor, TaskDefinition } from '../src/spec-schema.ts';
import { createExecutableFakeBd, createFakeBeads, type FakeBeads } from './helpers/fake-bd.ts';
import { makeSpec } from './helpers/spec.ts';

const missionId = 'mission-fixture';
const fixtureTask = makeSpec().tasks[0];
if (!fixtureTask) throw new Error('Fixture task missing');
const base: TaskDefinition = fixtureTask;

function chain(): SpecDescriptor {
  return makeSpec({
    tasks: [
      { ...base, key: 'core' },
      { ...base, key: 'api', title: 'Build api', dependsOn: ['core'] },
      { ...base, key: 'docs', title: 'Write docs', kind: 'doc', dependsOn: ['core', 'api'] },
    ],
  });
}

async function project(t: TestContext, spec: SpecDescriptor = makeSpec(), prefix = 'pi-sdd-materialize-') {
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, '.git'));
  const specDir = join(projectRoot, '.start', 'specs', `${spec.specId}-${spec.slug}`);
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'requirements.md'), 'Return a greeting.');
  await writeFile(join(specDir, 'solution.md'), 'Add src/core.ts and verify the greeting.\nRun: npm test');
  await writeFile(join(specDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  return { projectRoot, specDir, spec };
}

async function diskSpec(specDir: string): Promise<SpecDescriptor> {
  return JSON.parse(await readFile(join(specDir, 'spec.json'), 'utf8'));
}

function assertNoClose(fake: FakeBeads): void {
  assert.equal(fake.writes().filter(write => write.name === 'close').length, 0);
  assert.ok(fake.issues().every(issue => issue.status !== 'closed'));
}

function sddOf(issue: { metadata?: unknown }): Record<string, unknown> {
  const metadata = issue.metadata;
  if (typeof metadata !== 'object' || metadata === null || !('sdd' in metadata)) return {};
  const value = metadata.sdd;
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

test('two materializations yield one graph and a stable binding', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  const options = { projectRoot, spec: makeSpec(), missionId };
  const first = await materialize({ ...options, client: fake.client });
  const second = await materialize({ ...options, client: fake.client });
  assert.equal(first.createdIds.length, 1);
  assert.equal(second.createdIds.length, 0);
  assert.deepEqual(second.reusedIds, first.createdIds);
  assert.deepEqual(second.spec.binding, first.spec.binding);
  assert.equal(fake.actions().length, 1);
  assert.deepEqual((await diskSpec(specDir)).binding, first.spec.binding);
  assert.equal(first.spec.binding?.missionId, missionId);
  assertNoClose(fake);
});

test('action children carry stable sdd metadata, the brief and real test commands', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  const [action] = fake.actions();
  assert.ok(action);
  assert.equal(action.title, '[action] Build core');
  assert.equal(action.parent, missionId);
  assert.match(action.description ?? '', /Run: npm test/);
  assert.match(action.description ?? '', /src\/core\.ts/);
  const metadata = sddOf(action);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.taskKey, 'core');
  assert.equal(metadata.specPath, await realpath(specDir));
  assert.match(String(metadata.revision), /^[0-9a-f]{64}$/);
});

test('factory descriptions never include holdout scenario bodies', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const spec = makeSpec({ tier: 'factory', tasks: [{ ...base, scenarios: ['scenarios/greet.md'] }] });
  const { projectRoot, specDir } = await project(t, spec);
  await mkdir(join(specDir, 'scenarios'));
  await writeFile(join(specDir, 'scenarios', 'greet.md'), 'HOLDOUT expects exact greeting');
  await materialize({ projectRoot, spec, missionId, client: fake.client });
  assert.doesNotMatch(fake.actions()[0]?.description ?? '', /HOLDOUT/);
});

test('dependencies are wired once and retries do not duplicate them', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t, chain());
  const first = await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  const ids = first.spec.binding?.taskIds ?? {};
  const edges = fake.dependencies().map(edge => `${edge.issue_id}->${edge.depends_on_id}`).sort();
  assert.deepEqual(edges, [`${ids.api}->${ids.core}`, `${ids.docs}->${ids.api}`, `${ids.docs}->${ids.core}`].sort());
  const before = fake.writes().length;
  await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  assert.equal(fake.writes().length, before);
});

test('a create failure leaves no binding and retry recovers the first created task', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t, chain());
  fake.failWrite({ nth: 2, mode: 'before' });
  await assert.rejects(materialize({ projectRoot, spec: chain(), missionId, client: fake.client }), /BD_FAILED/);
  assert.equal((await diskSpec(specDir)).binding, null);
  assert.equal(fake.actions().length, 1);
  const retry = await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  assert.equal(retry.reusedIds.length, 1);
  assert.equal(retry.createdIds.length, 2);
  assert.equal(fake.actions().length, 3);
  assert.deepEqual((await diskSpec(specDir)).binding, retry.spec.binding);
  assertNoClose(fake);
});

test('a create applied but reported failed is reused instead of duplicated', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  fake.failWrite({ nth: 1, mode: 'after' });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), /BD_FAILED/);
  assert.equal((await diskSpec(specDir)).binding, null);
  const retry = await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  assert.equal(retry.createdIds.length, 0);
  assert.equal(retry.reusedIds.length, 1);
  assert.equal(fake.actions().length, 1);
});

test('a dependency failure blocks binding and retry completes the wiring', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t, chain());
  fake.failWrite({ nth: 5, mode: 'before' });
  await assert.rejects(materialize({ projectRoot, spec: chain(), missionId, client: fake.client }), /BD_FAILED/);
  assert.equal((await diskSpec(specDir)).binding, null);
  assert.equal(fake.actions().length, 3);
  const retry = await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  assert.equal(retry.createdIds.length, 0);
  assert.equal(fake.dependencies().length, 3);
  assertNoClose(fake);
});

test('an applied dependency reported failed is not re-added', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t, chain());
  fake.failWrite({ nth: 4, mode: 'after' });
  await assert.rejects(materialize({ projectRoot, spec: chain(), missionId, client: fake.client }), /BD_FAILED/);
  await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  assert.equal(fake.dependencies().length, 3);
});

test('duplicate stable keys stop with the conflicting ids and no writes', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  const [existing] = fake.actions();
  assert.ok(existing);
  fake.seed({ ...existing, id: `${missionId}.99`, status: 'in_progress' });
  await writeFile(join(specDir, 'spec.json'), JSON.stringify(makeSpec()));
  const writes = fake.writes().length;
  await assert.rejects(
    materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }),
    (error: Error) => {
      assert.match(error.message, /DUPLICATE_TASK_KEY/);
      assert.match(error.message, new RegExp(`${existing.id}.*${missionId}\\.99`));
      return true;
    },
  );
  assert.equal(fake.writes().length, writes);
  assert.equal((await diskSpec(specDir)).binding, null);
});

test('matching ignores titles without stable metadata', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  fake.seed({ id: `${missionId}.50`, title: '[action] Build core', status: 'open', issue_type: 'task', parent: missionId, metadata: { owner: 'x' } });
  const { projectRoot } = await project(t);
  const result = await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  assert.equal(result.createdIds.length, 1);
  assert.notEqual(result.createdIds[0], `${missionId}.50`);
});

test('malformed sdd metadata on a child is refused instead of guessed', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  fake.seed({ id: `${missionId}.50`, title: '[action] X', status: 'open', issue_type: 'task', parent: missionId, metadata: { sdd: { schemaVersion: 9 } } });
  const { projectRoot } = await project(t);
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), /INVALID_SDD_METADATA: mission-fixture\.50/);
  assert.equal(fake.writes().length, 0);
});

test('missing, non-epic and closed missions are refused without writes', async t => {
  const { projectRoot, specDir } = await project(t);
  const missing = createFakeBeads({ epicId: missionId });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId: 'mission-gone', client: missing.client }), /BD_FAILED/);
  const notEpic = createFakeBeads({ epicId: missionId });
  notEpic.seed({ id: missionId, title: 'task', status: 'open', issue_type: 'task' });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: notEpic.client }), /MISSION_NOT_EPIC/);
  const closed = createFakeBeads({ epicId: missionId });
  closed.seed({ id: missionId, title: 'done', status: 'closed', issue_type: 'epic' });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: closed.client }), /MISSION_CLOSED/);
  for (const fake of [missing, notEpic, closed]) assert.equal(fake.writes().length, 0);
  assert.equal((await diskSpec(specDir)).binding, null);
});

test('a conflicting existing binding is refused', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const bound = makeSpec({ binding: { missionId: 'mission-other', taskIds: { core: 'mission-other.1' } } });
  const { projectRoot, specDir } = await project(t, bound);
  await assert.rejects(materialize({ projectRoot, spec: bound, missionId, client: fake.client }), /BINDING_CONFLICT/);
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), /BINDING_CONFLICT/);
  assert.equal(fake.writes().length, 0);
  assert.deepEqual((await diskSpec(specDir)).binding, bound.binding);
});

test('a binding to a task that no longer matches is refused', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const bound = makeSpec({ binding: { missionId, taskIds: { core: `${missionId}.77` } } });
  const { projectRoot } = await project(t, bound);
  await assert.rejects(materialize({ projectRoot, spec: bound, missionId, client: fake.client }), /BOUND_TASK_MISSING/);
  assert.equal(fake.writes().length, 0);
});

test('stale caller data or a missing descriptor is refused', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  await assert.rejects(
    materialize({ projectRoot, spec: makeSpec({ tasks: [{ ...base, title: 'Changed' }] }), missionId, client: fake.client }),
    /STALE_SPEC/,
  );
  await rm(join(specDir, 'spec.json'));
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), /SPEC_IDENTITY_MISMATCH|SPEC_NOT_FOUND/);
  assert.equal(fake.writes().length, 0);
});

test('an unselected tier cannot be materialized', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const spec = makeSpec({ tier: 'unselected', tasks: [] });
  const { projectRoot } = await project(t, spec);
  await assert.rejects(materialize({ projectRoot, spec, missionId, client: fake.client }), /TIER_UNSELECTED/);
});

test('a changed revision updates reused metadata without clobbering unrelated keys', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  const first = await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  const id = first.createdIds[0] ?? '';
  const [action] = fake.actions();
  assert.ok(action);
  fake.seed({ ...action, status: 'in_progress', metadata: { owner: 'team', sdd: { ...sddOf(action), approval: { revision: sddOf(action).revision } } } });
  const oldRevision = sddOf(action).revision;
  await writeFile(join(specDir, 'solution.md'), 'Changed solution.');
  const second = await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  assert.deepEqual(second.reusedIds, [id]);
  const [updated] = fake.actions();
  assert.ok(updated);
  assert.equal(updated.status, 'in_progress');
  assert.equal((updated.metadata as Record<string, unknown>).owner, 'team');
  assert.notEqual(sddOf(updated).revision, oldRevision);
  assert.deepEqual(sddOf(updated).approval, { revision: oldRevision });
  assert.match(updated.description ?? '', /Changed solution/);
});

test('the same spec id in different repositories gets distinct tasks', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const one = await project(t);
  const two = await project(t);
  const first = await materialize({ projectRoot: one.projectRoot, spec: makeSpec(), missionId, client: fake.client });
  const second = await materialize({ projectRoot: two.projectRoot, spec: makeSpec(), missionId, client: fake.client });
  assert.equal(second.createdIds.length, 1);
  assert.notDeepEqual(first.createdIds, second.createdIds);
  assert.equal(fake.actions().length, 2);
});

test('materialize from a subdirectory reuses the repository-root identity', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t);
  const sub = join(projectRoot, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
  const again = await materialize({ projectRoot: sub, spec: makeSpec(), missionId, client: fake.client });
  assert.equal(again.createdIds.length, 0);
});

test('two concurrent materializations produce one graph and one owner-aware refusal', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t, chain());
  const results = await Promise.allSettled([
    materialize({ projectRoot, spec: chain(), missionId, client: fake.client, sessionId: 'session-a' }),
    materialize({ projectRoot, spec: chain(), missionId, client: fake.client, sessionId: 'session-b' }),
  ]);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  const reason: unknown = rejected[0]?.status === 'rejected' ? rejected[0].reason : null;
  assert.ok(reason instanceof ProjectLockError);
  assert.ok(['session-a', 'session-b'].includes(reason.owner?.sessionId ?? ''));
  assert.equal(reason.owner?.pid, process.pid);
  assert.equal(fake.actions().length, 3);
});

test('a held lock is reported with owner details and never stolen', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t);
  const lock = await acquireProjectLock({ projectRoot, sessionId: 'other-session' });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), (error: unknown) => {
    assert.ok(error instanceof ProjectLockError);
    assert.match(error.message, /PROJECT_LOCKED.*other-session/);
    return true;
  });
  assert.ok(lock.held());
  assert.equal(fake.log.length, 0);
  await lock.release();
  await materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client });
});

test('a lock with unreadable owner evidence still fails explicitly', async t => {
  const { projectRoot } = await project(t);
  await mkdir(join(projectRoot, '.pi', 'sdd', 'locks', 'project.lock'), { recursive: true });
  await assert.rejects(acquireProjectLock({ projectRoot }), (error: unknown) => {
    assert.ok(error instanceof ProjectLockError);
    assert.equal(error.owner, null);
    return true;
  });
  assert.ok((await stat(join(projectRoot, '.pi', 'sdd', 'locks', 'project.lock'))).isDirectory());
});

test('releasing a lock replaced by another owner fails instead of deleting it', async t => {
  const { projectRoot } = await project(t);
  const lock = await acquireProjectLock({ projectRoot, sessionId: 'a' });
  const ownerFile = join(projectRoot, '.pi', 'sdd', 'locks', 'project.lock');
  const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  await writeFile(ownerFile, JSON.stringify({ ...owner, token: 'someone-else' }));
  await assert.rejects(lock.release(), /PROJECT_LOCK_OWNER_CHANGED/);
  assert.ok((await stat(ownerFile)).isFile());
});

test('read-only task states report beads status without writes', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t, chain());
  const result = await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  await fake.client.update(result.spec.binding?.taskIds.core ?? '', { status: 'in_progress' });
  const writes = fake.writes().length;
  const states = await readTaskStates({ client: fake.client, projectRoot, spec: result.spec });
  assert.deepEqual(states, { core: 'in_progress', api: 'open', docs: 'open' });
  assert.equal(fake.writes().length, writes);
  await assert.rejects(readTaskStates({ client: fake.client, projectRoot, spec: chain() }), /SPEC_NOT_BOUND/);
});

test('end to end through an executable fake bd with spaces and quotes in the path', async t => {
  const { projectRoot, specDir } = await project(t, chain(), "pi-sdd it's spaced ");
  const directory = await mkdtemp(join(tmpdir(), 'pi-sdd-fake-bd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const beadsDir = join(directory, 'home', '.missions', '.beads');
  const fake = await createExecutableFakeBd({ directory, beadsDir, epicId: missionId });
  const client = createBeadsClient({ transport: fake.transport, beadsDir });
  const first = await materialize({ projectRoot, spec: chain(), missionId, client });
  const second = await materialize({ projectRoot, spec: chain(), missionId, client });
  assert.equal(first.createdIds.length, 3);
  assert.equal(second.createdIds.length, 0);
  assert.deepEqual((await diskSpec(specDir)).binding, first.spec.binding);
  const created = (await fake.argv()).filter(argv => argv[0] === 'create');
  assert.equal(created.length, 3);
  const specPath = await realpath(specDir);
  assert.ok(created.every(argv => argv.includes(`--spec-id=${specPath}`)));
  assert.ok((await fake.state()).issues.every(issue => issue.status === 'open'));
});

async function assertNoOutsideWrites(outside: string): Promise<void> {
  assert.deepEqual(await readdir(outside), []);
}

test('a lock directory symlinked outside the repository is refused without outside writes', async t => {
  const { projectRoot } = await project(t);
  const outside = await mkdtemp(join(tmpdir(), 'pi-sdd-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(projectRoot, '.pi', 'sdd'), { recursive: true });
  await symlink(outside, join(projectRoot, '.pi', 'sdd', 'locks'));
  await assert.rejects(acquireProjectLock({ projectRoot }), /PROJECT_LOCK_PATH_ESCAPES/);
  await assertNoOutsideWrites(outside);
});

test('a lock ancestor symlinked outside the repository is refused without outside writes', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot } = await project(t);
  const outside = await mkdtemp(join(tmpdir(), 'pi-sdd-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(projectRoot, '.pi'));
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client: fake.client }), /PROJECT_LOCK_PATH_ESCAPES/);
  await assertNoOutsideWrites(outside);
  assert.equal(fake.log.length, 0);
});

function editDuringCreate(fake: FakeBeads, edit: () => Promise<void>): BeadsClient {
  return {
    ...fake.client,
    createAction: async input => {
      const created = await fake.client.createAction(input);
      await edit();
      return created;
    },
  };
}

test('a static spec edit during materialize leaves the binding untouched and tasks discoverable', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t, chain());
  const edited = chain();
  edited.tasks[0] = { ...base, key: 'core', title: 'Build core again' };
  const client = editDuringCreate(fake, () => writeFile(join(specDir, 'spec.json'), JSON.stringify(edited, null, 2) + '\n'));
  await assert.rejects(materialize({ projectRoot, spec: chain(), missionId, client }), /STALE_SPEC/);
  assert.equal((await diskSpec(specDir)).binding, null);
  assert.ok(fake.actions().length > 0);
  const retry = await materialize({ projectRoot, spec: await diskSpec(specDir), missionId, client: fake.client });
  assert.equal(retry.createdIds.length + retry.reusedIds.length, 3);
  assert.ok(retry.reusedIds.length > 0);
  assert.equal(fake.actions().length, 3);
  assertNoClose(fake);
});

test('a document edit during materialize leaves the binding untouched and tasks discoverable', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t, chain());
  const client = editDuringCreate(fake, () => writeFile(join(specDir, 'solution.md'), 'Edited mid materialize.'));
  await assert.rejects(materialize({ projectRoot, spec: chain(), missionId, client }), /SPEC_CHANGED_DURING_MATERIALIZE/);
  assert.equal((await diskSpec(specDir)).binding, null);
  assert.equal(fake.actions().length, 3);
  const retry = await materialize({ projectRoot, spec: chain(), missionId, client: fake.client });
  assert.equal(retry.createdIds.length, 0);
  assert.equal(retry.reusedIds.length, 3);
  assertNoClose(fake);
});

test('a binding edit during materialize is not overwritten', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  const foreign = { missionId: 'mission-other', taskIds: { core: 'mission-other.1' } };
  const client = editDuringCreate(fake, async () => {
    await writeFile(join(specDir, 'spec.json'), JSON.stringify(makeSpec({ binding: foreign }), null, 2) + '\n');
  });
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client }), /BINDING_CHANGED_DURING_MATERIALIZE/);
  assert.deepEqual((await diskSpec(specDir)).binding, foreign);
  assert.equal(fake.actions().length, 1);
  assertNoClose(fake);
});

test('rows with matching metadata but the wrong parent, type or title prefix are refused', async t => {
  const { projectRoot, specDir } = await project(t);
  const specPath = await realpath(specDir);
  const revision = 'a'.repeat(64);
  const sdd = { schemaVersion: 1, specPath, taskKey: 'core', revision };
  const valid = { id: `${missionId}.40`, title: '[action] Build core', status: 'open', issue_type: 'task', parent: missionId, metadata: { sdd } };
  const mismatches = [
    { ...valid, parent: 'mission-other' },
    { ...valid, issue_type: 'decision' },
    { ...valid, title: '[finding] Build core', status: 'closed' },
  ];
  for (const row of mismatches) {
    const fake = createFakeBeads({ epicId: missionId });
    const client: BeadsClient = { ...fake.client, children: async id => [...await fake.client.children(id), row] };
    await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client }), /TASK_IDENTITY_MISMATCH: mission-fixture\.40/);
    assert.equal(fake.writes().length, 0);
  }
  assert.equal((await diskSpec(specDir)).binding, null);
});

test('a created row with the wrong identity is refused before binding', async t => {
  const fake = createFakeBeads({ epicId: missionId });
  const { projectRoot, specDir } = await project(t);
  const client: BeadsClient = {
    ...fake.client,
    createAction: async input => ({ ...await fake.client.createAction(input), issue_type: 'bug' }),
  };
  await assert.rejects(materialize({ projectRoot, spec: makeSpec(), missionId, client }), /TASK_IDENTITY_MISMATCH/);
  assert.equal((await diskSpec(specDir)).binding, null);
});
