export function sanitizeFeedback({failedScenarios,approvedSymptoms}:{failedScenarios:readonly unknown[];approvedSymptoms:readonly string[]}):string[] {
 // Approval is a parent boundary, not an automatic redaction claim.
 const forbidden:string[]=[];
 function collect(value:unknown):void {
  if(typeof value==='string'&&value.trim())forbidden.push(value);
  else if(Array.isArray(value))value.forEach(collect);
  else if(value&&typeof value==='object')Object.values(value).forEach(collect);
 }
 failedScenarios.forEach(collect);
 if(!approvedSymptoms.length||approvedSymptoms.length>5||approvedSymptoms.some(s=>typeof s!=='string'||!s.trim()||s.length>160||/[\r\n\u0000]/.test(s)||forbidden.some(secret=>s.toLowerCase().includes(secret.toLowerCase()))))throw Error('SAFE_FEEDBACK_REQUIRED');
 return [...new Set(approvedSymptoms.map(s=>s.trim()))];
}
