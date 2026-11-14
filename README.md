# Personal dotfiles and Pi workshop

Reusable software for a fresh or existing Pi coding-agent installation. This repository contains no saved missions, memory databases, sessions, provider logins or machine-specific credentials. Pi here means the coding agent, not a Raspberry Pi image.

## Install the Pi core

Requires macOS or Linux, Node 26+, npm, Git, Go, Cargo and a C compiler. Install those with your platform's package manager first. On macOS, the Brewfile includes these development tools.

```sh
git clone https://github.com/vixone/dotfiles.git
cd dotfiles
./bootstrap.sh --check
./bootstrap.sh
```

The bootstrap installs Pi 1.5.2 only if `pi` is absent, builds mx and the memory server, and registers `packages/mission-stack` as a local Pi package. It does not upgrade an existing Pi installation. Keep the checkout at its installed path. Existing provider settings are retained; configure a provider and default model with Pi's `/login` and `/model` on a fresh machine.

Add `$HOME/.local/bin` and `$HOME/.pi/bin` to PATH. Restart Pi or run `/reload`. Core commands include `/pibar`, `/continue` and its `/handover` alias, `/land`, `/focus`, and `/start`. See [mission-stack](packages/mission-stack/README.md) for workflow details.

The installer modifies Pi settings, installs binaries and seeds `~/Missions.md` and the domain registry only when absent. Existing loose copies of package resources are moved to a timestamped backup. It does not import history. To remove the package, remove its absolute path from Pi's `settings.json` packages list. Keep any missions or memories you create; removal should not delete user data.

## Optional macOS coding rig

```sh
./bootstrap.sh --with-rig
```

This also installs the rig's private Node 22 and OpenRig dependencies. It does not provision, link or launch seats. Read [OpenRig setup](packages/openrig/README.md) and configure repository access first. The lead retains your own Pi permissions; only experts are sandboxed. The bundled rig paths target Apple Silicon Homebrew.

## Experimental pi-sdd source

[pi-sdd](packages/pi-sdd/README.md) is not installed by bootstrap. Its older Pi 1.0.4, Node 26, bd, pstack, pi-subagent and guards contracts need separate validation. Execution is blocked by unfinished checkpoint/authority integration. This export does not claim compatibility with the current core. See [compatibility](packages/pi-sdd/docs/compatibility.md).

## Optional dotfiles

The software bootstrap does not apply shell, editor or terminal settings. To use the chezmoi dotfiles, install chezmoi and review changes first:

```sh
chezmoi init vixone
chezmoi diff
chezmoi apply
```

The first apply on macOS installs Brewfile packages and optional shell tooling. Review its run scripts before applying. Linux skips these macOS install hooks. Keep secrets in untracked machine-local files such as `~/.zshrc.local`, never in this repository. `packages/` and `bootstrap.sh` are excluded from home-directory application by `.chezmoiignore`.
