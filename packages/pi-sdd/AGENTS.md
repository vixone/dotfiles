# pi-sdd

## Scope and source

Implement mission-b7h in dependency order, with a review checkpoint per action.
The beads task descriptions are the plan. Do not create a second task ledger.

Work on feature/pi-sdd. The main branch contains only the empty bootstrap commit.
Do not publish, create a remote, push, open a PR, or merge.

The read-only source is ../the-startup at
88d447c7fb846f9d519faf59219cd34cf7577501. Do not modify or update it.
upstream.json is the per-file provenance record; docs/port-map.md describes
planned destinations and behavioral differences. Keep both aligned when porting.

## Host contracts

Target pi 1.0.4, Node 26 and macOS. Read the installed current pi documentation
and relevant examples completely before implementing a host integration.
Resolve the SDK release from the host, not a hard-coded older package name.
The initial documentation directory on this host is:
`~/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/docs`.

Use erasable TypeScript, strict NodeNext imports and node:test. Validate external
JSON at boundaries with typebox, then derive types from those schemas.
Keep behavioral policies in editable policies/*.md files rather than long code strings.
Host packages are peer dependencies. Development copies must not become a
second extension runtime or enter the archive.

Expose only /sdd and sdd_* tools. Keep all twenty skills namespaced and explicit-only.
Do not replace /start, /focus, /land, mission skills, pstack, guards, models,
themes, or the existing footer. Do not modify other pi packages.

Reuse installed pi-subagent through the guarded nested-tool API. Do not import
its private runner, register another subagent tool, or assume worker skill,
web, MCP, high-thinking or nested-agent support. Model IDs are exact, with
no fallback. Provider-backed tests require explicit final-stage user approval.

## State and safety

Versioned .start/specs files own static requirements, solution and decomposition.
Global beads owns executable tasks, dependencies, approvals and completion.
The descriptor links identities. It must not duplicate mutable task status.
Follow ~/Missions.md. Never use project-local .beads or global bd current.

Automated tests must use injected fake beads clients or executable fixtures.
They must never invoke real bd or touch the real global mission database.
Use disposable projects and owned, bounded local evaluation processes.
Worker workspace and holdout separation are cooperative, not an OS sandbox.
The parent reviews and verifies each patch before any task closes.

Never read, copy, log or archive credentials, including auth files.
Do not touch live infrastructure. No terraform apply/destroy or live deploy.
Do not install globally or change real pi settings without explicit approval
at the final stage. Do not auto-upgrade pi or existing packages.

## Verification

Write each task's failing tests first. Run `npm run check` before committing.
Preserve the upstream MIT notice. Review source-specific methods rather than
copying marketing text or unsupported Claude orchestration instructions.
Do not claim workflow parity, host loading or provider verification before the
corresponding checks run.
