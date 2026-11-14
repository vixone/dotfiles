---
description: Semantic index over mx missions knowledge. Surfaces related lessons and prior art from past missions. Use at mission start to check what's been learned before, and before `mx remember` to detect duplicates.
---

# Memory Skill — Mission Knowledge Graph

## Purpose

Cross-mission recall and dedup detection. The graph stores **lessons** (from
`mx memories`) and **mission children** (findings/decisions/actions) as embedded
vectors, with pre-computed similarity edges connecting related knowledge across
mission silos.

## When to Use

### Automatic (handled by the system — no manual action needed)

1. **At /focus** — prior art injected into system prompt automatically.
2. **After each `mx remember --key ...`** — the remember-gate's `tool_result`
   hook indexes that single lesson into the graph (`--add-lesson`).
3. **After /land** — the `agent_end` hook indexes the focused mission's new
   children (`--add-children`). Note: this does NOT re-index lessons — those
   are covered by the per-`mx remember` hook above. If a lesson index ever
   fails (you'll see a warning), run `memory-server --add-lesson <key>` to backfill.
4. **Before `mx remember`** — the remember-gate blocks duplicates (the
   `likely`/`merge` verdict tiers). The CLI refuses detected secrets. You can
   still call `memory_check_duplicate` to preview what the gate will do.
5. **On errors/mutations** — the memory-guard appends known fixes to bash
   results when relevant (≥0.70 score).
6. **High-confidence auto-inject** — when L3 is enabled, ≥0.85 hits surface
   in the system prompt without you asking.

### On-demand (only when asked)

- `memory-server --sync-incremental` — reconcile the index if a post-/land
  update failed or the index is behind. Normal indexing is automatic.

## Available Tools

### Native pi tools (preferred — always available, no connection step)

| Tool | Use for |
|------|--------|
| `memory_search` | Semantic search over lessons + mission children. Accepts `query`, optional `domain`, `type_filter`. |
| `memory_check_duplicate` | Pre-`mx remember` dedup preview. Pass `text` and optionally `proposed_key`. |
| `memory_related_missions` | Find which past missions touched similar ground. |

### Reindexing (there is no separate MCP server)

The native tools above are registered directly by the `mission-stack`
extension (`memory-tools.ts`). There is no Python `agent-memory` MCP server to
connect to. Reindexing is the `memory-server` Go binary's job:

| Need | Command |
|------|---------|
| Index one new lesson | `memory-server --add-lesson <key>` (auto after `mx remember`) |
| Index a mission's new children | `memory-server --add-children <mission-id>` (auto after `/land`) |
| Full rebuild from mx | `memory-server --sync` (re-embeds the whole store; allow time and memory). |

## Domains (for filtering)

Write lessons with a prefixed key (`mx remember "..." --key aws-sso-profile`); the
prefix sets the domain used by `memory_search({ domain })`. There is no `mx --domain` flag.

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

## Example usage patterns

```
# Semantic search (native tool — preferred)
memory_search({ query: "EKS nodegroup taint rollout", domain: "eks" })

# Pre-mx-remember dedup check
memory_check_duplicate({ text: "KEDA ScaledObjects must be deleted...", proposed_key: "keda-scaledobject-deletion-order" })

# Cross-mission recall
memory_related_missions({ query: "palo alto firewall whitelisting rules" })

# Incremental index (normally automatic; run only after a pending-reconcile warning)
memory-server --add-children <mission-id>
```

## What's in the graph

| Node type | Source | What it captures |
|-----------|--------|------------------|
| lesson | `mx memories` | Reusable operational insights, keyed by domain-slug |
| mission child | `mx children` across all epics | Findings, decisions, actions — the "what happened" record |
| mission | Top-level mission metadata | Containers for children |

For current counts (lessons / children / missions) run `/knowledge-status`; do
not rely on hardcoded totals in docs.

**Edges:**
- `SIMILAR_TO` (lesson↔lesson, score > 0.85) — dedup candidates
- `RELATED_ACROSS` (child↔child across different missions, score > 0.80) — cross-mission connections
- `BELONGS_TO` (child→mission) — structural

## Integration with /land

After `/land` records findings/decisions and `mx remember` entries, the
incremental `--add-children` index runs automatically in the `agent_end` hook.
No manual action.

## Configuration

- Backend: `memory-server` Go binary (`~/.pi/bin/memory-server`) over sqlite-vec.
- Index: `~/.pi/state/memory.db` (rebuildable; not the source of truth).
- Embeddings: `bge-base-en-v1.5` (768d); model cache under `~/.pi/state/models`.
- Native tools: registered by the `mission-stack` extension. No Neo4j, no Python, no MCP server.
- Source of truth: `mx` (memories + mission children). The index is derived.

## Capture routing and reliability (mission-927.11)

`knowledge-capture.ts` proposes where new input belongs (environment fact /
lesson / mission child / transient) and validates per type: environment facts
need scope + source, lessons need the durable-rule rubric. It never persists on
its own - use `mx remember` (pi dedup gate, CLI secret scan).

Successful `mx remember` is indexed with tracked retry; a persistent failure is
reported as `pending-reconcile` (re-run `memory-server --add-lesson <key>` to
backfill one lesson), not a silent fire-and-forget. The CLI scans text fields
on writes, even from scripts, but regexes are not a complete secret boundary.
See `policies/knowledge-capture.md`.

## Read-only status/explain (mission-927.12)

Run `/knowledge-status` for a read-only snapshot: active modules, L3 state
(off by default), loaded environment records, index coverage (lessons/children/
missions + last reconciliation), model/schema/binary identity, and actionable
failures (index not built, partial sync, schema mismatch). It never writes or
embeds - it reads `memory-server --status --json`.

The backend is the `memory-server` Go binary over sqlite-vec (bge-base-en-v1.5,
768d), built from mx. Duplicate detection uses one calibrated verdict
(merge/likely/related), not a lone 0.88 threshold.
