import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, transport } from './helpers/git.ts';
import { createWorkspace } from '../src/workspace.ts';
import { collectPatch, integratePatch } from '../src/patch.ts';
test('binary, disjoint integration, scope and atomic overlap',async()=>{
 const {root,runs}=await fixture();try {
 const input={projectRoot:root,runRoot:runs,role:'coder' as const,transport};
 const a=await createWorkspace({...input,taskKey:'a',allowedFiles:['src/a.ts','src/b.ts']});
 const b=await createWorkspace({...input,taskKey:'b',allowedFiles:['README.md']});
 await writeFile(join(b.path,'README.md'),'changed'); const bp=await collectPatch(b); await integratePatch({projectRoot:root,patch:bp,approvedFiles:bp.files});
 await writeFile(join(a.path,'src/a.ts'),Buffer.from([0,1,2,255]));await writeFile(join(a.path,'src/b.ts'),'new b');
 const p=await collectPatch(a); assert.deepEqual(p.files,['src/a.ts','src/b.ts']);
 await writeFile(join(root,'src/b.ts'),'parent');await assert.rejects(integratePatch({projectRoot:root,patch:p,approvedFiles:p.files}),/BASE_CHANGED/);
 assert.equal(await readFile(join(root,'src/a.ts'),'utf8'),'a\n');
 await writeFile(join(root,'src/b.ts'),'b\n');await integratePatch({projectRoot:root,patch:p,approvedFiles:p.files});
 assert.deepEqual(await readFile(join(root,'src/a.ts')),Buffer.from([0,1,2,255]));
 await assert.rejects(integratePatch({projectRoot:root,patch:p,approvedFiles:p.files}),/BASE_CHANGED/);
 await rm(join(b.path,'README.md')); const deletion=await collectPatch(b);
 // This workspace's original base predates its already integrated first patch.
 await assert.rejects(integratePatch({projectRoot:root,patch:deletion,approvedFiles:deletion.files}),/BASE_CHANGED/);
 await writeFile(join(a.path,'README.md'),'outside');await assert.rejects(collectPatch(a),/OUT_OF_SCOPE/);
 }finally{await rm(root,{recursive:true,force:true});await rm(runs,{recursive:true,force:true});}
});
