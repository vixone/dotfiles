# Corne ZMK Config

Minimal ZMK configuration for a 42-key Corne split keyboard.
Inspired by [urob's zmk-config](https://github.com/urob/zmk-config) — stripped to essentials.

**Zero external modules.** Pure ZMK. ZMK Studio compatible.

## Base Layer

```
 ESC    Q     W     E     R     T          Y     U     I     O     P    \|
 TAB    A     S   D/OPT F/SFT   G          H   J/SFT K/OPT   L     ;     '
CMD+TB   Z     X     C     V     B          N     M     ,     .     /   SHIFT
                   [L1]  [GUI] [SPC]      [ENT] [CTRL] [L2]
```

Home row mods (timeless tuning — cross-hand only, anti-misfire):
- **D** / **K** = Option (hold)
- **F** / **J** = Shift (hold)

## Layer 1 — Nav + Numbers (hold L1)

```
 ___   ___   ___   ___   ___   ___        ___    6     7     8     9     0
 ___    1     2     3     4     5        LEFT  DOWN   UP   RIGHT  ___   ___
 ___   ___   ___   ___   ___   ___        ___    =   ___   ___   ___   ___
```

Shift + number = symbols: `! @ # $ % ^ & * ( )`

## Layer 2 — Media + BT (hold L2)

```
 ___   BT1   BT2   BTC  ___   ___        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ PLAY  MUTE        ___   ___   ___   ___   ___   ___
 ___   ___  SCRN   ___ VOL-  VOL+        ___   ___   ___   ___   ___   ___
```

## Combos

### Horizontal (press 2 adjacent keys simultaneously)

```
Left hand:                          Right hand:
  Q+W = `                            U+I = Backspace    I+O = Delete
  Z+X = Copy   X+C = Paste           J+K = (            K+L = )
  Z+C = Cut                          M+, = [            ,+. = ]
```

### Vertical (press 2 keys in same column)

```
  Q+A = @      W+S = #               U+J = +
                                      \|+' = -    (Shift = _)
```

Shift + `[` = `{`, Shift + `]` = `}`, Shift + `` ` `` = `~`

## Build & Flash

```bash
./build.sh          # Build both halves
./build.sh left     # Left only
./build.sh right    # Right only
```

### Flashing (macOS)

1. Put the half in bootloader mode (double-tap reset)
2. Find the disk:
   ```bash
   diskutil list | grep KEEBART
   ```
3. Flash (replace `disk4` with your actual disk number):
   ```bash
   diskutil unmountDisk /dev/disk4 && sudo dd if=firmware/corne_choc_pro_left-zmk.uf2 of=/dev/rdisk4 bs=4096
   ```
4. For the right half, use `corne_choc_pro_right-zmk.uf2` instead.

> **Note:** Simple `cp` to `/Volumes/KEEBART/` is unreliable on macOS. Use the `dd` method above.

## Tuning

Things you'll likely want to adjust after trying it out:
- `tapping-term-ms` (280) — lower = faster mod activation, higher = fewer misfires
- `quick-tap-ms` (175) — how fast double-tap must be to always give letter
- `require-prior-idle-ms` (150) — typing speed threshold for mod activation
- Combo `timeout-ms` — adjust if combos feel too tight or too loose

## Future additions

- Leader key for BT profiles (zmk-leader-key module)
- Numword auto-layer for numbers (zmk-auto-layer module)
- Mod-morphs: `,` -> `;` and `.` -> `:` when shifted
- F-keys on Layer 2
