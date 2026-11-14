---
name: missions
description: "Manage persistent missions via the mx CLI (SQLite). Use when the user says 'start a mission', 'turn this into a mission', 'update mission', 'check missions', 'resume mission', 'park mission', 'close mission', 'search missions', 'what missions', 'mission status', or references ongoing work they want to track across sessions and tools."
---

# Missions

Use this skill as a thin adapter for the canonical missions protocol in `~/Missions.md`.
Do not duplicate or reinterpret the protocol here; load the canonical document and follow it.

## Required startup

Before responding to any missions-related request, read `~/Missions.md`.

`MX_DB` is already exported in `~/.zshrc` (points to `~/.missions/mx.db`). Run `mx` directly — do not re-export it in commands.

## Pi-specific operating rules

- Prefer machine-readable `mx` commands with `--json` when the output will be inspected programmatically. For a child with large parent notes, use `mx show <id> --compact-deps --json` so the parent dependency does not repeat its full body. Add `--include-comments` only when comment bodies are needed; the primary issue stays complete.
- Use `mx update` with flags (`--title`, `--priority`, `--add-label`, `--remove-label`, `--set-labels`, `--status`) for metadata changes. Append a summary with `mx note`; use `mx comment` for chronological updates. Park with `mx update <id> --status deferred`, then comment with the reason and any review date. Resume with `mx update <id> --status open`.
- Use the session-scoped `/focus` command (provided by `focus-land`) to track the active mission, and always pass explicit IDs to `mx`.
- Titles of child issues must be prefixed with `[finding]`, `[decision]`, `[action]`, or `[question]`. Close `[finding]` and `[decision]` children immediately after creating them (they are immutable history). Leave `[action]` children open until the work is actually done — this keeps `mx children <epic>` skimmable as a "what's left?" list. `[question]` children are open decisions on a mission-wayfinder map; resolving one retitles it to `[decision]`/`[finding]` and closes it (see the mission-wayfinder skill).
- Pi provides `/start` and `/focus` slash commands (via `focus-land`). `/land [mission-id]` updates the mission and stays in the session: it records missing findings and decisions, at most 2 cross-task lessons under the dedup and secret gates, then saves one Context Snapshot (`### Recorded`, `### Pending capture`). `/continue` only writes a lean handover, notes it on the focused mission and opens a fresh session. Neither auto-compacts.
- Auto-focus: pasting a resume prompt that opens with `Resume mission-<id> ...` into a fresh session focuses that mission automatically (no manual `/focus` needed). It only fires when nothing is focused yet, so it never overrides an explicit `/focus`.
- If the user asks to check, search, resume, or get status on missions, inspect existing mission state before proposing new missions.
- If the user is vague and multiple missions may match, search first, summarize likely matches briefly, and ask a short disambiguating question only if needed.
- When taking mission actions, report the mission ID(s), what changed, and the next sensible step.

## Capture-time quality gate

`mx` is the source of truth for the cross-mission knowledge graph. Sloppy
entries dilute retrieval permanently. Treat the "Knowledge Quality Rubric"
in `~/Missions.md` as normative.

**System-enforced:**
- The pi remember-gate blocks `mx remember` on the calibrated duplicate verdict (`likely` ≥ 0.93 or `merge` ≥ 0.96) against an existing lesson.
- The mx CLI checks text fields on writes and refuses detected secrets (exit 3). The regex scan cannot catch every secret.

**Your responsibility** (the system cannot judge these):
- **Rubric self-score** — score against the four dimensions in `~/Missions.md`
  (Specific, Reusable, Factual, Non-trivial). If any < 4, rewrite, downgrade
  to a `[finding]`, or drop.
- **Use the templates** in the rubric for `[finding]` (Symptom/Cause/Fix)
  and `[decision]` (Decision/Alternatives/Why).
- **Merge over create** — when `memory_check_duplicate` shows ≥ 0.83, prefer
  `mx remember "<merged text>" --key <existing>` (an existing key is updated in place).

## Common intent mapping

- Start / turn into a mission → **prefer `/start <title>`** which creates the epic AND auto-focuses it in one step. Only fall back to manual `mx create` if additional flags (priority, labels, description) are needed at creation time — and if so, always follow up with `/focus <id>` to pin the new mission.
- Check / what missions / mission status → inspect current mission state (`mx ready`, mission search/listing, or specific mission details as appropriate).
- Resume mission → recover context from existing missions before doing new work.
- Park mission → defer the mission and record why if relevant.
- Close mission → follow the landing-the-plane checklist in `~/Missions.md` before closing.
- Record finding / decision / action / lesson → use the canonical conventions from `~/Missions.md`.

## Corrections stay pending until landing completes (mission-927.11)

Corrections detected during a session surface in the next `/land`.
Anything the landing cannot record goes in the snapshot's Pending capture
list. The extension consumes them only after the landing turn completes and
saves a snapshot. A cancelled landing or failed snapshot leaves them for the
next landing.
