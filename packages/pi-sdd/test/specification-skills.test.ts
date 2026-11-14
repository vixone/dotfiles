import { test } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lintContent, parseSkillFrontmatter } from '../src/content-lint.ts';
import { classify } from '../src/classifier.ts';
import { parseSpec } from '../src/spec-schema.ts';
import { createSpec, contentRevision } from '../src/spec-store.ts';
import { materialize } from '../src/materialize.ts';
import { createFakeBeads } from './helpers/fake-bd.ts';

const names = ['specify', 'specify-meta', 'specify-requirements', 'specify-solution', 'specify-incremental', 'specify-factory'];
for (const name of names) {
  test(name + ' is an explicit pi skill with valid content and links', async () => {
    const path = new URL('../skills/sdd-' + name + '/SKILL.md', import.meta.url).pathname;
    const text = await readFile(path, 'utf8');
    const frontmatter = parseSkillFrontmatter(text);
    assert.equal(frontmatter.name, 'sdd-' + name);
    assert.equal(frontmatter['disable-model-invocation'], true);
    assert.ok(frontmatter.description.length > 0 && frontmatter.description.length <= 1024);
    assert.ok(Buffer.byteLength(text) < 25 * 1024);
    assert.doesNotMatch(text, /TeamCreate|SendMessage|TodoWrite|team:the-|\$ARGUMENTS|\/start:|Agent Team|user-invocable:/);
    assert.deepEqual(await lintContent({ path, skillName: 'sdd-' + name }), []);
  });
}
async function markdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? markdown(join(dir, e.name)) : Promise.resolve(e.name.endsWith('.md') ? [join(dir, e.name)] : [])))).flat();
}
test('all supporting instructions have resolved links and no mutable execution checklists', async () => {
  for (const name of names) for (const path of await markdown(new URL('../skills/sdd-' + name, import.meta.url).pathname)) {
    assert.deepEqual(await lintContent({ path }), [], path);
    assert.doesNotMatch(await readFile(path, 'utf8'), /- \[[ x]\]|^status:/m, path);
  }
});
test('every mapped specification source has an existing adapted destination', async () => {
  const schema = Type.Object({ files: Type.Array(Type.Object({ path: Type.String(), disposition: Type.String(), targets: Type.Array(Type.String()), actions: Type.Array(Type.String()) })) });
  const inventory: unknown = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  assert.ok(Value.Check(schema, inventory));
  const map = await readFile(new URL('../docs/port-map.md', import.meta.url), 'utf8');
  for (const source of inventory.files.filter(file => file.actions.includes('mission-b7h.15'))) {
    assert.ok(['adapt', 'test-fixture', 'omit'].includes(source.disposition));
    for (const target of source.targets) {
      assert.ok((await stat(new URL('../' + target, import.meta.url))).isFile(), target);
      assert.ok(map.split('\n').some(row => row.includes('`' + source.path + '`') && row.includes('`' + target + '`')), source.path);
    }
  }
});
test('lint rejects malformed frontmatter, oversized files, forbidden tokens, and dangling links', async t => {
  const dir = await mkdtemp('/tmp/sdd-content-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'SKILL.md');
  await writeFile(path, '---\nname: wrong\ndescription: ""\ndisable-model-invocation: false\n---\nTeamCreate [missing](missing.md)\n' + 'x'.repeat(26 * 1024));
  const issues = await lintContent({ path, skillName: 'sdd-specify' });
  for (const code of ['FRONTMATTER', 'SIZE', 'FORBIDDEN_TOKEN', 'LINK']) assert.ok(issues.some(i => i.code === code), code);
  assert.throws(() => parseSkillFrontmatter('no header'), /FRONTMATTER/);
});
test('fixture brief proceeds through documents and tier selection to one resumable beads graph', async t => {
  const root = await mkdtemp('/tmp/sdd-specification-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  const created = await createSpec({ projectRoot: root, name: 'Greeting' });
  const fixture = new URL('fixtures/specification/direct/', import.meta.url);
  const requirements = await readFile(new URL('requirements.md', fixture), 'utf8');
  const solution = await readFile(new URL('solution.md', fixture), 'utf8');
  assert.match(await readFile(new URL('brief.md', fixture), 'utf8'), /greeting/);
  await writeFile(join(created.path, 'requirements.md'), requirements);
  await writeFile(join(created.path, 'solution.md'), solution);
  const selected = classify({ changeType: 'feature', featureCount: 1, acCount: 1, componentCount: 0, parallelMarkers: false, existingSurfaceOnly: true });
  assert.equal(selected.tier, 'direct');
  assert.ok(selected.reasons.length);
  const spec = parseSpec({ ...created.spec, tier: selected.tier, documents: { requirements: 'requirements.md', solution: 'solution.md' }, tasks: [{ key: 'greeting', title: 'Return greeting', kind: 'feature', phase: null, dependsOn: [], files: ['src/greeting.ts', 'test/greeting.test.ts'], brief: 'solution.md', unit: null, scenarios: [] }] });
  await writeFile(join(created.path, 'spec.json'), JSON.stringify(spec));
  const fake = createFakeBeads({ epicId: 'mission-fixture' });
  const first = await materialize({ client: fake.client, projectRoot: root, spec, missionId: 'mission-fixture' });
  const resumed = await materialize({ client: fake.client, projectRoot: root, spec: first.spec, missionId: 'mission-fixture' });
  assert.equal(first.createdIds.length, 1);
  assert.equal(resumed.createdIds.length, 0);
  assert.equal(fake.actions().length, 1);
});
test('adapted upstream briefs and documents produce expected tier recommendations', async () => {
  const signals = Type.Object({ changeType: Type.Union([Type.Literal('feature'), Type.Literal('fix'), Type.Literal('refactor'), Type.Literal('doc')]), featureCount: Type.Integer(), acCount: Type.Integer(), componentCount: Type.Integer(), parallelMarkers: Type.Boolean(), existingSurfaceOnly: Type.Boolean() });
  const schema = Type.Array(Type.Object({ name: Type.String(), brief: Type.String(), requirements: Type.String(), solution: Type.Union([Type.String(), Type.Null()]), signals, expectedTier: Type.String() }));
  const input: unknown = JSON.parse(await readFile(new URL('fixtures/specification/cases.json', import.meta.url), 'utf8'));
  assert.ok(Value.Check(schema, input));
  for (const fixture of input) {
    assert.ok(fixture.brief.trim() && fixture.requirements.trim());
    assert.equal(classify(fixture.signals).tier, fixture.expectedTier, fixture.name);
    if (fixture.solution === null) assert.match(fixture.brief, /explicitly review/);
  }
});
test('omissions, dependencies, and scenario coverage are deterministic descriptor checks', () => {
  const base = { schemaVersion: 1, specId: '001', slug: 'sample', tier: 'factory', documents: { requirements: 'requirements.md', solution: null }, omissions: {}, binding: null, tasks: [{ key: 'api', title: 'API', kind: 'feature', phase: null, dependsOn: [], files: ['src/api.ts'], brief: 'units/api.md', unit: 'units/api.md', scenarios: ['scenarios/api/happy.md'] }] };
  assert.throws(() => parseSpec(base), /OMISSION_REASON_REQUIRED/);
  const approved = { ...base, omissions: { solution: 'User approved requirements-only design.' } };
  assert.equal(parseSpec(approved).tier, 'factory');
  assert.throws(() => parseSpec({ ...approved, tasks: approved.tasks.map(task => ({ ...task, dependsOn: ['unknown'] })) }), /UNKNOWN_DEPENDENCY/);
  assert.throws(() => parseSpec({ ...approved, tasks: approved.tasks.map(task => ({ ...task, scenarios: [] })) }), /SCENARIOS_REQUIRED/);
});
test('holdout scenario edits invalidate the content revision', async t => {
  const root = await mkdtemp('/tmp/sdd-scenario-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  const created = await createSpec({ projectRoot: root, name: 'API' });
  const spec = parseSpec({ ...created.spec, tier: 'factory', omissions: { requirements: 'User approved public unit requirements.', solution: 'User approved omission.' }, tasks: [{ key: 'api', title: 'API', kind: 'feature', phase: null, dependsOn: [], files: ['src/api.ts'], brief: 'unit.md', unit: 'unit.md', scenarios: ['scenario.md'] }] });
  await writeFile(join(created.path, 'spec.json'), JSON.stringify(spec));
  await writeFile(join(created.path, 'unit.md'), 'Public behavior. Run: npm test');
  await writeFile(join(created.path, 'scenario.md'), 'Private case one.');
  const before = await contentRevision({ projectRoot: root, spec });
  await writeFile(join(created.path, 'scenario.md'), 'Private case two.');
  assert.notEqual(await contentRevision({ projectRoot: root, spec }), before);
});
