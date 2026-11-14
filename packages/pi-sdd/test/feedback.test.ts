import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeFeedback} from '../src/feedback.ts';
test('only reviewed symptoms cross boundary',()=>{
 const failedScenarios=[{id:'ID_SENTINEL',name:'NAME_SENTINEL',text:'BODY_SENTINEL',logs:['LOG_SENTINEL']}];
 assert.deepEqual(sanitizeFeedback({failedScenarios,approvedSymptoms:['Request fails unexpectedly.']}),['Request fails unexpectedly.']);
 assert.throws(()=>sanitizeFeedback({failedScenarios,approvedSymptoms:['NAME_SENTINEL fails']}),/SAFE_FEEDBACK_REQUIRED/);
 assert.throws(()=>sanitizeFeedback({failedScenarios,approvedSymptoms:[]}),/SAFE_FEEDBACK_REQUIRED/);
});
