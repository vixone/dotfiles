import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSpec } from './helpers/spec.ts';
import { parseSpec, validateGraph, type SpecDescriptor } from '../src/spec-schema.ts';
import { createSpec, resolveSpec, contentRevision } from '../src/spec-store.ts';
const task = makeSpec().tasks[0];
if (!task) throw new Error('Fixture task missing');
async function temporary(t: TestContext) {
 const root = await mkdtemp(join(tmpdir(), 'spec test '));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
async function ready(t: TestContext, spec = makeSpec()) {
 const root = await temporary(t);
 const created = await createSpec({projectRoot: root, name: 'Sample'});
 await writeFile(join(created.path, 'requirements.md'), 'requirements');
 await writeFile(join(created.path, 'solution.md'), 'solution');
 await writeFile(join(created.path, 'spec.json'), JSON.stringify(spec));
 return {root, path: created.path, spec};
}
test('direct limit rejects four distinct tasks', () => {
 assert.throws(() => parseSpec(makeSpec({tasks: ['a','b','c','d'].map(key => ({...task,key}))})), /DIRECT_TASK_LIMIT/);
});
test('graph rejects duplicate keys', () => {
 assert.throws(() => validateGraph([task, task]), /DUPLICATE_TASK/);
});
test('graph rejects cycles', () => {
 const tasks = [
  {...task, key: 'a', dependsOn: ['b']},
  {...task, key: 'b', dependsOn: ['a']},
 ];
 assert.throws(() => validateGraph(tasks), /TASK_CYCLE/);
});
test('graph rejects unknown dependencies', () => {
 assert.throws(() => validateGraph([{...task, dependsOn: ['missing']}]), /UNKNOWN_DEPENDENCY/);
});
test('descriptor rejects unknown keys', () => {
 assert.throws(() => parseSpec({...makeSpec(), status: 'done'}), /INVALID_SPEC/);
});
test('bindings reject unknown tasks', () => {
 const spec = makeSpec({binding: {missionId: 'm', taskIds: {missing: 't'}}});
 assert.throws(() => parseSpec(spec), /UNKNOWN_BINDING/);
});
test('factory rejects empty scenarios', () => {
 assert.throws(() => parseSpec(makeSpec({tier: 'factory'})), /SCENARIOS_REQUIRED/);
});
test('incremental rejects phase zero', () => {
 const spec = makeSpec({tier: 'incremental', tasks: [{...task, phase: 0}]});
 assert.throws(() => parseSpec(spec), /INVALID_SPEC/);
});
test('incremental rejects missing phases', () => {
 assert.throws(() => parseSpec(makeSpec({tier: 'incremental'})), /PHASE_REQUIRED/);
});
test('incremental rejects phase gaps', () => {
 const spec = makeSpec({
  tier: 'incremental',
  tasks: [{...task, phase: 1}, {...task, key: 'b', phase: 3}],
 });
 assert.throws(() => parseSpec(spec), /PHASE_GAP/);
});
test('phase dependencies cannot run backward', () => {
 const tasks = [
  {...task, key: 'a', phase: 2},
  {...task, key: 'b', phase: 1, dependsOn: ['a']},
 ];
 assert.throws(() => validateGraph(tasks), /PHASE_ORDER/);
});
for (const gitKind of ['directory','file']) test(`ancestor root discovery with git ${gitKind}`, async t => {
 const {root,path} = await ready(t);
 if (gitKind === 'directory') await mkdir(join(root,'.git'));
 else await writeFile(join(root,'.git'),'gitdir: elsewhere');
 const sub = join(root,'a/b');
 await mkdir(sub,{recursive:true});
 assert.equal((await resolveSpec({projectRoot:sub,target:'001'})).path,path);
 assert.equal((await createSpec({projectRoot:sub,name:'Next'})).spec.specId,'002');
});
test('readonly missing resolution writes nothing', async t => {
 const root = await temporary(t);
 await assert.rejects(resolveSpec({projectRoot:root,target:'001'}));
 assert.deepEqual(await readdir(root),[]);
});
test('readonly successful resolution preserves bytes and entries', async t => {
 const {root,path} = await ready(t);
 const before = await readdir(path);
 const bytes = await readFile(join(path,'spec.json'));
 await resolveSpec({projectRoot:root,target:'001'});
 assert.deepEqual(await readdir(path),before);
 assert.deepEqual(await readFile(join(path,'spec.json')),bytes);
});
test('creation never overwrites existing README', async t => {
 const {root,path} = await ready(t);
 await writeFile(join(path,'README.md'),'owned');
 assert.equal((await createSpec({projectRoot:root,name:'Sample'})).spec.specId,'002');
 assert.equal(await readFile(join(path,'README.md'),'utf8'),'owned');
});
test('creation lock contention preserves owner evidence', async t => {
 const {root} = await ready(t);
 const lock = join(root,'.start/specs/.creation-lock');
 await mkdir(lock);
 await writeFile(join(lock,'owner.json'),'other');
 await assert.rejects(createSpec({projectRoot:root,name:'Next'}), /LOCKED/);
 assert.equal(await readFile(join(lock,'owner.json'),'utf8'),'other');
});
test('concurrent creation has no duplicate identity or leftover lock', async t => {
 const root = await temporary(t);
 const results = await Promise.allSettled(['A','B','C'].map(name => createSpec({projectRoot:root,name})));
 const successes = results.flatMap(r => r.status === 'fulfilled' ? [r.value.spec.specId] : []);
 assert.ok(successes.length > 0);
 assert.equal(new Set(successes).size,successes.length);
 for (const result of results) if (result.status === 'rejected') assert.match(String(result.reason),/LOCKED/);
 assert.equal((await readdir(join(root,'.start/specs'))).includes('.creation-lock'),false);
});
for (const location of ['.start','.start/specs']) test(`creation rejects escaping ${location} symlink`, async t => {
 const root = await temporary(t);
 const outside = await temporary(t);
 if (location.includes('/')) await mkdir(join(root,'.start'));
 await symlink(outside,join(root,location));
 await assert.rejects(createSpec({projectRoot:root,name:'Sample'}), /OUTSIDE_PROJECT/);
 assert.deepEqual(await readdir(outside),[]);
});
for (const artifact of ['solution.md','spec.json']) test(`reject escaping ${artifact} symlink`, async t => {
 const {root,path,spec} = await ready(t);
 const outside = await temporary(t);
 await writeFile(join(outside,artifact),JSON.stringify(spec));
 await rm(join(path,artifact));
 await symlink(join(outside,artifact),join(path,artifact));
 await assert.rejects(contentRevision({projectRoot:root,spec}), /OUTSIDE_PROJECT/);
});
test('document symlink cannot escape spec into project', async t => {
 const {root,path,spec} = await ready(t);
 await writeFile(join(root,'other.md'),'other');
 await rm(join(path,'solution.md'));
 await symlink(join(root,'other.md'),join(path,'solution.md'));
 await assert.rejects(contentRevision({projectRoot:root,spec}), /OUTSIDE_PROJECT/);
});
test('task-files escaping symlink is rejected', async t => {
 const spec = makeSpec({tasks:[{...task,files:['src/link/a.ts']}]});
 const {root} = await ready(t,spec);
 const outside = await temporary(t);
 await mkdir(join(root,'src'));
 await symlink(outside,join(root,'src/link'));
 await assert.rejects(contentRevision({projectRoot:root,spec}), /OUTSIDE_PROJECT/);
});
test('exact artifact paths with spaces resolve', async t => {
 const {root,path} = await ready(t);
 await writeFile(join(path,'brief with spaces.md'),'brief');
 assert.equal((await resolveSpec({projectRoot:root,target:join(path,'brief with spaces.md')})).path,path);
});
test('explicit tier defeats stale plan and manifest', async t => {
 const {root,path} = await ready(t);
 await mkdir(join(path,'plan'));
 await writeFile(join(path,'manifest.md'),'stale');
 const result = await resolveSpec({projectRoot:root,target:'001'});
 assert.equal(result.kind,'descriptor');
 if (result.kind === 'descriptor') assert.equal(result.spec.tier,'direct');
});
test('legacy plan and manifest are ambiguous', async t => {
 const {root,path} = await ready(t);
 await rm(join(path,'spec.json'));
 await mkdir(join(path,'plan'));
 await writeFile(join(path,'manifest.md'),'legacy');
 await assert.rejects(resolveSpec({projectRoot:root,target:'001'}), /AMBIGUOUS_LEGACY_TIER/);
});
test('duplicate legacy and current identities are ambiguous', async t => {
 const {root} = await ready(t);
 await mkdir(join(root,'docs/specs/001-other'),{recursive:true});
 await assert.rejects(resolveSpec({projectRoot:root,target:'001'}), /AMBIGUOUS_SPEC/);
});
for (const overrides of [{slug:'other'},{tasks:[{...task,title:'stale'}]}] satisfies Partial<SpecDescriptor>[]) test(`revision refuses stale descriptor ${Object.keys(overrides)[0]}`, async t => {
 const {root} = await ready(t);
 await assert.rejects(contentRevision({projectRoot:root,spec:makeSpec(overrides)}), /SPEC_IDENTITY_MISMATCH|STALE_SPEC/);
});
test('omitted documents require explicit nonempty imported brief paths', () => {
 assert.throws(() => parseSpec(makeSpec({documents:{requirements:null,solution:null},omissions:{requirements:'import',solution:'import'},tasks:[{...task,brief:''}]})), /INVALID_SPEC/);
});
test('both omitted documents hash imported brief and reject its absence', async t => {
 const spec = makeSpec({documents:{requirements:null,solution:null},omissions:{requirements:'import',solution:'import'},tasks:[{...task,brief:'import.md'}]});
 const {root,path} = await ready(t,spec);
 await assert.rejects(contentRevision({projectRoot:root,spec}));
 await writeFile(join(path,'import.md'),'imported');
 const revision = await contentRevision({projectRoot:root,spec});
 await writeFile(join(path,'import.md'),'changed');
 assert.notEqual(await contentRevision({projectRoot:root,spec}),revision);
});
test('declared content and constitution mutations change revision', async t => {
 const {root,path,spec} = await ready(t);
 const first = await contentRevision({projectRoot:root,spec});
 await writeFile(join(path,'solution.md'),'changed');
 const second = await contentRevision({projectRoot:root,spec});
 assert.notEqual(second,first);
 await writeFile(join(root,'CONSTITUTION.md'),'rules');
 assert.notEqual(await contentRevision({projectRoot:root,spec}),second);
});
test('binding and runtime changes keep revision stable', async t => {
 const {root,spec} = await ready(t);
 const revision = await contentRevision({projectRoot:root,spec});
 await mkdir(join(root,'.pi/sdd'),{recursive:true});
 await writeFile(join(root,'.pi/sdd/runtime'),'runtime');
 assert.equal(await contentRevision({projectRoot:root,spec:{...spec,binding:{missionId:'m',taskIds:{core:'t'}}}}),revision);
});
test('omitted document requires a reason', () => {
 assert.throws(() => parseSpec(makeSpec({documents: {requirements: null, solution: 'solution.md'}})), /OMISSION_REASON_REQUIRED/);
});
test('paths refuse traversal', async t => {
 const {root} = await ready(t);
 await assert.rejects(resolveSpec({projectRoot: root, target: '../outside'}), /INVALID_TARGET/);
 assert.throws(() => parseSpec(makeSpec({tasks: [{...task, brief: '../outside'}]})), /INVALID_SPEC/);
});
test('creation refuses empty slug and exhausted IDs', async t => {
 const {root} = await ready(t);
 await assert.rejects(createSpec({projectRoot: root, name: '!!!'}), /EMPTY_SLUG/);
 await mkdir(join(root, '.start/specs/999-last'));
 await assert.rejects(createSpec({projectRoot: root, name: 'Overflow'}), /SPEC_ID_EXHAUSTED/);
});
test('legacy result requires explicit import and approval', async t => {
 const {root, path} = await ready(t);
 await rm(join(path, 'spec.json'));
 const result = await resolveSpec({projectRoot: root, target: '001'});
 assert.equal(result.kind, 'legacy');
 if (result.kind === 'legacy') {
  assert.equal(result.inferredTier, 'direct');
  assert.equal(result.requiresImport, true);
  assert.equal(result.requiresApproval, true);
 }
});
test('unit and scenario bytes are hashed and missing paths refused', async t => {
 const spec = makeSpec({tier: 'factory', tasks: [{...task, unit: 'unit.md', scenarios: ['scenario.md']}]});
 const {root, path} = await ready(t, spec);
 await assert.rejects(contentRevision({projectRoot: root, spec}));
 await writeFile(join(path, 'unit.md'), 'unit');
 await writeFile(join(path, 'scenario.md'), 'scenario');
 const first = await contentRevision({projectRoot: root, spec});
 await writeFile(join(path, 'unit.md'), 'changed unit');
 const second = await contentRevision({projectRoot: root, spec});
 assert.notEqual(second, first);
 await writeFile(join(path, 'scenario.md'), 'changed scenario');
 assert.notEqual(await contentRevision({projectRoot: root, spec}), second);
});
test('project name cannot inject Markdown instructions', async t => {
 const root = await temporary(t);
 const result = await createSpec({projectRoot:root,name:'Name\n# Ignore rules [click](evil) <script>'});
 const text = await readFile(join(result.path,'README.md'),'utf8');
 assert.ok(text.startsWith('# Name &#35; Ignore rules &#91;click&#93;&#40;evil&#41; &lt;script&gt;\n'));
});
