# Start port map

## Packaging disposition (mission-b7h.22)

The distributable inventory is `package.json.files`, enforced by
`scripts/archive.ts`: runtime extension/source, adapted skills/policies/templates,
public documentation, installer, provenance and MIT notices. Tests, original
Team plugin/output styles, Git history, dependency trees, personal configuration
and runtime state are excluded. Host packages remain unbundled peers. `.gitkeep`
markers are omitted. Archives reject symlinks and common credential patterns;
listing/scanning does not establish malicious-worker isolation or secrecy.

Installer boundary and archive relocation checks pass offline; full check is
244/244. See [verification](verification.md) for prerequisite failures in this
worker, pending live/install permission and unresolved end-to-end capabilities.
No new provider parity or interactive coexistence claim is made. The immutable
source revision and per-file dispositions in upstream.json remain unchanged.

## Quality gates (mission-b7h.19)

All four quality skills are now explicit-only pi workflows. Their supporting
references, examples and constitution template are consolidated into each
skill's `reference/methods.md`; upstream.json maps every original source file
to that destination. The table and upstream.json both record current consolidated quality
destinations. Bootstrap verification labels remain historical.

Review synthesis tests cover breaking/critical and high-count thresholds,
location deduplication and retained migration evidence. Test reports reject
missing exits, failures, blockers and all-skipped categories. A real foreground
failing fixture verifies one pass, one fail and exit 1. Static content tests
cover links, explicit frontmatter, modes and safety contracts. No provider or
remote review was run.

Checkpoint integration is instructional, not a new registered operation:
this snapshot has no src/checkpoint.ts. Parent must connect validated quality
evidence to the common checkpoint contract when that implementation lands.
Constitution L1/L2, breaking review and missing E2E stay blocking. No claim of
end-to-end checkpoint or host/provider parity is made.

Worker verification: quality tests 8/8 pass, typecheck passes. Full
`TMPDIR=/tmp npm run check` has 219/221 passing tests. Two out-of-scope
commands tests still assume review SKILL.md is absent: the missing-skill test
now dispatches, and the real SDK loader's review invocation tries to send a
model message without a provider key. Parent must update those fixtures to
use an explicitly missing skills root/provider-free dispatch boundary; no
provider invocation or out-of-scope edit was authorized here.

## Factory action evidence

Factory skill and role references now describe reviewed group integration, cooperative holdouts, owned evaluation and total attempts (default five including initial run), replacing upstream retry-counter resets. Pure decision and feedback tests cover bounded retries, stale candidate evidence and forged reports. Full fake-worker/workspace/runner/beads Factory orchestration fixtures remain pending; no provider parity is claimed.

The factory configuration validator lives in src/factory.ts. The shared SpecSchema and makeSpec still need parent-approved out-of-scope extension to persist/hash factory configuration and require it for Factory descriptors. The helper accepts the extension locally, but this is not yet an end-to-end persisted descriptor contract.

## Source and current evidence

Upstream is `rsmdt/the-startup` at
`88d447c7fb846f9d519faf59219cd34cf7577501`.
The source checkout is read-only. Do not fetch, update or mutate it.

The pinned tree has 201 files under `plugins/start/`, including 20 `SKILL.md`
files. This inventory has 203 entries after adding `LICENSE` and
`docs/PRINCIPLES.md`. It includes all tracked Start references, templates,
examples, validation files and eval inputs. Counts in upstream prose are not
the inventory.

`upstream.json` owns the source paths, SHA-256 hashes, byte sizes, dispositions,
planned destinations and implementing action IDs. Hashes refer to source bytes
at the pinned revision, not the adapted destination files. Every source blob
was compared with the clean source checkout during bootstrap.

Dispositions: 1 port, 119 adapt, 80 test-fixture, 3 omit.
A planned destination below does not mean the port is implemented. At bootstrap
only the package manifest, catalog, license and provenance records exist.
The skill directory is empty. There is no extension, live worker dispatch,
installation or provider verification yet.

## Specification port evidence (mission-b7h.15)

The six specification skills and all their mapped supporting targets now exist.
References, validation, and output guidance are consolidated by subject rather
than copied one-for-one. The rows below and upstream.json identify each source
file's current destination. Source hashes still describe the pinned originals.
The bootstrap "port not yet verified" labels on supporting rows are historical;
for this action, static content lint and the specification tests are the current
evidence. No provider-backed skill eval has run.

`test/specification-skills.test.ts` checks frontmatter, size, forbidden active
tokens, supporting Markdown links, static plans without execution checkboxes,
seven adapted tier fixtures, descriptor omission/dependency/scenario rules,
scenario revision invalidation, and a real temporary spec materialized twice
through the fake beads client with one graph. Run it with `TMPDIR=/tmp`.
Upstream eval expectations are condensed in `eval-contracts.md`; those prose
contracts are not all executable tests. In particular, orphan-phase repair and
LLM-produced requirement coverage still need parent review. The fixture path
uses actual classifier and descriptor APIs; it does not simulate a model
writing or approving documents.

The current control surface lacks approval-receipt and legacy-import operations.
Skills name only real operations and pause before unsupported mutations.
Document approval must be supplied by the user; these tests do not manufacture
an execution authorization. Factory evaluation configuration awaits the later
evaluation action and is not invented in this descriptor.

## Execution port evidence (mission-b7h.16)

The three explicit execution skills now use descriptor tiers, approved briefs,
beads identity and parent-reviewed snapshot integration. Supporting output and
perspective guides are adapted; upstream eval inputs are condensed in
`test/fixtures/execution/cases.json`, not copied into historical planned fixture
paths. The fixture prose is acceptance guidance, not model eval evidence.

`src/execution.ts` is a pure decision function using existing beads issue status
and parent receipt metadata. Tests cover dependent ordering, stale closed
receipts, closed-task reuse prevention, direct limits, phase pause/resume,
stale approvals and interrupted/cancelled candidates. Existing real Git patch
tests cover out-of-scope rejection and atomic integration conflicts.

Guarded workspace prepare/collect/integrate operations require a session-owned
registry and explicit parent authority adapter; without it they fail closed.
This checkout lacks the prerequisite revision-receipt scheduler/checkpoint APIs
specified by action .14 (its existing claim API is session-local). Consequently
full end-to-end claim -> worker -> tested checkpoint -> beads close is **not**
claimed operational here. Wiring and deterministic two-task end-to-end failure
injection remain parent integration work. No default-pass authority adapter or
second status ledger was introduced. No provider calls or real beads commands
were run.

## Maintenance port evidence (mission-b7h.20)

Six explicit maintenance skills now preserve read-only previews, design/fix
approval separation, bound-epic reuse, reviewed documentation persistence and
baseline-preserving refactoring. Supporting source references, examples and
templates are condensed into each skill's reference/methods.md, not copied
verbatim. The per-file destinations below and upstream.json reflect this.
The earlier bootstrap verification labels are not claims of model evaluation.

`test/maintenance.test.ts` checks all six frontmatters, byte limits, forbidden
active tokens, local links and approval/binding contracts. Offline fixture cases
record cancellation, read-only preview, bound diagnosis, refactor outputs and
global lesson dedup boundaries. These are contract checks, not provider-backed
proof of a model following instructions. A real temporary-project materialization
through fake beads verifies reuse of the explicit epic and one graph across
repeated requests. A filesystem characterization fixture compares baseline and
extracted candidate outputs. Cancellation, read-only analysis, documentation
scope and lesson persistence remain content-contract checks, not executed model
traces. Native lifecycle tests remain in their owning actions. No provider or
real beads operations ran. `TMPDIR=/tmp npm run check` passed with 236 tests.
All 20 catalog SKILL.md files exist in this snapshot; this action verifies local
links only for its six maintenance skills.

## Storage and invocation changes

Static project requirements, solution and decomposition stay under
`.start/specs/NNN-name/`. A validated `spec.json` descriptor supplies explicit
tier, task definitions, artifact paths and identity bindings. Global beads owns
decisions, executable tasks, dependencies, approvals and completion. No editable
Markdown checkboxes, status frontmatter or second decisions ledger will own
execution progress.

`specify-meta/spec.py` becomes TypeScript schema/store operations. Safe spec
resolution, creation locks, content hashing and explicit legacy import replace
shell/Python file heuristics. Legacy checkmarks are untrusted import evidence.
They cannot close a task without verification.

The package will register `/sdd` with eleven workflow verbs and later add
`status`, `doctor` and `off` controls. All twenty `sdd-*` skills will set
`disable-model-invocation: true`. Internal helpers will not become top-level
workflow commands. Existing `/start`, `/focus`, `/land`, mission skills and
pstack remain unchanged.

## Exclusions and host constraints

Do not include `plugins/team/**`, Team agent identifiers or Agent Team
coordination. Start's own perspective prompts can be adapted without Team
definitions. Do not copy the separate constitution plugin. The Start
constitution skill remains in scope.

Omit upstream output styles, personas and statusline scripts. Preserve the
installed pi footer, theme and unslop writing policy. Rewrite usage docs from
verified pi behavior rather than copy marketing or Claude installation text.

Use the installed pi-subagent through guarded nested-tool calls. Do not bundle
a second worker runtime, import private runner code, register another subagent,
or change existing packages. Worker context must be explicit. Model IDs resolve
from existing roles without substitution. Workers currently have low/off
thinking, no web/MCP, no automatic skill loading and no nested workers.

Snapshots omit upstream Git history, runtime data, credentials and coder
holdout files. Parent review controls patch integration and completion.
This is cooperative same-user separation, not OS-enforced isolation. Evaluators
receive scenarios and a runnable interface, not unit design or coding transcripts.
Retries receive only parent-approved short failure symptoms.

Evaluation is local, bounded and parent-owned. No detached services or live
infrastructure. A worker's succeeded result is candidate evidence, never proof
of completion. Changed specs, failed dependencies, cancelled approvals, missing
logs or unknown cleanup block progress.

Host `@earendil-works/pi-coding-agent` and `typebox` are peers with `*` ranges.
Development copies are pinned to the installed host's 1.0.4 and 1.3.27 versions.
They and all `node_modules` content must stay out of the distributable archive.
A disposable TypeScript probe under this package's dependency tree loaded through
the installed pi 1.0.4 core extension loader. Object-identity checks confirmed
that coding-agent and typebox imports used the host modules rather than the
physical development copies. It created no model session and changed no real
settings. The probe was removed after the check. This proves peer resolution,
not SDD extension behavior. The real extension enters verification in .11 and
full coexistence acceptance in .21. No real settings change is authorized here.

## Skill parity cases to verify

These are acceptance targets, not passing-test claims.

| Skill family | Required behavior | Verification action |
|---|---|---|
| Specify and its five helpers | Non-linear document entry, approved omissions, complexity rationale, static briefs and safe legacy import | .9, .15 |
| Implement dispatcher | Explicit descriptor tier, no heuristic execution of stale artifacts | .16 |
| Direct | One to three tasks, dependency order, no decomposition files, reviewed patches | .16 |
| Incremental | Current phase only, human transition gates, interrupted resume without duplicate work | .14, .16 |
| Factory | Ready-unit parallelism, black-box command/HTTP checks, bounded total attempts, failed prerequisites stay blocked | .17, .18 |
| Validate | Spec, File, Drift, Constitution, Comparison and Understanding modes | .19 |
| Test | All, targeted, baseline and audit, actual category counts, missing E2E blocks completion | .19 |
| Review | Conditional perspectives, deduplication, breaking changes first with consumer migration | .19 |
| Constitution | Approved checkable L1/L2/L3 rules; L1/L2 findings block checkpoints | .19 |
| Analyze | Read-only repository discovery; documentation persistence needs review | .20 |
| Brainstorm | Approved design before code; one explicit binding, no duplicate mission ceremony | .20 |
| Debug | Root-cause-first evidence in the bound epic; diagnosis does not authorize a fix | .20 |
| Refactor | Baseline, file scope and approval before behavior-preserving changes | .20 |
| Document | Approved documentation only, checked against source; no unrelated refactor | .20 |
| Writing skills | Pi frontmatter, relative links, progressive disclosure and offline eval guidance | .20 |

Factory will define `maxAttempts` as total attempts including the initial run,
rather than carry over ambiguous `max_iterations` wording. Its descriptor
settings and static evaluation configuration enter the approval content hash.

Each action updates this map with actual checks and intentional deviations.
Offline tests use fake model/beads boundaries, real disposable Git operations
and actual local test/evaluation processes. Provider-backed smoke tests and
global installation require explicit approval in the final stage.

## Per-file destinations

The action column links to the authoritative beads plan. A destination can
appear in more than one row when multiple source methods share a native
implementation. Every omitted file has an explicit reason in `upstream.json`.

| Source | Disposition | Planned destination | Action | Verification |
|---|---|---|---|---|
| `LICENSE` | port | `LICENSE` | `mission-b7h.8` | Byte-identical MIT notice |
| `docs/PRINCIPLES.md` | adapt | `policies/workflow.md`<br>`policies/worker-common.md` | `mission-b7h.11`, `mission-b7h.12` | Source hash checked; port not yet verified |
| `plugins/start/.claude-plugin/plugin.json` | adapt | `package.json` | `mission-b7h.8` | Installed pi 1.0.4 resource loading checked (action 21); tier acceptance blocked pending checkpoint capability; see docs/verification.md |
| `plugins/start/README.md` | omit | None | `mission-b7h.22` | Exclusion recorded |
| `plugins/start/output-styles/the-scaleup.md` | omit | None | `mission-b7h.8` | Exclusion recorded |
| `plugins/start/output-styles/the-startup.md` | omit | None | `mission-b7h.8` | Exclusion recorded |
| `plugins/start/skills/analyze/SKILL.md` | adapt | `skills/sdd-analyze/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/analyze/evals/evals.json` | test-fixture | `test/fixtures/maintenance/cases.json` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/analyze/examples/output-example.md` | adapt | `skills/sdd-analyze/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/analyze/reference/output-format.md` | adapt | `skills/sdd-analyze/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/analyze/reference/perspectives.md` | adapt | `skills/sdd-analyze/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/brainstorm/SKILL.md` | adapt | `skills/sdd-brainstorm/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/SKILL.md` | adapt | `skills/sdd-constitution/SKILL.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/examples/CONSTITUTION.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/examples/output-example.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/reference/output-format.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/reference/perspectives.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/reference/rule-patterns.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/reference/scenarios.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/constitution/template.md` | adapt | `skills/sdd-constitution/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/SKILL.md` | adapt | `skills/sdd-debug/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/examples/hard-bug-example.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/examples/output-example.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/reference/hypothesis-hygiene.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/reference/investigation-ladder.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/reference/output-format.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/debug/reference/perspectives.md` | adapt | `skills/sdd-debug/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/SKILL.md` | adapt | `skills/sdd-document/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/examples/output-example.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/reference/knowledge-capture.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/reference/output-format.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/reference/perspectives.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/templates/domain-template.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/templates/interface-template.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/document/templates/pattern-template.md` | adapt | `skills/sdd-document/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/SKILL.md` | adapt | `skills/sdd-implement-direct/SKILL.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/evals.json` | test-fixture | `test/fixtures/execution/implement-direct/evals.json` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-1-simple-fix/requirements.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-1-simple-fix/requirements.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-1-simple-fix/solution.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-1-simple-fix/solution.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-2-decompose-limit/requirements.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-2-decompose-limit/requirements.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-2-decompose-limit/solution.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-2-decompose-limit/solution.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-3-freeform-brief/README.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-3-freeform-brief/README.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-7-sequential-deps/requirements.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-7-sequential-deps/requirements.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/evals/fixtures/eval-7-sequential-deps/solution.md` | test-fixture | `test/fixtures/execution/implement-direct/fixtures/eval-7-sequential-deps/solution.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/examples/output-example.md` | adapt | `skills/sdd-implement-direct/examples/output-example.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-direct/reference/output-format.md` | adapt | `skills/sdd-implement-direct/reference/output-format.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/SKILL.md` | adapt | `skills/sdd-implement-factory/SKILL.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/evals.json` | test-fixture | `test/fixtures/factory/implement-factory/evals.json` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/scenarios/dm1/health-status-fields.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/scenarios/dm1/health-status-fields.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/scenarios/rl1/rate-limit-exceeded.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/scenarios/rl1/rate-limit-exceeded.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/scenarios/ve1/endpoint-returns-200.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/scenarios/ve1/endpoint-returns-200.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/scenarios/ve1/invalid-method-405.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/scenarios/ve1/invalid-method-405.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/units/dm1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/units/dm1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/units/rl1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/units/rl1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-1-happy-path/units/ve1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-1-happy-path/units/ve1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-2-retry/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-2-retry/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-2-retry/scenarios/ve1/age-out-of-range.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-2-retry/scenarios/ve1/age-out-of-range.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-2-retry/scenarios/ve1/invalid-email.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-2-retry/scenarios/ve1/invalid-email.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-2-retry/scenarios/ve1/valid-input.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-2-retry/scenarios/ve1/valid-input.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-2-retry/units/ve1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-2-retry/units/ve1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-3-max-iterations/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-3-max-iterations/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-3-max-iterations/scenarios/ve1/returns-version.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-3-max-iterations/scenarios/ve1/returns-version.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-3-max-iterations/units/ve1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-3-max-iterations/units/ve1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/scenarios/ep1/ping-returns-pong.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/scenarios/ep1/ping-returns-pong.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/scenarios/ep2/echo-missing-body.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/scenarios/ep2/echo-missing-body.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/scenarios/ep2/echo-returns-body.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/scenarios/ep2/echo-returns-body.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/units/ep1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/units/ep1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-4-parallel/units/ep2.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-4-parallel/units/ep2.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-5-resume/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-5-resume/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-5-resume/scenarios/dm1/health-data.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-5-resume/scenarios/dm1/health-data.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-5-resume/scenarios/ve1/health-endpoint.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-5-resume/scenarios/ve1/health-endpoint.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-5-resume/units/dm1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-5-resume/units/dm1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-5-resume/units/ve1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-5-resume/units/ve1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/manifest.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/manifest.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/scenarios/dm1/e2e-stubs.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/scenarios/dm1/e2e-stubs.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/scenarios/dm1/echo-response.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/scenarios/dm1/echo-response.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/scenarios/ve1/e2e-stubs.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/scenarios/ve1/e2e-stubs.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/scenarios/ve1/echo-missing-message.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/scenarios/ve1/echo-missing-message.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/scenarios/ve1/echo-success.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/scenarios/ve1/echo-success.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/units/dm1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/units/dm1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/evals/fixtures/eval-6-e2e-stubs/units/ve1.md` | test-fixture | `test/fixtures/factory/implement-factory/fixtures/eval-6-e2e-stubs/units/ve1.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/examples/output-example.md` | adapt | `skills/sdd-implement-factory/examples/output-example.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/reference/code-agent.md` | adapt | `skills/sdd-implement-factory/reference/code-agent.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/reference/eval-agent.md` | adapt | `skills/sdd-implement-factory/reference/eval-agent.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-factory/reference/output-format.md` | adapt | `skills/sdd-implement-factory/reference/output-format.md` | `mission-b7h.18` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/SKILL.md` | adapt | `skills/sdd-implement-incremental/SKILL.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/evals.json` | test-fixture | `test/fixtures/execution/implement-incremental/evals.json` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-1-happy-path/plan/README.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-1-happy-path/plan/README.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-1-happy-path/plan/phase-1.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-1-happy-path/plan/phase-1.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-1-happy-path/plan/phase-2.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-1-happy-path/plan/phase-2.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-1-happy-path/plan/phase-3.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-1-happy-path/plan/phase-3.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-2-resume/plan/README.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-2-resume/plan/README.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-2-resume/plan/phase-1.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-2-resume/plan/phase-1.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-2-resume/plan/phase-2.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-2-resume/plan/phase-2.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-2-resume/plan/phase-3.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-2-resume/plan/phase-3.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-3-parallel-tasks/plan/README.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-3-parallel-tasks/plan/README.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-3-parallel-tasks/plan/phase-1.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-3-parallel-tasks/plan/phase-1.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-3-parallel-tasks/plan/phase-2.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-3-parallel-tasks/plan/phase-2.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-6-no-plan/requirements.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-6-no-plan/requirements.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/evals/fixtures/eval-6-no-plan/solution.md` | test-fixture | `test/fixtures/execution/implement-incremental/fixtures/eval-6-no-plan/solution.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/examples/output-example.md` | adapt | `skills/sdd-implement-incremental/examples/output-example.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/reference/output-format.md` | adapt | `skills/sdd-implement-incremental/reference/output-format.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement-incremental/reference/perspectives.md` | adapt | `skills/sdd-implement-incremental/reference/perspectives.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/implement/SKILL.md` | adapt | `skills/sdd-implement/SKILL.md` | `mission-b7h.16` | Source hash checked; port not yet verified |
| `plugins/start/skills/refactor/SKILL.md` | adapt | `skills/sdd-refactor/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/refactor/examples/output-example.md` | adapt | `skills/sdd-refactor/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/refactor/reference/code-smells.md` | adapt | `skills/sdd-refactor/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/refactor/reference/output-format.md` | adapt | `skills/sdd-refactor/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/refactor/reference/perspectives.md` | adapt | `skills/sdd-refactor/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/SKILL.md` | adapt | `skills/sdd-review/SKILL.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/examples/output-example.md` | adapt | `skills/sdd-review/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/reference/checklists.md` | adapt | `skills/sdd-review/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/reference/classification.md` | adapt | `skills/sdd-review/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/reference/output-format.md` | adapt | `skills/sdd-review/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/review/reference/perspectives.md` | adapt | `skills/sdd-review/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/SKILL.md` | adapt | `skills/sdd-specify-factory/SKILL.md` | `mission-b7h.15` | Public unit/holdout port; content tests passed |
| `plugins/start/skills/specify-factory/evals/evals.json` | test-fixture | `test/fixtures/specification/eval-contracts.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/evals/fixtures/spec-missing-sdd/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/evals/fixtures/spec-with-both/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/evals/fixtures/spec-with-both/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/examples/manifest-example.md` | adapt | `skills/sdd-specify-factory/examples/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/examples/scenario-example.md` | adapt | `skills/sdd-specify-factory/examples/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/examples/unit-example.md` | adapt | `skills/sdd-specify-factory/examples/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/reference/decomposition.md` | adapt | `skills/sdd-specify-factory/reference/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/reference/output-format.md` | adapt | `skills/sdd-specify-factory/reference/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/reference/scenario-guide.md` | adapt | `skills/sdd-specify-factory/reference/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/templates/e2e-stubs.md` | adapt | `skills/sdd-specify-factory/templates/e2e-stubs.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/templates/manifest.md` | adapt | `skills/sdd-specify-factory/templates/manifest.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/templates/scenario.md` | adapt | `skills/sdd-specify-factory/templates/scenario.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/templates/unit.md` | adapt | `skills/sdd-specify-factory/templates/unit.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-factory/validation.md` | adapt | `skills/sdd-specify-factory/reference/factory.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/SKILL.md` | adapt | `skills/sdd-specify-incremental/SKILL.md` | `mission-b7h.15` | Static phase port; content tests passed |
| `plugins/start/skills/specify-incremental/evals/evals.json` | test-fixture | `test/fixtures/specification/eval-contracts.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-single-feature/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-single-feature/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-validation-gaps/plan/README.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-validation-gaps/plan/phase-1.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-validation-gaps/plan/phase-2.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-validation-gaps/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/evals/fixtures/spec-validation-gaps/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/examples/output-example.md` | adapt | `skills/sdd-specify-incremental/examples/phase-examples.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/examples/phase-examples.md` | adapt | `skills/sdd-specify-incremental/examples/phase-examples.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/reference/output-format.md` | adapt | `skills/sdd-specify-incremental/reference/task-structure.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/reference/task-structure.md` | adapt | `skills/sdd-specify-incremental/reference/task-structure.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/template.md` | adapt | `skills/sdd-specify-incremental/template.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/templates/phase.md` | adapt | `skills/sdd-specify-incremental/templates/phase.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-incremental/validation.md` | adapt | `skills/sdd-specify-incremental/reference/task-structure.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-meta/SKILL.md` | adapt | `skills/sdd-specify-meta/SKILL.md` | `mission-b7h.15` | TypeScript control port; content tests passed |
| `plugins/start/skills/specify-meta/reference/spec-management.md` | adapt | `skills/sdd-specify-meta/reference/spec-management.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-meta/spec.py` | adapt | `src/spec-schema.ts`<br>`src/spec-store.ts` | `mission-b7h.9` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-meta/template.md` | adapt | `templates/spec-readme.md`, `skills/sdd-specify-meta/template.md` | `mission-b7h.9`, `mission-b7h.15` | Navigation-only templates; content lint passed |
| `plugins/start/skills/specify-requirements/SKILL.md` | adapt | `skills/sdd-specify-requirements/SKILL.md` | `mission-b7h.15` | Explicit requirements port; content tests passed |
| `plugins/start/skills/specify-requirements/evals/evals.json` | test-fixture | `test/fixtures/specification/eval-contracts.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/examples/good-prd.md` | adapt | `skills/sdd-specify-requirements/examples/good-prd.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/examples/output-example.md` | adapt | `skills/sdd-specify-requirements/examples/good-prd.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/reference/focus-and-mece.md` | adapt | `skills/sdd-specify-requirements/reference/requirements.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/reference/output-format.md` | adapt | `skills/sdd-specify-requirements/reference/requirements.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/template.md` | adapt | `skills/sdd-specify-requirements/template.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-requirements/validation.md` | adapt | `skills/sdd-specify-requirements/reference/requirements.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/SKILL.md` | adapt | `skills/sdd-specify-solution/SKILL.md` | `mission-b7h.15` | Explicit design port; content tests passed |
| `plugins/start/skills/specify-solution/evals/evals.json` | test-fixture | `test/fixtures/specification/eval-contracts.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/examples/architecture-examples.md` | adapt | `skills/sdd-specify-solution/examples/architecture-examples.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/examples/output-example.md` | adapt | `skills/sdd-specify-solution/examples/architecture-examples.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/reference/focus-and-mece.md` | adapt | `skills/sdd-specify-solution/reference/solution.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/reference/output-format.md` | adapt | `skills/sdd-specify-solution/reference/solution.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/template.md` | adapt | `skills/sdd-specify-solution/template.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify-solution/validation.md` | adapt | `skills/sdd-specify-solution/reference/solution.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/SKILL.md` | adapt | `skills/sdd-specify/SKILL.md` | `mission-b7h.15` | Native static port; content and fixture tests passed |
| `plugins/start/skills/specify/evals/evals.json` | test-fixture | `test/fixtures/specification/eval-contracts.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-direct/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-direct/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-factory/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-factory/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-incremental/requirements.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/evals/fixtures/classifier-incremental/solution.md` | test-fixture | `test/fixtures/specification/cases.json` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/examples/output-example.md` | adapt | `skills/sdd-specify/examples/output-example.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/reference/classifier.md` | adapt | `skills/sdd-specify/reference/workflow.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/reference/output-format.md` | adapt | `skills/sdd-specify/reference/workflow.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/specify/reference/perspectives.md` | adapt | `skills/sdd-specify/reference/workflow.md` | `mission-b7h.15` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/SKILL.md` | adapt | `skills/sdd-test/SKILL.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/examples/output-example.md` | adapt | `skills/sdd-test/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/reference/discovery-protocol.md` | adapt | `skills/sdd-test/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/reference/failure-investigation.md` | adapt | `skills/sdd-test/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/reference/output-format.md` | adapt | `skills/sdd-test/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/test/reference/test-design-rules.md` | adapt | `skills/sdd-test/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/SKILL.md` | adapt | `skills/sdd-validate/SKILL.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/examples/output-example.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/3cs-framework.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/ambiguity-detection.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/constitution-validation.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/drift-detection.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/output-format.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/validate/reference/perspectives.md` | adapt | `skills/sdd-validate/reference/methods.md` | `mission-b7h.19` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/SKILL.md` | adapt | `skills/sdd-writing-skills/SKILL.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/examples/canonical-skill.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/examples/output-example.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/reference/common-failures.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/reference/conventions.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/reference/output-format.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/reference/persuasion-principles.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
| `plugins/start/skills/writing-skills/reference/testing-with-subagents.md` | adapt | `skills/sdd-writing-skills/reference/methods.md` | `mission-b7h.20` | Source hash checked; port not yet verified |
