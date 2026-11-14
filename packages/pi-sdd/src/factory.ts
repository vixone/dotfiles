import {Type,type Static} from 'typebox';
import {Value} from 'typebox/value';
import {parseSpec,type SpecDescriptor} from './spec-schema.ts';
import {parseEvaluationReport,summarizeEvaluation} from './evaluation-schema.ts';
export const FactoryConfigSchema=Type.Object({threshold:Type.Number({exclusiveMinimum:0,maximum:1}),maxAttempts:Type.Integer({minimum:1,maximum:10})},{additionalProperties:false});
export type FactoryConfig=Static<typeof FactoryConfigSchema>;
export function parseFactoryConfig(value:unknown):FactoryConfig {
 if(value&&typeof value==='object'&&!('maxAttempts' in value))value={...value,maxAttempts:5};
 if(!Value.Check(FactoryConfigSchema,value))throw Error('INVALID_FACTORY_CONFIG');
 return value;
}
export type FactoryState={key:string;status:'open'|'in_progress'|'closed';verifiedRevision:string|null;revision:string;approvalRevision:string;integratedRevision:string;failed?:boolean;skipped?:boolean};
export type FactoryDecision={kind:'dispatch'|'evaluate'|'retry';taskKeys:string[]}|{kind:'escalate';taskKeys:string[];reason:string}|{kind:'blocked';reason:string}|{kind:'complete'};
// Pure projection. Parent receipts and integrated candidate identities are mandatory.
export function decideFactory({spec,states,reports,attempts}:{spec:SpecDescriptor & {factory?:unknown};states:readonly FactoryState[];reports:readonly {report:unknown;integratedRevision:string}[];attempts:Readonly<Record<string,number>>}):FactoryDecision {
 try {
 const {factory,...base}=spec;
 parseSpec(base);
 const config=parseFactoryConfig(factory);
 if(spec.tier!=='factory'||!spec.evaluation)throw Error('FACTORY_EVALUATION_REQUIRED');
 if(new Set(states.map(s=>s.key)).size!==states.length||states.some(s=>!['open','in_progress','closed'].includes(s.status)))throw Error('INVALID_STATE');
 const ordered=spec.tasks.map(task=>{const state=states.find(s=>s.key===task.key);if(!state)throw Error('STATE_MISSING');return {task,state};});
 if(ordered.some(({state:s})=>!s.revision||!s.integratedRevision||s.approvalRevision!==s.revision))throw Error('APPROVAL_REQUIRED');
 const verified=(s:FactoryState)=>s.status==='closed'&&s.verifiedRevision===s.revision&&!s.failed&&!s.skipped;
 const parsed=reports.map(r=>({...r,report:parseEvaluationReport(r.report,spec.evaluation!.scenarioIds)}));
 if(new Set(parsed.map(r=>r.report.unitKey)).size!==parsed.length||parsed.some(r=>!spec.tasks.some(t=>t.key===r.report.unitKey)))throw Error('INVALID_REPORT_BINDING');
 if(ordered.some(({state:s})=>s.status==='closed'&&!verified(s)))throw Error('UNVERIFIED_CLOSED_TASK');
 const pending=ordered.filter(({state:s})=>!verified(s));
 if(!pending.length)return {kind:'complete'};
 const ready=pending.filter(({task,state})=>!state.failed&&!state.skipped&&task.dependsOn.every(k=>verified(ordered.find(t=>t.task.key===k)!.state)));
 if(!ready.length)throw Error('DEPENDENCIES_NOT_VERIFIED');
 const dispatch:string[]=[],evaluate:string[]=[],retry:string[]=[],exhausted:string[]=[];
 for(const {task,state} of ready){
 const count=attempts[task.key]??0;
 if(!Number.isInteger(count)||count<0||count>config.maxAttempts)throw Error('INVALID_ATTEMPTS');
 if(state.status==='in_progress')throw Error('PARENT_INTEGRATION_REQUIRED');
 if(count===0){dispatch.push(task.key);continue;}
 const evidence=parsed.find(r=>r.report.unitKey===task.key&&r.report.revision===state.revision&&r.integratedRevision===state.integratedRevision);
 if(!evidence){evaluate.push(task.key);continue;}
 if(summarizeEvaluation(evidence.report).satisfaction<config.threshold){(count>=config.maxAttempts?exhausted:retry).push(task.key);}
 }
 if(exhausted.length)return {kind:'escalate',taskKeys:exhausted,reason:'TOTAL_ATTEMPT_BUDGET_EXHAUSTED'};
 if(evaluate.length)return {kind:'evaluate',taskKeys:evaluate};
 if(retry.length)return {kind:'retry',taskKeys:retry.slice(0,2)};
 if(dispatch.length)return {kind:'dispatch',taskKeys:dispatch.slice(0,2)};
 return {kind:'blocked',reason:'PARENT_CHECKPOINT_REQUIRED'};
 }catch(error){return {kind:'blocked',reason:error instanceof Error?error.message:'INVALID_FACTORY_INPUT'};}
}
