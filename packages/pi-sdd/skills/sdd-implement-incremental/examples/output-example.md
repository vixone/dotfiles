# Incremental resume example

Spec 003 notification API; mission m; revision r.
Phase 1: receipts verified, skipped without reading future phase context.
Phase 2: m.2 verified; m.3 interrupted, reconcile cleanup/evidence first.
After m.3 integration and passing combined tests: phase_review 2.
User chooses Pause: no phase receipt, no phase 3 dispatch.
Resume: reload beads and revision; same phase_review. User explicitly Continues and records revision-r phase-2 receipt. Only now load phase 3 briefs and dispatch its ready tasks.
Report actual commands, log paths, counts, changed files, drift and blockers. Never change phase Markdown progress.
