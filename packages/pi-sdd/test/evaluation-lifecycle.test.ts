import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../src/evaluation-runner.ts';
const cwd=fileURLToPath(new URL('fixtures/evaluation/',import.meta.url));
async function port(){const s=createServer(); await new Promise<void>(r=>s.listen(0,'127.0.0.1',r)); const a=s.address(); if(!a||typeof a==='string')throw Error(); await new Promise<void>(r=>s.close(()=>r()));return a.port;}
test('owned HTTP batch, timeout, hung check and cancellation clean up',async()=>{
 const root=await mkdtemp('/tmp/eval-test-');
 try {for(const mode of ['normal','unhealthy','hang','cancel']) {
 const p=await port();const controller=new AbortController();
 const config={kind:'service' as const,cwd,start:{command:process.execPath,args:['service.mjs',String(p),mode]},readyUrl:`http://127.0.0.1:${p}/health`,readyTimeoutMs:500,check:{command:process.execPath,args:[mode==='hang'?'hang.mjs':'check.mjs']},timeoutMs:300,scenarioIds:['a']};
 const timer=mode==='cancel'?setTimeout(()=>controller.abort(),100):null;
 const result=await runEvaluation({config,projectRoot:cwd,runRoot:root,revision:'r',unitKey:'u',signal:controller.signal});
 if(timer)clearTimeout(timer);
 assert.equal(result.scenarios[0]?.runs.length,3);
 const outputs=await Promise.all(result.logs.map(p=>readFile(p,'utf8')));
 if(mode==='normal')assert.equal(outputs.join('').split('SERVICE_STARTED').length-1,1);
 assert.equal(result.scenarios[0]?.runs[0]?.kind,mode==='normal'?'pass':'error');
 await assert.rejects(fetch(config.readyUrl));
 } } finally {await rm(root,{recursive:true,force:true});}
});
test('command fixture and occupied foreign port',async()=>{
 const root=await mkdtemp('/tmp/eval-test-');const s=createServer();
 try {const result=await runEvaluation({projectRoot:cwd,runRoot:root,revision:'r',unitKey:'u',config:{kind:'command',cwd,command:process.execPath,args:['command.mjs'],timeoutMs:500,scenarioIds:['a']}});assert.equal(result.scenarios[0]?.runs[0]?.kind,'pass');
 await new Promise<void>(r=>s.listen(0,'127.0.0.1',r)); const a=s.address();if(!a||typeof a==='string')throw Error();
 await assert.rejects(runEvaluation({projectRoot:cwd,runRoot:root,revision:'r',unitKey:'u',config:{kind:'service',cwd,start:{command:process.execPath,args:['service.mjs',String(a.port)]},readyUrl:`http://127.0.0.1:${a.port}`,readyTimeoutMs:300,check:{command:process.execPath,args:['check.mjs']},timeoutMs:300,scenarioIds:['a']}}),/PORT_OCCUPIED/);assert.equal(s.listening,true);
 }finally{if(s.listening)await new Promise<void>(r=>s.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
