---
name: sdd-document
description: Audit, propose or maintain project documentation, API descriptions, diagrams and captured patterns with source evidence.
disable-model-invocation: true
---
# SDD document

Default to read-only research and draft preview. Persistence requires user approval of exact content and documentation allowlist. This is not authority to refactor implementation. Code comments require separately approved source paths.

## Workflow
1. Resolve target and binding. Search existing docs first and read source, API schemas and diagrams they describe. Audit scope runs no mutations. Identify gaps, contradictions and stale assumptions with references; do not invent coverage percentages.
2. Read [methods and templates](reference/methods.md). Choose code, API, README, architecture or capture lenses; audit determines which lenses are needed. Use bounded sdd_worker research/prose roles with selected context, explicit read-only instructions and no web/MCP assumptions.
3. Summarize worker output with file references, not raw dumps. Verify diagrams, endpoints, parameters, returns, exceptions and examples against source. Mark uncertainty and missing evidence rather than presenting guesses as contracts.
4. Preview proposed changes, including paths and deletions. Update same-topic docs rather than duplicate them. Approved patterns, interfaces and domain documents go under docs/patterns, docs/interfaces and docs/domain. Mission findings and decisions stay in beads.
5. Obtain user approval, then delegate only approved documentation edits through reviewed snapshots. Parent checks the documentation allowlist, source accuracy, relative links and project doc checks. No implementation refactoring, generated undocumented API claims or automatic remote operations.
6. For global lesson proposals, use memory_check_duplicate before bd remember, satisfy Missions.md knowledge rubric (specific, reusable, factual, non-trivial), and obtain user persistence approval. Near duplicates need reviewed merging; secrets are never persisted. If dedup is unavailable, stop at proposal. Do not put every project fact in both docs and global memory.
7. Report created/updated files, evidence, checks, uncertainties and remaining gaps; cancelled review leaves files unchanged.
