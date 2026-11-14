---
name: sdd-analyze
description: Explain repository mechanisms, business rules, architecture, auth flows, integrations, data models or performance with source evidence.
disable-model-invocation: true
---
# SDD analyze

Default to read-only research and preview. Persistence needs review of exact content and paths; analysis never authorizes implementation or documentation writes.

## Workflow
1. Resolve the target and SDD binding with sdd_control. Read relevant source end-to-end. Clarify broad scope before investigation.
2. Read [methods](reference/methods.md). Select business, technical, security, performance, integration or data lenses. For bounded independent research use sdd_worker with explicit local context and configured research roles. Workers have no automatic skill loading, web/MCP or nested workers; missing capabilities block delegation rather than inventing agents.
3. Require What / How / Why for each discovery with actual file:line evidence. Mark inferred rationale as uncertain. Explain guards, state transitions, dependencies and failure paths, not just pattern names.
4. Summarize workers' relevant findings with references, deduplicate by evidence, and explain cross-cutting risks. Recommend the clean solution first with affected files, migration, scope and open questions; alternatives are available on request.
5. Present a read-only preview. Ask whether to deepen, continue, finish or review persistence. Approved maintainable project docs belong in docs/patterns, docs/interfaces or docs/domain. Mission findings/decisions belong to beads. Reusable global lessons need memory_check_duplicate, the knowledge rubric and explicit user approval before bd remember; never persist secrets or duplicate every project fact into both stores. Missing persistence tools means proposal only.
