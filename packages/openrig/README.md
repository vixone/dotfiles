# Optional personal coding rig

One lead and two coding experts using Pi and OpenRig. macOS only: experts require `sandbox-exec`. The lead is your own Pi with your normal tools and permissions, not a sandboxed seat. Unit and real sandbox tests pass on the export machine; live seat launch and generic-provider login are not verified.

## Setup

1. Install the core with the root `bootstrap.sh`, then run `./bootstrap.sh --with-rig` for local dependencies. Keep this checkout in place.
2. Install tmux, herdr and WezTerm. The bundled executable paths assume Apple Silicon Homebrew at `/opt/homebrew`. Adjust `policy/safety.json` and launcher paths for another prefix.
3. Configure your own Pi default provider/model and login first. Seat preparation copies only the selected provider's config/catalog and login to private seat directories. No provider or model fallback is supplied. Custom provider extensions may need separate integration and are not bundled.
4. Review `policy/safety.json`. `repos` and `bash.writableRepos` are empty by default. Add only intended repository roots. Git remotes are SSH-only under `vixone`; update both the Git remote pattern and GitHub owner for your account. Set personal Git identity, SSH authentication and `gh auth login --hostname github.com` outside the rig.
5. Run commands below only when ready to create state under your account's `~/.devrig`. The launcher resolves account home from the password database, so changing HOME does not isolate it.

```sh
packages/openrig/bin/devrig provision
packages/openrig/bin/devrig --rig devrig start
# When finished:
packages/openrig/bin/devrig --rig devrig stop
```

Optional `bin/devrig link` installs command symlinks in `~/.local/bin`, including `rig`, `rig-start` and `rig-stop`. Review existing commands before using it. Provision/start can be run with the full path without linking.

Expert bash cannot access operator credentials or localhost. Controlled `git` and `github` tools handle authenticated operations. Prompt rules are not merge/deployment approval gates. The operator reviews and merges PRs. No cloud tools, gateway or change-execution service are included.

## Development

```sh
cd packages/openrig
npm ci
npm ci --prefix .runtime/node
npm ci --prefix .runtime/openrig
npm run typecheck
npm test
```

Tests use the private Node 22 runtime through `bin/devrig-node`. Never test provision/start by merely setting a temporary HOME. Stop the rig before moving or removing its checkout; removal does not automatically delete private state.
