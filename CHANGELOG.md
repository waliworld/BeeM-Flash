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

## Beta 2 — v2.x.x

### v2.4.0
- **Binary-level tune verification** — bundled **SHA-256 fingerprints** of 156
  known MG1 DME images (79 stock + 77 MHD+ bases, from the community
  dmacpro91/BMW-XDFs collection; fingerprints only, no firmware redistributed).
  A new `binverify` module hashes a calibration image and reports whether it is a
  **byte-for-byte stock** image, a **known MHD+ base**, or unknown — which closes
  the gap the ID-only check left: a tune that keeps the stock calibration ID but
  changes the maps has a different hash. The Flash tab now shows, for the loaded
  calibration, whether it's a known stock/MHD+ image. The numeric stock software
  IDs from these bins also strengthen the ID-level tune check.

### v2.3.0
- **Definitive tune detection** — bundled a database of **stock DME calibration
  IDs** (162 versions across MG1CS003/MG1CS201/MG1CS049/MG1CS024, extracted from
  the Apache-2.0 mgflasher-map-packs A2Ls). The INFO/CODES tune check now matches
  the car's reported calibration ID against this set: a match is a recognised
  **stock** calibration; a known DME reporting an ID not in the set is **modified**
  (a tune, or newer SW). Vendor signatures (MHD/bootmod3/xHP/MG Flasher) still
  flag a tune by name. Honest caveat kept: an ID-preserving tune can't be told
  apart by ID alone. Stock IDs / signatures remain configurable to override.

### v2.2.0
- **Renamed to BeeM-Flash** (brand, titles, log filenames; internal package id
  kept for install continuity).
- **Strict black / yellow / red theme** — pure-black background, one bright
  yellow accent, bright red for danger and anything important; **no orange, no
  green**. Emphasis (e.g. the active tab) is shown with **bolder, larger** text,
  not by changing colour. Fixed the header/tab text overlaps.
- **Both OBD boost PIDs kept available** — `boostObd0B` (manifold, saturates at
  ~2.55 bar) and `boostObd70` (boost control, doesn't) so you can confirm on-car
  which reads correctly on a high-boost car.
- **ECU INFO is now a flashing prerequisite** — you cannot arm the flash engine
  until you have read the car on the INFO tab (you must see its current software
  and calibration first).
- **Tune / last-flash detection** — the INFO read and the CODES scan now read the
  DME's calibration ID + programming date and heuristically flag a possible tune
  (e.g. MHD) so you can see what's on the car; stock list and tune signatures are
  configurable.

### v2.1.0
- **Brighter theme accent** — the Giallo yellow is punchier (`#ffe600`) for a
  cleaner pop on black.
- **Flex-fuel + Reflex+ port-injection channels** — ethanol target, flex-fuel
  factor, fuel temp; port rail pressure/target, port injector duty target, port
  fuel split, port-injection-active flag, port/direct fuel mass. The demo feed
  produces them so the datalogger logs them off-car; real values come from your
  pidmap.
- **Dyno pull capture + session summaries (#23)** — the logger auto-detects a
  WOT pull and reports peak boost, an acceleration-based power estimate (wheel +
  crank, mass/drag configurable), peak-power rpm and a 100–200 time, shown on the
  LOG tab; every session's CSV gets a per-channel min/max/avg summary footer.
- **Read-only ECU INFO tab (#21)** — reads the standard `22 F1xx` identification
  DIDs (VIN, hardware/software numbers, serial, date, calibration ID) over UDS;
  read-only, DID list configurable per vehicle.

### v2.0.0
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
