import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
const strict={additionalProperties:false} as const;
const text=Type.String({minLength:1});
const invocation=Type.Object({command:text,args:Type.Array(Type.String())},strict);
const common={cwd:text,timeoutMs:Type.Integer({minimum:1,maximum:3600000}),scenarioIds:Type.Array(text,{minItems:1,uniqueItems:true})};
export const EvaluationConfigSchema=Type.Union([
 Type.Object({kind:Type.Literal('command'),...common,command:text,args:Type.Array(Type.String())},strict),
 Type.Object({kind:Type.Literal('service'),...common,start:invocation,readyUrl:text,readyTimeoutMs:Type.Integer({minimum:1,maximum:60000}),check:invocation},strict),
]);
export type EvaluationConfig=Static<typeof EvaluationConfigSchema>;
export const OutcomeSchema=Type.Union([
 Type.Object({kind:Type.Literal('pass')},strict),Type.Object({kind:Type.Literal('fail'),symptom:text},strict),
 Type.Object({kind:Type.Literal('error'),message:text},strict),Type.Object({kind:Type.Literal('skipped'),reason:text},strict),
]);
export type Outcome=Static<typeof OutcomeSchema>;
export const EvaluationReportSchema=Type.Object({schemaVersion:Type.Literal(1),revision:text,unitKey:text,scenarios:Type.Array(Type.Object({id:text,runs:Type.Tuple([OutcomeSchema,OutcomeSchema,OutcomeSchema])},strict)),logs:Type.Array(text)},strict);
export type EvaluationReport=Static<typeof EvaluationReportSchema>;
export function loopbackUrl(value:string):URL {
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password)throw Error('LOOPBACK_HTTP_REQUIRED');
 return url;
}
export function parseEvaluationConfig(input:unknown):EvaluationConfig {
 if(!Value.Check(EvaluationConfigSchema,input))throw Error('INVALID_EVALUATION_CONFIG');
 if(input.kind==='service')loopbackUrl(input.readyUrl);
 return input;
}
export function parseEvaluationReport(input:unknown,declaredIds?:readonly string[]):EvaluationReport {
 if(!Value.Check(EvaluationReportSchema,input))throw Error('INVALID_EVALUATION_REPORT');
 if(!input.scenarios.length)throw Error('EMPTY_EVALUATION');
 const ids=input.scenarios.map(s=>s.id);
 if(new Set(ids).size!==ids.length)throw Error('DUPLICATE_SCENARIO');
 if(declaredIds&&(new Set(declaredIds).size!==declaredIds.length||ids.length!==declaredIds.length||ids.some(id=>!declaredIds.includes(id))))throw Error('SCENARIO_MISMATCH');
 return input;
}
export function summarizeEvaluation(input:EvaluationReport){
 const report=parseEvaluationReport(input);
 const failures=report.scenarios.filter(s=>s.runs.filter(r=>r.kind==='pass').length<2);
 const total=report.scenarios.length;const passed=total-failures.length;
 return {passed,total,satisfaction:passed/total,failures};
}
