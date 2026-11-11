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

## MHD live-monitor protocol (`src/mhdmonitor.js`)

The MHD live-monitor exchange — request `2C 88 01`
(DynamicallyDefineDataIdentifier), reply `6C 88` + a 36-byte little-endian
packed block — and its field table (offsets, sizes, signedness, scaling) are
transcribed from:

- **MHD Tuning's own publicly published TunerPro RT ADX file** (`MG1.adx`) for
  the live monitor, via
- **`github.com/freebeamer/core`** (**MIT License**), package `pkg/mhd`, which
  documents the exchange field-by-field.

Copyright (c) the `freebeamer/core` authors; used under the MIT License. We port
the factual field/scaling table (not the Go code) and map the fields to our
channel keys. Read-only: the write / map-switch path is MHD's closed plugin and
is intentionally not implemented, consistent with that source.

## MGFlasher A2L / XDF map packs (staged for integration)

- **`github.com/mgflasher-team/mgflasher-map-packs`** (**Apache-2.0**) — 913 A2L
  files + XDFs for B48/B58 gen1, B58 gen2, S58, N63/S63. A2L (ASAM MCD-2 MC)
  defines MEASUREMENT and CHARACTERISTIC objects with addresses, data types and
  conversions. These are **memory-address** definitions (for XCP / flash tools),
  a different transport from the enhanced-PID (`0x22`) and MHD-monitor (`0x2C`)
  paths. Planned: an A2L MEASUREMENT parser that extends the unified dataset
  with `identifier_type=address` rows, plus UDS ReadMemoryByAddress (`0x23`)
  support. Not yet wired in; attributed here.

## Referenced but NOT used

- `github.com/gediz/bmw-unified-db` (MIT) — a build pipeline that assembles a DB
  from pinned sources **including BMW EDIABAS/SGBD binaries**. We do not run or
  vendor its output, because this project does not source BMW's licensed SGBD/
  EDIABAS files. Listed here for completeness.
- `github.com/MBTune/mgctl` (Apache-2.0) — an MG1 control tool. Noted as a
  reference for MG1 protocol work; no data taken.
- `github.com/jtownson/xdfbinext` — XDF/bin tooling; noted for working with a
  user's own `.xdf`.

## What this project does **not** include

No BMW SGBD/EDIABAS files, no ISTA/INPA binaries, no MHD application code or
signing material. The enhanced-PID list above is open community reference data
about the vehicle, used for interoperability and clearly attributed.

## Verification

The generated `profiles/pidmap.*.json` are `verified:false`. The on-car values
are suppressed (strict mode) until you confirm the identifiers/scaling for your
specific DME and set `verified:true`. See `docs/SIGNALS-AND-DIDS.md`.
