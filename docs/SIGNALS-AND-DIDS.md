# Signals and DIDs — how live data is read, and how to calibrate it

The app reads vehicle data two ways. Neither can be finalised from a desk: the
names and layouts are specific to each head unit and each engine controller.
This file is the procedure to fill them in. Until then the app shows
clearly-labelled demo data and marks these sources unverified so **no wrong
number is ever displayed or logged**.

## 0. MHD live monitor — the easy path for an MHD-flashed MG1 car

If the car is MHD-flashed (B58/S58, MG1), the simplest and most accurate source
needs **no PID map at all**. MHD's live monitor is one fixed UDS exchange —
request `2C 88 01`, reply `6C 88` + a 36-byte little-endian packed block — that
returns a full live set already correctly scaled: RPM, load, boost / target /
deviation, coolant, gear, ethanol, WG distribution, mass flow, boost setpoint
factor, speed, ambient and intake air temp.

`src/mhdmonitor.js` implements it and is the **preferred source** (Settings →
Data source → *Auto* or *MHD live monitor*; set *Engine platform* to B58 or
S58 so mass flow is read from the right field). The field table and scaling are
transcribed from MHD's own published TunerPro ADX via the MIT-licensed
`freebeamer/core`; see `data/SOURCES.md`. It is read-only — the map-switch write
path is MHD's closed plugin and is not implemented.

This is the recommended route; the per-PID map below is for stock cars, extra
channels, or non-MHD setups.

## 1. SOME/IP bus signals (`src/signalmap.js`)

Signals such as RPM, vehicle speed and temperatures are broadcast on the unit's
internal bus. Interface and field names come from the unit's own catalogue:

```
/etc/oap/someip/someip-interfaces.json   (on the head unit)
```

Procedure:

1. Copy that catalogue off the unit to `reference/someip-interfaces.json`
   (git-ignored; do not publish it).
2. Explore fields and scaling with the kit tools:
   `python3 kit/tools/sigdoc.py <interface>` and
   `python3 kit/tools/check_signals.py`.
3. For each entry in `MAP`, set the real `iface`/`field`, the scaling `m`/`b`
   (engineering = raw·m + b), and then `verified: true`.
4. Mirror the interface/field you actually use in `app.json` → `signals`, so the
   platform grants the subscription.

Unverified entries stay dormant: `someip.js` only wires `verified:true`
bindings, so a guess can't emit a value.

## 2. DME measured values (`src/dme_profiles.js`)

Performance channels (boost, charge-air temp, timing, lambda, rail pressure,
wastegate, load, knock, EGT…) are read from the DME as measured values over UDS
`ReadDataByIdentifier` (service `0x22`). The DID, byte offset/length, endianness
and scaling are **DME- and tune-specific** and differ between engine families
and tune revisions — exactly as in any professional logging tool.

The app ships the full **MHD+ class channel catalogue** (~92 channels across
Engine, Air/Boost, Fuel, Ignition incl. per-cylinder timing and knock, Temps,
Electrical, Cams/VANOS, Dynamics, Port Injection, and Status — see
`src/channels.js`). What it does not ship is a vendor PID address table; you
supply that for your DME/tune.

### Matching your MHD log preset (channel selection)

If you have an MHD Flasher **`LogPresets.csv`** export, convert it into a Wali
Datalog preset (an enabled-channel list — just the parameter names and on/off
flags, no vendor data):

```bash
node scripts/preset_from_mhd_csv.js path/to/LogPresets.csv
# -> presets/<ECU>.json  (e.g. 00005C64145A05.json)
```

Copy that file to the head unit as the app's **`preset.json`** (in the app data
dir) and the channel selection matches what MHD+ logs on that ECU. The converter
reports any MHD parameters it does not represent. This sets *which* channels are
on; the live *values* still come from the DID map below.

> Note: an MHD `LogPresets.csv` and `.xdf`/`.bin` identify the ECU and the
> channel set, but they do **not** contain the runtime measurement DIDs/scaling.
> Those come from the BMW diagnostic description (SGBD/ISTA) or your tuner — see
> the `pidmap.json` import below. (MHD application binaries and signing/bundle
> files are not used by this project.)

### Packed measurement blocks (how MHD+ reads fast)

MHD+ does not read one value per request — it reads a few **wide blocks**: one
`0x22` request returns many values packed at fixed byte offsets, which the app
unpacks into many channels in a single read. Model that by giving several
channels the **same `did`** at different `off`. `diag.js` groups reads by DID
(`dme_profiles.byDid`) and reads each block once per cycle, so adding channels to
a block costs no extra requests.

### Importing a per-tune PID profile (`pidmap.json`)

Rather than editing code, drop a JSON profile on the unit as the app's
**`pidmap.json`** (in the app's data dir). `main.js` loads it at startup via
`dme_profiles.fromJson`. Start from the documented example at
[`profiles/template.json`](../profiles/template.json):

```json
{
  "label": "My B58 tune v3",
  "verified": true,
  "reads": {
    "boost":       { "did": 16640, "off": 0, "len": 2, "m": 0.001, "b": -1 },
    "boostTarget": { "did": 16640, "off": 2, "len": 2, "m": 0.001, "b": -1 },
    "iat":         { "did": 16640, "off": 4, "len": 2, "m": 0.1, "b": -40, "signed": true }
  }
}
```

- `engineering = raw·m + b`; `len` bytes big-endian (`le:true` for little-endian);
  `signed:true` for two's-complement.
- Unknown channel keys are ignored; an entry without a numeric `did` is rejected.
- `verified:true` enables live reads; omit it (or `false`) to keep the profile in
  the suppressed/demo state while you work on it.

### From a measurement table (ISTA / INPA / tuner) — `pidmap_from_measurements.js`

If you have a table of measured-value definitions from a **legitimate** source —
your own licensed ISTA/INPA export, or a sheet from your tuner — convert it in
one step:

```bash
node scripts/pidmap_from_measurements.js measurements.csv --label "B58 gen2"
# -> profiles/pidmap.json  (verified:false until you confirm)
```

The table is a CSV (or JSON array) with columns matched case-insensitively:
`name` , `did`/`identifier` (decimal or `0x…`) , `off` , `len` , `scale`/`m` ,
`bias`/`b` , `signed` , `le` , `unit`. Measurement names are mapped to channel
keys via built-in aliases (English + German BMW/ISTA terms, e.g. *Ladedruck →
boostAbs*, *Zündwinkel → timing*); unmatched rows are **reported, not guessed**,
and several rows sharing a `did` become one packed block automatically. Review
the result, confirm the scaling on your car, then set `verified: true`.

> On sourcing: this project does not ship or download BMW's SGBD/EDIABAS
> diagnostic files — those are BMW's licensed software. Bring the measurement
> definitions from your own licensed tools, your tuner, or your own on-car
> readout; the importer only reformats a table you provide.

### Ready-made maps from open PID data (B58 / S58)

The repo ships a unified, attributed dataset of BMW **enhanced PIDs** (read via
UDS `0x22`) and curated channel maps built from it — no BMW SGBD binaries, all
community-sourced and `verified:false`:

- `data/bmw_enhanced_pids.csv` — ~2000 PIDs across B48/B58/N55/N63/S55/S63 in the
  schema `platform,ecu_variant,software_id,measurement_name,identifier_type,
  identifier,address,data_type,endianness,scale,offset,unit,source,verified`
  (see `data/SOURCES.md` for attribution). Rebuild with
  `node scripts/build_pid_dataset.js <bmw_pid_data-checkout>`.
- `profiles/pidmap.b58.json` — 21 core channels mapped to B58
  enhanced PIDs, with units folded into the scaling (hPa→bar, MPa→bar, …).
  Rebuild/extend via `profiles/select.b58.json` +
  `node scripts/pidmap_from_dataset.js data/bmw_enhanced_pids.csv profiles/select.b58.json`.
- `profiles/pidmap.s58.json` — S58 candidate (S58 and B58 gen2
  are both Bosch MG1 and share the enhanced-PID map); derived from B58, flagged
  unverified for S58.

To use one: copy it to the head unit as the app's `pidmap.json`. It stays in
demo (strict mode suppresses it) until you confirm a few channels on your car
and set `verified: true`. Enhanced PIDs are read one per `0x22` request, so each
channel is its own single-field block.

### Per-channel, by hand (alternative)

1. Identify the measured-value DID and the field's position within its response
   for your DME/tune (from your tuner's measurement-block definition, or by
   correlating a `0x22` read against a known reference while logging).
2. Fill the entry `{ did, off, len, signed, le, m, b }` in a profile (code or
   JSON). The catalogue carries a `dguess` seed per channel that the built-in
   `generic_template` uses as a placeholder.
3. When the whole profile is confirmed on the car, set `verified: true`.

In strict mode (default) `diag.js` suppresses output until the profile is
verified, so an uncalibrated template can't produce a mis-scaled log.

### UDS codec (`src/uds.js`)

The request/response framing is standard ISO 14229 and is fully implemented and
tested:

| Service | Build | Parse |
|---------|-------|-------|
| `0x22` ReadDataByIdentifier | `buildReadDataByIdentifier(did)` | positive → `data[]`, scale with `scaleFromSpec` |
| `0x10` DiagnosticSessionControl | `buildSessionControl(session)` | — |
| `0x27` SecurityAccess | `buildSecurityRequestSeed` / `buildSecuritySendKey` | seed/key |
| `0x31` RoutineControl | `buildRoutineControl(sub, rid, data)` | status |
| `0x3E` TesterPresent | `buildTesterPresent()` | — |

Negative responses are decoded to their NRC names (e.g. `conditionsNotCorrect`,
`securityAccessDenied`).

## 3. Map switching (`src/mapcontrol.js`)

Switching tune maps uses the DME diagnostic jobs the MGU community apps use for
this (map `0x611E`, cooling `0x60FD`), driven as UDS `RoutineControl`. The exact
job encoding (sub-function, parameter bytes, whether a security level is needed)
is DME/tune specific and is kept in this one module. Confirm it against your
target DME before trusting a live switch.

Security access (`0x27`) is scaffolded but the **seed→key algorithm is not
included** — it is vehicle-specific. If your access level needs it, inject a
`keyFn(seed, level)` when constructing `MapControl`/`DiagProvider`. If no security
is required for the job at your session level, leave it unset.

> Map writes remain gated regardless: off by default, confirmed on screen, and
> refused unless the car is stationary with the engine at idle.
