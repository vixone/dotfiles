---
name: mission-execute
description: "Use when you have a mission tracked in mx with [action] tasks to implement, or when the user says execute/implement the plan/mission. Drives mx ready and mx children to closure with review checkpoints, closing each task as its deliverable is verified - no markdown checklist files."
---

# Mission Execute

Execute a mission in mx task-by-task. The mission's `[action]` children ARE the
plan; `mx ready` is the next task; closing a child ticks it off. This replaces the
old executing-plans / subagent-driven-development flow (no markdown checklist).

Load `~/Missions.md` conventions before recording. Use `mx` directly.

**Announce at start:** "Using mission-execute to implement `<epic-id>`."

## Step 1: Load and review the mission

```bash
mx show <epic-id>            # goal + design summary (the note)
mx children <epic-id>        # decisions (history) + open [action] tasks (the plan)
mx ready --json | jq -r '.[] | select(.id|startswith("<epic-id>")) | "\(.id)  \(.title)"'
```
- Read the design and every open `[action]` description critically. Raise any
  questions or concerns with the user BEFORE starting.
- An open `[question]` child means the route isn't clear yet. Go back to
  `mission-wayfinder` and resolve it (or rule it out of scope) first.
- **Isolate the workspace.** Never start implementation on `main`/`master`. Ensure
  a feature branch (or git worktree) exists first:
  ```bash
  git checkout main && git pull            # or master
  git checkout -b feature/<short-name>
  ```

## Step 2: Execute each task

Work in dependency order — `mx ready` surfaces only unblocked tasks. For each:

1. **Claim it:** `mx update <task-id> --status in_progress` (or `--claim`).
2. **Follow the steps in the task description exactly** — they're bite-sized
   (write failing test → run it fails → implement minimal → run it passes →
   commit). Don't skip verifications. Don't bundle "while I'm here" changes.
3. **Verify the deliverable** — tests pass, nothing else broke.
4. **Close it:** `mx close <task-id>`. Record anything discovered mid-task as a
   closed `[finding]` child; new out-of-scope work as a new `[action]` (chained
   with `mx dep add` if it blocks later tasks) or a separate epic.
5. **Review checkpoint** — pause between tasks so the user can review before the
   next. Re-run `mx ready` to get the next task.

Progress is visible at any time: `mx children <epic-id>` (closed = done, open =
left).

## Step 3: Finish the branch

After all `[action]` tasks are closed and verified:
1. **Full verification** — run the whole test suite / linters; confirm green.
   Evidence before claiming done.
2. **Present integration options** to the user. For repos with a remote, push
   the feature branch and provide a compare URL for the user's PR. Never push
   to main/master. For local-only repos, merge after the user approves the
   cutover, then sync main/master and stop working on the merged branch.

## Step 4: Land the mission

Once the work is integrated, run `/land <epic-id>` (canonical prompt in
`~/Missions.md`): it records remaining findings, at most 2 reusable lessons via
`mx remember` (dedup-checked), then appends a Context Snapshot. Close the mission (`mx close <epic-id> --reason "..."`) only when all
`[action]` children are closed and knowledge is captured.

## When to STOP and ask

- Hit a blocker (missing dep, unclear instruction, repeated verification failure).
- The mission has a critical gap that prevents starting.
- Fundamental approach needs rethinking.

Don't force through blockers. Stop, `mx comment <task-id> "blocked: <why>"`, and
ask the user rather than guessing. If the approach itself is wrong, return to
`mission-wayfinder`: open a `[question]` ticket for what broke, resolve it, and
revise the affected `[action]` tasks before continuing.

## Reminders
- Follow task steps exactly; the plan is deliberately bite-sized.
- One task at a time; close each before moving on.
- `mx ready` is the source of truth for "what's next", not memory.
- Never implement on main/master; never push/merge protected branches.
