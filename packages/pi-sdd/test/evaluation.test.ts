import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluationConfig, parseEvaluationReport, summarizeEvaluation } from '../src/evaluation-schema.ts';
const report = {schemaVersion:1,revision:'r',unitKey:'u',scenarios:[{id:'a',runs:[{kind:'pass'},{kind:'pass'},{kind:'fail',symptom:'bad'}]}],logs:[]};
test('remote readiness is rejected',()=>assert.throws(()=>parseEvaluationConfig({kind:'service',cwd:'.',start:{command:'node',args:[]},check:{command:'node',args:[]},readyUrl:'http://example.com',readyTimeoutMs:100,timeoutMs:100,scenarioIds:['a']}),/LOOPBACK_HTTP_REQUIRED/));
test('majority is computed and malformed evidence rejected', () => {
 assert.equal(summarizeEvaluation(parseEvaluationReport(report,['a'])).satisfaction,1);
 const failed={...report,scenarios:[{id:'a',runs:Array(3).fill({kind:'fail',symptom:'bad'})}]};
 assert.equal(summarizeEvaluation(parseEvaluationReport(failed,['a'])).satisfaction,0);
 assert.throws(()=>parseEvaluationReport({...report,scenarios:[]},['a']),/EMPTY_EVALUATION/);
 assert.throws(()=>parseEvaluationReport({...failed,satisfaction:1},['a']));
 for(const scenarios of [[{id:'a',runs:[{kind:'pass'}]}], [...report.scenarios,...report.scenarios], [{...report.scenarios[0],id:'unknown'}]]) assert.throws(()=>parseEvaluationReport({...report,scenarios},['a']));
});
