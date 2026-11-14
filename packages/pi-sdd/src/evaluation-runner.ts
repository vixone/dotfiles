import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loopbackUrl, parseEvaluationConfig, parseEvaluationReport, type EvaluationConfig, type EvaluationReport, type Outcome } from './evaluation-schema.ts';
function inside(root:string,path:string){const p=relative(root,path);if(p==='..'||p.startsWith('../')||isAbsolute(p))throw Error('OUTSIDE_PROJECT');}
async function stop(child:ChildProcess){
 if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
 const closed=new Promise<void>(r=>child.once('close',()=>r()));
 child.kill('SIGTERM');
 await Promise.race([closed,delay(300)]);
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 await Promise.race([closed,delay(1000)]);
 if(child.exitCode===null&&child.signalCode===null)throw Error('incomplete_cleanup');
}
async function available(url:URL){
 const server=createServer();
 await new Promise<void>((ok,no)=>{server.once('error',()=>no(Error('PORT_OCCUPIED')));server.listen(Number(url.port||80),url.hostname==='[::1]'?'::1':url.hostname,()=>ok());});
 await new Promise<void>(r=>server.close(()=>r()));
}
export interface EvaluationRequest {config:EvaluationConfig;projectRoot:string;runRoot:string;revision:string;unitKey:string;signal?:AbortSignal}
export async function runEvaluation(request:EvaluationRequest):Promise<EvaluationReport>{
 const config=parseEvaluationConfig(request.config);
 const root=await realpath(request.projectRoot);const cwd=await realpath(resolve(root,config.cwd));inside(root,cwd);
 const invocations=config.kind==='service'?[config.start,config.check]:[config];
 for(const invocation of invocations){
  if(invocation.command!==process.execPath){const executable=await realpath(resolve(cwd,invocation.command));inside(root,executable);if(/(?:aws|terraform|sh|bash|zsh)$/i.test(executable))throw Error('FORBIDDEN_COMMAND');invocation.command=executable;}
 }
 if(config.kind==='service')await available(loopbackUrl(config.readyUrl));
 await mkdir(request.runRoot,{recursive:true,mode:0o700});
 const dir=await mkdtemp(join(request.runRoot,'evaluation-'));const logs:string[]=[];const children=new Set<ChildProcess>();
 let sequence=0;
 async function start(invocation:{command:string;args:string[]},scenario:string){
  const path=join(dir,`${sequence++}.log`);logs.push(path);const log=await open(path,'wx',0o600);
  const child=spawn(invocation.command,invocation.args,{cwd,env:{PATH:'/usr/bin:/bin',TMPDIR:'/tmp',SDD_SCENARIO_ID:scenario,SDD_READY_URL:config.kind==='service'?config.readyUrl:''},stdio:['pipe',log.fd,log.fd],detached:false});
  children.add(child);await log.close();
  child.stdin?.end(JSON.stringify({scenarioId:scenario})+'\n');
  return child;
 }
 const abort=()=>{for(const c of children)c.kill('SIGTERM');};request.signal?.addEventListener('abort',abort,{once:true});
 const scenarios:EvaluationReport['scenarios']=[];
 try{
  if(request.signal?.aborted)throw Error('CANCELLED');
  if(config.kind==='service'){
   const service=await start(config.start,'');service.on('error',()=>{});
   const deadline=Date.now()+config.readyTimeoutMs;let ready=false;
   while(Date.now()<deadline&&!request.signal?.aborted){
    if(service.exitCode!==null||service.signalCode!==null)break;
    try{const response=await fetch(config.readyUrl,{signal:AbortSignal.any([AbortSignal.timeout(Math.min(200,config.readyTimeoutMs)),...(request.signal?[request.signal]:[])])});await response.body?.cancel();if(response.ok){ready=true;break;}}catch{}
    await delay(Math.min(50,Math.max(1,deadline-Date.now())));
   }
   if(!ready)throw Error(request.signal?.aborted?'CANCELLED':'HEALTH_TIMEOUT');
  }
  for(const id of config.scenarioIds){
   const runs:Outcome[]=[];
   for(let i=0;i<3;i++){
    if(request.signal?.aborted){runs.push({kind:'error',message:'CANCELLED'});continue;}
    const child=await start(config.kind==='service'?config.check:config,id);
    const exit=new Promise<Outcome>(r=>{child.once('error',()=>r({kind:'error',message:'SPAWN_ERROR'}));child.once('close',code=>r(code===0?{kind:'pass'}:{kind:'fail',symptom:'Check exited unsuccessfully'}));});
    const controller=new AbortController();
    const outcome=await Promise.race([exit,delay(config.timeoutMs,{kind:'error',message:'CHECK_TIMEOUT'} as Outcome,{signal:controller.signal}),...(request.signal?[new Promise<Outcome>(r=>{if(request.signal?.aborted)r({kind:'error',message:'CANCELLED'});else request.signal?.addEventListener('abort',()=>r({kind:'error',message:'CANCELLED'}),{once:true});})]:[])]);
    controller.abort();await stop(child);children.delete(child);runs.push(outcome);
   }
   scenarios.push({id,runs:runs as [Outcome,Outcome,Outcome]});
  }
 }catch(error){
  for(const id of config.scenarioIds)if(!scenarios.some(s=>s.id===id)){const outcome:Outcome={kind:'error',message:error instanceof Error?error.message:'EVALUATION_ERROR'};scenarios.push({id,runs:[outcome,outcome,outcome]});}
 }finally{request.signal?.removeEventListener('abort',abort);await Promise.all([...children].map(stop));}
 const report=parseEvaluationReport({schemaVersion:1,revision:request.revision,unitKey:request.unitKey,scenarios,logs},config.scenarioIds);
 await writeFile(join(dir,'report.json'),JSON.stringify(report),{mode:0o600});return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());process.on('SIGINT',()=>controller.abort());
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const request:EvaluationRequest=JSON.parse(input);request.signal=controller.signal;
 try{console.log(JSON.stringify(await runEvaluation(request)));}catch(error){console.error(error instanceof Error?error.message:'EVALUATION_ERROR');process.exitCode=1;}
}
