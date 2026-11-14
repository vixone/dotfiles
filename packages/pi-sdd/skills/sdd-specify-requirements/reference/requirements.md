# Requirements focus and validation

Requirements answer WHAT is needed, WHY it matters, WHO uses it, and WHEN it succeeds. Architecture and database design belong in the solution.

## Mutually exclusive, collectively exhaustive checks

| Enumeration | Overlap check | Gap check |
|---|---|---|
| Personas | Merge duplicate goals and roles | Include every relevant user type |
| Journeys | Avoid duplicate paths for one persona | Include happy, error, and recovery paths |
| Features | Merge the same capability across priority groups | Cover each persona's problem |
| Criteria | Test distinct conditions | Cover each feature's boundaries and failures |

After each section, compare across sections as well. Every persona needs a journey. Every feature needs criteria. Every metric needs measurement evidence.

## Review checks

Before requesting approval, verify required sections, no unfinished placeholders, measurable problem and acceptance, consistent scope, supported assumptions, MoSCoW priorities, defined jargon, and risk mitigations. A reader new to the project must understand the document without hidden context. Ask through `ask_user_question` about unresolved contradictions, priorities, and alternate scenarios.

A section report lists approved content, unresolved clarification count, acceptance count, evidence sources, validation gaps, and next decisions. Do not confuse authoring readiness with beads task completion. Resume edits only unapproved sections after reading the existing file.
