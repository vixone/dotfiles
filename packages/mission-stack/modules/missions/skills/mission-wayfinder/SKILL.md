---
name: mission-wayfinder
description: "Use before any creative or design work: new features, components, migrations, behavior changes, or a loose idea too big or foggy to plan in one go. Charts the effort as a mission map in mx (an epic of open [question] tickets wired by dependencies), resolves them one at a time through grilling, research, prototypes, or unblocking tasks, then lays the cleared route down as a chained [action] plan for mission-execute. Small efforts with no fog collapse to a single-session design. Skip for trivial one-off tasks."
---

# Mission Wayfinder

A loose idea arrives wrapped in fog: the way from here to the **destination**
isn't visible yet. Wayfinding finds that way before anyone charges at the
destination. The way is charted as a **map** in mx: one epic whose open
`[question]` children are the decisions still in the way. Resolve them one at a
time until nothing is left to decide, then lay down the route as `[action]` tasks
and hand off to `mission-execute`.

Adapted from mattpocock/skills `wayfinder`. Issue tracker, labels, and git
branches are replaced by mx: epic, children, `mx dep`, `mx ready`, `--claim`.

Load `~/Missions.md` conventions before recording anything (title prefixes, the
Knowledge Quality Rubric, `[finding]`/`[decision]`/`[action]` templates). Use `mx`
directly; `MX_DB` points at the global store after cutover.

## Plan, don't do

<HARD-GATE>
No code, scaffolding, `terraform`, `kubectl apply`, or other implementation until
the route is clear and the user has agreed to it. Every ticket resolves a
decision. The only doing allowed before that is a `wf:task` ticket, and only
because a decision is blocked on it.

The pull to just start building means you've reached the edge of the map. Lay the
route down (see **Arrive**) and hand off.

Recording is not gated. Creating the epic, tickets, decisions, and the final
`[action]` chain is the job of this skill. Never ask "shall I create the
mission?" or "want me to record this?". Agreement on the design IS the trigger.
</HARD-GATE>

An effort may override plan-only in its map **Notes** ("execute tickets in the
map"). Absent that, produce decisions, not deliverables.

## Trivial-task escape hatch

One small, low-risk change (one-line fix, config tweak, rename) carries no
design decisions. Say "one-liner, skipping wayfinder" and do it.

## Refer by name

Bead ids (`mission-l4w.28`) are illegible in a list. In everything the human
reads, refer to a ticket by its title with the id riding along:
`Pick the ingress controller (mission-l4w.3)`. Never a bare wall of ids.

## The map

The map is the **epic**. It is an index, not a store. A decision lives in exactly
one place, its own child bead.

- **Map body**: the epic's `design` field, written with `mx update <epic>
  --design-file -`. Read it with `mx show <epic>`. Rewrite the whole field when a
  section changes (read, edit, write back).
- **Decisions so far**: no section needed. mx already indexes them: the closed
  `[decision]`/`[finding]` children of the epic, each title a one-line gist.
  `mx children <epic>` is the index; `mx show <child>` is the zoom.
- **Label**: the epic carries `wayfinder` plus its domain labels.

### Map body template

```markdown
## Destination
<what arriving looks like: usually "an executable [action] plan for X", sometimes
a single locked decision, a written spec, or a change made in place. 1-2 lines.
Every session orients to it before choosing a ticket.>

## Notes
<domain, repos/accounts/clusters in play, skills every session should load,
standing preferences, plan-only override if any>

## Not yet specified
<fog: in-scope questions you can sense but can't yet phrase sharply. Loose is fine.>

## Out of scope
<one line per ruled-out item: gist + why + (id) of the closed ticket if one existed>
```

## Tickets

A ticket is a child bead of the epic, sized to one focused session. Its title is
`[question] <the sharp question>`; its description holds the question and the
context needed to resolve it cold.

```bash
Q=$(mx create "[question] Which queue replaces the cron poller?" \
  --parent <epic> --no-inherit-labels --labels <domains>,question,wf:grilling \
  -d "Question: <the decision or investigation this resolves>
Context: <what's known, what it hangs on, pointers to files/resources>" --json | jq -r .id)
```

`--no-inherit-labels` keeps the epic's `wayfinder` label off the children; list
domain labels explicitly.

### Ticket types (label `wf:<type>`)

Every ticket is **HITL** (worked with the human, who speaks for themselves) or
**AFK** (agent alone). A HITL ticket only resolves through that live exchange.
Never answer the human's side of a grilling yourself.

- **`wf:grilling`** (HITL, the default). Conversation. Load
  `../grill-me/SKILL.md` (relative to this skill) and run it scoped to this ticket's
  question.
- **`wf:research`** (AFK). A fact a decision waits on, living outside this
  conversation: vendor docs, upstream source, AWS/k8s behavior, other repos, past
  missions. Resolved by a background subagent (see **Research workers**).
- **`wf:prototype`** (HITL). "How should it look / behave" is the real question.
  Build a cheap throwaway artifact to react to: a rendered manifest, a stub
  module, a sample tfvars, a rough doc outline, an HTML state-machine toy. Put it
  in a scratch path clearly named as a prototype (e.g. `/tmp/wf-<epic>-<slug>/`
  or a `*-PROTOTYPE*` file next to where it would live), never on main. Link the
  path in the resolution.
- **`wf:task`** (HITL or AFK). Manual work a decision is blocked on: get access,
  provision a scratch resource, pull data to see its shape. Do it yourself where
  you can; otherwise hand the human an exact checklist. The resolution records
  what was done and any facts later tickets need (where creds live, ARNs, URLs,
  row counts). Respect the usual guards: no `terraform apply`, no pushes to main.

### Blocking and the frontier

Blocking is `mx dep add <blocked> <blocker>`. A ticket is unblocked when all its
blockers are closed. The **frontier** is the open, unblocked, unclaimed questions:

```bash
mx ready --parent <epic> --label question --unassigned
```

Claim before any work, so parallel sessions skip it:
`mx update <id> --claim` (assignee + in_progress).

## Fog of war

The map is deliberately incomplete. Don't chart what you can't yet see.

**Fog or ticket?** The test is whether you can state the question sharply now,
not whether you can answer it now.
- **Ticket** when the question is sharp, even if blocked.
- **Not yet specified** when you can't phrase it that sharply yet. Don't pre-slice
  fog into ticket-sized pieces; one patch may graduate into several tickets or
  none.

Resolving a ticket clears fog ahead of it. Graduate whatever became specifiable
into fresh tickets and delete that patch from **Not yet specified**.

## Out of scope

Fog only gathers toward the destination. Work beyond it is out of scope, not fog.
When an existing ticket turns out to sit past the destination:

```bash
mx comment <id> "Out of scope: <why>"
mx update <id> --add-label wf:out-of-scope
mx close <id> --reason "out of scope: <why>"
```

Add one line to the map's **Out of scope**. A closed `[question]` therefore means
"ruled out"; resolved ones are retitled (below), so the two never mix. Out of
scope never graduates back. If the destination is redrawn, that's a new effort.

## Mode 1: Chart the map

User invokes with a loose idea.

1. **Explore context first.** Relevant repos/files, `mx search "<topic>" --status
   all`, `memory_search`, `memory_related_missions`. If a related mission exists,
   surface it. If the session is `/focus`ed on an epic or clearly extending one,
   chart onto that epic instead of a new one.
2. **Name the destination.** Grill (load `grill-me`) until the destination is
   pinned: what artifact or state marks arrival. It fixes the scope, so it's
   settled first.
3. **Map the frontier.** Grill again, **breadth-first**: fan out across the whole
   space, surface every open decision and the first steps takeable now. Don't go
   deep on any one thread yet.
4. **No fog? Skip the map.** If the way is already clear and the whole journey
   fits one session, say so and run the **Small effort** path below. Don't build
   a map for a two-decision change.
5. **Create the map.** `/start "<title>"` (creates and focuses the epic) or
   `mx create "<title>" --type epic --labels wayfinder,<domains> -p <n>` and tell
   the user to `/focus <id>`. Write the map body into `--design`.
6. **Create the tickets you can specify now**, then wire `mx dep add` edges in a
   **second pass** (ids must exist first). Everything not yet sharp goes in **Not
   yet specified**.
7. **Fire research workers** for every `wf:research` ticket, in parallel.
8. **Stop.** Show the map: destination, frontier tickets by name, blocked tickets
   by name with what blocks them, the fog. Charting resolves nothing by hand.

## Mode 2: Work the map

User invokes with an epic id (or the session is focused on one). A ticket is
optional; without one, you pick.

1. **Load the map**: `mx show <epic>` (destination, notes, fog) and
   `mx children <epic>` (decisions so far, open questions). Low-res only; don't
   read every ticket body.
2. **Choose a ticket.** The user's pick, else the first frontier ticket from
   `mx ready --parent <epic> --label question --unassigned`. **Claim it.**
3. **Resolve it** as its `wf:<type>` label says. The label decides the type, not
   the body. Zoom on demand: `mx show` any related or closed ticket. Load any
   skill the map's **Notes** names. In doubt, grill.
4. **Record the resolution.** Retitle to the answer, rewrite the description with
   the template, close:
   ```bash
   # decision (grilling / prototype / task outcomes)
   mx update <id> --title "[decision] <what was chosen>" \
     --remove-label question --add-label decision -d "Question: <original question>
   Decision: <what we chose>
   Alternatives: <what we rejected>
   Why: <the reason that survives review>
   Assets: <prototype paths, links, or none>"
   mx close <id> --reason "<one-line gist>"

   # fact (research outcomes) uses [finding] + label finding, same shape:
   # Question / Finding / Evidence (sources with links) / Implication
   ```
   The retitled closed child IS the map's index entry. No separate index edit.
5. **Advance the frontier.** Create newly surfaced tickets (create, then wire).
   Graduate fog the answer made sharp, deleting it from **Not yet specified**.
   Rule out-of-scope tickets out. If the answer invalidates other tickets, update
   or close them (`--reason "superseded by <title> (<id>)"`).
6. **Next ticket or pause.** Continuing in the same session is fine. When context
   is getting heavy, or before a new HITL grilling, suggest `/compact` (never run
   it). Other sessions may be working the same map; re-run `mx ready` rather than
   trusting a list from earlier.

When the frontier is empty and **Not yet specified** is empty, go to **Arrive**.

## Research workers

Research is the one type you fan out. For each `wf:research` ticket:

1. Claim it, then `mkdir -p /tmp/wf-research/<ticket-id>`.
2. Use `subagent` with `agent: "scout"`,
   `cwd: "/tmp/wf-research/<ticket-id>"`, and `async: true`. Role/model routing
   comes from `subagents.agentOverrides` in Pi settings. Task text:
   the ticket's question and context verbatim, plus:
   > Investigate against primary sources only: official docs, upstream source,
   > specs, first-party APIs, live read-only CLI output (`aws ... describe`,
   > `kubectl get`). Follow each claim to the source that owns it. Use
   > web_search/fetch_content for the web; never curl. Read-only: no applies, no
   > writes outside this directory, no mx writes. Write findings to
   > `findings.md` here with a citation per claim, then reply with a 5-line
   > summary.
3. End the turn or keep working other tickets. Don't poll.
4. When the notice arrives, **verify** the findings (a succeeded run is not proof),
   then record the resolution yourself as a `[finding]` (step 4 above), with the
   key evidence in the description and `findings.md` path under Evidence.

Workers never write to mx; this session does, after checking.

## Arrive: lay down the route

The way is clear when no open `[question]` remains and the fog is empty. Present
the design that the closed decisions add up to (architecture, components, data
flow, failure handling, testing), sized to the effort. Get the user's agreement
on it. That agreement is the trigger; materialize immediately, no second ask.

What gets materialized depends on the **Destination**:

- **Executable plan** (the usual case). Note the design on the epic, then create
  the chained `[action]` list:
  ```bash
  mx note <epic> "## Route - $(date +%Y-%m-%d)
  <2-6 sentences: goal, architecture, key components, testing approach>"

  A1=$(mx create "[action] <Task 1>" --parent <epic> --no-inherit-labels \
    --labels <domains>,action -d "Files: <create/modify/test paths>
  Decided by: <decision titles (ids)>
  Steps:
  1. Write failing test: <exact test>
  2. Run it, expect FAIL: <command>
  3. Minimal implementation: <what>
  4. Run it, expect PASS: <command>
  5. Commit: <message>" --json | jq -r .id)
  A2=$(mx create "[action] <Task 2>" ... --json | jq -r .id)
  mx dep add "$A2" "$A1"
  ```
  One child per Task, the smallest unit worth a fresh reviewer's gate, ending in
  an independently testable deliverable. Steps live in the description; no child
  per step. For infra work, steps are plan/verify loops instead of tests
  (`terraform plan` shows only X, `kubectl diff`, pipeline comment check).
- **A locked decision or a spec.** The closed decisions are the deliverable. Add a
  `mx note` summarizing them; if the spec must live in a repo, write it there on a
  feature branch and link it.
- **A change made in place.** The map's Notes already carried an execution
  override; the closed tickets are the record.

**No placeholders.** Every `[action]` carries what an implementer needs: exact
files, real commands, real test code. Never "TBD", "add error handling", "similar
to Task N". If a task names a type or function, some task defines it.

**Self-review before handoff:**
1. Coverage: every closed decision is reflected in some `[action]`, or is
   deliberately a no-op.
2. Placeholders: none.
3. Consistency: names match across tasks.
4. Scope: one coherent mission, or split into several epics.

Then report:
> "Route laid down in `<title>` (`<epic-id>`): N decisions, M findings, K chained
> tasks. `mx children <epic-id>` is the checklist. Ready for mission-execute?"

The terminal state is `mission-execute`. Do not start implementing here.

## Small effort path (no fog)

When charting finds the whole way already visible:

1. Grill to a shared understanding (load `grill-me`). Propose 2-3 approaches with
   trade-offs, recommendation first. YAGNI.
2. Present the design; get agreement.
3. Create or reuse the epic, write each key choice as a closed `[decision]`
   child (Decision/Alternatives/Why), then run **Arrive** for the `[action]`
   chain. No `[question]` tickets, no map body needed.

## Design principles (apply while grilling)

- If the request is several independent subsystems, say so and split into
  separate maps. Chart the first one now.
- Small units, one purpose each, clear interfaces, testable alone. If you can't
  say what a unit does, how it's used, and what it depends on, the boundaries
  need work.
- In existing repos, follow established patterns. Fold in only the improvements
  this destination needs.
