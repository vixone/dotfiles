export interface ReviewFinding {
 severity: 'critical' | 'high' | 'medium' | 'low';
 confidence: 'high' | 'medium' | 'low';
 path: string;
 line: number;
 title: string;
 issue: string;
 fix: string;
 breaking: null | { consumers: string; migration: string };
}
const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
const confidenceRank = { high: 0, medium: 1, low: 2 };
export function synthesizeReview(input: ReviewFinding[]): {
 breakingChanges: ReviewFinding[]; findings: ReviewFinding[];
 verdict: 'request_changes' | 'approve_with_comments' | 'approve';
} {
 const sorted = input.map(f => ({ ...f })).sort((a,b) => severityRank[a.severity]-severityRank[b.severity] || confidenceRank[a.confidence]-confidenceRank[b.confidence] || a.path.localeCompare(b.path) || a.line-b.line);
 const findings: ReviewFinding[] = [];
 for (const finding of sorted) {
  const existing = findings.find(f => f.path === finding.path && Math.abs(f.line-finding.line) <= 5);
  if (!existing) { findings.push(finding); continue; }
  if (!existing.issue.includes(finding.issue)) existing.issue += `; ${finding.issue}`;
  if (!existing.fix.includes(finding.fix)) existing.fix += `; ${finding.fix}`;
  if (finding.breaking) existing.breaking = existing.breaking ? {
   consumers: [...new Set([existing.breaking.consumers,finding.breaking.consumers])].join('; '),
   migration: [...new Set([existing.breaking.migration,finding.breaking.migration])].join('; ')
  } : finding.breaking;
 }
 const breakingChanges = findings.filter(f => f.breaking !== null);
 const high = findings.filter(f => f.severity === 'high').length;
 const verdict = breakingChanges.length || findings.some(f => f.severity === 'critical') || high > 3 ? 'request_changes' : high || findings.some(f => f.severity === 'medium') ? 'approve_with_comments' : 'approve';
 return { breakingChanges, findings, verdict };
}
