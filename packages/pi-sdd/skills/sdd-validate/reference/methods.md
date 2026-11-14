# Validation methods

## 3Cs and ambiguity
Completeness checks required populated sections, artifacts, unresolved clarification markers and unfinished implementation. Consistency checks terminology, contradictions, links and requirement-to-component-to-task traceability. Correctness checks user-confirmed decisions, feasible dependencies, testable acceptance and sound contracts. Static briefs and beads receipts replace executable Markdown checkboxes; README is navigation only.

Coverage assesses depth: measurable nonfunctional targets, edge cases, errors, complete types and security requirements. Flag hedges (should/might/could), vague quantities (fast/many), open-ended lists, unnamed actors and weak verbs. Ambiguity score is matched vague statements / total statements × 100, with actual denominator shown: 0–5 excellent, 5–15 acceptable, 15–25 clarify, above 25 high ambiguity. Empty input has no meaningful score. Propose metrics, boundaries, exhaustive lists and named actors rather than mechanical replacement of legitimate uncertainty.

## Drift and comparison
Extract functional requirements, interfaces, models, business and quality rules. Map each to implementation and test assertions. Compare signatures, request/response fields, status codes, configuration values and architecture boundaries. Search synonyms and abstractions before marking Missing. Name Scope Creep, Missing, Contradicts and Extra separately. Security/data-integrity gaps and breaking contracts have highest urgency. Annotations can aid traceability but are not proof. No progress or drift ledger in README: parent records acknowledged, resolved or deferred decisions in bound mission evidence. Acknowledgment never overrides constitution or acceptance gates.

Comparison report: source, reference, requirement, implementation path/line, observed behavior, status and deviation recommendation. Understanding report: subject, correct points, partial points with clarification, misconceptions with source-backed correction. Avoid invented precision scores.

## Constitution checks
Parse category headings, rule headings and YAML fields level, pattern OR check, scope, optional excludes and message. Match scoped files, apply regex or evidence-backed semantic checks, collect path/line and minimal redacted snippets. Invalid rules/regex, failed reads or incomplete scopes are blockers to a complete compliance claim. No constitution means report absence, not invented compliance. Scopes matching no files require explicit explanation.

Report L1 candidate repairs, L2 manual findings and L3 advisories separately, with rule IDs and evidence paths. L1/L2 cannot be skipped to close a task; L1 repair needs reviewed approval. Never reproduce secrets in report snippets.

## Example
A requirement names email and SMS but solution only implements email: Consistency FAIL, cite both sections and propose SMS design or separately approved requirement revision. A vague retry rule: Coverage WARN, propose explicit count/backoff/timeout. A missing required security check remains blocking rather than an acknowledged drift shortcut.
