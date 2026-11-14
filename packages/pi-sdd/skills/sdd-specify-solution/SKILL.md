---
name: sdd-specify-solution
description: Explicit design helper for creating reviewed architecture, interfaces, data models, and testable system criteria from approved public requirements.
disable-model-invocation: true
---
# Design the solution

This helper produces static design only. Read the [template](template.md), [design guide](reference/solution.md), and [architecture examples](examples/architecture-examples.md) using pi `read`. Resolve bundled links from this directory.

Read requirements.md and the current solution.md. If requirements are absent, inform the user and obtain explicit omission approval with sufficient public scope before design. Preserve approved sections and ask about pending decisions on resume. Write reviewed design to solution.md under `.start/specs/NNN-name/`.

## Explore before documenting

Explore project conventions and actual source files. Discover commands from package.json, Makefile, and test configurations rather than guessing. Present architectural alternatives and trade-offs through `ask_user_question`. Follow the user's selected approach, including rejection of a proposed architecture.

Use at most two bounded local `sdd_worker` research perspectives concurrently when independent investigation adds evidence. Provide the relevant methods and exact source scope in each prompt. The parent alone may use warranted `web_search` or `fetch_content`. Missing worker or model capabilities block research delegation.

Require findings to explain the mechanism, why it fits this project, and its effect on dependencies, migration, complexity, and tests. A pattern name without a concrete data or control flow is insufficient. Summarize conflicts with evidence instead of dumping transcripts.

## Document and confirm

Document constraints, strategy, components, directory mapping, external and internal interfaces, data ownership, runtime flows, errors, deployment constraints, quality targets, and risks. Mark irrelevant sections as approved no-change scope instead of inventing infrastructure. Strategic examples may clarify complex logic but do not authorize implementation.

For SQL examples, verify real column names against migrations. Include example rows and a traced walkthrough of conditional logic, NULL, no-row, and zero cases.

Each architecture decision needs alternatives, rationale, trade-offs, and explicit user confirmation. Record decisions as closed mission children, and reference those IDs from the design rather than keeping a second editable decision ledger. Cancellation pauses design. Constitution changes require separate approval.

## Validate

Assign each public requirement to one component owner. Resolve overlapping responsibilities and unassigned requirements. Deduplicate interfaces, model every referenced field, and map public Given/When/Then criteria to EARS system behavior. Cover ubiquitous, event-driven, state-driven, optional, and conditional behavior as applicable.

Check naming consistency across diagrams, interfaces, directory maps, and requirements. Validate dependency direction and error paths. Compare against CONSTITUTION.md when present; blocking L1 or L2 findings prevent readiness. Present unresolved questions and measured validation gaps to the user before requesting solution approval and tier selection.
