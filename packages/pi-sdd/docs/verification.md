# Verification evidence

## Packaging handoff (mission-b7h.22)

- Expected red: two installer/archive tests failed before `install.sh` existed
  (`/tmp/action22-red.log`).
- Final `TMPDIR=/tmp npm run check`: typecheck passed; 244 tests passed,
  zero failures/skips. `TMPDIR=/tmp npm run test:acceptance`: six passed.
  Acceptance remains capability/resource evidence, not end-to-end success.
- Installer tests use temporary HOME and PI_CODING_AGENT_DIR plus fake pi;
  double install leaves exactly one canonical entry, double remove restores
  only that entry, unrelated packages/settings remain unchanged. A path with
  spaces and a symlinked package root resolves to the same source.
- Archive/extraction test creates a fresh `/tmp` bundle, lists and checks
  entries, extracts at another path, and passes `--check` on macOS with fixture
  prerequisites. It rejects existing/relative outputs, symlinks and common
  private-key patterns. No node_modules, .git, .pi, .beads or tests are bundled.
- `TMPDIR=/tmp ./install.sh --check`: exit 1 in this worker environment:
  guards, global beads directory, role config and subagent declaration missing.
  Node 26/macOS/pi 1.0.4 passed. No settings changed or bd invoked. CLI preflight
  cannot verify active guard hooks or subagent schemas; `/sdd doctor` remains
  required after an authorized reload. Secret scanning is not a secrecy guarantee.

The host-provided peer ranges remain `*` per pi's documented contract; pinned
local development versions and the lockfile are unchanged. `files` contains
only reviewed distribution paths. No additional runtime dependencies exist.

**Deferred:** first provider-backed Direct and both Factory smoke styles,
actual global installation, `pi list`, reload/restart and interactive
`/sdd doctor`/status plus real /focus /land/pstack/theme/footer coexistence.
These require explicit user authorization and resolution of the execution
blockers below. Cancellation leaves the package built but uninstalled. This
handoff does not authorize closing the action or landing the mission.

## Offline checks (mission-b7h.21)

Run with Node 26 and the installed managed pi release 1.0.4:

```sh
TMPDIR=/tmp npm run check
TMPDIR=/tmp npm run test:acceptance
P=$(mktemp -d /tmp/pi-sdd-offline.XXXXXX)
TMPDIR=/tmp node scripts/smoke.ts --mode=offline --tier=direct --project "$P"
rmdir "$P"
```

Repeat the smoke command with `incremental`, `factory-command` and
`factory-http`. Default mode is offline. The project must be an empty,
non-symlink directory created directly under /tmp with the shown prefix.
The current smoke checks loading in its own disposable agent directory; it
validates but does not populate the supplied project.

Observed results:

- Expected red: both new test files failed before the helper existed.
- `TMPDIR=/tmp npm run check`: 242 passed, zero failed/skipped; typecheck passed.
- New host/acceptance checks: six passed. These are resource and capability
  checks, **not successful end-to-end tier acceptance**.
- All four offline smoke invocations: exit 2, `CHECKPOINT_CAPABILITY_MISSING`.
  No tasks closed. An exit 2 is a blocked result, not a successful smoke.

The helper resolves the installed managed release through `current-version`,
then imports its public SDK entry. It uses disposable agent/workspace paths,
in-memory settings and sessions, no provider prompts, and cleans its directory.
It loads the real pi-sdd package and synthetic coexistence commands. All twenty
skills load with model invocation disabled. A second /sdd registration is
reported with command source information by the actual host diagnostics.

## Blocking gaps

The current extension has no registered checkpoint/receipt persistence
operation. Its workspace control operations need an authority adapter that
`createSddExtension` does not provide. Worker authorization defaults to denial.
The helper deliberately stops rather than manufacture completion or approvals.
Completing those contracts requires changes outside action 21's scope.

Not verified by these new tests: actual mission-workflow/pstack packages,
installed guards/subagent, loopback model orchestration, full command-to-spec
materialization/integration/checkpoint/close, phase interruption/resume and the
complete injected-failure matrix. Existing unit/lifecycle tests cover portions
of these boundaries but do not establish end-to-end acceptance.

Live mode requires `--allow-provider-usage` and a disposable project, then
fails explicitly with `LIVE_ADAPTER_UNAVAILABLE`. No provider-backed smoke,
installation or interactive UI verification was performed. No real beads
operation was invoked; the resource checks do not enter beads operations at all.
