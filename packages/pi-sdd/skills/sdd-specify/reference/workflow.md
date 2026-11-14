# Research and tier selection

## Independent perspectives

| Perspective | Evidence to seek |
|---|---|
| Requirements | Personas, stakeholder goals, acceptance, error and boundary cases |
| Technical | Existing modules, constraints, dependencies, migration alternatives |
| Security | Authentication, authorization, sensitive data, compliance |
| Performance | Load, latency, throughput, capacity, bottleneck risks |
| Integration | External contracts, failure modes, data ownership |
| UX | User flows, accessibility, loading, empty and error states; omit for non-UI work |

Use only relevant perspectives. The parent interviews the user and gathers warranted external evidence. Local workers inspect explicit source context with bounded prompts. Limit concurrent research to two workers. Collect findings, deduplicate, expose conflicting recommendations, and organize evidence by requirements, solution, and decomposition section.

## Classifier

Count distinct user-facing capabilities rather than treating each acceptance criterion as a feature. Count new top-level modules or services from the design. Existing-only changes do not increase the new component count. Record acceptance count, change kind, and explicit independent work markers as well.

Apply the TypeScript [classifier](../../../src/classifier.ts) rules in order:

1. Refactor across more than two components recommends Incremental.
2. Non-feature work, existing-only changes, or no new components with at most two criteria recommends Direct.
3. At least two features, at least three components, or explicit independent work recommends Factory.
4. Other single-feature work recommends Incremental.

Show every signal and reason, then ask the user to choose among all three tiers. Overrides are allowed but Direct still requires at most three tasks. Many criteria alone do not justify Factory. A single feature with many components may justify it.

Record the tier and rationale as a closed mission decision. Do not delete old artifacts on a tier change. The descriptor selects the current tier and artifact paths. Old context remains non-authoritative and must not drive execution.

## Approval report

Show the spec path, tier, current revision, bound mission, artifact links, task keys, file scopes, dependencies, requirement coverage, omissions, and unresolved blockers. Do not give invented confidence percentages. Link local test evidence when it exists. Approval of documents authorizes materialization once into the chosen binding, not implementation completion.
