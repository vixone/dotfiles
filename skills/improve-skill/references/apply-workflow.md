## Apply Workflow

### Step 1: Plan Assessment

**1.1 — Locate the plan**
Read `<SkillRoot>/<skillName>/improvements/plan.md`.
If the file does not exist → output:
```
No pending improvements for `<skillName>`. Nothing to apply.
```
Then exit.

**1.2 — Parse entries**
Collect all `### IMP-<N>: <title>` headings. For each, extract:
`Target file`, `Current state`, `Proposed change`, and `Confidence`.
List them with title and confidence level before proceeding.

---

### Step 2: Evidence-Based Triage

For each IMP entry, run this checklist independently:

**2.1 — Re-read current file**
Read the file named in `Target file` from the live skill directory.
Never trust the `Current state` text stored in the plan — it may be stale.

**2.2 — Validate the gap**
Compare `Current state` against the actual file content:
- If the quoted text no longer exists or the described gap has already been fixed
  → classify as **DISCARD** (reason: "gap no longer exists")

**2.3 — Evaluate the proposed change**
- Does it remove ambiguity, fix a real omission, or prevent a known failure mode?
  → **IMPLEMENT**
- Does it add verbosity, duplication, or edge-case hedging without proportional benefit?
  → **DISCARD** (reason: "adds noise")
- Is the trade-off genuinely unclear — e.g. style preference, uncertain scope impact?
  → **NEEDS INPUT**

**2.4 — Apply confidence as a tie-breaker only**
Higher confidence lowers the bar for IMPLEMENT, but does not override evidence.
A high-confidence entry still gets DISCARDed if the gap no longer exists.

---

### Step 3: Present Triage Results

Display a summary table before touching any files:

```
## Triage: <skillName> (<count> entries)
- IMP-1: <title> → IMPLEMENT | DISCARD | NEEDS INPUT (<reason>)
- IMP-2: <title> → ...
```

For NEEDS INPUT entries, add a sentence explaining the ambiguity and what would resolve it.

Ask: `Confirm this triage? I'll implement the IMPLEMENT entries and discard the DISCARD entries.`
Wait for explicit confirmation. Respect any overrides the user makes before continuing.

---

### Step 4: Implementation

Process each IMPLEMENT entry in ascending IMP number order:

**4.1 — Re-read then edit**
Re-read the target file immediately before editing (catches edits made mid-session).
Make only the change in `Proposed change` — no adjacent reformatting, no combined edits.

**4.2 — Commit each change individually**
```bash
git -C ~/sandbox/rbro-infra-claude-skills add plugins/infra/skills/<skillName>/
git -C ~/sandbox/rbro-infra-claude-skills commit -m "fix(<skillName>): <IMP title>"
```

---

### Step 5: Cleanup

**5.1 — Remove resolved entries from plan.md**
- Remove all successfully IMPLEMENTED entries
- Remove all DISCARDED entries
- Leave NEEDS INPUT entries intact for the next session

**5.2 — Delete plan if empty**
If no `### IMP-` headings remain in `plan.md`, delete the file.
Then delete the `improvements/` directory if it is now empty.

**5.3 — Output final summary**
```
Applied <N> improvements, discarded <M>, <R> remaining.
```
R = entries left in plan.md (NEEDS INPUT).
