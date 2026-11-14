import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decideFactory} from '../src/factory.ts';
import {makeSpec} from './helpers/spec.ts';
const spec={...makeSpec(),tier:'factory' as const,factory:{threshold:1,maxAttempts:2},evaluation:{kind:'command' as const,cwd:'.',command:'node',args:[],timeoutMs:1000,scenarioIds:['secret']},tasks:['a','b','c'].map(key=>({...makeSpec().tasks[0]!,key,scenarios:['scenario.md'],dependsOn:key==='c'?['a']:[]}))};
const states=['a','b','c'].map(key=>({key,status:'open' as const,verifiedRevision:null,integratedRevision:'candidate',approvalRevision:'spec',revision:'spec'}));
const report=(key:string,pass:boolean)=>({integratedRevision:'candidate',report:{schemaVersion:1 as const,revision:'spec',unitKey:key,scenarios:[{id:'secret',runs:[{kind:pass?'pass':'fail',symptom:'private'},{kind:pass?'pass':'fail',symptom:'private'},{kind:pass?'pass':'fail',symptom:'private'}]}],logs:[]}});
// Passing outcomes cannot carry symptom fields.
const good={integratedRevision:'candidate',report:{schemaVersion:1,revision:'spec',unitKey:'b',scenarios:[{id:'secret',runs:[{kind:'pass'},{kind:'pass'},{kind:'pass'}]}],logs:[]}};
test('retry only failed units and exhaust total budget',()=>{
 assert.deepEqual(decideFactory({spec,states,reports:[report('a',false),good],attempts:{a:1,b:1}}),{kind:'retry',taskKeys:['a']});
 assert.equal(decideFactory({spec,states,reports:[report('a',false),good],attempts:{a:2,b:1}}).kind,'escalate');
});
test('dependencies and candidate invalidation',()=>{
 assert.deepEqual(decideFactory({spec,states,reports:[],attempts:{}}),{kind:'dispatch',taskKeys:['a','b']});
 const changed=states.map(s=>({...s,integratedRevision:'new'}));
 assert.equal(decideFactory({spec,states:changed,reports:[report('a',false),good],attempts:{a:1,b:1}}).kind,'evaluate');
});
test('verified prerequisite releases dependent, failures do not',()=>{
 const closed=states.map(s=>s.key==='a'?{...s,status:'closed' as const,verifiedRevision:'spec'}:s);
 assert.deepEqual(decideFactory({spec,states:closed,reports:[],attempts:{}}),{kind:'dispatch',taskKeys:['b','c']});
 for(const flag of ['failed','skipped'] as const){
 const failed=states.map(s=>s.key==='a'?{...s,[flag]:true}:s);
 const result=decideFactory({spec,states:failed,reports:[],attempts:{}});
 assert.deepEqual(result,{kind:'dispatch',taskKeys:['b']});
 }
});
test('forged ratios and empty checks blocked',()=>{
 for(const scenarios of [[],report('a',false).report.scenarios]){
 assert.equal(decideFactory({spec,states,reports:[{integratedRevision:'candidate',report:{...report('a',false).report,scenarios,satisfaction:1}}],attempts:{a:1}}).kind,'blocked');
 }
});
