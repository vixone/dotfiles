---
name: sdd-test
description: Explicit all, targeted, baseline or read-only audit of test infrastructure with actual category evidence and bounded repair authority.
disable-model-invocation: true
---

# Testing

Read [test methods](reference/methods.md). Discover runners, configuration, test file patterns, CI commands and every category/quality command before execution using pi read. Exclude holdout scenarios/ directories and evaluation artifacts from ordinary test discovery. Do not expose holdouts in logs or worker prompts.

Modes:
- all: execute every discovered category and quality command.
- targeted: map the named target to relevant tests, but identify all categories and state this limited scope; it is not full-suite evidence.
- baseline: record actual results, no fixes.
- audit: read-only; do not execute tests or edit source, tests or configuration. Report static cost signals and design recommendations only.

For execution use guarded, bounded foreground commands and approved local environment. Missing E2E is blocked, not green: record command/config, missing browser/service/setup evidence and next setup action. Never silently skip E2E, install packages or start guessed services. Explicitly approved owned evaluation contracts govern service checks.

For each category capture TestCategoryResult: category, command, exitCode number/null, passed, failed, skipped, logPath, blockedReason string/null. Keep complete logs by private evidence path and report counts without flooding context. Unknown counts, unparseable/truncated logs or missing results are blocked; never infer pass from worker exit or prose. suitePassed is false for empty results, nonzero/null exit, failed counts, blockers or all-skipped required categories. Partial skips remain visible and need explicit policy/approval, not counted as passed tests. Required quality commands with zero test cases can pass with exit zero and valid evidence.

Investigate original failure output and classify root cause. Only fix in-scope regressions under existing task authority; unrelated failures become evidence and proposed new action/mission. Never auto-weaken assertions or drop failing tests to pass. Noise-test deletion needs reviewed rationale and proof of retained behavioral coverage. Re-run affected tests and full required suite after approved fixes; if another failure appears, investigate rather than silently revert or broaden scope.

Report discovery, baseline, execution, blockers, final category coverage and MECES overlaps/gaps/noise. Audit reports cost heatmap and concrete recommendations, not execution results. Parent supplies actual logs plus review/drift/constitution evidence to the common checkpoint via existing sdd_control operations only when available. Missing E2E, constitution L1/L2 or requested review changes prevents inappropriate completion.
