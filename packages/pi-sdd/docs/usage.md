# Command reference

Use `/sdd doctor` before activation. Workflow verbs dispatch explicit skills;
loading a skill does not prove its downstream execution capabilities are ready.

| Command | Purpose |
| --- | --- |
| `/sdd specify <brief>` | Clarify requirements and solution; approve a descriptor and mission binding. |
| `/sdd brainstorm <topic>` | Explore alternatives; no implementation before design approval. |
| `/sdd validate <ID or file>` | Spec, File, Drift, Constitution, Comparison or Understanding checks. |
| `/sdd implement <ID>` | Execute the selected Direct, Incremental or Factory tier after current approval. |
| `/sdd test [all/targeted/baseline/audit]` | Discover and report tests; baseline does not fix, audit neither runs nor writes. |
| `/sdd review <scope>` | Breaking changes first, actionable severity findings and evidence. |
| `/sdd analyze <scope>` | Read-only repository research unless persistence is approved. |
| `/sdd debug <problem>` | Evidence-first diagnosis in the bound mission; diagnosis is not fix approval. |
| `/sdd refactor <scope>` | Approved file scope, behavioral baseline and reviewed changes. |
| `/sdd document <scope>` | Approved documentation, not incidental code refactoring. |
| `/sdd constitution <scope>` | Propose testable project rules; write only after approval. |

Session utilities: `/sdd doctor` inspects capabilities without providers;
`/sdd status` reports current binding; `/sdd off` clears only SDD activation.
Use `/sdd help` for parser-supported forms. `/focus` and `/land` remain the
existing mission-workflow commands; SDD does not own or replace them.

## Approval, binding and tiers

Choose the descriptor/spec and explicit mission once. There is no global
“current issue” shortcut or second editable Markdown task ledger. Requirements,
solution and topology are static `.start/specs` data; executable status belongs
in global beads. Do not infer completion from old checkboxes or artifacts.
Legacy specs require explicit non-destructive import/reconciliation. A changed
spec invalidates approval and affected verification; upgrades never silently
migrate user data.

Direct has 1–3 ordered tasks. Incremental adds review before the next phase.
Factory separates public unit contracts from private scenarios, uses reviewed
local command/HTTP evaluation and a finite total attempt budget (default five,
including the first). Failed/skipped work does not release dependencies.

The parent claims, dispatches, reviews, integrates and verifies. Worker success
is candidate evidence only. No task closes without current tests, review and
constitution gates. Single-owner session state is not permission to steal a
live project/task lease. Concurrent ownership, stale approval, unknown cleanup
or an interrupted worker requires explicit reconciliation, not automatic retry.
Cancel/pause keeps unfinished work open; timeout is not a pass. Preserve logs
and patches until owned cleanup is confirmed. No live deployment is authorized.

## Model and evaluation boundaries

Use the existing pstack exact role IDs (see compatibility); no fallback models.
Workers use low/off thinking and read/write/edit/bash only: no worker web, MCP,
skills or nested agents. Web research stays with the parent. Holdout separation
and snapshots are cooperative same-user boundaries, not malicious-worker
containment. Evaluation runs foreground-owned local processes, with bounded
readiness/check deadlines and verified cleanup; occupied ports remain untouched.

The current acceptance harness stops at missing checkpoint/authority capability.
Do not treat these intended workflows as verified end-to-end operation. See
[verification](verification.md) for the blocked paths and live handoff gates.
