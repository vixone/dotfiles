---
name: sdd-refactor
description: Simplify code structure, naming, duplication or dependencies while preserving observable behavior and public contracts.
disable-model-invocation: true
---
# SDD refactor

No automatic Git branch, PR or merge. Inspect current branch safety; protected/dirty or ambiguous source is a blocker, not permission to reset, stash or switch branches.

## Workflow
1. Establish a behavior baseline: actual commands, exit codes, representative outputs, side-effect ordering and public interfaces. Failing baseline blocks refactoring. Coverage gaps require user choice: add characterization tests, narrow/skip scope, or explicitly accept the risk; never weaken tests quietly.
2. Read [methods](reference/methods.md). Analyze smells, coupling, coverage, patterns and risk. For readability work emphasize complexity, clarity, structure and waste. Rank by impact then risk, deduplicate by location and sequence dependencies.
3. Present exact file allowlist, scope, techniques, tests, baseline expectations and rollback strategy. Get user approval, then delegate through sdd_worker in an isolated snapshot with explicit local context and configured refactoring role. Missing capability blocks; do not silently code outside the tracked contract.
4. Make one behavior-preserving change at a time and rerun tests after each. Public API, business logic and side-effect changes are separate work needing approval. Failed tests stop integration; discard only owned candidate changes, never reset user files.
5. Parent reviews only the allowed diff, integrates approved changes, reruns the relevant full suite and compares outputs to baseline. Record genuine logs and review evidence for the bound mission checkpoint. Worker success alone does not close an action.
6. Report before/after, skipped risks, outputs and actual test counts. Offer further review or local commit readiness; no unsolicited branch, push, PR or merge operations.
