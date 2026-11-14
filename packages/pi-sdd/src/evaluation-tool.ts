import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseSpec } from './spec-schema.ts';
import { contentRevision } from './spec-store.ts';
import { parseEvaluationReport, summarizeEvaluation } from './evaluation-schema.ts';
const params=Type.Object({specPath:Type.String(),unitKey:Type.String(),revision:Type.String()},{additionalProperties:false});
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function createEvaluationTool(options:{owned:Set<AbortController>}):ToolDefinition<typeof params>{
 return {name:'sdd_evaluate',label:'SDD evaluate',description:'Run a reviewed descriptor evaluation contract as one owned foreground local batch. Outputs private evidence paths and computed counts.',parameters:params,
 async execute(_id,input,signal,_update,ctx){
 const controller=new AbortController();options.owned.add(controller);
 const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
 try{
 const spec=parseSpec(JSON.parse(await readFile(input.specPath,'utf8')));
 if(!spec.evaluation)throw Error('EVALUATION_CONTRACT_REQUIRED');
 if(!spec.tasks.some(t=>t.key===input.unitKey))throw Error('UNKNOWN_UNIT');
 const revision=await contentRevision({projectRoot:ctx.cwd,spec});if(revision!==input.revision)throw Error('STALE_REVISION');
 const request={config:spec.evaluation,projectRoot:ctx.cwd,runRoot:join(ctx.cwd,'.pi/sdd/runs'),revision,unitKey:input.unitKey};
 const runner=fileURLToPath(new URL('./evaluation-runner.ts',import.meta.url));
 const command=`printf %s ${quote(JSON.stringify(request))} | ${quote(process.execPath)} ${quote(runner)}`;
 const outcome=await ctx.executeTool('bash',{command,timeout:Math.ceil((spec.evaluation.timeoutMs*spec.evaluation.scenarioIds.length*3+(spec.evaluation.kind==='service'?spec.evaluation.readyTimeoutMs:0)+10000)/1000)},{signal:combined});
 if(outcome.isError)throw Error('EVALUATION_TRANSPORT_FAILED');
 const text=outcome.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 const report=parseEvaluationReport(JSON.parse(text),spec.evaluation.scenarioIds);
 if(report.revision!==revision||report.unitKey!==input.unitKey)throw Error('EVALUATION_IDENTITY_MISMATCH');
 const summary=summarizeEvaluation(report);
 return {content:[{type:'text',text:JSON.stringify({passed:summary.passed,total:summary.total,satisfaction:summary.satisfaction,logs:report.logs})}],details:{report}};
 }finally{options.owned.delete(controller);}
 }};
}
