# Verification — what was checked, and how

## Automated checks (run anywhere)

```bash
npm test        # 75 assertions, 0 dependencies
npm run sim     # headless end-to-end drive + render of every screen
npm run shots   # renders every screen to real pixels (out/shots/*.png)
```

### `npm test` covers

- **Formatting** — CSV escaping/quoting, `mm:ss`, byte sizes, °C→°F, bar→psi,
  invalid-value placeholder, timestamp shape.
- **UDS codec** — `0x22` frame bytes; positive parse + big/little-endian and
  signed integer assembly; `scaleFromSpec`; negative-response NRC decoding;
  `0x31` routine parse (RID `0x611E`).
- **Channels** — defaults, metric→imperial conversion, unit labels, full MHD+
  catalogue size (85+ channels incl. per-cylinder + B58 boost/wastegate control).
- **MHD preset converter** — parses a `LogPresets.csv` (names + flags only),
  maps selected parameters to channel keys, reports unmapped ones.
- **Measurement importer** — maps a measurement table (English/German BMW/ISTA
  names, hex or decimal DIDs) to channel keys, groups shared DIDs into packed
  blocks, reports unmatched rows.
- **Enhanced-PID dataset + pidmap composition** — data-type → len/signed; curated
  channel→PID selection composes DID + unit-converted scaling (hPa→bar folded in).
  The B58 map's scaling was spot-checked against known values (coolant 90 °C,
  boost 1.00 bar, rpm 3000, rail 200 bar, λ 1.000, pedal 100 %, ethanol 10 %).
- **PID profiles** — `generic_template` coverage; `fromJson` import (unknown
  channels ignored, missing `did` rejected); **packed-block** grouping and a
  live `DiagProvider` read that unpacks two channels (boost + IAT) from one DID.
- **Log engine** — start/sample/stop; header reflects selected channels + units;
  **config is preserved through `start()`** (a real bug fixed during the build);
  marker lands on the right row; derived AFR = λ·14.7; `done` state and counts;
  **error path**: a storage that throws on open drives the engine to `error` with
  the message captured.
- **Map control gating** — refused when disabled, when moving, and at high RPM;
  allowed only stationary + idle; `commit` succeeds on a positive DME, reports a
  DME rejection, and refuses (never calls the DME) when preconditions fail.
- **Provider** — demo `on` yields values incl. derived AFR; demo `off` with no
  source yields non-live `NaN`s (gauges show `--`); demo `auto` falls back after
  5 s without data.

### `npm run sim` confirms

The full `App` boots on a simulated ctx, records a 240-sample session at 20 Hz
with two markers, writes a valid CSV, and renders all five screens without
throwing. Output includes the CSV header and sample rows.

### `npm run shots` confirms

Every screen (live, datalog REC + DONE, channels, maps enabled/off/confirm, MHD)
renders to pixels through the **real app modules** (bundled and run in a browser
canvas), with zero page/console errors. Screenshots are in `out/shots/`.

## Verified vs. needs-a-car

| Area | Status | Where |
|------|--------|-------|
| Logging engine, CSV, sessions, markers, stats | ✅ verified | tests + sim |
| UDS / ISO-14229 request+parse+scale | ✅ verified | tests |
| Unit conversion, channel catalogue | ✅ verified | tests |
| Map-control gating + confirm + commit flow | ✅ verified (mock DME) | tests |
| Provider source-mux + demo fallback | ✅ verified | tests |
| Every screen renders (all states) | ✅ verified | sim + shots |
| **SOME/IP field names / scaling** | ⚠️ needs unit | `src/signalmap.js`, [SIGNALS-AND-DIDS](SIGNALS-AND-DIDS.md) |
| **DME DID layout / scaling** | ⚠️ needs unit | `src/dme_profiles.js` |
| **Map/cooling job encoding + security** | ⚠️ needs unit | `src/mapcontrol.js`, `src/diag.js` |
| **Device bindings** (canvas, screen switch, USB, transport) | ⚠️ needs unit | `main.js`, `src/ui/surface.js`, `src/diag.js` |
| **Packaging/install against the BMW SDK** | ⚠️ needs kit/unit | [BUILD-AND-INSTALL](BUILD-AND-INSTALL.md) |

The ⚠️ items are not stubs that pretend to work: each is isolated, documented,
and fails safe (unverified → demo data; writes → refused) so the app is honest
about its state until finished on a vehicle.

## Known limitations

- Demo data is synthetic and labelled; it is not vehicle behaviour.
- Live diagnostic logging needs a calibrated DME profile; without it those
  channels read `--`.
- The map-switch job and any required seed/key are confirmed per DME; the seed→key
  algorithm is intentionally not bundled.
- The MHD web screen opens MHD's site; it does not scrape or automate it.
