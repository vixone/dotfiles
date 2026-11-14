---
name: sdd-implement-direct
description: Execute one to three approved task briefs through isolated workers and parent-reviewed verification, without decomposition artifacts.
disable-model-invocation: true
---

## Contract
Read the explicit descriptor, approved task briefs, referenced requirements/solution and safe project instructions. The briefs are the work contract: exact affected files, commands, red/green intent and acceptance. Direct allows 1–3 tasks; more requires an approved tier revision, never silent decomposition. Create no plan, manifest or units files. Parent never codes as a fallback.

## Parent-owned loop
Reload beads and recompute content revision before every claim. Use nextExecutionStep; closed/current verified tasks are not dispatched again. Dependents need closed prerequisites with current verification receipts, not worker success. Independent tasks are bounded to two workers by default.

Before each worker, obtain the project lock and approved claim, prepare an isolated snapshot through sdd_control workspace_prepare, and supply the exact brief plus relevant public context to sdd_worker. Resolve the configured implementation/fix/refactoring role without model substitution. Include failing test first, minimal fix, then refactor. Confirm production-critical scope with the user before dispatch. No live deploy or infrastructure apply.

After the owned worker terminates with known cleanup, use workspace_collect. The parent reads the entire diff and changed-file inventory, rejects out-of-scope changes, and separately approves workspace_integrate. These operations require a parent authority adapter; if absent stop with a blocker. succeeded is only candidate evidence, never done.

Run explicit combined test commands in the parent and retain actual exit codes/logs, pass/fail/skip counts, drift findings and constitution evidence. No default-pass adapters. L1/L2 blocks completion. Record the parent checkpoint and verification receipt in beads before closing; the control workspace operations never close tasks. If the checkpoint/claim capabilities are missing, leave the task open and report the gap.

Reconcile failed tests, cancellation, unknown cleanup, stale receipts or changed specs before the next dispatch. Fix only authorized in-scope regressions. Unrelated failures become blocked evidence and proposed follow-ups; never delete tests, weaken assertions or expand scope silently.

## Report
List task IDs, source and spec revisions, changed files, exact executed commands and actual pass/fail/skip counts, drift, constitution and blockers. Offer local commit/push readiness only, never auto-push, PR or merge.
