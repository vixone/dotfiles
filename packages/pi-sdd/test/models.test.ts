import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { formatDoctor, runDoctor, type DoctorInput } from '../src/doctor.ts';
import { loadModelOverrides, loadRoleConfig, resolveModel, ROLE_KEYS, workerRoles } from '../src/models.ts';
import { skillNames } from '../src/catalog.ts';

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const roles = {
  'feature, refactoring': 'p/feature',
  'bug-fix': 'p/bugfix',
  'perf-issue': 'p/perf',
  'how explorer': 'p/explorer',
  'judgment and prose': 'p/judgment',
  'hardest tasks': 'p/hardest',
  'arena runners': ['p/a', 'p/b'],
};
const available = ['p/feature', 'p/bugfix', 'p/perf', 'p/explorer', 'p/judgment', 'p/hardest', 'p/override'];

test('task examples resolve exact role IDs and fail without fallback', () => {
  assert.equal(resolveModel({ role: 'code', roles: { 'feature, refactoring': 'github-copilot/gpt-6.1-sol' }, overrides: {}, available: ['github-copilot/gpt-6.1-sol'] }), 'github-copilot/gpt-6.1-sol');
  assert.throws(() => resolveModel({ role: 'code', roles: {}, overrides: {}, available: [] }), /MODEL_ROLE_MISSING/);
  assert.throws(() => resolveModel({ role: 'code', roles: { 'feature, refactoring': 'x/y' }, overrides: {}, available: [] }), /MODEL_UNAVAILABLE/);
});

test('every SDD role maps to its exact pstack role key', () => {
  assert.deepEqual(ROLE_KEYS, {
    code: 'feature, refactoring',
    fix: 'bug-fix',
    performance: 'perf-issue',
    research: 'how explorer',
    review: 'judgment and prose',
    eval: 'judgment and prose',
    prose: 'judgment and prose',
    hardest: 'hardest tasks',
  });
  const expected = { code: 'p/feature', fix: 'p/bugfix', performance: 'p/perf', research: 'p/explorer', review: 'p/judgment', eval: 'p/judgment', prose: 'p/judgment', hardest: 'p/hardest' };
  for (const role of workerRoles) {
    assert.equal(resolveModel({ role, roles, overrides: {}, available, escalation: 'explicit test escalation' }), expected[role]);
  }
});

test('hardest requires an explicit escalation reason', () => {
  assert.throws(() => resolveModel({ role: 'hardest', roles, overrides: {}, available }), /MODEL_ESCALATION_REQUIRED/);
  assert.throws(() => resolveModel({ role: 'hardest', roles, overrides: {}, available, escalation: '  ' }), /MODEL_ESCALATION_REQUIRED/);
});

test('overrides win but never fall through to the role mapping', () => {
  assert.equal(resolveModel({ role: 'code', roles, overrides: { code: 'p/override' }, available }), 'p/override');
  assert.throws(() => resolveModel({ role: 'code', roles, overrides: { code: 'p/missing' }, available }), /MODEL_UNAVAILABLE: override for code/);
  assert.throws(() => resolveModel({ role: 'code', roles, overrides: { code: 'no-slash' }, available }), /MODEL_OVERRIDE_INVALID/);
});

test('malformed role values and unknown roles are explicit errors', () => {
  assert.throws(() => resolveModel({ role: 'code', roles: { 'feature, refactoring': ['p/a'] }, overrides: {}, available }), /MODEL_ROLE_INVALID/);
  assert.throws(() => resolveModel({ role: 'code', roles: { 'feature, refactoring': 'nope' }, overrides: {}, available }), /MODEL_ROLE_INVALID/);
  assert.throws(() => resolveModel({ role: 'hillclimb', roles, overrides: {}, available }), /MODEL_ROLE_UNKNOWN/);
});

test('role config is validated without echoing file content', async t => {
  const dir = await tempDir(t, 'pi-sdd-models-');
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ version: 1, roles, skillsEnabled: true }));
  assert.deepEqual((await loadRoleConfig(path)).roles, roles);
  await assert.rejects(loadRoleConfig(join(dir, 'absent.json')), /MODEL_CONFIG_MISSING/);
  await writeFile(path, JSON.stringify({ version: 1, roles, token: 'CONFIG_SECRET' }));
  await assert.rejects(loadRoleConfig(path), (error: Error) => /MODEL_CONFIG_INVALID/.test(error.message) && !error.message.includes('CONFIG_SECRET'));
  await writeFile(path, '{"version":1, CONFIG_SECRET');
  await assert.rejects(loadRoleConfig(path), (error: Error) => /MODEL_CONFIG_INVALID/.test(error.message) && !error.message.includes('CONFIG_SECRET'));
});

test('override config is optional but strict when present', async t => {
  const dir = await tempDir(t, 'pi-sdd-overrides-');
  const path = join(dir, 'config.json');
  assert.deepEqual(await loadModelOverrides(path), {});
  await writeFile(path, JSON.stringify({ schemaVersion: 1, models: { review: 'p/override' } }));
  assert.deepEqual(await loadModelOverrides(path), { review: 'p/override' });
  for (const bad of [
    { schemaVersion: 2, models: {} },
    { schemaVersion: 1, models: { hillclimb: 'p/x' } },
    { schemaVersion: 1, models: { code: 'no-slash' } },
    { schemaVersion: 1, models: {}, extra: true },
  ]) {
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(loadModelOverrides(path), /MODEL_CONFIG_INVALID/);
  }
});

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

async function doctorFixture(t: TestContext) {
  const root = await tempDir(t, 'pi-sdd-doctor-');
  const agentDir = join(root, 'agent');
  const bin = join(root, 'bin');
  const skillsRoot = join(root, 'skills');
  await mkdir(join(agentDir, 'extensions', 'guards'), { recursive: true });
  await writeFile(join(agentDir, 'extensions', 'guards', 'index.ts'), 'export default () => {};\n');
  await mkdir(join(agentDir, 'pstack'), { recursive: true });
  await writeFile(join(agentDir, 'pstack', 'models.json'), JSON.stringify({ version: 1, roles }));
  await mkdir(join(root, 'beads'));
  await mkdir(bin);
  const marker = join(root, 'bd-ran');
  await writeFile(join(bin, 'bd'), `#!/bin/sh\ntouch ${marker}\n`);
  await chmod(join(bin, 'bd'), 0o755);
  for (const name of skillNames) {
    await mkdir(join(skillsRoot, name), { recursive: true });
    await writeFile(join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  const input: DoctorInput = {
    version: '1.0.4',
    platform: 'darwin',
    tools: [{ name: 'subagent', parameters: subagentParameters, sourceInfo: { path: '/pkg/pi-subagent/extensions/subagent.mjs' } }],
    commandCollision: null,
    agentDir,
    beadsDir: join(root, 'beads'),
    pathEnv: bin,
    skillsRoot,
    rolesPath: join(agentDir, 'pstack', 'models.json'),
    overridesPath: join(agentDir, 'pi-sdd', 'config.json'),
    availableModels: available,
  };
  return { input, marker, root };
}

test('doctor reports host facts truthfully without running bd or claiming guard hooks are loaded', async t => {
  const { input, marker } = await doctorFixture(t);
  const report = await runDoctor(input);
  const text = formatDoctor(report);
  assert.equal(report.ok, true, text);
  assert.match(text, /pi 1\.0\.4 on darwin/);
  assert.match(text, /subagent: registered by \/pkg\/pi-subagent\/extensions\/subagent\.mjs/);
  assert.match(text, /guards: .*index\.ts present/);
  assert.match(text, /cannot prove/i);
  assert.match(text, /bd: .*bin\/bd found on PATH \(not executed\)/);
  assert.match(text, /code -> p\/feature/);
  assert.match(text, /hardest -> p\/hardest \(explicit escalation only\)/);
  assert.match(text, /skills: 20\/20/);
  assert.match(text, /low or off thinking/);
  assert.match(text, /no web, MCP/);
  const guard = report.checks.find(check => check.name === 'guards');
  assert.equal(guard?.status, 'unverified');
  await assert.rejects(import('node:fs/promises').then(fs => fs.stat(marker)), /ENOENT/);
});

test('doctor fails missing subagent, incompatible schema, guards, roles and skills', async t => {
  const { input, root } = await doctorFixture(t);
  const missing = await runDoctor({ ...input, tools: [] });
  assert.equal(missing.ok, false);
  assert.match(formatDoctor(missing), /SUBAGENT_UNAVAILABLE/);
  const incompatible = await runDoctor({ ...input, tools: [{ name: 'subagent', parameters: Type.Object({ agent: Type.String() }), sourceInfo: { path: '/x' } }] });
  assert.match(formatDoctor(incompatible), /SUBAGENT_INCOMPATIBLE/);
  await rm(join(input.agentDir, 'extensions', 'guards'), { recursive: true });
  await rm(join(input.skillsRoot, 'sdd-review'), { recursive: true });
  const broken = await runDoctor({ ...input, availableModels: [], pathEnv: join(root, 'nothing') });
  const text = formatDoctor(broken);
  assert.equal(broken.ok, false);
  assert.match(text, /guards: FAIL/);
  assert.match(text, /MODEL_UNAVAILABLE/);
  assert.match(text, /skills: FAIL 19\/20.*sdd-review/);
  assert.match(text, /bd: FAIL/);
  assert.doesNotMatch(text, /auth\.json/);
});
