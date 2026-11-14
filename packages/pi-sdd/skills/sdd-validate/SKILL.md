---
name: sdd-validate
description: Explicit validation of specs, files, drift, constitution rules, artifact comparisons and understanding with actionable evidence.
disable-model-invocation: true
---

# Validation

Resolve the user's target before reading selected context with pi read. Six modes:

| Mode | Context and perspectives |
|---|---|
| Spec | Approved descriptor, requirements, solution and task briefs; Completeness, Consistency, Coverage and ambiguity |
| File | Target and surrounding interfaces; Completeness, Consistency, Alignment |
| Drift | Spec plus implementation and tests; Drift, Alignment, Consistency |
| Constitution | CONSTITUTION.md and scoped files; rule compliance |
| Comparison | Both named artifacts; Alignment, Consistency, Coverage |
| Understanding | User's claim plus supporting source; Alignment and Completeness |

Read [methods](reference/methods.md). Delegate applicable independent perspectives through sdd_worker with selected explicit context and configured existing models. No inherited project instructions, skills or network access are assumed. Missing capabilities block delegation. Parent synthesizes results, not raw worker dumps.

Apply the 3Cs: Completeness, Consistency, Correctness. Every finding includes status, severity, path/line, issue and actionable recommendation. Keep structural completeness distinct from coverage depth and snapshot alignment distinct from drift. Deduplicate nearby locations, retaining highest severity and complementary evidence.

Constitution L1/L2 findings block checkpoints independently of review verdict. L1 candidate autofixes require reviewed approval; L2 requires manual resolution; L3 is advisory. Invalid rules, regex or unreadable scoped files mean incomplete checks, not success. No bypass of higher-priority safety rules or live-cloud prohibitions.

Drift classes are Scope Creep, Missing, Contradicts, Extra. Ordinary recommendations remain advisory with explicit acknowledgment; do not authorize repairs or silently expand scope. Parent records decisions in bound mission findings, never README progress. Changes to static specs invalidate revision approval.

Report counts and evidence paths. Assessment: any failure Critical; otherwise 4+ warnings Needs Attention, 1–3 Good, zero Excellent. Use ask_user_question for clarification, approved repair proposals or deferral. Cancellation pauses. Supply drift and constitution evidence to the parent's common checkpoint through existing sdd_control operations only when available; a prose pass is not completion.
