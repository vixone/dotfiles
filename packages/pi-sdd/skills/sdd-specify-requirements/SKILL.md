---
name: sdd-specify-requirements
description: Explicit requirements helper for discovering user needs and writing reviewed product requirements with measurable, traceable acceptance criteria.
disable-model-invocation: true
---
# Write requirements

Use only for an explicitly bound spec. Read the existing requirements before changing them. This helper documents WHAT, WHY, WHO, and WHEN success is measurable. It does not implement code or start a second mission workflow.

Read the [template](template.md), [validation and focus guide](reference/requirements.md), and [example](examples/good-prd.md) through pi `read`. Resolve links from this directory. Write approved project content to requirements.md under `.start/specs/NNN-name/`.

## Discover, document, review

1. Clarify the problem, users, scale, constraints, success measures, and scope with `ask_user_question`. Explore alternatives before template filling; do not invoke a second global brainstorm.
2. Identify evidence gaps in the current section. The parent may use external search when warranted. Use `sdd_worker` only for bounded local research with selected project context. Do not assume workers inherit skill content or web tools.
3. Document the current section. Preserve already approved sections on resume. Replace clarification markers with supported findings, not plausible guesses.
4. Summarize findings and source references. Present conflicts and questions. Ask the user to approve the section, clarify a topic, or redo discovery before continuing.
5. Validate across the document. Return to discovery for unresolved gaps. Do not call an unfinished document complete.

Use MoSCoW priorities: Must, Should, Could, and Won't. Give each public requirement a stable ID and Given/When/Then criteria for happy, error, and boundary paths. For CLI or batch work, describe observable output, exit codes, idempotency, and recovery rather than inventing UI journeys.

Apply mutually exclusive, collectively exhaustive checks to personas, journeys, features, and criteria. Merge duplicate capabilities. Ensure every persona has a journey, every feature has criteria, and success metrics have tracking evidence. Public behavioral requirements remain available to coders even in Factory mode.

Keep architecture, database design, and API contracts in solution.md. Track scope omissions with separate explicit user approval and closed mission decisions. Before tier selection, require a requirement-to-task-key mapping in the task brief coverage sections. User approval is not a task verification receipt.
