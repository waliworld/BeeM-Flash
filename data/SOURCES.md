# Data sources and attribution

`bmw_enhanced_pids.csv` is a unified, reformatted dataset of BMW **enhanced PIDs**
(diagnostic measured values read via UDS service `0x22`), assembled by
`scripts/build_pid_dataset.js`. It contains factual identifiers, data types and
scaling for datalogging. Every row carries its `source` and `verified=false`.

## Primary source

- **PID tables:** `thesecretingredient.neocities.org/bmw/` — a public,
  community-published list of BMW enhanced PIDs and scaling.
- **Machine-readable CSVs:** `github.com/Shooooooooo/bmw_pid_data` (per-engine
  `*_pid_data.csv`), which credits the source above. Used as reference/data; not
  vendored wholesale — we generate our own schema and keep the derivation script
  for provenance.

## fast UDS block read protocol (`fastlog.js`)

The fast UDS block read exchange — request `2C 88 01`
(DynamicallyDefineDataIdentifier), reply `6C 88` + a 36-byte little-endian
packed block — and its field table (offsets, sizes, signedness, scaling) are
transcribed from:

- **the tuner community's own publicly published TunerPro RT ADX file** (`MG1.adx`) for
  the live monitor, via
- **`github.com/freebeamer/core`** (**MIT License**), its block-layout package, which
  documents the exchange field-by-field.

Copyright (c) the `freebeamer/core` authors; used under the MIT License. We port
the factual field/scaling table (not the Go code) and map the fields to our
channel keys. Read-only: the write / map-switch path is tuner's closed plugin and
is intentionally not implemented, consistent with that source.

## MGFlasher A2L / XDF map packs (integrated: measurements)

- **`github.com/mgflasher-team/mgflasher-map-packs`** (**Apache-2.0**) — 913 A2L
  files + XDFs for B48/B58 gen1, B58 gen2, S58, N63/S63. A2L (ASAM MCD-2 MC)
  defines MEASUREMENT and CHARACTERISTIC objects with addresses, data types and
  conversions.
- `scripts/a2l_to_dataset.js` extracts the MEASUREMENTs (name, data type,
  endianness, ECU address, and linear scaling derived from each RAT_FUNC
  COMPU_METHOD) into the unified schema with `identifier_type=address`. Samples
  committed: `data/a2l_measurements.s58.csv` (89) and
  `data/a2l_measurements.b58gen2.csv` (84). These are **memory addresses**
  (specific to one software id), read via UDS ReadMemoryByAddress `0x23`
  (implemented, read-only) or XCP — a different transport from enhanced PIDs.
  Rows are `verified=false`.
- The CHARACTERISTIC (map/table) side is used only for a planned **read-only map
  viewer**. This project does **not** implement ECU flashing / calibration
  writing, a virtual map generator, or automation of any third-party app — see the project
  README/NOTICE.

## Referenced but NOT used

- `github.com/gediz/bmw-unified-db` (MIT) — a build pipeline that assembles a DB
  from pinned sources **including BMW EDIABAS/SGBD binaries**. We do not run or
  vendor its output, because this project does not source BMW's licensed SGBD/
  EDIABAS files. Listed here for completeness.
- `github.com/MBTune/mgctl` (Apache-2.0) — a diagnostic **and flash** utility for
  the Bosch MG1 ECU (`write-cal` / WriteCalibration) with a **SeedKey /
  SecurityAccess** plugin system to unlock the ECU for writing. Its
  calibration-writing and seed/key material are **intentionally not integrated**:
  this project does not flash ECUs or implement security-access unlocking.
- `github.com/ohgeeceee/beemuu` (GPL-3.0-or-later) — a community BMW diagnostic
  app (read/clear faults, live data, session logging over K+DCAN/ENET). It
  confirms the read-only ENET model, but its GPL code is **not** copied into this
  MIT project; referenced for context only.
- `github.com/jtownson/xdfbinext` — XDF/bin tooling; noted for working with a
  user's own `.xdf`.

## DoIP transport + connection safety gate (`src/doip.js`, `src/enetgate.js`)

An original, read-only ISO 13400 (DoIP) client gives the datalogger a
standards-based way to read live data from the DME over the vehicle's own
diagnostic Ethernet, a standard open diagnostic transport. It is **not** a gateway/bridge: it opens
no external listener, forwards no third-party traffic, and contains no flashing,
calibration-write, or seed/key code. A **virtual ENET-over-WiFi bridge** that
would expose the vehicle's diagnostic network to external tools is deliberately
**not** provided — it is the enabling layer for wireless ECU flashing and broad
remote vehicle-network access.

`src/doip.js` also implements ISO 13400's **Vehicle Identification** UDP
broadcast/announcement (an original implementation of the published standard),
so the app finds the car's gateway automatically — no manual IP entry, and no
external "ENET adapter" app involved.

The connection itself is behind `src/enetgate.js`, a hard consent gate: nothing
is sent to the vehicle until the user acknowledges a safety disclosure and
explicitly enables the connection, and "enabled" is never persisted — every app
session starts fully disconnected (see NOTICE.md and docs/VEHICLE-CONNECTION.md).
No remote or companion interface exists yet (none is built by this project); the
gate is designed so that if one is added later, it still has to go through this
same acknowledge-then-enable state rather than a silent auto-connect.

## openbimmer (MIT) — identification DIDs + boost-PID reference

The read-only ECU **INFO** page uses the standard ISO 14229 identification DIDs
(`22 F190` VIN, `F191/F194/F195` hardware/software numbers, `F18C` serial,
`F18B` date, `F17C` calibration ID). This 22 F1xx roadmap and the BMW F/G-series
D-CAN addressing (DME `0x12`, `6F1`/`6xx` extended addressing) were cross-checked
against the MIT-licensed [openbimmer](https://github.com/openbimmer/openbimmer)
project's `docs/bmw-control-units.md`. We reimplement from the protocol facts;
no code is copied. openbimmer also documents a useful gotcha we note in the
datalogging docs: on high-boost cars the standard OBD-II manifold-pressure PID
`0x0B` saturates at 255 kPa, so boost should be taken from PID `0x70`/`0x87` —
relevant only to an OBD-II source, not our UDS/DID or fast-block paths.
openbimmer itself is a generic OBD-II app and contains no MG1-specific,
flex-fuel, or port-injection data.

## Stock calibration IDs — mgflasher-map-packs A2Ls (Apache-2.0)

`data/stock_calibrations.json` and the bundled `apps/wali_datalog/stockdb.js`
are the set of **stock DME calibration identifiers** for the MG1 engine families,
extracted from the A2L headers (ECU type, `VERSION`, EPK) of the
[mgflasher-team/mgflasher-map-packs](https://github.com/mgflasher-team/mgflasher-map-packs)
A2Ls, which are **Apache-2.0** licensed. 913 A2Ls → 162 stock versions across:

- `MG1CS003` — B58/B48 Gen1
- `MG1CS201` — B58/B48 Gen2
- `MG1CS049` / `MG1CS024` — S58

Only the identifier strings are used (not any map/calibration data). The app
compares the DME's reported calibration ID against this set to tell **stock from
modified definitively**: a reported ID in the set is a recognised stock
calibration; a known ECU type reporting an ID not in the set is not a known stock
calibration (a tune, or newer software than this dataset). A tune that keeps the
stock ID and changes only the maps cannot be distinguished by the ID alone — the
app says so and shows the programming date to compare. Regenerate with
`python3 -I scripts/build_stockdb.py <A2Ls_dir> data/stock_calibrations.json`
then the stockdb.js generator (see that script's header).

## Stock / MHD+ image fingerprints — dmacpro91/BMW-XDFs

`data/stock_bins.json` and the bundled `apps/wali_datalog/stockbins.js` are
**SHA-256 fingerprints** of known MG1 DME images taken from the community
[dmacpro91/BMW-XDFs](https://github.com/dmacpro91/BMW-XDFs) collection: the stock
images (`*_original.bin`) and the MHD+ custom-code bases (`*_MapSwitchBase.bin`),
for B58 Gen1/Gen2 and S58 (156 images → 79 stock + 77 MHD+).

**No binary bytes are redistributed.** The bins are BMW firmware; this project
stores only their hashes, sizes and the public calibration IDs. The fingerprints
let BeeM-Flash verify a calibration is **byte-for-byte stock**, or positively
identify an **MHD+ base**, which closes the gap left by the ID-only check: a tune
that keeps the stock calibration ID but changes the map data has a different
hash, so the ID reads "stock" while the fingerprint shows it is not. Regenerate
with `python3 -I scripts/build_binfingerprints.py <bins_root> data/stock_bins.json`
then the stockbins.js generator. The numeric stock software IDs parsed from these
filenames also augment the A2L-derived stock-ID set used by the tune check.

## OBD-II source PID scalings

The optional OBD-II data source (`apps/wali_datalog/obd.js`) decodes standard
SAE J1979 Mode-01 PIDs. The scalings are the published standard ones, cross-checked
against the MIT-licensed openbimmer project (already credited above), including
its note that high-boost cars should read boost from PID `0x70` / `0x87` rather
than the `0x0B` manifold PID that saturates at 255 kPa. The app exposes all three
so the correct source can be confirmed on-car. This source is additive; the
UDS/DID, fast-block and bus sources are unchanged.

## What this project does **not** include

No BMW SGBD/EDIABAS files, no ISTA/INPA binaries, no proprietary tuning-application code or
signing material. The enhanced-PID list above is open community reference data
about the vehicle, used for interoperability and clearly attributed.

## Verification

The generated `profiles/pidmap.*.json` are `verified:false`. The on-car values
are suppressed (strict mode) until you confirm the identifiers/scaling for your
specific DME and set `verified:true`. See `docs/SIGNALS-AND-DIDS.md`.
