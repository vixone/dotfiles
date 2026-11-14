# Review classification and output

Critical means security vulnerability, data loss or crash. High means significant defect or performance issue; medium maintainability or missing behavioral coverage; low minor suggestion. Confidence high is clear evidence, medium context-dependent, low tentative. Breaking is an independent contract marker naming affected consumers and concrete migration. It always requests changes even at low severity.

Always review auth/authz, injection, input boundaries, secret handling, complexity, dead code, N+1 queries, resource cleanup, error propagation, naming/pattern consistency and behavioral happy/error/boundary tests. Do not impose arbitrary line-length rules as defects without project evidence. Activate concurrency for async/shared-state races, dependencies for versions/licenses/supply chain, compatibility for public interfaces/schema/config, accessibility for UI keyboard/semantic navigation, and constitution for scoped L1/L2/L3 compliance.

Provide reviewers complete relevant files, diff, callers and public constraints. Parent merges overlapping locations within five lines with highest severity and complementary remediation; distinct non-overlapping locations remain separate. Retain breaking consumer/migration details even when a duplicate has higher severity.

Output order:
1. Target, revision, verdict and evidence scope.
2. Breaking Changes when present, BEFORE every severity table: title, path:line, Breaks (consumers), Migration (action).
3. Severity counts and critical/high, medium and low tables: ID, finding plus location, issue and remediation. Breaking rows retain a marker so totals stay honest.
4. Critical before/after examples; non-obvious high fix examples.
5. Strengths, uncertainties, verdict reasoning and authorized next steps.

Example: a low-severity payload field rename at src/api.ts:10 affects SDK clients; migration requires an adapter or coordinated SDK release. Verdict request_changes; breaking section leads, low table still includes the finding. Two high defects without breaking/critical yield approve_with_comments, not automatic permission to close despite constitution blockers.

Offer explanation, scoped repair review or follow-up proposal. Remote comments require separate authorization and approved gh host routing. Accepting a breaking change needs an explicit migration decision and revised evidence, not a hidden verdict override.
