# Context selection policy

Editable behavioral policy for the context-coordinator (mission-927.10). Code
reads only the numeric knobs from `stack-config.ts`; this file documents the
rules and rationale so they can be tuned without hunting through TypeScript.

## Signal sources

All retrieval hooks submit to one selector rather than each doing their own
retrieval:

- **prompt** (before planning) - load applicable context before the agent plans.
- **focus** - a `/focus` or focused-mission change; resets session dedup so new
  context rehydrates.
- **repo / file** - first contact with a system or file path.
- **tool** - tool-result context for later reasoning.
- **error** - known-fix lookup on a failed command.

## Priority

1. **Exact scoped environment match wins.** If the query resolves to an
   environment record by id / alias / scope-alias / `id#scope` path, inject that
   fact and skip semantic search. A concrete environment fact beats a guess.
2. **Semantic fallback** only when there is no exact environment match, and only
   above `minSemanticScore`. Generic historical similarity is not current
   applicability; low-score hits are dropped so unrelated queries return zero
   context.

## Budget, dedup and cache

- One **token budget** per session (`tokenBudget`); once spent, no more
  injection this session.
- **Session dedup**: a key is injected at most once per session. A focused
  mission change or a resume/fork/compaction clears dedup.
- A short **retrieval cache** (`cacheTtlMs`) means several hooks reacting to the
  same turn don't re-query the graph.

## Failure and safety

- Retrieval timeout or a malformed/errored response injects **nothing** and is
  **not cached**, so first contact can retry later (state never suppresses
  retries forever after a failure).
- The coordinator only decides what *context* to add. It never bypasses the
  existing preflight/safety gates (remember-gate, guards). Consequential calls
  still pause on a missing prerequisite via those gates.
- Keep a small, stable overview + safety rules always available; do not churn
  the cached system prefix and do not add a per-tool LLM classification call.
- L3 auto-injection stays opt-in / off by default.

## Inspectability

Every decision records a `reason` (`env-exact`, `semantic`, `no-match`,
`deduped`, `budget-exhausted`, `retrieval-timeout`, `disabled`, `empty-query`).
`recentDecisions()` exposes the last selections for debugging why context was or
was not injected.
