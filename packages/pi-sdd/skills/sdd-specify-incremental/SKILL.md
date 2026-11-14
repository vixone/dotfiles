---
name: sdd-specify-incremental
description: Explicit decomposition helper for a reviewed phase-gated Incremental specification, with static phase context and complete test-first task briefs.
disable-model-invocation: true
---
# Define incremental phases

Read the [plan template](template.md), [phase template](templates/phase.md), [task and validation guide](reference/task-structure.md), and [example](examples/phase-examples.md) using pi `read`. Resolve these links from this directory. This helper plans work only; it does not dispatch implementation or record task completion.

Read requirements.md, solution.md, and relevant project instructions. If either design document is absent, obtain explicit user-approved omission and enough public context to write complete briefs. Discover tests and file paths from the repository.

## Decompose deliverables

Investigate sequencing, testing, risks, and independent work through bounded local `sdd_worker` perspectives when useful. Synthesize evidence and ask through `ask_user_question` before accepting phase boundaries. Do not assume worker inheritance, web access, or nested delegation.

Each task is a logical, verifiable outcome, not a preparation step or an individual test case. Embed Prime, Test, Implement, Validate, and acceptance inside its brief. Require:

- Stable task key, title, kind, phase number, and explicit dependencies in spec.json.
- Exact affected source and test files. No directory-wide guessed scope.
- Readable references to specific requirements and solution sections.
- Exact discovered test commands with red and green intent.
- Measurable acceptance and requirement-to-task-key coverage.

Write static phase context to `plan/phase-N.md` and complete task briefs in `plan/`. Write `plan/README.md` as links to phases and briefs only. It is not a progress ledger. Use no status frontmatter or executable checkboxes. spec.json owns task identity and tier; beads owns state and verification.

## Review and validate

Review each phase with the user before defining the next. A final phase covers combined integration, required E2E, performance, and security checks as applicable. Missing E2E setup is a gap, not a passing test.

Validate unique task IDs, known dependency IDs, an acyclic graph, contiguous phases, and no backward phase dependencies through [parseSpec](../../src/spec-schema.ts). Check all local brief links, missing requirement references, unlisted phase files, complete file scopes, commands, and acceptance. A validation-gaps fixture must remain incomplete until reviewed repairs resolve its missing refs and orphan phase.

No time estimates, worker assignments, or implementation code belongs in phase context. Independent tasks may share a phase only when file scopes and dependencies permit safe parallel work. Human review gates phase advancement during execution; Markdown files never encode whether a gate passed.

Present the complete descriptor and content revision for approval before `sdd_control` materialization into the existing binding. Resume checks descriptor and beads receipts. Never infer readiness from old files. Proposed deviations require explicit approval and fresh revision approval, not silent plan edits.
