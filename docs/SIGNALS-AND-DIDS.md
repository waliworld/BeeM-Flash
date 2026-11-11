# Signals and DIDs — how live data is read, and how to calibrate it

The app reads vehicle data two ways. Neither can be finalised from a desk: the
names and layouts are specific to each head unit and each engine controller.
This file is the procedure to fill them in. Until then the app shows
clearly-labelled demo data and marks these sources unverified so **no wrong
number is ever displayed or logged**.

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

Procedure per channel:

1. Identify the measured-value DID and the field's position within its response
   for your DME/tune (from your tuner's measurement-block definition, or by
   correlating a `0x22` read against a known reference while logging).
2. Fill the entry `{ did, off, len, signed, le, m, b }` in a profile.
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
