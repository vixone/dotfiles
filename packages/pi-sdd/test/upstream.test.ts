import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Type from 'typebox';
import { Parse } from 'typebox/schema';
import { skillNames } from '../src/catalog.ts';

const MappedFile = Type.Object({
  path: Type.String({ minLength: 1 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  bytes: Type.Integer({ minimum: 0 }),
  disposition: Type.Union([
    Type.Literal('port'), Type.Literal('adapt'),
    Type.Literal('test-fixture'), Type.Literal('omit'),
  ]),
  targets: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  reason: Type.String({ minLength: 1 }),
  actions: Type.Array(Type.String({ pattern: '^mission-b7h\\.[0-9]+$' }), {
    minItems: 1, uniqueItems: true,
  }),
}, { additionalProperties: false });

const Inventory = Type.Object({
  schemaVersion: Type.Literal(1),
  upstream: Type.Object({
    repository: Type.Literal('rsmdt/the-startup'),
    revision: Type.Literal('88d447c7fb846f9d519faf59219cd34cf7577501'),
    license: Type.Literal('MIT'),
  }, { additionalProperties: false }),
  scope: Type.Object({
    included: Type.Array(Type.String()),
    excluded: Type.Array(Type.Object({
      path: Type.String(), reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  files: Type.Array(MappedFile, { minItems: 1 }),
}, { additionalProperties: false });

async function readInventory() {
  const input: unknown = JSON.parse(await readFile(
    new URL('../upstream.json', import.meta.url), 'utf8',
  ));
  return Parse(Inventory, input);
}

test('the pinned inventory maps every catalog skill and excludes Team', async () => {
  const inventory = await readInventory();
  assert.equal(inventory.files.length, 203);
  assert.equal(inventory.files.filter(file => file.path.startsWith('plugins/start/')).length,
    201);
  assert.deepEqual(inventory.scope.included, [
    'plugins/start/**', 'LICENSE', 'docs/PRINCIPLES.md',
  ]);
  assert.equal(new Set(inventory.files.map(file => file.path)).size,
    inventory.files.length);
  assert.ok(inventory.files.every(file =>
    file.path.startsWith('plugins/start/') ||
    ['LICENSE', 'docs/PRINCIPLES.md'].includes(file.path)));
  assert.ok(inventory.files.every(file => !file.path.startsWith('plugins/team/')));

  const skills = inventory.files.filter(file => file.path.endsWith('/SKILL.md'));
  assert.equal(skills.length, 20);
  assert.deepEqual(skills.flatMap(file => file.targets).sort(),
    skillNames.map(name => `skills/${name}/SKILL.md`).sort());
  assert.ok(skills.every(file => file.disposition === 'adapt'));

  for (const file of inventory.files) {
    assert.equal(file.targets.length === 0, file.disposition === 'omit', file.path);
    for (const path of [file.path, ...file.targets]) {
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), path);
    }
    if (file.path.includes('/evals/')) {
      assert.equal(file.disposition, 'test-fixture', file.path);
      assert.ok(file.targets.every(path => path.startsWith('test/fixtures/')));
    }
  }
});

test('Python storage, plugin manifest and output styles have explicit dispositions', async () => {
  const inventory = await readInventory();
  const python = inventory.files.filter(file => file.path.endsWith('/spec.py'));
  assert.equal(python.length, 1);
  assert.deepEqual(python.map(file => file.disposition), ['adapt']);
  assert.ok(python.every(file => file.targets.includes('src/spec-store.ts')));
  const styles = inventory.files.filter(file => file.path.includes('/output-styles/'));
  assert.equal(styles.length, 2);
  assert.ok(styles.every(file => file.disposition === 'omit' && file.targets.length === 0));
  const manifest = inventory.files.filter(file => file.path.endsWith('/plugin.json'));
  assert.equal(manifest.length, 1);
  assert.ok(manifest.every(file => file.targets.includes('package.json')));
});

test('the MIT license bytes match the pinned source hash', async () => {
  const inventory = await readInventory();
  const licenseEntry = inventory.files.filter(file => file.path === 'LICENSE');
  assert.equal(licenseEntry.length, 1);
  const license = await readFile(new URL('../LICENSE', import.meta.url));
  const sha256 = createHash('sha256').update(license).digest('hex');
  assert.deepEqual(licenseEntry.map(file => file.sha256), [sha256]);
  assert.match(license.toString(), /Copyright \(c\) 2025-current Rudolf Schmidt/);
});

test('the port map has exactly one row per inventory file', async () => {
  const inventory = await readInventory();
  const map = await readFile(new URL('../docs/port-map.md', import.meta.url), 'utf8');
  const rows = map.split('\n').filter(line => line.startsWith('| `'));
  assert.equal(rows.length, inventory.files.length);
  for (const file of inventory.files) {
    assert.equal(rows.filter(line => line.startsWith(`| \`${file.path}\` |`)).length,
      1, file.path);
  }
});
