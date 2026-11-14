import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { synthesizeReview, type ReviewFinding } from '../src/review-report.ts';
import { suitePassed, type TestCategoryResult } from '../src/test-report.ts';
const baseFinding: ReviewFinding = { severity:'low', confidence:'high', path:'src/api.ts', line:10, title:'Payload rename', issue:'Existing clients use the old field.', fix:'Provide a migration adapter.', breaking:null };
const result: TestCategoryResult = {category:'unit',command:'node --test',exitCode:0,passed:1,failed:0,skipped:0,logPath:'unit.log',blockedReason:null};
test('review verdict boundaries and breaking-first evidence', () => {
 assert.equal(synthesizeReview([{...baseFinding,breaking:{consumers:'SDK clients',migration:'Rename payload field'}}]).verdict,'request_changes');
 assert.equal(synthesizeReview([{...baseFinding,severity:'critical'}]).verdict,'request_changes');
 for (const n of [1,3,4]) assert.equal(synthesizeReview(Array.from({length:n},(_,i)=>({...baseFinding,line:10+i*10,severity:'high'}))).verdict,n>3?'request_changes':'approve_with_comments');
 assert.equal(synthesizeReview([{...baseFinding,severity:'medium'}]).verdict,'approve_with_comments');
 assert.equal(synthesizeReview([baseFinding]).verdict,'approve');
 assert.equal(synthesizeReview([]).verdict,'approve');
 const merged=synthesizeReview([baseFinding,{...baseFinding,line:12,severity:'critical',breaking:{consumers:'clients',migration:'adapter'}}]);
 assert.equal(merged.findings.length,1); assert.equal(merged.breakingChanges.length,1);
});
test('suite evidence cannot turn missing or skipped tests green',()=>{
 assert.equal(suitePassed([]),false);
 assert.equal(suitePassed([result]),true);
 for(const patch of [{exitCode:null},{exitCode:1},{failed:1},{blockedReason:'missing browser'},{passed:0,skipped:4}]) assert.equal(suitePassed([{...result,...patch}]),false);
 assert.equal(suitePassed([{category:'e2e',command:'npm run e2e',exitCode:null,passed:0,failed:0,skipped:4,logPath:'e2e.log',blockedReason:'browser missing'}]),false);
});
test('actual failing fixture preserves counts and exit status',()=>{
 const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR:'/tmp' };
 delete env.NODE_TEST_CONTEXT;
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap','test/fixtures/quality/failing.mjs'],{encoding:'utf8',env});
 assert.equal(run.status,1); assert.match(run.stdout,/# pass 1/); assert.match(run.stdout,/# fail 1/);
 assert.equal(suitePassed([{...result,exitCode:run.status,failed:1}]),false);
});
for(const name of ['validate','test','review','constitution']) test(`${name} explicit skill and local links`,async()=>{
 const root=new URL(`../skills/sdd-${name}/`,import.meta.url);
 async function scan(dir:URL):Promise<void>{for(const e of await readdir(dir,{withFileTypes:true})) {const p=new URL(e.name+(e.isDirectory()?'/':''),dir);if(e.isDirectory()) await scan(p);else {const text=await readFile(p,'utf8');assert.doesNotMatch(text,/TeamCreate|SendMessage|TodoWrite|team:the-|\$ARGUMENTS|\/start:|AskUserQuestion|Agent Team/);for(const m of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) if(!m[1]!.includes('://')) await readFile(new URL(m[1]!,p));}}}
 await scan(root);const text=await readFile(new URL('SKILL.md',root),'utf8');assert.match(text,new RegExp(`name: sdd-${name}`));assert.match(text,/disable-model-invocation: true/);assert.ok(Buffer.byteLength(text)<25000);
});
test('workflow safety contracts',async()=>{
 const skill=async(n:string)=>readFile(new URL(`../skills/sdd-${n}/SKILL.md`,import.meta.url),'utf8');
 const v=await skill('validate');for(const mode of ['Spec','File','Drift','Constitution','Comparison','Understanding'])assert.ok(v.includes(mode));
 assert.match(await skill('constitution'),/L1 and L2.*block/);assert.match(await skill('constitution'),/reviewed approval/);
 const t=await skill('test');assert.match(t,/audit.*read-only/);assert.match(t,/baseline.*no fixes/);assert.match(t,/holdout/);assert.match(t,/E2E.*blocked/);
 const r=await skill('review');assert.match(r,/full.*context.*diff/);assert.match(r,/breaking changes FIRST/);
});
