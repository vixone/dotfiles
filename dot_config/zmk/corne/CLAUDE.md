# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZMK firmware configuration for a 42-key Corne split keyboard with nice_nano controllers. Pure ZMK — no external modules. Inspired by urob's zmk-config, stripped to essentials.

## Build Commands

Builds use Docker (`zmkfirmware/zmk-build-arm:stable`). Docker must be running.

```bash
./build.sh          # Build both halves
./build.sh left     # Build left half only
./build.sh right    # Build right half only
./build.sh clean    # Remove firmware/ directory
```

Output: `firmware/corne_left-nice_nano.uf2` and `firmware/corne_right-nice_nano.uf2`

First build is slow (~5 min) because `west update` fetches ZMK + Zephyr. Subsequent builds reuse cached `zmk/`, `zephyr/`, `modules/` directories.

The build script auto-exports macOS system CA certs into Docker to handle Zscaler SSL interception on corporate networks.

## Architecture

This is a local-only project (no remote repo, no CI). All configuration lives in `config/`:

- **`config/corne.keymap`** — The keymap (Devicetree overlay). Contains behaviors, combos, and all 3 layers. This is the main file you'll edit.
- **`config/corne.conf`** — Kconfig overrides (Bluetooth power, sleep timeout, combo limits).
- **`config/west.yml`** — West manifest pinning ZMK to `main` branch from `zmkfirmware`.
- **`build.yaml`** — Build targets (board + shield combos). Parsed by `build.sh`.

## Keymap Structure (corne.keymap)

The keymap file follows this structure, all within a single Devicetree root node (`/ { ... }`):

1. **Key position defines** (`KEYS_L`, `KEYS_R`, `THUMBS`) — used by homerow mods for cross-hand detection
2. **Behaviors** — custom hold-tap definitions (`hml`/`hmr` for timeless homerow mods)
3. **Combos** — horizontal (fast timing, 18ms) and vertical (slower, 30ms) key combinations
4. **Keymap layers** — `DEF` (0), `NAV` (1), `MED` (2)

Key positions are numbered 0-41 (see ASCII diagram in the file header). Combos and positional hold-taps reference these numbers.

## Homerow Mod Tuning

The `hml`/`hmr` behaviors use "timeless" settings from urob's approach. Key parameters to adjust:

- `tapping-term-ms` (280) — mod activation threshold
- `quick-tap-ms` (175) — double-tap speed for guaranteed letter
- `require-prior-idle-ms` (150) — typing speed gate; rule of thumb: `10500 / WPM`

## When Making Keymap Changes

After editing `config/corne.keymap` or `config/corne.conf`, run `./build.sh` to verify the build succeeds. Common build errors come from mismatched key counts per layer (must be exactly 42 per layer) or undefined behavior references.

Combo `key-positions` use the 0-41 numbering from the file header. The `layers` property controls which layers a combo is active on.
