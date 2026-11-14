# Export verification

Verified on macOS with Pi 1.5.2 and host Node 26. The optional rig uses its private Node 22 runtime. These are local checks, not a Linux runtime or live rig certification.

- mission-stack: 211 tests passed; typecheck passed; module/session tests passed; Go memory-server tests and Rust mx tests passed.
- A real mission-stack install under an isolated temporary HOME and explicit temporary PI_CODING_AGENT_DIR built and installed mx and memory-server. No active Pi settings were used.
- Pi 1.5.2's resource loader found six extensions without errors. `/pibar`, `/continue`, `/handover`, `/land`, `/focus` and `/start` were registered.
- OpenRig: typecheck and all 237 tests passed, including real macOS sandbox checks. Shell syntax checks passed. No provision/start or live provider-backed seat launch was attempted.
- pi-sdd: typecheck and 238 tests passed. Six host/resource/acceptance tests fail with `HOST_VERSION_UNSUPPORTED: 1.5.2`, consistent with its older Pi 1.0.4 target. It is experimental source, not a supported current integration, and bootstrap does not install it.
- Chezmoi's managed-file listing excludes packages and the software bootstrap. No dotfiles were applied to the export machine.
- Work-marker and forbidden-filename scans of the staged export found no work configuration or saved runtime state. Secret-pattern hits were reviewed and are deliberate synthetic secret-rejection fixtures, not credentials. Dependencies and build caches are ignored.

Before using on another machine, configure your own provider and model, check local toolchain compatibility, and review optional rig repository permissions. Linux, alternate Homebrew prefixes and custom provider extensions need their own runtime verification.
