---
name: sdd-specify-meta
description: Explicit internal helper for creating, resolving, binding, and reading static SDD descriptors through TypeScript control operations.
disable-model-invocation: true
---
# Manage a specification

This is an explicit-only helper. The parent reads it when requested by the specification workflow. It does not independently start a workflow or create a mission.

Read the [management reference](reference/spec-management.md) and [navigation template](template.md). Resolve these links from this directory.

## Use the control boundary

Use `sdd_control` with an operation object. Supply the canonical projectRoot explicitly.

- `create`: supply name. The TypeScript store allocates an unused three-digit ID and creates `.start/specs/NNN-slug/` with README.md and spec.json under a creation lock.
- `read`: supply target, an ID or project-local path. Read the returned descriptor and artifacts using pi `read`.
- `status`: supply target when checking spec tasks. Read beads and branch-owned binding, not Markdown progress.
- `bind`: supply target and the explicitly chosen existing missionId. This validates the epic and branch binding without altering land-focus.
- `materialize`: supply target and the same missionId, only after explicit approval of the current revision. Stable spec/task identity reuses existing children and reconstructs partial writes.

Do not create directories through shell commands or a Python script. Do not invent additional tool operations. Use guarded file writes for approved static document changes. Validate spec.json with [parseSpec](../../src/spec-schema.ts), and compute the revision with [contentRevision](../../src/spec-store.ts). If a needed receipt or import operation is not available, report the missing capability and pause.

## Own each kind of state once

README.md contains navigation and links only. Requirements, solution, briefs, and scenarios contain static design. spec.json owns explicit tier, task definitions, artifact paths, approved omissions, and mission/task identity bindings. It never owns task completion.

Record dated choices and rationale in closed decision children of the bound mission using parent-owned mission persistence. Execution status, approvals, and verification receipts belong to beads. Do not maintain a duplicate editable decision table or update Markdown status fields.

## Resume and import

Inspect documents for unresolved clarification markers and incomplete task contracts. Suggest a continuation point, then ask through `ask_user_question` before changing approved content. An artifact's presence is not a completed task or approval receipt.

Read legacy `.start/docs`, `docs/specs`, and old filenames without moving or overwriting them. An explicit import creates a new validated descriptor, records the source reference and omission decisions, and reconciles any prior verified state. Unknown old status remains unverified. The current resolver supports `.start/specs` and `docs/specs`; unsupported legacy locations require user-selected source paths, not silent fallback or guessed control arguments.
