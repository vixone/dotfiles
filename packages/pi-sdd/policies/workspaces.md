# Reviewed cooperative workspaces

The parent must use a clean feature branch at the exact repository root. Dirty
or unresolved checkouts, submodules, detached HEAD and ambiguous roots block
snapshot creation. Never stash, reset or clean user files automatically.

Coder snapshots use tracked inventory, omitting .git, .start, .pi, .beads,
dependencies and recognized credential paths. Their fresh Git repository has
only a local baseline. Do not supply holdout bodies through prompts. Evaluator
snapshots require explicit scenarioFiles and interfaceFiles: supply scenarios
and runnable black-box interface only, not implementation or instructions.
Parents must review that interface inventory for source leakage. Public task
requirements and selected safe instructions belong in coder prompts.

Exact repository-relative task allowlists are mandatory. Escaping symlinks
block; all other symlinks currently block as unsupported, including links in
excluded tracked files. Special files and unsupported filesystem behavior must
be reconciled explicitly. Install dependencies only via a reviewed bounded
command in the snapshot; never copy node_modules or npm credentials.

Collect an exact changed inventory and binary-capable patch. Untracked outputs
are accepted only within the allowlist. The parent reviews all files before
integration; only the collected immutable candidate is accepted. No arbitrary
external patch or rename is trusted. Compare every changed file's recorded base
before any write; overlap stops even when Git could merge. Git apply preflight
and its default all-or-nothing application preserve unrelated parent changes.
Do not run concurrent integration or edit the parent during integration: these
operations require parent serialization. Failed snapshots and patches remain
available for diagnosis. Deletions and executable modes use Git patches.

Task locks live under Git's common control directory, including across
worktrees. They record process/session token and task key. Existing locks,
including stale or unknown owners, block until explicit reconciliation. Runtime
artifacts are not completion receipts. Use an ignored .pi/sdd/runs runRoot in
production. Cleanup accepts only the original in-process owned workspace and
verified owner lock; evidence retention leaves its claim intact. Patch evidence
is not removed with the snapshot.

This is cooperative same-user isolation, not a security sandbox. Workers can
access other same-user paths deliberately. Recognized credential exclusions
are not exhaustive secret detection: review tracked inventory before dispatch.
If hard secrecy is required, stop for a separate OS isolation design. Candidate
objects and leases are process-local; restart recovery requires explicit parent
reconciliation, never automatic adoption or deletion of unknown artifacts.
