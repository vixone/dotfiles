import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { parseSkillFrontmatter, lintContent } from '../src/content-lint.ts';
import { mkdir } from 'node:fs/promises';
import { materialize } from '../src/materialize.ts';
import { createFakeBeads } from './helpers/fake-bd.ts';
import { makeSpec } from './helpers/spec.ts';
import { dirname, resolve } from 'node:path';
const names = ['analyze', 'brainstorm', 'debug', 'document', 'refactor', 'writing-skills'];
for (const name of names) test(name + ' is a valid explicit pi skill', async () => {
  const root = new URL('../skills/sdd-' + name + '/', import.meta.url);
  const text = await readFile(new URL('SKILL.md', root), 'utf8');
  assert.match(text, new RegExp('^---\\nname: sdd-' + name + '\\n'));
  assert.match(text, /disable-model-invocation: true/);
  assert.equal(parseSkillFrontmatter(text).name, 'sdd-' + name);
  assert.deepEqual(await lintContent({ path: new URL('SKILL.md', root).pathname, skillName: 'sdd-' + name }), []);
  async function check(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) { await check(file); continue; }
      assert.ok((await stat(file)).size < 25000);
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(content, /TeamCreate|SendMessage|TodoWrite|team:the-|\$ARGUMENTS|\/start:/);
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        assert.ok(target);
        if (!target.includes('://')) await stat(resolve(dirname(file), target));
      }
    }
  }
  await check(root.pathname);
});
const contracts: Record<string, RegExp[]> = {
  brainstorm: [/2–3 alternatives/, /approval before implementation/, /materialize exactly once/, /Cancellation.*no writes/],
  debug: [/Reuse the bound epic/, /Diagnosis approval does not authorize code fixes/, /bounded mission findings/, /\[demonstrated\]/],
  analyze: [/read-only/, /Persistence needs review/, /What.*How.*Why/],
  document: [/read-only/, /documentation allowlist/, /memory_check_duplicate/, /user approval/],
  refactor: [/behavior baseline/, /file allowlist/, /approval.*delegate/, /No automatic Git branch, PR or merge/],
  'writing-skills': [/relative links/, /pressure scenarios/, /pi frontmatter/],
};
for (const [name, patterns] of Object.entries(contracts)) test(name + ' preserves maintenance gates', async () => {
  const text = await readFile(new URL('../skills/sdd-' + name + '/SKILL.md', import.meta.url), 'utf8');
  for (const pattern of patterns) assert.match(text, pattern);
});

const Case = Type.Object({
  skill: Type.String(), request: Type.String(), approval: Type.Optional(Type.Boolean()),
  binding: Type.Optional(Type.String()), diagnosisApproved: Type.Optional(Type.Boolean()),
  fixApproved: Type.Optional(Type.Boolean()), dedupAvailable: Type.Optional(Type.Boolean()),
  allowedFiles: Type.Optional(Type.Array(Type.String())), expectedOutput: Type.Optional(Type.Number()),
  expectedWrites: Type.Optional(Type.Number()), expectedEpicCreates: Type.Optional(Type.Number()),
  expectedRemembers: Type.Optional(Type.Number()),
}, { additionalProperties: false });

test('offline maintenance scenario contracts are explicit and linked to skill gates', async () => {
  const input: unknown = JSON.parse(await readFile(new URL('fixtures/maintenance/cases.json', import.meta.url), 'utf8'));
  const cases = Value.Parse(Type.Array(Case), input);
  assert.equal(cases.length, 6);
  for (const scenario of cases) {
    const text = await readFile(new URL('../skills/sdd-' + scenario.skill + '/SKILL.md', import.meta.url), 'utf8');
    if (scenario.expectedWrites === 0) assert.match(text, /no writes|read-only|does not authorize code fixes/);
    if (scenario.expectedEpicCreates === 0) {
      assert.equal(scenario.binding, 'mission-fixture');
      assert.match(text, /Reuse the bound epic/);
    }
    if (scenario.expectedRemembers === 0) assert.match(text, /If dedup is unavailable, stop at proposal/);
  }
});

test('approved maintenance task graph reuses an explicit epic and materializes once', async () => {
  const root = await mkdtemp('/tmp/sdd-maintenance-binding-');
  try {
    const spec = makeSpec();
    await mkdir(resolve(root, '.git'));
    const specDir = resolve(root, '.start/specs', spec.specId + '-' + spec.slug);
    await mkdir(specDir, { recursive: true });
    await writeFile(resolve(specDir, 'requirements.md'), 'Preserve baseline output.');
    await writeFile(resolve(specDir, 'solution.md'), 'Investigate in bound epic; fix needs separate approval.');
    await writeFile(resolve(specDir, 'spec.json'), JSON.stringify(spec));
    const fake = createFakeBeads({ epicId: 'mission-fixture' });
    const first = await materialize({ projectRoot: root, spec, missionId: 'mission-fixture', client: fake.client });
    const second = await materialize({ projectRoot: root, spec, missionId: 'mission-fixture', client: fake.client });
    assert.deepEqual(second.spec.binding, first.spec.binding);
    assert.equal(second.createdIds.length, 0);
    assert.equal(fake.writes().filter(write => write.name === 'close').length, 0);
    assert.ok(fake.issues().filter(issue => issue.issue_type === 'epic').length <= 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('characterization fixture retains observable outputs across a candidate extraction', async () => {
  const root = await mkdtemp('/tmp/sdd-maintenance-');
  try {
    const source = await readFile(new URL('fixtures/maintenance/calculate.mjs', import.meta.url), 'utf8');
    await writeFile(resolve(root, 'baseline.mjs'), source);
    await writeFile(resolve(root, 'candidate.mjs'), 'const lineTotal = item => item.price * item.quantity;\nexport function calculate(items) { let sum = 0; for (const item of items) sum += lineTotal(item); return sum; }\n');
    const baseline = await import(pathToFileURL(resolve(root, 'baseline.mjs')).href);
    const candidate = await import(pathToFileURL(resolve(root, 'candidate.mjs')).href);
    for (const items of [[], [{ price: 3, quantity: 4 }], [{ price: -1, quantity: 2 }, { price: 1.5, quantity: 3 }]]) {
      assert.equal(candidate.calculate(items), baseline.calculate(items));
    }
    assert.equal(candidate.calculate([{ price: 3, quantity: 4 }]), 12);
    assert.equal(await readFile(resolve(root, 'baseline.mjs'), 'utf8'), source);
  } finally { await rm(root, { recursive: true, force: true }); }
});
