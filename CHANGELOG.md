# Changelog

Versioning: the **Stable Beta 1** line is `0.x` (final: `0.5.0`). The current
**Beta 2** line is `2.x.x`.

## Stable Beta 1 — v0.5.0  (git tag `stable-beta-1`, commit `ca15e72`)

The last release before the Beta 2 UI redesign. To return to it:
`git checkout stable-beta-1`. Its catalog packages were `wali_datalog@0.5.0.tgz`
/ `wali_datalog8@0.5.0.tgz`.

Includes: live datalogging (tiles/bars/dials), map switching (gated), the full
extended-PID set + fast UDS block read, importable per-tune PID maps, the open
ENET/DoIP toolkit, pluggable SecurityAccess (seed/key), the calibration-section
flasher (library + descriptor), and the whole-vehicle fault-code reader/clearer.
UI: one canvas screen with internal paging driven by four HMI bar buttons
(A/B/C/D).

## Beta 2 — v2.x.x  (in progress)

- **New UI shell.** Tabs along the top, in-tab controls along the bottom; the
  confusing A/B/C/D hardware-button bar is hidden in favour of on-screen,
  touchable controls (with the hardware buttons still mapped to the bottom row
  as a fallback). A dedicated **Settings** tab.
- **Lamborghini-influenced visual theme** — dark, hard sleek lines, bold clear
  type, minimalist, yellow-on-black.
- **Gated on-car calibration-flash UI** over the existing flash engine, with an
  explicit engine **on/off** switch.

> Keeping both channels installable at once (a "Stable" entry and a "Beta" entry
> in the same Store catalog) is a packaging change to the release workflow; ask
> if you want both offered simultaneously rather than Beta 2 superseding Beta 1.
