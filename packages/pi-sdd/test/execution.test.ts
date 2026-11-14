import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextExecutionStep } from '../src/execution.ts';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, transport } from './helpers/git.ts';
import { createWorkspace } from '../src/workspace.ts';
import { collectPatch, integratePatch } from '../src/patch.ts';
import { quoteShell } from '../src/beads.ts';
import { makeSpec } from './helpers/spec.ts';
const tasks = ['a','b'].map((key,i)=>({...makeSpec().tasks[0]!,key,dependsOn:i?['a']:[],phase:null}));
const spec=makeSpec({tasks,binding:{missionId:'m',taskIds:{a:'m.1',b:'m.2'}}});
const approval={revision:'r',tier:'direct',approvedAt:'now',approvalSource:'user'} as const;
const states=[{id:'m.1',status:'open',metadata:{}},{id:'m.2',status:'open',metadata:{}}];
const step=(s=spec,st=states,a:unknown=approval,phaseApprovals:unknown[]=[] )=>nextExecutionStep({spec:s,states:st,approval:a,phaseApprovals,currentRevision:'r'});
test('direct dependency ordering and verified closed task is never dispatched again',()=>{
 assert.deepEqual(step(),{kind:'dispatch',taskKeys:['a']});
 assert.equal(step(spec,[{...states[0]!,status:'closed'},states[1]!]).kind,'reconcile');
 assert.deepEqual(step(spec,[{...states[0]!,status:'closed',metadata:{verifiedRevision:'r'}},states[1]!]),{kind:'dispatch',taskKeys:['b']});
});
test('real two-source candidate integration preserves first verification after second fails',async()=>{
 const {root,runs}=await fixture();
 try {
  const a=await createWorkspace({projectRoot:root,runRoot:runs,taskKey:'a',allowedFiles:['src/a.ts'],role:'coder',transport});
  const b=await createWorkspace({projectRoot:root,runRoot:runs,taskKey:'b',allowedFiles:['src/b.ts'],role:'coder',transport});
  await writeFile(join(a.path,'src/a.ts'),'verified a\n');
  const ap=await collectPatch(a);
  await integratePatch({projectRoot:root,patch:ap,approvedFiles:['src/a.ts']});
  const command='node -e '+quoteShell("const fs=require('node:fs');process.exit(fs.readFileSync('src/a.ts','utf8').startsWith('verified')?0:1)");
  const passed=await transport.run({command:'cd '+quoteShell(root)+' && '+command,timeout:10});
  assert.equal(passed.exitCode,0);
  // Fixture parent persists verification only after observing actual passing tests.
  const verified={...states[0]!,status:'closed',metadata:{verifiedRevision:'r'}};
  assert.deepEqual(step(spec,[verified,states[1]!]),{kind:'dispatch',taskKeys:['b']});
  await writeFile(join(b.path,'src/b.ts'),'broken b\n');
  const bp=await collectPatch(b);
  await integratePatch({projectRoot:root,patch:bp,approvedFiles:['src/b.ts']});
  const failed=await transport.run({command:'cd '+quoteShell(root)+' && node -e '+quoteShell("const fs=require('node:fs');process.exit(fs.readFileSync('src/b.ts','utf8')==='b\\n'?0:1)"),timeout:10});
  assert.equal(failed.exitCode,1);
  const result=step(spec,[verified,{...states[1]!,metadata:{failedTests:true}}]);
  assert.equal(result.kind,'reconcile');
  assert.equal(verified.metadata.verifiedRevision,'r');
  await writeFile(join(b.path,'README.md'),'outside scope');
  await assert.rejects(collectPatch(b),/OUT_OF_SCOPE/);
 } finally {await rm(root,{recursive:true,force:true});await rm(runs,{recursive:true,force:true});}
});
test('explicit skill content and adapted fixture contracts',async()=>{
 for(const name of ['implement','implement-direct','implement-incremental']) {
  const text=await readFile(new URL('../skills/sdd-'+name+'/SKILL.md',import.meta.url),'utf8');
  assert.match(text,new RegExp('name: sdd-'+name));
  assert.match(text,/disable-model-invocation: true/);
  assert.doesNotMatch(text,/TeamCreate|SendMessage|TodoWrite|team:the-|\$ARGUMENTS|\/start:/);
 }
 const cases=JSON.parse(await readFile(new URL('./fixtures/execution/cases.json',import.meta.url),'utf8'));
 assert.equal(cases.length,8);
});
test('four tasks cannot dispatch',()=>assert.equal(step(makeSpec({tasks:[...tasks,...tasks.map(t=>({...t,key:t.key+'x'}))]})).kind,'blocked'));
test('incremental pause/cancellation stays at gate; resume requires current user receipt',()=>{
 const s={...spec,tier:'incremental' as const,tasks:tasks.map((t,i)=>({...t,phase:i+1}))};
 const st=[{...states[0]!,status:'closed',metadata:{verifiedRevision:'r'}},states[1]!];
 assert.deepEqual(step(s,st,{...approval,tier:'incremental'}),{kind:'phase_review',phase:1});
 assert.deepEqual(step(s,st,{...approval,tier:'incremental'},[{phase:1,revision:'r',approvalSource:'user',approvedAt:'now'}]),{kind:'dispatch',taskKeys:['b']});
});
test('stale approval, cancelled worker, and three failed cycles do not dispatch',()=>{
 assert.equal(step(spec,states,{...approval,revision:'old'}).kind,'approval_required');
 assert.equal(step(spec,[{...states[0]!,status:'in_progress'},states[1]!]).kind,'reconcile');
 assert.equal(step(spec,[{...states[0]!,metadata:{failedReviewCycles:3}},states[1]!]).kind,'blocked');
});
