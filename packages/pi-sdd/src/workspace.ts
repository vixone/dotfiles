import { mkdir, mkdtemp, readFile, writeFile, lstat, readlink, realpath, rm, unlink } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { quoteShell, type CommandTransport } from './beads.ts';

export interface Workspace { workspaceId:string; path:string; sourceRevision:string; baseFiles:Record<string,string|null> }
interface State { transport:CommandTransport; root:string; runRoot:string; lock:string; token:string; allowed:string[]; bases:Record<string,string|null> }
const owned = new WeakMap<Workspace,State>();
export function state(workspace:Workspace):State { const s=owned.get(workspace); if(!s) throw new Error('NOT_OWNED'); return s; }
export async function git(transport:CommandTransport,cwd:string,args:string[]):Promise<string> {
 const r=await transport.run({command:['git','-C',cwd,...args].map(quoteShell).join(' '),timeout:30});
 if(r.exitCode!==0) throw new Error(`GIT_BLOCKED: ${r.stderr}`); return r.stdout;
}
export function safePath(p:string):void {if(!p || isAbsolute(p)||p.split('/').some(x=>!x||x==='.'||x==='..')||p.includes('\\')||/[\x00-\x1f]/.test(p)) throw new Error('INVALID_PATH');}
export function forbidden(p:string):boolean {return p.split('/').some(x=>['.git','.start','.pi','.beads','node_modules','.npmrc','.env','.ssh'].includes(x)||x.startsWith('.env.')||/\.(pem|key)$/.test(x));}
export async function hashFile(root:string,p:string):Promise<string|null> {
 safePath(p); const target=join(root,p);
 // Never follow a symlink ancestor when checking or applying a candidate.
 let current=root; for(const part of p.split('/')) {current=join(current,part);try{if((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_BLOCKED');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') return null;throw e;}}
 try {return createHash('sha256').update(await readFile(target)).digest('hex');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export async function createWorkspace(input:{projectRoot:string;runRoot:string;taskKey:string;allowedFiles:string[];role:'coder'|'evaluator';transport:CommandTransport;scenarioFiles?:string[];interfaceFiles?:string[]}):Promise<Workspace> {
 const {transport}=input; const root=await realpath(input.projectRoot);
 if((await git(transport,root,['rev-parse','--show-toplevel'])).trim()!==root)throw new Error('AMBIGUOUS_ROOT');
 const branch=(await git(transport,root,['symbolic-ref','--short','HEAD'])).trim(); if(['main','master'].includes(branch))throw new Error('FEATURE_BRANCH_REQUIRED');
 if((await git(transport,root,['status','--porcelain'])).trim())throw new Error('DIRTY_OR_UNRESOLVED');
 if(!input.taskKey||!input.allowedFiles.length)throw new Error('ALLOWLIST_REQUIRED');
 for(const p of input.allowedFiles){safePath(p);if(forbidden(p))throw new Error('FORBIDDEN_SCOPE');}
 const inventory=(await git(transport,root,['ls-files','--stage','-z'])).split('\0').filter(Boolean);
 const paths:string[]=[];
 for(const entry of inventory){const [info,p]=entry.split('\t');if(!p)throw new Error('INVALID_INVENTORY');safePath(p);if(info?.startsWith('160000'))throw new Error('SUBMODULE_BLOCKED');if(!info?.endsWith(' 0'))throw new Error('UNRESOLVED');
 if((await lstat(join(root,p))).isSymbolicLink()){const dest=resolve(dirname(join(root,p)),await readlink(join(root,p)));if(relative(root,dest).startsWith('..'))throw new Error('ESCAPING_SYMLINK');throw new Error('SYMLINK_UNSUPPORTED');}
 if(input.role==='coder'&&!forbidden(p))paths.push(p);
 }
 if(input.role==='evaluator') {if(!input.scenarioFiles?.length||!input.interfaceFiles?.length)throw new Error('EVALUATOR_INTERFACE_REQUIRED');for(const p of [...input.scenarioFiles,...input.interfaceFiles]){safePath(p);if(!inventory.some(e=>e.endsWith('\t'+p))||p.split('/').includes('.git'))throw new Error('INVALID_EVALUATOR_FILE');paths.push(p);}}
 const common=resolve(root,(await git(transport,root,['rev-parse','--git-common-dir'])).trim());
 const locks=join(common,'sdd-task-locks');await mkdir(locks,{recursive:true});if(await realpath(locks)!==locks)throw new Error('LOCK_PATH_ESCAPES');
 const lock=join(locks,createHash('sha256').update(input.taskKey).digest('hex'));const token=randomUUID();
 try{await writeFile(lock,JSON.stringify({token,pid:process.pid,sessionId:token,taskKey:input.taskKey}),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('TASK_LOCKED: reconcile owner explicitly');throw e;}
 const runRoot=await realpath(input.runRoot);let path:string|undefined;
 try {path=await mkdtemp(join(runRoot,'workspace-'));const baseFiles:Record<string,string|null>={};
 for(const p of paths){await mkdir(dirname(join(path,p)),{recursive:true});await writeFile(join(path,p),await readFile(join(root,p)),{mode:(await lstat(join(root,p))).mode});baseFiles[p]=await hashFile(root,p);}
 for(const p of input.allowedFiles)baseFiles[p]=await hashFile(root,p);
 await git(transport,path,['init','-b','worker']);await git(transport,path,['add','--all']);await git(transport,path,['-c','user.name=SDD','-c','user.email=sdd@localhost','commit','--allow-empty','-m','Isolated baseline']);
 const workspace={workspaceId:token,path,sourceRevision:(await git(transport,root,['rev-parse','HEAD'])).trim(),baseFiles};
 owned.set(workspace,{transport,root,runRoot,lock,token,allowed:[...input.allowedFiles],bases:{...baseFiles}});return workspace;
 }catch(e){if(path)await rm(path,{recursive:true,force:true});await unlink(lock);throw e;}
}
export async function destroyWorkspace({workspace,keepEvidence}:{workspace:Workspace;keepEvidence:boolean}):Promise<void>{
 const s=state(workspace);if(keepEvidence)return;
 if(await realpath(workspace.path)!==workspace.path||dirname(workspace.path)!==s.runRoot)throw new Error('NOT_OWNED');
 const owner:unknown=JSON.parse(await readFile(s.lock,'utf8'));if(!owner||typeof owner!=='object'||!('token'in owner)||owner.token!==s.token)throw new Error('OWNER_CHANGED');
 await rm(workspace.path,{recursive:true});await unlink(s.lock);owned.delete(workspace);
}
