---
name: grill-me
description: Interview the user relentlessly about a plan, design, decision, or idea until reaching shared understanding, working the design tree in rounds. Use when the user wants to stress-test their thinking, mentions "grill me" or grilling, or when mission-wayfinder resolves a wf:grilling ticket.
---

# Grill me

Interview the user relentlessly until you reach a shared understanding. Map the
topic as a **design tree**: every decision branches into the decisions that hang
off it.

Adapted from mattpocock/skills `grilling`, with the term-sharpening parts of
`domain-modeling` folded in. Decisions are recorded in mx (via
mission-wayfinder), not ADR files or a GLOSSARY.md.

## Rounds

The **frontier** is every decision whose prerequisites are already settled: the
questions you can ask now without guessing at answers you haven't heard. Ask the
whole frontier in one round. Number each question and give your recommended
answer. Then wait for the user's answers before the next round.

```
❓ **Q1** - **<question title>**: <question body, may be several paragraphs,
including lettered options where they help>

➡️ <your recommended answer, and the one-line reason>

---

❓ **Q2** - **<question title>**: <...>

➡️ <...>
```

Word each question so "yes" accepts your recommendation. The user may answer
"yes to all but Q3: ...".

Each round of answers reshapes the tree. Settled decisions push the frontier
outward and unblock questions that depended on them. Recompute the frontier and
ask the next round. A question whose answer depends on another question still
open in this round belongs to a later round.

Keep rounds readable: if the frontier is larger than ~6 questions, ask the ones
that unblock the most first.

## Facts are yours, decisions are theirs

Never ask the user for a fact you can look up: file contents, repo layout, live
AWS/k8s state (read-only), past missions (`mx search`, `memory_search`), vendor
docs (`web_search`/`fetch_content`). Look it up first, or dispatch a subagent for
anything slow. Don't block on it: only the questions downstream of a pending
lookup wait; ask the rest of the frontier now.

Every decision goes to the user. Put it to them and wait. Never answer your own
question and move on.

## Sharpen the language

- **Fuzzy or overloaded terms**: propose one precise term. "You said 'the
  database'. The primary or the read replica? Different things."
- **Contradictions with the code or live state**: surface them. "You said the
  chart pins 1.7.0, the lockfile pins 1.8.2. Which is
  right?"
- **Edge cases**: invent concrete scenarios that force a boundary. "Pipeline
  apply fails halfway through account 3 of 5. What state is the rollout in?"

## Done

The grilling is done when the frontier is empty: every branch visited, nothing
silently assumed. Summarize the settled decisions in a short list and ask the
user to confirm shared understanding. Do not act on any of it before they
confirm.
