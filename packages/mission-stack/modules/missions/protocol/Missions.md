# Mission Memory Protocol

You have access to a persistent mission knowledge base via the `mx` CLI (SQLite).
This is a shared brain across all AI tools — anything recorded here is accessible
from Claude Code, Copilot CLI, Pi, Cursor, or any tool that can run bash commands.

**Activate when:** the user says "mission: <topic>", "start a mission", "check missions",
"search missions", "resume mission", or similar. Otherwise, do not proactively load mission context.

**Environment:** `MX_DB` is set in the shell profile (`~/.zshrc`) pointing to `~/.missions/mx.db`. Just run `mx` commands directly — no export needed:
```bash
mx list
mx search "topic"
```

Run `mx --help` or `mx <command> --help` for CLI flags. This document covers
**mission-specific conventions only**.

### Ironclad rules for agents

1. **Missions are global.** Keep the store at `~/.missions/mx.db`. Do not
   create a project-local mission database. `mx` uses this path by default;
   wrappers that need a different store must pass `MX_DB` explicitly.
2. **Update metadata with flags.** For example:
   ```bash
   mx update <id> --title "New title"
   mx update <id> --priority P2
   mx update <id> --add-label foo --remove-label bar
   mx update <id> --set-labels iam,finding
   mx update <id> --status closed   # or mx close <id>
   ```
3. **Pass explicit mission IDs.** Track the active mission per session (e.g.
   with pi `/focus`), not through a shared database pointer.
4. **Titles are prefixed by type.** All child issues of a mission epic start
   with one of `[finding]`, `[decision]`, `[action]`, `[question]`. This lets
   `mx children` be skimmed at a glance: open `[action]` = work left, open
   `[question]` = decision still in the way, everything closed is history.
   `[question]` tickets come from the mission-wayfinder skill. On resolution a
   question is retitled `[decision] <answer>` or `[finding] <fact>` and closed;
   a closed `[question]` was ruled out of scope (label `wf:out-of-scope`).

## Quick Reference

| Action | Command |
|--------|---------|
| **Start mission** | `mx create "Title" --type epic --labels domain1,domain2 -p 1` |
| **What's next** | `mx ready` |
| **Record finding** | `mx create "What" --parent <epic-id> --labels domain,finding -d "Details"` |
| **Record decision** | `mx create "What" --parent <epic-id> --labels domain,decision -d "Reasoning"` |
| **Record action** | `mx create "What" --parent <epic-id> --labels domain,action -d "Details"` |
| **Record lesson** | `mx remember "Reusable insight" --key domain-slug` |
| **List lessons** | `mx memories` |
| **Recall lesson** | `mx recall <key>` |
| **Forget lesson** | `mx forget <key>` |
| **Add comment** | `mx comment <id> "Chronological update"` |
| **Append summary note** | `mx note <id> "Summary update"` |
| **Search** | `mx search "query" --status all` |
| **Search by label** | `mx search "query" --label finding --status all` |
| **Search descriptions** | `mx list --all --json` then filter `.description` with `jq` |
| **Park mission** | `mx update <epic-id> --status deferred` and `mx comment <epic-id> "Resume after YYYY-MM-DD: reason"` |
| **Resume mission** | `mx update <epic-id> --status open` |
| **Close mission** | `mx close <epic-id> --reason "Summary"` |
| **Reopen mission** | `mx reopen <epic-id>` |
| **Show details** | `mx show <epic-id>` |
| **Show child without dependency bodies** | `mx show <child-id> --compact-deps --json` |
| **Mission children** | `mx children <epic-id>` |
| **Execution timeline** | `mx history <epic-id>` |
| **Epic completeness** | `mx children <epic-id>` |
| **Link missions** | `mx link <id1> <id2> --type relates_to` |

`mx show <id> --json` expands dependencies into full issues by default. A child
can repeat its parent's entire notes field in that output. Use `--compact-deps`
to keep the requested issue's full fields but limit each dependency to id,
title, status, priority, and dependency_type. Add `--include-comments` only
when comment bodies are needed. The default JSON response remains unchanged.

## Starting a Mission

```bash
# Create the mission epic
mx create "IAM Permission Boundaries" --type epic --labels iam,security -p 1

# Note the returned ID (e.g., mission-a1b2) — use it as --parent for all child issues
# Claim it to mark as actively worked on
mx update mission-a1b2 --claim
```

If the user starts with something small that grows, create the epic when scope becomes clear.
Retroactively parent earlier findings to the epic.

## Recording Knowledge

After each investigation step, capture knowledge **atomically**:

**Findings, decisions, actions** — create as child issues of the epic. These are
mission-scoped and individually searchable. Title prefix is mandatory; label
mirrors the prefix.

```bash
# Finding — something discovered during investigation (read-only history)
FID=$(mx create "[finding] Dev accounts lack permission boundaries" --parent mission-a1b2 \
  --labels iam,finding -d "Checked accounts 111, 222, 333. None have boundary policies." \
  --json | jq -r .id)
mx close "$FID"   # close immediately — it's history, not outstanding work

# Decision — a choice made, with reasoning (read-only history)
DID=$(mx create "[decision] Use permission boundaries over SCPs" --parent mission-a1b2 \
  --labels iam,decision -d "SCPs apply at account level. Boundaries give per-user control." \
  --json | jq -r .id)
mx close "$DID"

# Action — work to do, in progress, or done. STAYS OPEN until actually executed.
mx create "[action] Roll out the new config" --parent mission-a1b2 \
  --labels iam,action -d "Roll the new config out to staging, then prod."
# ... later, when done:
# mx close mission-a1b2.N
```

**Why close findings/decisions immediately?** They are immutable history.
Keeping them "open" makes `mx children <epic>` useless for answering
"what's left to do?" — the only legitimate open children are `[action]`
items not yet executed and `[question]` tickets not yet resolved.

**Lessons** — use `mx remember` instead of child issues. Lessons are cross-mission
knowledge that should surface in every future session. **Every lesson must
pass the Knowledge Quality Rubric below before being stored.**

```bash
# Lesson — reusable knowledge for future missions
mx remember "Tags set in org root don't always propagate — verify per-account" \
  --key iam-tag-propagation

# The key prefix sets the indexed domain (see ~/.pi/agent/knowledge/domains.json).
# Defaults: eks- terraform- tf- karpenter- aurora- iam- pi- git- bd- memory- mq-
# artifactory- github- aws-. Other prefixes (e.g. s3-) index as `general` until
# added to the registry; then run `memory-server --backfill-domains` (changes
# only lessons.domain; no re-embed). `--domains-file <path>` uses another registry.
mx remember "smec pattern catches smechannel but NOT sme-commons — distinct naming roots" \
  --key s3-smec-vs-sme-commons
```

## Knowledge Quality Rubric

Before recording a `[finding]`, `[decision]`, or `mx remember` lesson,
self-score it against the four dimensions below. Anything that fails should
not enter the graph — it dilutes retrieval and erodes trust in `mx recall`
and `memory_search`. The graph is not a notebook; it is the cross-mission
brain.

### The four dimensions  (target: ≥ 4/5 on every dimension)

| Dimension | 1 (drop) | 5 (keep) |
|---|---|---|
| **Specific**    | "check things before pushing" | names exact resources, files, commands, error strings |
| **Reusable**    | one-off note about today's session | likely useful to a future agent in *new* missions |
| **Factual**     | preference or opinion | verifiable observation or rule, with evidence |
| **Non-trivial** | anyone in the role would already know | hard-won, surprising, or counter-intuitive |

If **any** dimension scores < 4:
  - fold the insight into an existing lesson via `mx remember "<merged text>" --key <existing>` (an existing key is updated in place),
  - or record it as a mission-scoped `[finding]` only (it is history, not knowledge),
  - or drop it.

### Pre-flight dedup check (mandatory before `mx remember`)

> **System-enforced**: The remember-gate extension blocks `mx remember`
> automatically on the calibrated duplicate verdict (`likely` ≥ 0.93 or
> `merge` ≥ 0.96). The 0.83 band below is a softer, voluntary manual-merge
> guideline via `memory_check_duplicate`, stricter than the gate to
> encourage proactive dedup.

Before every `mx remember`, call `memory_check_duplicate` (native pi tool)
with the proposed text and key. If cosine ≥ **0.83**, update the existing
lesson with `mx remember "<merged text>" --key <existing>` (updated in place)
instead of creating a new key. (The 0.83 advisory band is stricter than the runtime write-gate,
which blocks on the calibrated merge/likely tiers; see
`extensions/mission-stack/memory-contract.ts` for the canonical values.)

### Templates

Use these shapes when authoring. Concrete > clever. Single paragraph is fine.

**Lesson** (for `mx remember`):
```
<subject>: <observation>. <why it matters / what to do>.
<evidence: exact command, output, doc link, or named resource>.
```

**[finding]** (mission-scoped history):
```
Symptom: <what we observed>
Cause:   <why it happened>
Fix:     <what made it stop>     (or: "unresolved — see action <id>")
```

**[decision]** (mission-scoped history):
```
Decision:     <what we chose>
Alternatives: <what we rejected>
Why:          <the reason that survives review>
```

### Calibration examples

**KEEP** — `keda-cabundle-runtime-patched` (S/R/F/N = 5/5/5/5)
> KEDA operator runtime-patches caBundle into ValidatingWebhookConfiguration
> keda-admission AND APIService v1beta1.external.metrics.k8s.io. Chart-
> rendered manifests ship empty caBundle → ArgoCD sees perpetual drift.
> Mandatory ignoreDifferences: webhook /webhooks/{0,1,2}/clientConfig/caBundle,
> APIService /spec/caBundle, Secret/kedaorg-certs /data + /metadata/annotations.

Named resources, named webhook paths, named issues. Hard-won, repeatable.

**DROP** — `debug-by-exception` (S/R/F/N = 1/2/3/1)
> Debug from observed exceptions, not from theories.

Generic adage. Trivially derivable. Drop or fold into a `[finding]`.

**MERGE** — `route53-no-cname-at-apex` overlaps with `networking-vpce-dns-route53-phz`.
Both cover Route53 PHZ A-record patterns. Use `mx remember "<combined text>" --key
networking-vpce-dns-route53-phz` (updates the key in place) instead of two keys.

## Progressive Updates

Use **comments** for chronological updates (timestamped, threaded):
```bash
mx comment mission-a1b2.1 "Account 444 also missing boundaries"
mx comment mission-a1b2.1 "Tried SCP approach — doesn't give per-user control"
```

Use **notes** to append summary updates (they do not replace the description):
```bash
mx note mission-a1b2 "UPDATE: Scope expanded to include prod accounts"
```

## Searching Past Knowledge

```bash
# Cross-mission lessons
mx memories
mx recall iam-tag-propagation

# Mission-scoped knowledge
mx search "cross-account" --status all
mx list --all --json | jq '.[] | select(.description | ascii_downcase | contains("cross-account"))'

# All findings across all missions
mx list --all --label finding --json

# Everything about arc-runners
mx search "arc-runners" --status all

# Terraform decisions specifically
mx list --all --json | jq '.[] | select((.labels | index("decision")) and (.description | ascii_downcase | contains("terraform")))'

# Find missions by domain
mx list --type epic --all
```

## Mission Lifecycle

**Park** (pause for later):
```bash
# Deferrals stay deferred until someone explicitly resumes the mission.
mx update mission-a1b2 --status deferred
mx comment mission-a1b2 "Parked: waiting for security team approval; review after YYYY-MM-DD"
```

**Resume** (continue from any tool):
```bash
mx ready                      # See all actionable work across missions
mx show mission-a1b2          # Review where you left off
mx children mission-a1b2      # See all findings so far
mx history mission-a1b2       # Execution timeline
mx update mission-a1b2 --status open  # Mark as active again
```

**Reopen** (revisit completed mission):
```bash
mx reopen mission-a1b2
mx comment mission-a1b2 "Reopened: team asking about tag enforcement approach"
# ... add findings ... close again when done
```

## Landing the Plane

`/land [mission-id]` updates the mission with the session's state: missing
findings, decisions and at most two lessons, then one Context Snapshot. The
session continues afterwards; it does not close the mission. `/continue` is
separate: it writes a no-tool handover, notes it on the focused mission and
opens a fresh session, with no knowledge capture. Land first when the session
learned something worth keeping, then `/continue`.

### Canonical land-the-plane prompt

This is the one source of truth. `/land` reads this block and appends the
preloaded mission state (latest snapshot, children) and any correction
candidates.

<!-- land-the-plane-prompt:begin -->
```
LAND THE PLANE for {MISSION_IDS}: update the mission with this session's state. The session continues afterwards, so write no resume prompt.

The mission state is preloaded below; do not run mx show or mx children. Do not launch subagents, investigate, run new verification, change code, commit, close the mission or ask for confirmation.

1. Capture only what this session established and mx does not have yet. Check the preloaded children first.
   - Findings and decisions a future session needs: one atomic, domain-labeled child each, closed at once:
     `ID=$(mx create "[finding] <what>" --parent {MISSION_IDS} --labels <domain>,finding -d "<evidence>" --silent) && mx close "$ID"`
     Routine progress, commands run and anything already recorded belong in the snapshot, not in a child.
   - Actions: update or close an existing child only when its state changed this session. A new follow-up is one open `[action]` child, with no plan.
   - Lessons: at most 2, and zero is the normal case. Only a cross-task rule (always / never / prefer / gotcha, with evidence) that would change what a session on a different mission does. Mission-specific facts are findings. Call `memory_check_duplicate` with the text and key before each `mx remember`; on a merge or likely verdict, update that key instead.
   Put independent writes in one bash call. If a write fails or a guard rejects it, keep the item for Pending capture and move on. Do not retry, debug or bypass guards. Keep secrets out of every write.

2. Save ONE `mx note {MISSION_IDS}` last, headed `## Context Snapshot <YYYY-MM-DD HH:MM>Z (/land)`, under 60 lines:
   - current state and the exact next action first, then working location, guardrails and gotchas, evidence references (paths, commands, IDs; no pasted output);
   - `### Recorded`: the IDs and keys written in step 1, or `- None`;
   - `### Pending capture`: each unrecorded item with its substance and evidence, plus items from the previous snapshot's Pending capture that are still unrecorded, or `- None`.
   No secrets and no raw messages. If the note fails, print it in the reply with a warning.

3. Reply in at most 5 lines: snapshot saved or not, recorded IDs and keys, pending items.
```
<!-- land-the-plane-prompt:end -->

### When to actually CLOSE a mission

Only close when all of the following are true:

1. All `[action]` children are closed (the work has been executed).
2. Land-the-plane has been run at least once on this session's work.
3. Any reusable knowledge has been captured via `mx remember`.
4. Any out-of-scope work has been filed as a separate epic (and linked via
   `mx link` if related).

Then:

```bash
mx children mission-a1b2       # check for open actions or questions
mx close mission-a1b2 --reason "Summary of what was accomplished"
```

If `mx close` refuses because `[finding]`/`[decision]` children are still
open, that means they were created without being immediately closed (old
habit). Mass-close them:

```bash
mx children mission-a1b2 --json \
  | jq -r '.[] | select(.status != "closed") | select(.title | test("^\\[(finding|decision)\\]")) | .id' \
  | xargs -n1 mx close
```

or, if you're confident no real action work is hiding, `mx close <epic-id> --force`.

## Context Snapshots

A context snapshot preserves the state needed to continue without
re-investigation. `/land` writes one after its captures, listing what it
recorded and what is still pending. `/continue` writes one from its handover.

Keep current state and the next action within the first 2,200 characters,
which Pi injects on resume. Aim for about 2,000 characters and reference
detailed evidence instead of pasting it.

### Format

Include only sections that are relevant; skip empty ones:

```bash
mx note <epic-id> "## Context Snapshot $(date -u '+%Y-%m-%d %H:%M')Z (/land)

### Current state and next action
- Verified state and any uncertainty: ...
- Next action, existing mx ID if available: ...
- Blockers or approvals still needed: ...

### Working context
- Repo, branch, uncommitted work: ...
- Relevant profiles, clusters, namespaces: ...
- Critical guardrails and gotchas: ...
- Evidence paths and non-obvious commands: ...

### Recorded
- <IDs and lesson keys written by this landing>

### Pending capture
- <discovery, decision, lesson, correction, or follow-up not yet recorded>
- <substance and evidence needed to capture it later>
"
```

### Rules

1. Append, never overwrite prior snapshots. One snapshot per landing.
2. Record current state and the next action even in planning-only sessions.
   Distinguish observed results from unverified assumptions.
3. Include only non-obvious commands, with full paths and explicit contexts.
4. Reference existing findings, lessons, and evidence instead of repeating them.
5. Preserve uncaptured knowledge without weakening secret handling. A pending
   item is not an accepted lesson until it passes the existing quality gates.
6. The latest snapshot's Pending capture is the backlog for the next `/land`,
   which carries over whatever it still cannot record.

## Mission Hygiene

Run periodically (or when resuming work after time away):

```bash
mx ready                  # What can I work on right now?
mx memories               # Review cross-mission lessons
```

## Context Recovery

If you've lost mission context (after compaction, clear, or session restart):

```bash
mx ready                  # What's actionable right now
mx memories               # Cross-mission knowledge
mx list --type epic --all          # All missions overview
```

Use `mx show <id>`, `mx children <id>`, and `mx history <id>` to recover full context
for a specific mission.

## Agents (Optional)

If you want to parallelize investigation, dispatch `infra-reader` (read-only) or
`infra-executor` (approved changes) as subagents. Not required — running commands
directly in the main session works fine for most missions.

## Domain Labels

Controlled vocabulary. Prefer these; extend only when a truly new domain
appears. Consistency here is what makes `mx search --label <x> --status all`
useful across missions.

**Infrastructure:** `eks`, `iam`, `acm`, `awx`, `ec2`, `rds`, `s3`, `route53`, `networking`, `docker`
**Operations:** `terraform`, `deployment`, `cost`, `security`, `monitoring`, `arc-runners`
**Tooling:** `pi`, `claude`, `copilot`, `mx`, `vscode`, `git`
**Knowledge type:** `finding`, `decision`, `action`
**Work type:** `bug`, `fix`, `test`, `docs`, `ux`, `refactor`
**Meta:** `tooling`, `process`

## Security

- **Never store secrets** (API keys, passwords, credentials) in mission descriptions
- Record *what was done*, not *the credentials used to do it*
- Mission data is plaintext in `~/.missions/mx.db` — filesystem permissions only

## Knowledge capture and the secret gate

New information is routed by `knowledge-capture.ts` to one of: environment fact,
lesson, mission finding/decision/action, or transient session state. Capture
only *proposes* and validates; persistence stays a reviewed `mx` action. Ordinary
environment facts need a scope + source (not the full lesson rubric); lessons
need the durable-rule rubric; mission children need a focused mission.

Corrections surfaced at `/land` stay pending until the landing completes, so a
cancelled landing never loses them. Successful writes are indexed with tracked
retry (pending-reconcile is surfaced, not swallowed).

**The `mx` secret scan is a regex heuristic, not a complete boundary.**
The CLI checks text fields on writes, including calls from scripts, and allows
placeholders. Review every proposed write for secrets yourself. The pi
remember-gate handles lesson dedup and indexing, not CLI secret scanning. See
`policies/knowledge-capture.md`.

## Status

Run `/knowledge-status` for a read-only view of the mission-stack: active
modules, L3 auto-inject state (off by default), loaded environment records,
index coverage and identity, and actionable failures. It reads only; it never
writes to mx or embeds.
