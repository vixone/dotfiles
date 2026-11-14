# pi-sdd

EXPERIMENTAL SOURCE ONLY. The personal bootstrap does not install this package. Its Pi 1.0.4 target and bd/pstack/pi-subagent/guards requirements are separate from mission-stack. Current Pi compatibility and end-to-end execution are not established. Do not treat this export as a working integration. Read [compatibility](docs/compatibility.md) before opting in.

Opt-in, spec-driven engineering workflows for pi: turn an approved brief into
mission tasks, review isolated worker changes, and verify before completion.
Twenty explicit skills share one `/sdd` entry point. Existing `/start`, `/focus`,
`/land`, pstack, themes and footer are not replaced.

**Current status:** packaged for local review, not installed. Offline resource
checks pass, but end-to-end execution is blocked by missing checkpoint/authority
integration. Provider-backed and interactive verification remain pending. See
[verification](docs/verification.md) before attempting implementation.

## Prerequisites and installation

Target: macOS, Node 26, pi 1.0.4, installed pi-subagent, worker guards, global
beads and pstack role configuration. See [compatibility](docs/compatibility.md).
No auto-upgrades or credential copying occur.

```sh
./install.sh --check                   # read-only prerequisites; no providers
# Only after explicit user authorization:
./install.sh --install                 # pi install <canonical absolute path>
# In pi, /reload or restart, then /sdd doctor
```

Local paths are loaded in place: keep the package directory. Host modules are
peers supplied by pi, not bundled. There are no non-host runtime dependencies.
For development checks only, install pinned tools with `npm ci --ignore-scripts`.
Pi does not install dependencies for local packages.

## Usage

Start with `/sdd doctor`, `/sdd specify <brief>`, then `/sdd validate <ID>`.
`/sdd implement <ID>` requires a current approved descriptor and bound mission;
it does not itself approve changes. `/sdd status` shows the session binding;
`/sdd off` disables only SDD. See the [command reference](docs/usage.md).

Direct uses 1–3 tasks; Incremental adds user-reviewed phase gates; Factory
uses public units plus separate holdouts and bounded owned local command/HTTP
evaluation. Approval, reviewed integration, passing tests and checkpoint
receipts—not worker exit—are the intended completion boundary.

## Architecture

`extensions/sdd.ts` registers `/sdd` and `sdd_*` tools. `skills/` and `policies/`
provide explicit workflows; `src/` implements schemas and guarded boundaries.
Static requirements/design live in `.start/specs`; global beads owns mutable
tasks, dependencies and receipts. A descriptor binds those identities. The parent
owns state and reviews patches from distinct snapshots. Isolation is cooperative,
not an OS sandbox. Workers use low/off thinking, local tools only, no web/MCP or
nested agents. The parent owns bounded foreground evaluation and cleanup.

Upstream: The Agentic Startup at
`88d447c7fb846f9d519faf59219cd34cf7577501`. See [port map](docs/port-map.md),
`upstream.json`, `LICENSE` and `NOTICE` for provenance and intentional deviations.

## Verification and rollback

```sh
TMPDIR=/tmp npm run check
TMPDIR=/tmp npm run test:acceptance
./install.sh --archive /absolute/output/pi-sdd.tar.gz
./install.sh --remove                  # pi remove <same exact source>
```

The archive lists reviewed distribution paths and scans common secret patterns;
review that list before sharing. It excludes tests, dependencies, Git and private
runtime/configuration. Extract at a new location and run `--check` there.
Remove from the original install directory before moving/upgrading it; installation
at a different absolute path is a different source. Removal never deletes specs,
beads, roles or unrelated settings. Do not restore an old settings backup over
newer user changes. Live smoke/global install need separate explicit permission.
