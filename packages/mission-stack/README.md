# mission-stack

Personal Pi package: persistent missions in `mx`, semantic memory, the mission
workflow skills, tool-call guards, a session picker, a status bar and a few
harness extensions.

## Layout

One Pi package, grouped by domain. Each module holds its own `skills/` and
`extensions/`; `package.json` globs `modules/*/skills` and
`modules/*/extensions/*/index.ts`, so a new skill or extension only needs a
directory in the right module.

| Module | Extensions | Skills | Other |
|--------|-----------|--------|-------|
| `modules/missions/` | `mission-stack` (`/focus`, `/start`, `/land`, `/continue`, memory tools, remember-gate), `mission-workflow` (skills primer) | `missions`, `memory`, `mission-wayfinder`, `mission-execute`, `mission-debug`, `grill-me` | `mx/` (Rust CLI), `memory-server/` (Go), `protocol/Missions.md`, `contracts/`, `policies/` |
| `modules/guards/` | `guards` (push / commit / terraform gates) | | |
| `modules/sessions/` | `sidebar` (`/sessions` or Ctrl+F resume overlay, `/sidebar` alias) | | `pi-sessions` fzf CLI |
| `modules/bar/` | `pi-bar` (`/pibar` status bar) | | |
| `modules/harness/` | `context-budget` (tool-output caps, compaction backstop) | `improve-skill`, `unslop`, `technical-writing`, `typescript-best-practices` | |

## Install

Needs Node, Go and Rust (cargo). From this directory:

```bash
./install.sh
```

- Registers this checkout in `~/.pi/agent/settings.json` (or
  `$PI_CODING_AGENT_DIR/settings.json`) as a local Pi package. Skills and
  extensions load from the checkout; edit, then `/reload`.
- Moves old copies with the same names out of `~/.pi/agent/{skills,extensions}`
  into `~/.pi/agent/backups/mission-stack-<timestamp>/`.
- Builds `mx` into `~/.local/bin/` and `memory-server` into `~/.pi/bin/`,
  installs `pi-sessions` and the memory export/import scripts, and seeds
  `~/Missions.md` and the domain registry only when they are missing.

Safe to re-run. The mission store lives in `~/.missions/mx.db` (override with
`MX_DB`).

Semantic memory (`memory-server`) uses ONNX Runtime. On macOS install it with
`brew install onnxruntime`. On Linux it is untested: `mx`, `/continue`,
`/land` and the guards work without it, memory search does not.

## Test

```bash
npm test               # missions stack (incl. install.sh)
npm run test:modules   # guards, context-budget, pi-bar, sessions
npm run test:go        # memory-server
npm run typecheck
```

## Verify landing

```bash
npm test
npm run typecheck
npm run verify:land
```

`verify:land` typechecks landing hooks against the installed Pi SDK. It does not
change real missions or call a model provider.

After a normal landing, run `node scripts/audit-land.mjs YYYY-MM`. The report
shows elapsed time and time in top-level tool calls for each landing that month.
It does not break down nested calls inside `codemode`.

## Architecture

Three-layer retrieval model:
- **L1** — Native pi tools (`memory_search`, `memory_check_duplicate`, `memory_related_missions`)
- **L2** — Policy injection (always-on `<memory-policy>` in system prompt)
- **L3** — High-confidence auto-inject (≥0.85 threshold, off by default)

Plus safety primitives:
- **Remember gate** — unified duplicate verdict (shared merge/likely/related
  tiers) before `mx remember`; mx scans text fields for secrets
- **Memory guard** — known-fix surfacing on bash errors/mutations
- **Correction detector** — catches user pushback, surfaces when landing
- **Context coordinator** — one selector for all retrieval hooks (env-exact
  before semantic, shared cache/dedup/budget)
- **Environment records** — validated scoped facts in `~/.pi/agent/knowledge/environment/` (none ship)

Session handover:
- **`/continue [-e] [-r] [steering]`** (alias `/handover`) - handover + fresh
  session. One no-tool turn on the cached transcript writes a lean handover
  (the agent declares the mission via `<mission>id|none</mission>`; a
  validated epic becomes the focus), appends it as a `## Context Snapshot` via
  `mx note`, and opens a parent-linked session seeded with it. No knowledge
  capture. A handover written in the last 15 min is reused; `-r` or steering
  writes a new one. `-e` loads the first prompt in the editor instead of
  sending. The new session keeps the model and thinking level.
- **`/land [mission-id]`** - update the mission and stay in the session. The
  focused (or given, or chosen) mission's latest snapshot and children are
  preloaded into one land turn, which records missing findings and decisions,
  at most 2 cross-task lessons (dedup-checked), then saves one
  `## Context Snapshot` with `### Recorded` and `### Pending capture`. New
  children are indexed after the turn. Run `/land` then `/continue` when the
  session learned something worth keeping.
- Both queue when the agent is busy; a repeated request does not start a
  second run.

Run `/knowledge-status` for a read-only view of modules, L3 state, loaded
records, index coverage/identity and actionable failures.

## Lesson domains

Write a lesson with a prefixed key, e.g. `mx remember "..." --key aws-sso-profile`.

Lesson domains come from the lesson key prefix. The editable registry is
`~/.pi/agent/knowledge/domains.json` (seeded by `install.sh` only when missing;
your edits are kept). Without it, `memory-server` uses the bundled defaults in
`memory-server/domains.json`:

| Prefix | Domain | Prefix | Domain |
|--------|--------|--------|--------|
| `eks-` | eks | `git-` | git |
| `terraform-` | terraform | `bd-` | bd |
| `tf-` | terraform | `memory-` | memory |
| `karpenter-` | karpenter | `mq-` | mq |
| `aurora-` | aurora | `artifactory-` | artifactory |
| `iam-` | iam | `github-` | github |
| `pi-` | pi | `aws-` | aws |

Keys matching no prefix get `general`. When prefixes overlap, the longest one
wins. Format:

```json
{ "version": 1, "domains": [ { "prefix": "aws-", "domain": "aws" } ] }
```

A registry file replaces the defaults entirely. If you edit it, keep every
default mapping you still want. Prefixes and domains are lowercase
(`[a-z0-9]`, plus `-` and `_`; prefixes may also use `.`). Unknown fields,
duplicate prefixes, an empty list or a version other than 1 are errors.
Commands that classify lessons stop on an invalid registry before writing to
the index. `--domains-file <path>` selects another registry, which must exist.
Check a registry with `memory-server --validate-domains [--domains-file <path>]`.

After changing the registry, update the domains of already-indexed lessons:

```bash
memory-server --backfill-domains            # add --json for machine output
memory-server --backfill-domains --domains-file <path>
```

The backfill opens the existing index only (it never creates one) and changes
only `lessons.domain`, in one transaction. It does not call `mx` or the
embedding model, and does not touch lesson text, hashes, vectors, children,
edges or metadata. It prints the number of lessons scanned and changed, and the
change count for each new domain. Running it again changes 0.
`--sync-incremental` also refreshes domains for unchanged lessons without
re-embedding them.

## Dependencies

- `mx` CLI (Rust/SQLite, `~/.missions/mx.db`) — source of truth for missions and lessons
- `memory-server` Go binary — self-contained sqlite-vec index (bge-base-en-v1.5,
  768d) built from mx. No Python/Neo4j service; no network embedding call.

## Retained logging (honest inventory)

There is **no telemetry service** and no capture log. Missions, lessons and
the memory index are the only state mission-stack writes.
