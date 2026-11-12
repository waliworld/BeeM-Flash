# Verification — what was checked, and how

## Automated checks (run anywhere)

```bash
npm test        # 124 assertions, 0 dependencies
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
- **DoIP (ISO 13400) read client** — routing-activation frame bytes; frame
  parse round-trip; a full client exchange over a fake socket (activate → send →
  unwrap the UDS reply). Read-only transport; no bridge/flash/seed-key.
- **DoIP vehicle discovery** — Vehicle Identification Request frame bytes;
  announcement payload decode (VIN, logical address); full-datagram decode;
  `discoverVehicles()` finds a responding fake gateway and times out to an
  empty list when nothing answers.
- **Vehicle-connection safety gate (`enetgate.js`)** — enabling before
  acknowledgment is refused; enabling after acknowledgment succeeds; "connected"
  requires both enabled *and* a discovered vehicle; disabling forgets the
  vehicle; **acknowledgment persists across a restart but "enabled" never does**;
  `scan()` opens no socket at all while disabled.
- **Full app wiring, end to end** — a real `App` instance: boots with no
  transport; refuses Enable before Acknowledge; Acknowledge→Enable succeeds but
  still has no transport until a vehicle is found; a successful Scan (via a
  fake UDP socket) wires in a working transport (`diag.supported` /
  `monitor.supported` both flip to `true`); Disable tears it back out; and a
  **second, fresh `App` instance on the same storage boots with the connection
  disabled** even though acknowledgment was remembered.
- **A2L parser** — parses a MEASUREMENT + its RAT_FUNC COMPU_METHOD, deriving the
  linear scale (f/b), data type (UWORD→u16), endianness (MSB_LAST→little) and
  ECU address; plus the UDS ReadMemoryByAddress (`0x23`) frame.
- **MHD live-monitor decode** — a synthetic `6C 88` + 36-byte little-endian reply
  decodes to the right channels/scaling (RPM 3000, LOAD 50 %, BOOST→1.00 bar,
  ENGINETEMP→90 °C, GEAR 3, SPEED 100, IAT 30 °C); a negative reply → null.
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
with two markers, writes a valid CSV, and renders all six screens (incl.
Connect, in its default locked state) without throwing. Output includes the
CSV header and sample rows.

### `npm run shots` confirms

Every screen (live in 3 styles, datalog REC + DONE, channels x2, maps
enabled/off/confirm, MHD, and Connect in its locked/enabled/connected states)
renders to pixels through the **real app modules** (bundled and run in a
browser canvas), with zero page/console errors. Screenshots are in
`out/shots/`.

## Verified vs. needs-a-car

| Area | Status | Where |
|------|--------|-------|
| Logging engine, CSV, sessions, markers, stats | ✅ verified | tests + sim |
| UDS / ISO-14229 request+parse+scale | ✅ verified | tests |
| Unit conversion, channel catalogue | ✅ verified | tests |
| Map-control gating + confirm + commit flow | ✅ verified (mock DME) | tests |
| Provider source-mux + demo fallback | ✅ verified | tests |
| Every screen renders (all states) | ✅ verified | sim + shots |
| Vehicle connection safety gate (ack/enable/disable, never auto-reconnects) | ✅ verified | tests |
| DoIP read transport + vehicle discovery protocol | ✅ verified | tests |
| **SOME/IP field names / scaling** | ⚠️ needs unit | `src/signalmap.js`, [SIGNALS-AND-DIDS](SIGNALS-AND-DIDS.md) |
| **DME DID layout / scaling** | ⚠️ needs unit | `src/dme_profiles.js` |
| **Map/cooling job encoding + security** | ⚠️ needs unit | `src/mapcontrol.js`, `src/diag.js` |
| **Device bindings** (canvas, screen switch, USB, transport) | ⚠️ needs unit | `main.js`, `src/ui/surface.js`, `src/diag.js` |
| **Real UDP discovery over a physical ENET adapter** | ⚠️ needs unit/hardware | `src/doip.js` `nodeUdpSocket`, `docs/VEHICLE-CONNECTION.md` |
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
