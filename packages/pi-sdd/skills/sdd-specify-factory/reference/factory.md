# Factory decomposition and scenario validation

## Boundaries and size

A unit is a self-contained outcome implementable in one bounded coding session. Vertical slices, data model with consumers, cross-cutting behavior, and integration points are useful boundaries. Split unrelated outcomes; avoid per-function units that add orchestration without independent value.

Use position-independent keys. Extract shared prerequisites and minimize dependencies. Topological groups explain possible concurrency, but readiness still requires verified prerequisites during execution. Unknown dependencies and cycles are errors.

## Public coverage

Map every public requirement to at least one task key. If multiple units contribute, identify the primary owner. Every generated brief specifies files, red/green commands, references, and acceptance. Public required behavior is never hidden as a secret evaluation rule.

## Holdout coverage

Scenarios test one observable behavior each through a real external interface. Read project conventions, actual route contracts, and test patterns before writing them. Stable scenario IDs, task keys, requirement IDs, and priorities must be consistent and unique. Every unit needs at least one P0 scenario; add P1 failures and P2 boundaries as warranted.

Reject vague outcomes, fictional interfaces, internal imports, orphan scenarios, missing requirement coverage, duplicate IDs, and unknown task keys. Read every referenced path. Review all holdouts and stubs with the user before execution.

## Information boundaries

Coders receive public requirements and constraints. Evaluators receive holdout cases and the reviewed black-box contract. Neither role receives the full parent transcript. Holdouts and evaluator logs stay out of public units and beads descriptions. Feedback is a parent-reviewed short observable symptom, not a case body or secret expected value.

Separate snapshots omit holdouts and original history for coders. This reduces accidental leakage but does not prevent deliberate same-user filesystem access. If OS-enforced secrecy is required, stop and request a separately designed sandbox.

## Report

Show unit count and dependencies, scenario count and public coverage, P0 gaps, topology, configuration blockers, and current revision. User approval of the current units, scenarios, and descriptor is required; file presence is not approval. Missing E2E setup remains blocked. No guessed satisfaction or completion is allowed.
