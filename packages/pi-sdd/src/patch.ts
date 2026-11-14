import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { git, state, hashFile, safePath, forbidden, type Workspace } from './workspace.ts';
import type { CommandTransport } from './beads.ts';
export interface Patch {files:string[];patchPath:string;baseHashes:Record<string,string|null>}
const candidates=new WeakMap<Patch,{digest:string;root:string;transport:CommandTransport;files:string[];bases:Record<string,string|null>}>();
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function collectPatch(workspace:Workspace):Promise<Patch>{
 const s=state(workspace);
 const files=[...new Set((await git(s.transport,workspace.path,['ls-files','--modified','--deleted','--others','--exclude-standard','-z'])).split('\0').filter(Boolean))].sort();
 for(const p of files){safePath(p);if(forbidden(p)||!s.allowed.includes(p))throw new Error(`OUT_OF_SCOPE: ${p}`);await hashFile(workspace.path,p);}
 // Stage only after the entire changed inventory has passed scope validation.
 if(files.length)await git(s.transport,workspace.path,['add','--all','--',...files]);
 const staged=(await git(s.transport,workspace.path,['diff','--cached','--name-only','-z','HEAD'])).split('\0').filter(Boolean);
 for(const p of staged)if(!files.includes(p)) {if(!s.allowed.includes(p)||forbidden(p))throw new Error('OUT_OF_SCOPE');files.push(p);}
 files.sort();
 const text=await git(s.transport,workspace.path,['diff','--cached','--binary','--no-renames','--full-index','HEAD','--']);
 const patchPath=join(s.runRoot,`${workspace.workspaceId}.patch`);await writeFile(patchPath,text,{mode:0o600});
 const baseHashes=Object.fromEntries(files.map(p=>[p,s.bases[p]??null]));const patch={files,patchPath,baseHashes};
 candidates.set(patch,{digest:digest(text),root:s.root,transport:s.transport,files:[...files],bases:{...baseHashes}});return patch;
}
export async function integratePatch({projectRoot,patch,approvedFiles}:{projectRoot:string;patch:Patch;approvedFiles:string[]}):Promise<void>{
 const c=candidates.get(patch);if(!c||await realpath(projectRoot)!==c.root)throw new Error('UNREVIEWED_PATCH');
 if(JSON.stringify(patch.files)!==JSON.stringify(c.files)||JSON.stringify(patch.baseHashes)!==JSON.stringify(c.bases))throw new Error('PATCH_CHANGED');
 if(c.files.length!==approvedFiles.length||c.files.some(p=>!approvedFiles.includes(p)))throw new Error('OUT_OF_SCOPE');
 const text=await readFile(patch.patchPath,'utf8');if(digest(text)!==c.digest)throw new Error('PATCH_CHANGED');
 for(const p of c.files)if(await hashFile(projectRoot,p)!==c.bases[p])throw new Error(`BASE_CHANGED: ${p}`);
 if(!c.files.length)return;
 // git apply without --reject is atomic: all hunks must pass before any write.
 await git(c.transport,projectRoot,['apply','--check','--binary','--',patch.patchPath]);
 await git(c.transport,projectRoot,['apply','--binary','--',patch.patchPath]);
}
