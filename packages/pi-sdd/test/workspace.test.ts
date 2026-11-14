import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git, transport } from './helpers/git.ts';
import { createWorkspace, destroyWorkspace } from '../src/workspace.ts';
test('separate baselines, holdouts, ownership and duplicate claims', async () => {
 const {root,runs}=await fixture();
 try {
 const input={projectRoot:root,runRoot:runs,allowedFiles:['src/a.ts'],role:'coder' as const,transport};
 const a=await createWorkspace({...input,taskKey:'a'}); const b=await createWorkspace({...input,taskKey:'b'});
 assert.notEqual(a.path,b.path); assert.equal(await git(a.path,'rev-list','--count','HEAD'),'1');
 await assert.rejects(access(join(a.path,'.start/scenarios/secret.md')));
 await assert.rejects(createWorkspace({...input,taskKey:'a'}),/TASK_LOCKED/);
 await assert.rejects(destroyWorkspace({workspace:{...a,path:root},keepEvidence:false}),/NOT_OWNED/);
 await destroyWorkspace({workspace:a,keepEvidence:false}); await access(root);
 await destroyWorkspace({workspace:b,keepEvidence:false});
 const evaluator=await createWorkspace({...input,taskKey:'eval',role:'evaluator',scenarioFiles:['.start/scenarios/secret.md'],interfaceFiles:['README.md']});
 assert.equal(await readFile(join(evaluator.path,'.start/scenarios/secret.md'),'utf8'),'SENTINEL');
 await assert.rejects(access(join(evaluator.path,'src/a.ts')));
 await destroyWorkspace({workspace:evaluator,keepEvidence:false});
 await writeFile(join(root,'src/a.ts'),'dirty'); await assert.rejects(createWorkspace({...input,taskKey:'c'}),/DIRTY/);
 } finally {await rm(root,{recursive:true,force:true});await rm(runs,{recursive:true,force:true});}
});
test('escaping tracked symlinks block snapshots',async()=>{
 const {root,runs}=await fixture(); try {await symlink('/tmp',join(root,'escape'));await git(root,'add','escape');await git(root,'-c','user.name=T','-c','user.email=t@t','commit','-m','link');
 await assert.rejects(createWorkspace({projectRoot:root,runRoot:runs,taskKey:'x',allowedFiles:['src/a.ts'],role:'coder',transport}),/SYMLINK/);
 } finally {await rm(root,{recursive:true,force:true});await rm(runs,{recursive:true,force:true});}
});
