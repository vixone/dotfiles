---
name: sdd-implement
description: Resolve an approved specification descriptor and route explicit Direct or Incremental execution without guessing from artifacts.
disable-model-invocation: true
---

Use sdd_control read with the explicit project root and target. Read spec.json, not artifact-presence heuristics. Unselected, ambiguous, legacy or stale descriptors require user approval/import; never infer a tier. An arbitrary external plan may be imported into a new bound specification with approved briefs without modifying its source. Missing usable context is an error.

Show spec ID, explicit tier, bound mission and content revision. Execution requires persisted user approval of this revision, not the invocation itself. Dispatch exactly one helper: [Direct](../sdd-implement-direct/SKILL.md) or [Incremental](../sdd-implement-incremental/SKILL.md). Factory requires its separate evaluation workflow; stop if unavailable. Do not code in the parent or silently downgrade tiers.

Missing beads, worker, model role, approval, claim or checkpoint capability blocks execution. Present unresolved capabilities honestly; never substitute untracked coding. Existing mission and session controls remain unchanged.
