---
name: sdd-debug
description: Investigate bugs, test failures and unexpected behavior through reproducible evidence and competing hypotheses before proposing a fix.
disable-model-invocation: true
---
# SDD debug

Reuse the bound epic. If none is bound, explicitly select a related or new debug mission once under Missions.md conventions; resolve focus conflicts before persistence. Do not create a second epic for each hypothesis. Diagnosis approval does not authorize code fixes or instrumentation edits.

## Workflow
1. Capture exact symptoms, commands, inputs, outputs and reproduction conditions. If reproduction is unknown, propose reviewed instrumentation or a failing test; do not call a vanished symptom fixed.
2. Read [investigation methods](reference/methods.md) and the complete failing path. Compare a working example, dependencies, recent changes and environment without reading credentials.
3. Track bounded mission findings/comments plus private runtime investigation evidence. Each hypothesis has ID, predicted observation, falsifying experiment, status and cited result. Use [hypothesis], [evidence: command/path], [ruled out: reason] and [demonstrated]. Never silently abandon a theory; explicitly defer unresolved ones with reason.
4. Test one variable at a time. Two untested hypotheses trigger deeper evidence gathering, not more speculation. Use bounded independent sdd_worker research for conflicting explanations; send observations rather than a favored story. No peer coordination or invented tools.
5. Promote a root cause to [demonstrated] only when a controlled toggle makes the symptom appear/disappear. Obtain separate user approval for exact fix/test files, commands and scope before delegating code changes. Keep the fix in the same bound mission. A worker result is candidate evidence, not completion.
6. Parent reviews the allowed diff and runs regression plus relevant full tests before a checkpoint. Report actual exit codes, logs and remaining uncertainty. After three unsuccessful fixes, or repeated unknown failures, stop with concrete commands/results and request architectural review or more evidence; no silent fourth fix.
7. Reusable lessons follow dedup, rubric and user-approved persistence rules; unresolved bugs remain open.
