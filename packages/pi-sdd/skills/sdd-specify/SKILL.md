---
name: sdd-specify
description: Create or resume an approved specification from a brief, with requirements, solution design, and a user-selected Direct, Incremental, or Factory tier. Use explicitly through the SDD workflow.
disable-model-invocation: true
---
# Specify a change

Run only when the user explicitly requests specification work. Inputs are the user brief, project root, and an explicit spec or mission binding. Do not infer the mission from global current state. This workflow writes static project documents, not implementation code.

## Read the methods

Use pi `read` to load the [meta helper](../sdd-specify-meta/SKILL.md). Read the [research and classifier guide](reference/workflow.md) before recommending a tier. Read the [output example](examples/output-example.md) before reporting results. Resolve bundled paths from this directory, not the project working directory.

## Initialize or resume

Use `sdd_control` with `operation.op: read` or `status` for an existing target. Use `create` with the explicit projectRoot and name for a new spec. Read the documents, descriptor, and current beads state before proposing the continuation point. File existence, old checkboxes, or model confidence do not establish approval or completion.

Ask through `ask_user_question` whether to start with Requirements, Solution, or Decomposition. Non-linear entry is allowed. If a document is omitted, show the missing input, ask for explicit approval, and record the reason in descriptor omissions and a closed decision child of the bound mission. Never keep a second decisions ledger in README. Decomposition requires enough public context for complete briefs even when a document is omitted.

## Research and document

Select relevant independent perspectives from the guide. Use at most two local-only research workers at once via `sdd_worker`, with exact models, explicit context, bounded tasks, and reviewed workspace paths. Workers cannot browse, use MCP, inherit these skills, or dispatch other workers. The parent may use `web_search` and `fetch_content` when external evidence is warranted. Missing capabilities block delegation rather than authorize invented findings.

Summarize evidence with file references, deduplicate findings, and present unresolved conflicts to the user. Do not paste raw worker transcripts into mission children.

Read the [requirements helper](../sdd-specify-requirements/SKILL.md) to document WHAT and WHY. Obtain section review and requirements approval before moving on. Read the [solution helper](../sdd-specify-solution/SKILL.md) to document HOW and WHERE. Obtain approval for architecture choices and the solution. The user may stop or revisit either document. Preserve approved content on resume.

If CONSTITUTION.md exists, compare proposed design against it. L1 and L2 findings block readiness. Propose constitution changes separately and write them only after separate user approval. Design approval does not approve constitution edits.

## Select a tier

Read requirements and solution before computing feature count, acceptance-criterion count, new component count, change kind, existing-only scope, and independent work markers. Use the TypeScript classifier in [classifier.ts](../../src/classifier.ts). Show the actual signals and rationale. Present all three options through `ask_user_question`; recommendation is not approval.

- Direct: 1–3 tasks with complete briefs, file scopes, dependencies, and test commands. No plan or manifest is required. A brief may reference a specific solution section, but its descriptor path must resolve to a file.
- Incremental: read the [incremental helper](../sdd-specify-incremental/SKILL.md). Define static phase contexts and task briefs with user phase gates.
- Factory: read the [factory helper](../sdd-specify-factory/SKILL.md). Define public units and separate reviewed holdout scenarios.

Record the chosen tier and rationale as a closed mission decision child. Leave old decomposition artifacts untouched on tier changes; select only current artifacts in spec.json and explain stale context to the user.

## Approve and materialize once

Validate descriptor paths, dependencies, complete briefs, requirement-to-task coverage, and scenario coverage. Show the exact revision, tier, file scopes, task graph, omissions, and mission identity for approval. Cancellation or absent UI pauses. No model-generated boolean counts as user approval.

Approval authorizes materialization into the explicitly bound mission exactly once. If there is no mission, choose or obtain approval for a new mission once using the existing Missions.md conventions, then bind via `sdd_control`. Do not ask a second create-mission question after design approval. Call `materialize` for that binding; it reuses stable spec/task keys on retry. It does not approve execution, verify tasks, or close them. If approval receipt support is unavailable, stop before mutation rather than invent an operation.

Use `status` to reconcile resume. A changed static revision needs fresh approval; an existing task graph is not permission to execute. Legacy specs are read non-destructively and require an explicit import and verified-status reconciliation. Never trust old progress marks.
