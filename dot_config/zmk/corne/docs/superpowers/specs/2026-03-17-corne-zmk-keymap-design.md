# Corne ZMK Keymap Design

## Overview

Minimal ZMK configuration for a 42-key Corne split keyboard, inspired by urob's zmk-config but stripped down to essentials. Pure ZMK with no external modules. QWERTY base with timeless homerow mods, 2 layers, and symbol combos.

## Hardware

- Keyboard: Corne (3x6 + 3 thumb keys per side = 42 keys)
- Firmware: ZMK
- Bluetooth: 2 profiles
- No external ZMK modules required

## Key Position Reference

```
Left hand                                      Right hand
LT5  LT4  LT3  LT2  LT1  LT0      RT0  RT1  RT2  RT3  RT4  RT5
LM5  LM4  LM3  LM2  LM1  LM0      RM0  RM1  RM2  RM3  RM4  RM5
LB5  LB4  LB3  LB2  LB1  LB0      RB0  RB1  RB2  RB3  RB4  RB5
               LH2  LH1  LH0      RH0  RH1  RH2
```

Numbering: 0 = inner (near split gap), 5 = outer (pinky side).

## Base Layer (Layer 0)

```
 ESC    Q     W     E     R     T          Y     U     I     O     P    \|
 TAB    A     S   D/OPT F/SFT   G          H   J/SFT K/OPT   L     ;     '
CMD+TAB Z     X     C     V     B          N     M     ,     .     /   SHIFT
                  [L1]  [GUI] [SPC]      [ENT] [CTRL] [L2]
```

### Outer columns
- Left: ESC (top), TAB (mid), CMD+TAB (bottom, for window switching)
- Right: \| (top), ' (mid), Right Shift (bottom)

### Home row mods (timeless tuning)
- D = Option (hold) / D (tap) — left middle finger
- K = Option (hold) / K (tap) — right middle finger
- F = Shift (hold) / F (tap) — left index finger
- J = Shift (hold) / J (tap) — right index finger

### Thumb cluster
- Left: Layer 1 (outer), GUI/Cmd (middle), Space (inner)
- Right: Enter (inner), Ctrl (middle), Layer 2 (outer)

## Layer 1 — Navigation + Numbers

Activated by holding L1 thumb key (LH2).

```
 ___   ___   ___   ___   ___   ___        ___    6     7     8     9     0
 ___    1     2     3     4     5        LEFT  DOWN   UP   RIGHT  ___   ___
 ___   ___   ___   ___   ___   ___        ___    =   ___   ___   ___   ___
                  [___] [___] [___]      [___] [___] [___]
```

- Numbers 1-5: left home row (A-G positions)
- Numbers 6-0: right top row (U-P positions)
- Arrows: HJKL on right home row
- Equals: RB1 (below H, index finger)
- Shift+number = standard symbols (!@#$%^&*())

## Layer 2 — Media + Bluetooth

Activated by holding L2 thumb key (RH2).

```
 ___   BT1   BT2   BTC  ___   ___        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ PLAY  MUTE        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ ZM+   VOL+        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ ZM-   VOL-        ___   ___   ___   ___   ___   ___
                  [___] [___] [___]      [___] [___] [___]
```

- BT1/BT2: Bluetooth profile select (LT4, LT3)
- BTC: Bluetooth clear (LT2)
- Media: Play/Pause (LM1), Mute (LM0)
- Zoom: GUI+= in (LB1), GUI+- out (LB1 bottom row... wait)

Correction — zoom and volume on left inner columns:
- LM1 = Play/Pause, LM0 = Mute
- LB1 = Zoom In (GUI+=), LB0 = Volume Up
- Row below... actually on a 3-row Corne there is no row 4.

Revised Layer 2:
```
 ___   BT1   BT2   BTC  ___   ___        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ PLAY  MUTE        ___   ___   ___   ___   ___   ___
 ___   ___  SCRN   ___ ZM+   VOL+        ___   ___   ___   ___   ___   ___
                  [___] [___] [___]      [___] [___] [___]
```

Volume down and zoom out accessible via Shift+VOL+ and Shift+ZM+ if needed,
or we put them on additional positions. Since this is minimal, we include:
- LB1 = Volume Up, LB0 = Volume Down (or zoom)
- Screenshot on LB3

Final Layer 2:
```
 ___   BT1   BT2   BTC  ___   ___        ___   ___   ___   ___   ___   ___
 ___   ___   ___   ___ PLAY  MUTE        ___   ___   ___   ___   ___   ___
 ___   ___  SCRN   ___ VOL-  VOL+        ___   ___   ___   ___   ___   ___
                  [___] [___] [___]      [___] [___] [___]
```

Zoom in/out dropped for simplicity (can be added later). Screenshot on LB3.

## Combos

### Timing constants
- COMBO_TERM_FAST: 18ms (horizontal combos)
- COMBO_TERM_SLOW: 30ms (vertical combos)
- COMBO_IDLE_FAST: 150ms (require-prior-idle, horizontal)
- COMBO_IDLE_SLOW: 50ms (require-prior-idle, vertical)

### Horizontal combos (adjacent keys, same row)

| Combo | Keys | Output | Layers |
|-------|------|--------|--------|
| backtick | LT4+LT3 (Q+W) | ` | DEF, L1, L2 |
| cut | LB4+LB2 (Z+C skip) | Ctrl+X | DEF, L1, L2 |
| copy | LB4+LB3 (Z+X) | Ctrl+Ins | DEF, L1, L2 |
| paste | LB3+LB2 (X+C) | Shift+Ins | DEF, L1, L2 |
| bspc | RT1+RT2 (U+I) | Backspace | DEF, L1, L2 |
| del | RT2+RT3 (I+O) | Delete | DEF, L1, L2 |
| lpar | RM1+RM2 (J+K) | ( | DEF, L1 |
| rpar | RM2+RM3 (K+L) | ) | DEF, L1 |
| lbkt | RB1+RB2 (M+,) | [ | DEF, L1 |
| rbkt | RB2+RB3 (,+.) | ] | DEF, L1 |

Shifted variants (automatic, no extra config):
- Shift + ` = ~
- Shift + ( = N/A (( is already shifted 9, sends LPAR directly)
- Shift + [ = {
- Shift + ] = }

### Vertical combos (same column, adjacent rows)

| Combo | Keys | Output | Layers |
|-------|------|--------|--------|
| at | LT4+LM4 (Q+A) | @ | DEF, L1, L2 |
| hash | LT3+LM3 (W+S) | # | DEF, L1, L2 |
| plus | RT1+RM1 (U+J) | + | DEF, L1, L2 |
| minus | RT5+RM5 (P+;... wait, \|+') | - | DEF, L1, L2 |

Note: RT5+RM5 is the outer right column (\| position + ' position). Shift + - = _.

## Timeless Homerow Mods

Configuration for D/K (Option) and F/J (Shift):

```
flavor: balanced
tapping-term-ms: 280
quick-tap-ms: 175
require-prior-idle-ms: 150
hold-trigger-key-positions: <opposite hand positions only>
hold-trigger-on-release: true
```

### Cross-hand positional triggers
- Left hand mods (D/OPT, F/SFT): only trigger hold when RIGHT hand keys are pressed
- Right hand mods (J/SFT, K/OPT): only trigger hold when LEFT hand keys are pressed
- This prevents same-hand rolls from triggering modifiers

## Design Decisions

1. **No external modules** — pure ZMK for simplicity and ZMK Studio compatibility
2. **2 layers max** — dedicated thumb buttons for each, no layer-tap complexity
3. **Combos for symbols** — frees layers for numbers/nav/media
4. **Timeless homerow mods** — prevents misfires during fast typing
5. **Voyager-faithful outer columns** — smooth transition from current keyboard
6. **CMD+TAB on dedicated key** — high-frequency shortcut gets a physical key
7. **Backtick via combo** (Q+W) — freed up outer column for CMD+TAB
8. **Cut/Copy/Paste use Ctrl+X, Ctrl+Ins, Shift+Ins** — works cross-platform

## Future Additions (Not In MVP)

- Leader key module for BT profile switching (zmk-leader-key)
- Numword auto-layer (zmk-auto-layer)
- Mod-morphs (, -> ; and . -> :)
- Mouse emulation layer
- RGB layer indicators
- F-keys (can be added to empty Layer 2 positions)
