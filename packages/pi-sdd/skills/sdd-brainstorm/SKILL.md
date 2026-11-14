---
name: sdd-brainstorm
description: Clarify an idea, explore design alternatives, or revise a proposed feature before implementation in an explicitly bound SDD mission.
disable-model-invocation: true
---
# SDD brainstorm

## Constraints
Require design approval before implementation. Do not write code, scaffold, dispatch implementation workers or create scratch plans during exploration. Cancellation means no writes. Do not run a second global brainstorm or write docs/plans scratch files. Existing approved design can be resumed without restarting the ceremony.

## Workflow
1. Read project context and the current SDD binding through sdd_control; compare any focused mission without changing its state. Clarify ambiguous identity with the user. Load Missions.md before persistence.
2. Clarify intent, users, constraints and success criteria one question at a time. Use installed ask_user_question when available; otherwise ask conversationally and pause. Do not treat technology suggestions as settled decisions.
3. Present 2–3 alternatives with trade-offs, recommendation and YAGNI rationale. Keep new unrelated scope in a parking lot.
4. Present architecture, interfaces, data flow, failure handling and tests in sections scaled to complexity. Ask for explicit approval of the complete design and intended binding. Revision or cancellation is not approval.
5. On approval, materialize exactly once in the explicit SDD binding. Reuse its mission; use stable descriptor task keys and idempotent materialization rather than creating duplicate children. Hybrid design artifacts under .start/specs require the user's reviewed path/content choice. Beads owns decisions and executable actions, not a second Markdown ledger. If approval/materialization capability is unavailable, report blocked; never manufacture receipts or use shell-created task graphs.
6. Summarize approved design, task IDs, files, tests and unresolved questions. Offer SDD specification/execution handoff, not immediate coding. Do not ask again whether to create the already-approved mission.
