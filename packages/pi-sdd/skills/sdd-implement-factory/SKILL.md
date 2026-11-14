---
name: sdd-implement-factory
description: Explicit Factory orchestration with reviewed combined candidates, black-box holdouts and finite total attempt budgets.
disable-model-invocation: true
---

# Factory execution

Resolve the explicit descriptor through sdd_control. Require current user approval of decomposition, scenarios, evaluation interface, threshold and attempt budget. Legacy manifests are static topology only; beads owns status and receipts. Never update Markdown progress. Read [coding boundary](reference/code-agent.md), [evaluation boundary](reference/eval-agent.md) and [reporting](reference/output-format.md).

Validate the DAG and factory configuration: threshold >0 and <=1; maxAttempts is an integer 1..10, default 5 **total attempts including the initial run**, not five retries. The pure decideFactory helper computes actions; it starts no workers. Missing evaluation configuration or stale approval blocks execution.

Claim only dependency-ready units under the project lock. Closed prerequisites require matching verified receipts; failed, skipped and unverified prerequisites block dependents. Dispatch at most two independent coding workers by default via sdd_worker in separate allowlisted snapshots. Do not implement directly. Resume reconciles beads and candidate revisions, never adopts old live workers.

Wait for the whole group. Parent collects and reviews exact patches, rejects conflicts/out-of-scope edits, integrates approved files, and runs combined tests and L1/L2 constitution checks before evaluation. Worker success is only candidate evidence. Cancellation, service failure, unknown cleanup or conflicting patches blocks the group without closing tasks.

Evaluators author runnable black-box checks in separate workspaces through sdd_worker. Parent reviews checks and executes the explicit command/service contract via sdd_evaluate, which owns bounded foreground lifecycle and cleanup. Never guess a start command, health route or port. Never start detached services.

Use parsed exact per-scenario three-run outcomes and computed satisfaction, never evaluator prose or a supplied ratio. Empty, missing or forged results block; errors/skips remain visible. Retry below-threshold units only. Parent approves short observable symptoms through sanitizeFeedback; if none can safely be formed, escalate instead of forwarding output. Shared integrated candidate changes invalidate old affected evidence: rerun affected scenarios and full group checks, including previously passing units, without unnecessary recoding.

At maxAttempts escalate with no extra worker. Ask for a recorded new authorized budget, defer, or abort. Never silently reset counters. Deferred units remain open and their dependents blocked. Threshold success still requires parent integrated tests, review, constitution evidence and checkpoint before closure. No automatic commit, push, merge or live deployment.

Snapshot/prompt separation reduces accidental leakage only; malicious same-user access is not OS-isolated. If hard isolation is required, stop and request a separately designed sandbox.
