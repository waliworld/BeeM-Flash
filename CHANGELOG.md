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

### v2.10.0 — the car's own diagnostic link: CODES, INFO and FLASH work without CONNECT
- **The fault scanner, ECU info and the flasher were unreachable on the car.** All
  three refused unless an ENET/DoIP link was established — and DoIP cannot be
  established from inside the head unit's app sandbox. New `vehiclelink.js` talks
  UDS over the head unit's **own** diagnostic service (InternalTasu), which our
  manifest already declares and which needs **no connect step**. `_makeGateway`
  now falls back to it, so all five gated features light up unchanged.
  **ENET/DoIP is untouched and still preferred when a real link exists** (bench /
  external adapter) — this adds a transport, it does not remove one.
- **Still read-only by default.** The new link enforces its own allow-list
  (`0x19` read DTCs, `0x14` clear, `0x22`/`0x23` reads, `0x27` unlock, `0x10`
  session). Writing services (`0x34`/`0x36`/`0x37`/`0x31`/`0x11`) are refused
  unless the gated flash path explicitly opts in, and `0x2E` is refused always.
  The live-data guard (`readonly-diag`) was deliberately **not** widened.
- **FIXED: a byte-for-byte stock car could be reported as modified.** The DME
  reports its software number as spaced lowercase hex (`00 00 5d 55 28 96 06`)
  while the bundled stock sets hold `00005D55289606`, so a real stock calibration
  matched nothing. Identifiers are now compared in one canonical form — verified
  against the bundled set: that car now reads **stock, exact match, MG1CS201**.
- **Tune matching is stricter and says how sure it is.** Minimum key length raised
  5 → 9 (with no ECU type reported the pool is every engine family at once, where
  a 5-character fragment could produce a false "stock"); exact match preferred over
  substring, with `matchQuality` and `matchedEcu` reported; a short vendor
  signature like `MHD` must stand as its own word before it asserts a tune
  (`signatureConfidence`). An unknown ID is still an honest "unknown", never "stock".
- **Added `reflashedAfterBuild`** — compares the DME's programming date (F199)
  against the car's build date (F18B), which was read but never used.
- **SAFETY: the flash prerequisite could be satisfied by a read that saw nothing.**
  `ecuinfo.read` resolves `ok:true` even when every identifier fails, so "you must
  read ECU INFO before flashing" only proved the loop ran. Flashing now stays
  blocked unless the DME actually reported its calibration ID or software number,
  and says so.
- **CONNECT and the gated tabs now say what is actually wrong** (link starting, car
  not answering, no link in this build) instead of "Connect to the vehicle first".
- **README corrected**: we advertised "finds the car automatically (ISO 13400
  vehicle discovery)" for a path only ever exercised against a simulator. It now
  states plainly what is proven on the car and what is not.

### v2.9.0 — the app stops dying, and the dark channels get a working source
Found by diffing our behaviour against the car-tested MIT reference apps
(`cauliflowermossgrape/idrive7-apps`), which run on this same head unit.

- **FIXED: the app killed itself after ~30 s, and got laggier the longer it ran.**
  Not the frame rate — an unbounded draw-op leak. We acquired the drawing surface
  **once** in `start()`, but `ctx.canvas()` is the only code path that calls the kit
  recorder's `reset()`, and `reset()` is the only thing that rewinds the op buffer.
  So every frame appended to a buffer that was never truncated and **replayed every
  op ever drawn**. Measured: 41 frames produced 3,280 ops instead of 80 — linear
  growth, ~72,000 ops per frame by the 30-second mark. The surface is now re-acquired
  every frame (as all 15 reference apps do). A regression test fails if this returns.
- **Frame rate 30 → 8 fps.** Every real reference app runs 2–10 (car_vitals 10,
  dyno 6, live_data 4, dtc_scanner 2). Values update at the sample rate, not the
  frame rate, so 30 fps bought nothing and cost a full-screen redraw 30×/second.
- **The LOG list no longer reads every recorded CSV off disk on every frame** just
  to show a size label — it uses a `stat` and caches the list (lag grew with every
  session you recorded).
- **Charge-air temp, ignition timing and boost should now read.** The OBD-II source
  already decoded PID `0x0F`/`0x0E`/`0x33` and derives boost from the non-saturating
  `0x87`/`0x70`, and the head unit's diagnostic link permits OBD service 01 — but the
  provider was only ever handed a transport if the ENET/DoIP **CONNECT** had
  succeeded, which it cannot on a head unit. All providers now share one link to the
  car's internal gateway, available from app start, **with no connect step**.
  (CONNECT/DoIP remains, unchanged, as an additional path — see below.)
- **Fixed the UDS read plumbing** that kept even configured DIDs dark: requests now
  carry a reply-matching predicate (previously the *first* frame from the DME
  resolved a request, so a reply to the previous DID could be scaled as this one), a
  4000 ms timeout instead of 1500 (a cold DME answers slower than that), a check that
  the reply echoes the DID we asked for, and a poll gated on the link actually being
  up. Failures now record **why** (incl. the NRC) instead of being discarded, with a
  30 s backoff after 3 failures.
- **Un-muted the DME.** The diagnostic link latches an ECU as "silent" after 5 missed
  replies and then drops every request to it without sending; nothing in the app ever
  cleared that latch, so one bad patch muted the engine for the rest of the session.
- **Stopped leaking a SOME/IP proxy and a response subscription on every
  ENABLE/SCAN tap** — the link is built once and reused.
- **Knock retard is no longer a default tile**: it has no standard DID on the MG1, so
  it could only ever show `--`. It stays available under CHANNELS. `Load` takes its
  place — it is in the verified profile and actually reads.
- **The error banner no longer blames us for the head unit's own faults.** The
  `CurrentVehicleUnits::initVehicleDataProxy` message is the BMW SDK's (that name
  appears nowhere in this app); we only saw it because we listen for rejections
  process-wide. It is still logged in full — with its stack, and no longer truncated
  mid-message — but it no longer raises an on-screen alarm. `_fail` also no longer
  throws when a rejection arrives before startup finishes.

### v2.8.3 — on-car stability + theme
First on-car run (2.8.2 installs and reads live engine data). Fixes from it:
- **App no longer quits itself.** On iDrive 7 the kit turned **any** stray
  uncaught async exception (e.g. a failed UDS read or a signal callback) into
  `process.exit(1)` — which is exactly what made the app "shut off after 30–60 s"
  and "die when a log channel was tapped". The kit now **logs and keeps running**
  instead (iDrive 8 already did), matching the kit's own rule that an app must not
  exit on the car (an exit makes the platform wipe/uninstall it). The render and
  sampler loops were already individually guarded.
- **Colours are the Lambo black/yellow/red again.** The car's default kit theme
  (M Tricolour — white/**orange**/red) was being merged *over* our palette. Added a
  proper **`lambo` kit theme** (black, bright yellow `#ffe600`, red `#ff2a1f`, no
  orange, no green), made it the app's **default `theme` setting** (selectable in
  Setup), and made the Lambo palette authoritative for the app's own canvas so the
  unit theme can't override it.
- **Header now reads “BeeM-Flash”** (the `MAIN` screen title was still the old
  “Wali Datalog”).
- **On-screen error banner** — if anything throws, a red strip briefly shows the
  message so an on-car fault is visible/screenshot-able instead of silent.
- Hardened the channel Log/Show toggles against an out-of-range selection.

Known, still open (need a clearer photo / the car's app log to finish): the canvas
is drawn at 1600×520 and the HMI scales it to the unit's app area, so it doesn't
fill perfectly; and the UDS-only live channels (boost, charge-air temp, timing,
knock) read `--` until the UDS/fast-block source is confirmed on this car — the
bus signals (rpm, coolant, oil, speed) already work. The **Connect** tab is the
optional ENET/Wi-Fi path; on the head unit the data already comes through the
car's internal gateway, so no Wi-Fi adapter appears or is needed.

### v2.8.2 — install fix (SOME/IP manifest)
- **Fixes the on-car install failure** `the app manager could not install … :
  generateSomeipInterfaces … nothing is installed`. BMW's interface generator
  refuses the **whole** app if the manifest asks for one access a field doesn't
  support. Our `app.json` requested **`rs`** (read + subscribe) on
  `de.bmw.infrastructure.VehicleInformation.DataPowerTrain2` and
  `de.bmw.infrastructure.EnvironmentalInformation.ExteriorTemperature`, but those
  fields are **subscribe-only** on the car (notifier, no getter) — exactly as the
  shipping iDrive 7 apps (`live_data`, `car_vitals`) declare them. Both are now
  **`s`**, matching the car's catalog, so the generator accepts the app.
- **Bus signals are now `_optional`.** The five supplementary vehicle/infrastructure
  bus interfaces (CDS, CDS2, Vehicle2, VehicleInformation, EnvironmentalInformation)
  are marked optional, so a unit whose firmware lacks one installs the app
  **without** it (recorded in `meta.json` `optional`, the field the community
  installer prunes against) instead of refusing the whole app. The UDS transport
  (`InternalTasu`) stays required — it's present on these units and the
  UDS/OBD data paths depend on it. The runtime already degrades gracefully when a
  signal interface is absent, so the datalogger keeps working from its UDS/OBD
  sources.
- Verified against the car-tested `cauliflowermossgrape/idrive7-apps` SDK: every
  interface and field BeeM-Flash uses is used by shipping iDrive 7 apps; only the
  two access flags were wrong.

### v2.8.1
- **Flash-protocol research written up** (`docs/FLASH-PROTOCOL.md`) — studied the
  open S58/MG1 flash tooling. **MBTune/mgctl** (Apache-2.0) independently confirms
  the exact UDS flash sequence our `flash.js` already runs
  (`session 0x02 → 0x27 → 0x34 → 0x36 loop → 0x37 → 0x31`), plus the D-CAN
  addressing (`0x6F1`/`0x6F9`), `0x400` block size, DID/NRC lists, and a
  CRC-32 + AES-CMAC-128 integrity model — all consistent with the app; it supplies
  no real seed/key, addresses or keys, and requires a bench unlock (our scope).
  **rftx-tuning** is all-rights-reserved with fabricated placeholder values, so its
  code/numbers are **not** used — only its public "S58 needs a bench unlock"
  statement is cited. Attributions added to `data/SOURCES.md`.
- **Block-size default** — when the DME reports no `maxNumberOfBlockLength`, the
  TransferData block now falls back to `0x400` (the MG1 convention) instead of 256.
  No change when the DME reports its max (it almost always does).

### v2.8.0
- **Connect label fix** — the acknowledge button now reads **ACCEPT** (was the
  cryptic "ACK"); navigation is via the top tabs, there is no Back button.
- **Flasher scope made explicit** — the Flash tab and `docs/FLASHING.md` now state
  plainly that this is for an **already-unlocked DME** (a car running a flashed
  tune): the app does **not** unlock a DME or bypass the DME's RSA/ECC signature,
  so a locked/signature-checked ECU will reject the write by design. Checksum
  correction remains the important step on an unlocked DME.

### v2.7.0
- **DME checksum-scheme research** (`data/checksum_schemes/`) — the BMW MG1CS
  A2Ls declare the checksum method as **`XCP_CRC_32` (standard CRC-32)** over the
  code/data flash segments; per-DME range templates are generated by
  `scripts/scheme_from_a2l.py` for MG1CS201/049/003. Documented honestly: the
  stored-CRC location + init/seed aren't in the A2L (confirm from the bin/WinOLS),
  and MG1 also carries an RSA **signature** a correct CRC doesn't satisfy.
- **`bosch-mg1` checksum preset** — the auto-detecting Bosch MG1 block scheme
  (CRC-32 reflected, init `0xACC08E37`, big-endian CRC per `DEADBEEF`-block),
  ported from the MIT `NetworkDir/moto-ecu-checksum`. Verified it does **not**
  match BMW automotive MG1CS images, so it's scoped to motorcycle MG1 / MSE8.
- **README screenshot gallery** — every tab is now shown on the repo front page.

### v2.6.0
- **Checksum check + correction before flashing** — a new `checksum` engine
  (standard CRC-32, CRC-16 CCITT/XMODEM/MODBUS, additive sum/xor and
  additive-complement, validated against the usual CRC test vectors). When a
  checksum scheme is supplied (descriptor `checksum` or `config.checksum`), the
  Flash tab shows the calibration's checksum status on load, and before writing
  the flasher **corrects** the checksums (default) or **refuses to flash** an
  invalid calibration — so you never write a cal the DME would reject. The scheme
  (algorithm + regions) is owner-supplied; nothing MG1-specific is bundled.

### v2.5.0  (all additive — nothing removed)
- **Smaller fonts** — every screen's text is scaled down uniformly (default 0.85,
  `config.fontScale`) so nothing overlaps or runs off the head-unit screen.
- **OBD-II data source (added, not a replacement)** — a new `obd` option under
  Data source reads standard SAE J1979 Mode-01 PIDs, for cars without a per-tune
  pidmap. It reads boost from PID **0x70 / 0x87** (which don't saturate) as well
  as **0x0B** (which caps at 255 kPa), exposing all of them so the boost-PID
  question can be settled on-car. Existing sources (fast block, bus, UDS) are
  untouched.
- **On-car calibration read-out (added)** — a **READ CAL** action on the INFO tab
  reads the DME's calibration region over UDS (0x23) and runs the binary
  fingerprint on it, so the stock/MHD+/modified verdict is confirmed against the
  car's *live* image — the fully-automatic version of the v2.4 check. Region and
  any security come from `config.calReadout`.

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
