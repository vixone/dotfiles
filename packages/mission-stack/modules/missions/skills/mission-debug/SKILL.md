---
name: mission-debug
description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes. Enforces root-cause-first debugging. Creates a lightweight debug mission when none is focused, then records findings, the root cause, and the fix into mx instead of scratch notes."
---

# Mission Debug

**Core principle:** ALWAYS find the root cause before attempting fixes. Symptom
fixes are failure. This is the mx-backed replacement for systematic-debugging.

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes. Load `~/Missions.md`
conventions before recording. Use `mx` directly.

## Where the knowledge lands

A debug session without an epic has nowhere to put findings. Create or attach
one before Phase 1. Do not ask.

- **A mission is already focused** and this bug belongs to it. Use that epic-id.
- **A related in-progress epic exists.** Search first:
  `mx search "<symptom>" --type epic --status all`
  Attach to it and tell the user the id.
- **Otherwise, create a lightweight debug epic now:**

```bash
EPIC=$(mx create "Debug: <symptom in one line>" --type epic --labels debug -p 2 \
  -d "Symptom: <what we observed>
Started: $(date +%Y-%m-%d)" --json | jq -r '.id')
```

Announce in one line. `Debug trail: <epic-id>. /focus <epic-id> to pin this session.`
Do not wait for focus. Use `$EPIC` as `--parent` from this moment.

Do NOT ask "want a mission?" or "shall I start one?". Creating the epic is the
skill. Asking is why this used to record nothing.

### Skip a new epic only when

The whole issue is a mechanical one-shot you will finish this turn AND you
already know the root cause without investigating. Wrong path, missing import,
typo you just made.

Reading a stack trace, reproducing, or checking git history means it is not a
skip. If you skipped and then spent a second look, create the epic retroactively
before the first `[finding]`. Findings without a parent are lost.

## When to use

ANY technical issue: test failures, production bugs, unexpected behavior,
performance problems, build failures, integration issues. **Especially** under
time pressure, when "one quick fix" seems obvious, or when a previous fix failed.
Don't skip because the issue "seems simple". Simple bugs have root causes too.

## The Four Phases (complete each before the next)

### Phase 1: Root Cause Investigation

0. **Create or attach the epic** (see above). Done when you have an epic-id.
1. **Read errors carefully**. Full stack traces, line numbers, codes. They often
   contain the solution.
2. **Reproduce consistently**. Exact steps; does it happen every time? If not
   reproducible, gather more data, don't guess.
3. **Check recent changes**. `git diff`, recent commits, new deps, config/env.
4. **Gather evidence in multi-component systems**. Before proposing fixes, add
   diagnostic instrumentation at each component boundary (log what enters / exits
   each layer, verify env/config propagation). Run once to see WHERE it breaks,
   then investigate that component.
5. **Trace data flow backward**. Where does the bad value originate? What called
   this with it? Keep tracing UP to the source. Fix at the source, not the symptom.

Capture what you learn as you go:
```bash
FID=$(mx create "[finding] <symptom in one line>" --parent <epic-id> --labels finding \
  -d "Symptom: <what we observed>
Cause:   <why it happened, or 'under investigation'>
Fix:     <what made it stop, or 'see action <id>'>" --json | jq -r '.id')
mx close "$FID"   # findings are immutable history. Close immediately
```

A closed `[finding]` with Symptom/Cause/Fix IS the learning for a short session.
Do not skip it because it is not lesson-worthy.

### Phase 2: Pattern Analysis
1. **Find working examples**. Similar code in the same codebase that works.
2. **Compare against references**. Read reference implementations COMPLETELY, not
   skimmed.
3. **Identify every difference**. However small. Don't assume "that can't matter".
4. **Understand dependencies**. Config, environment, assumptions.

### Phase 3: Hypothesis and Testing
1. **Form ONE hypothesis**. "I think X is the root cause because Y." Be specific.
2. **Test minimally**. Smallest possible change, one variable at a time.
3. **Verify**. Worked → Phase 4. Didn't → form a NEW hypothesis, don't stack fixes.
4. **When you don't know, say so**. Research or ask; don't pretend.

Record the confirmed root cause as a closed `[decision]` or `[finding]`:
```bash
DID=$(mx create "[decision] Root cause: <one line>" --parent <epic-id> --labels decision \
  -d "Decision: root cause is <X>.
Alternatives: <hypotheses ruled out>.
Why: <evidence that confirmed it>." --json | jq -r '.id')
mx close "$DID"
```

### Phase 4: Implementation
1. **Create a failing test**. Simplest reproduction; automated if possible. MUST
   have before fixing.
2. **Track the fix as an open `[action]`**. Close it only after verification:
   ```bash
   AID=$(mx create "[action] Fix <root cause>" --parent <epic-id> --labels action \
     -d "Root cause <id>. Failing test: <path>. Fix: <what>." --json | jq -r '.id')
   # ... implement the single fix (address root cause, ONE change, no drive-by refactors) ...
   mx close "$AID"   # only after the test passes and nothing else broke
   ```
3. **Verify**. Test passes, no other tests broken, issue actually resolved.
4. **If the fix doesn't work**. STOP. Count attempts. If < 3, return to Phase 1
   with the new information. **If ≥ 3, question the architecture** (see below);
   don't attempt fix #4 without that discussion.

### If 3+ fixes failed: question the architecture
Pattern: each fix reveals new coupling/shared state elsewhere; fixes need "massive
refactoring"; each fix creates new symptoms. That's a wrong-architecture signal,
not a failed hypothesis. STOP and discuss fundamentals with the user before more
fixes.

## Red flags. STOP and return to Phase 1
"Quick fix now, investigate later" · "just try changing X" · "add multiple changes,
run tests" · "skip the test, I'll verify manually" · "it's probably X, let me fix
that" · proposing solutions before tracing data flow · "one more fix" after 2+
failures · each fix revealing a new problem elsewhere · "this is too small for a
mission".

## Capture the lesson (if reusable)
If the root cause is non-trivial and likely to recur across missions, record a
cross-mission lesson. But only if it clears the Knowledge Quality Rubric
(Specific, Reusable, Factual, Non-trivial; ≥4/5 each):
```bash
# First: memory_check_duplicate (native tool) with text + key. If cosine ≥ 0.83,
# mx remember --key <existing> with merged text instead of a new key.
mx remember "<subject>: <observation>. <why it matters / what to do>. <evidence>." \
  --key <domain>-<slug>
```
The remember-gate auto-blocks near-duplicates (≥0.88) and secrets. Generic adages
("debug from evidence not theory") fail the rubric. Drop them or fold into a
`[finding]`.

## Verify before claiming done
Test passes now? No other tests broken? Issue actually resolved? Only then say it's
fixed and close the `[action]`.

## Close the trail
When the issue is actually resolved:
- Confirm every finding/decision/action is under `$EPIC`
- Write one `[finding]` with Symptom/Cause/Fix if you somehow didn't record as you went
- `mx remember` only if it clears the rubric
- `mx close $EPIC --reason "Root cause: <X>. Fix: <Y>."`

Leave it open if the bug is not resolved or the user is still in it.
