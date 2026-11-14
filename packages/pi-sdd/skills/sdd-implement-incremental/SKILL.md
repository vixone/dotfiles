---
name: sdd-implement-incremental
description: Execute the current approved phase with beads task identity, verified checkpoints and explicit human transition gates.
disable-model-invocation: true
---

Follow the [isolated parent-owned execution loop](../sdd-implement-direct/SKILL.md), including locks, exact prompts, sdd_worker, separate collection/review/integration, actual combined tests and parent checkpoints. Incremental task count is not limited to three; concurrency remains bounded.

Read the explicit descriptor phase graph and beads receipts first. Load only current phase context, its task briefs, referenced public specification sections and relevant prior public evidence. Do not preload future phase documents. Missing phase context/briefs blocks; do not fall back to Direct. Task identity and status come from beads, never Markdown checkboxes. Do not write status frontmatter or progress checklists.

At every phase boundary report observed test results, drift (Scope Creep, Missing, Contradicts, Extra), constitution and blockers. Ask the user through installed ask_user_question: Continue, Pause, Review output or Revise. Cancellation/escape means pause. Continue requires a persisted current-revision user phase receipt; absence keeps phase_review. Pausing does not close unfinished tasks. Resume reloads beads and revision, skips only verified closed work and reconciles interrupted workers; never adopts another session's process.

Requested revisions return to the current task's authorized scope and red/green verification. Three failed review/fix cycles per task trigger escalation, not another automatic attempt. Changed specifications invalidate approvals; reconcile and obtain fresh approval. Tests must pass with logs and L1/L2 findings must be resolved before any checkpoint. No mutable Markdown progress or default-pass review adapters.

Final report includes completed/remaining phases, task IDs, source revision, commands, pass/fail/skip counts, drift and blockers. Offer local commit readiness only. No live deployment, automatic push, PR or merge.
