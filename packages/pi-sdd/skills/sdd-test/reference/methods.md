# Discovery, investigation and test design

Discover package scripts, runner configs, Makefile/task definitions and CI commands. Node runners include node:test, Jest, Vitest, Mocha, Playwright and Cypress; Python pytest; Rust cargo; Go go test; Java JUnit. Locate co-located test/spec files, test directories and ecosystem naming patterns. Exclude scenarios/ holdouts and evaluation outputs. Determine separate unit, integration, E2E, snapshot/performance/accessibility commands and lint/typecheck/format checks; a primary test command does not prove all categories execute.

Capture category command/config/file count, runner version and setup requirements. Missing E2E runner/script/browser/service is blocked with evidence. Do not install or start services without approved bounded setup. Baseline records actual exits/counts without repairs. Targeted results cannot masquerade as full coverage. Audit is static only: no commands that execute tests and no edits.

## MECES
Mutually Exclusive, Collectively Exhaustive, Signal-bearing tests cover real behaviors without same-level duplicates. Preserve pure branching/domain logic, security/correctness gates, timeout/malformed/concurrency edge cases and stateful coordinators with functional fakes. Mock only foreign boundaries; assert outcomes, not call sequences. Type checking already covers static signatures and required fields, not runtime behavior.

Noise candidates: tautological literal/template tests, framework re-verification, mocked database clients with no real query, identity-mapped service mocks, call-sequence-only assertions, trivial wrappers, presentation/CSS structure and constants with no logic. Use accessibility/user behavior rather than rigid DOM classes. A candidate is not automatic deletion authority: obtain reviewed rationale and demonstrate retained coverage by callers/integration tests.

Audit cost signals: per-directory test/source LOC ratio, mock density, fake availability and previously measured runtime (never execute to measure in audit). Ratios below .3 may signal gaps, .3–.7 often healthy, above .7 invite inspection, above 1 stronger hotspot; typed code often lower. Ratios alone are not verdicts. Flag two combined hotspot signals, inspect code/test pairs, list source/test paths and rationale, recommend deletions or fake-backed rewrites and estimate savings without claiming observed execution.

## Investigation
Keep original failure output. Classify YOUR_CHANGE, OUTDATED_TEST, TEST_BUG, NOISE_TEST, MISSING_DEP, ENVIRONMENT or CODE_BUG. Read test and source, establish intended behavior and root cause. Repair only authorized in-scope regressions. Other failures remain blocked evidence and new-action proposals. Do not weaken assertions or delete failures for green output. Reviewed noise deletion proves coverage remains. Run affected and full required tests after fixes.

## Report formats
Discovery: category/runner/config/command/files, quality commands and setup.
Baseline: actual passed/failed/skipped and exits, no fixes.
Execution: command, duration, exit, counts, logPath, blockers and root cause.
Escalation: original symptom, exact missing setup/authority, evidence and next authorized action; skipping is not a workaround pass.
Final: category coverage, quality exits, scoped fixes, MECES overlaps/gaps/noise, partial skips and explicit policy decisions.
Audit: discovery, cost heatmap, noise evidence, high-signal examples and recommendations; no execution results.

Example: unit 1 pass / 1 fail, exit 1; E2E null exit, 0 pass / 4 skip, browser missing. Suite is blocked. Complete raw logs stay private by path; summarize symptoms without holdout content. Quality typecheck exit 0 with no test counts is a command pass, not proof of E2E.
