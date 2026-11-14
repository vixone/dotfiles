import { parseSpec, type SpecDescriptor } from './spec-schema.ts';
import type { ChildIssue } from './beads-schema.ts';

export type ExecutionStep = {kind:'approval_required';reason:string} | {kind:'dispatch';taskKeys:string[]} | {kind:'phase_review';phase:number} | {kind:'reconcile';taskKeys:string[];reason:string} | {kind:'complete'} | {kind:'blocked';reason:string};
// Beads owns status. This projection deliberately uses its existing issue shape,
// not a second mutable task-state ledger. Receipt metadata is parent-written.
type State = Pick<ChildIssue,'id'|'status'|'metadata'>;
function receipt(value:unknown,revision:string,tier?:string,phase?:number):boolean {
 if (!value || typeof value!=='object') return false;
 const r=value as Record<string,unknown>;
 return r.revision===revision && r.approvalSource==='user' && typeof r.approvedAt==='string' && !!r.approvedAt && (tier===undefined||r.tier===tier) && (phase===undefined||r.phase===phase);
}
export function nextExecutionStep({spec,states,approval,phaseApprovals,currentRevision}:{spec:SpecDescriptor;states:readonly State[];approval:unknown;phaseApprovals:readonly unknown[];currentRevision:string}):ExecutionStep {
 try {parseSpec(spec);} catch(e) {return {kind:'blocked',reason:(e as Error).message};}
 if(spec.tier==='unselected'||!receipt(approval,currentRevision,spec.tier))return {kind:'approval_required',reason:'Current explicit tier and user revision approval required'};
 if(spec.tier==='factory')return {kind:'blocked',reason:'Factory requires its evaluation scheduler'};
 if(!spec.binding)return {kind:'blocked',reason:'SPEC_NOT_BOUND'};
 if(new Set(states.map(s=>s.id)).size!==states.length||states.some(s=>!['open','in_progress','closed'].includes(s.status)))return {kind:'blocked',reason:'INVALID_BEADS_STATE'};
 const ordered=spec.tasks.map(t=>({task:t,state:states.find(s=>s.id===spec.binding!.taskIds[t.key])}));
 if(ordered.some(t=>!t.state))return {kind:'blocked',reason:'BOUND_TASK_MISSING'};
 const verified=(s:State)=>s.status==='closed' && s.metadata?.verifiedRevision===currentRevision;
 const interrupted=ordered.filter(({state:s})=>s!.status==='in_progress'||(s!.status==='closed'&&!verified(s!))||s!.metadata?.failedTests===true);
 if(interrupted.length)return {kind:'reconcile',taskKeys:interrupted.map(t=>t.task.key),reason:'Interrupted candidate, failed tests or stale verification requires parent reconciliation'};
 if(ordered.some(({state:s})=>!verified(s!)&&Number(s!.metadata?.failedReviewCycles)>=3))return {kind:'blocked',reason:'REVIEW_ESCALATION_REQUIRED'};
 const phases=spec.tier==='incremental'?[...new Set(spec.tasks.map(t=>t.phase!))].sort((a,b)=>a-b):[];
 for(const phase of phases){
  if(ordered.filter(t=>t.task.phase===phase).every(t=>verified(t.state!))){
   if(!phaseApprovals.some(r=>receipt(r,currentRevision,undefined,phase)))return {kind:'phase_review',phase};
  }else break;
 }
 if(ordered.every(t=>verified(t.state!)))return {kind:'complete'};
 const phase=phases.find(p=>ordered.some(t=>t.task.phase===p&&!verified(t.state!)));
 const ready=ordered.filter(t=>t.state!.status==='open'&&(phase===undefined||t.task.phase===phase)&&t.task.dependsOn.every(k=>{const dep=ordered.find(d=>d.task.key===k);return !!dep&&verified(dep.state!);}));
 return ready.length?{kind:'dispatch',taskKeys:ready.slice(0,2).map(t=>t.task.key)}:{kind:'blocked',reason:'DEPENDENCIES_NOT_VERIFIED'};
}
