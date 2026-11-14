# Compatibility

Verified resource-loading target: **pi 1.0.4**, **Node 26**, **macOS**.
`package.json` restricts Node to `>=26 <27`. Host package peers deliberately use
`*` per pi's package contract; this is not a claim of support for every host
version. Development checks pin pi 1.0.4 and typebox 1.3.27.

Peers are `@earendil-works/pi-coding-agent` and `typebox`, supplied by pi's
extension loader. They are not bundled and must not become a second runtime.
Local installs load in place and do not install dependencies. The archive has
no node_modules; there are no other runtime dependencies. Development-only
`npm ci --ignore-scripts` uses the included lockfile inside the package checkout.

Required external capabilities:

- pi-subagent's registered `start/status/wait/cancel/list` contract, guarded
  nested tool execution and known process cleanup. No private runner import or
  alternate worker runtime. Incompatible schemas must block `/sdd doctor`.
- `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) with
  `extensions/guards/index.ts`; presence alone does not prove active hooks.
- Global `bd` on PATH and `~/.beads`; the installer never invokes bd.
- `pstack/models.json`, version 1, with exact provider/model IDs:

| Worker role | Existing pstack key |
| --- | --- |
| code | feature, refactoring |
| fix | bug-fix |
| performance | perf-issue |
| research | how explorer |
| review, eval, prose | judgment and prose |
| hardest (explicit escalation only) | hardest tasks |

Optional SDD model overrides are session-doctor validated from
`pi-sdd/config.json`; no guessed model fallback or thinking upgrade is allowed.
`--check` checks versions, files, role shape and package declaration read-only;
it cannot prove active tool schemas, guards or provider/model availability.
Run `/sdd doctor` after an authorized reload for the active contract. CLI
preflight success does not establish provider or interactive compatibility.

The managed release is resolved from the host rather than an older npm package
namespace. Resource tests currently use synthetic coexistence command fixtures,
not the user's full mission-workflow/pstack/footer/theme stack. Full execution
and live acceptance remain blocked/pending as described in
[verification](verification.md). Do not auto-upgrade host or worker packages.
