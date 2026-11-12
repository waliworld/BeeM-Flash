# Notice — independence, interoperability, and safety

## What this project is

**Wali Datalog** is an independent, open-source application for the BMW **MGU**
head unit (iDrive 7 and iDrive 8). It reads live vehicle data for datalogging,
requests a tune **map switch** on a car already tuned by its owner, and provides
an open ENET/DoIP diagnostic toolkit — a pluggable SecurityAccess (seed/key)
framework and a calibration-section flasher — for an owner working on their own
vehicle. It is written from scratch, for the benefit of the open-source
community. No manufacturer keys, algorithms, calibrations, or SDK are bundled.

It is built the way a third-party client is built for a platform (the "RideTube
for YouTube" model): it targets a documented, public application interface and
talks to the vehicle over standard, publicly documented diagnostic protocols.

## What this project is **not**

- It is **not** affiliated with, endorsed by, or derived from the tuner community, BMW,
  or any tuning vendor. "tuner", "BMW", "iDrive", and "MGU" are the trademarks of
  their respective owners and are used here only to describe compatibility.
- It contains **no** decompiled, reverse-engineered, or copied code from the
  a tuner tool application or any other third-party app.
- It contains **no** BMW SDK. The BMW on-board application SDK (`oap-sdk` and
  the generated `rhmiData`) is **never** committed to this repository. On the
  head unit, the MGU app platform links the app against the SDK that is already
  present on that unit (supplied from a donor app at build time). See
  `docs/BUILD-AND-INSTALL.md`.

## Data and privacy

- All vehicle data stays on the head unit. Logs are written to the app's own
  writable data directory and exported by the user to a USB stick. No telemetry
  is sent anywhere by this app.
- The app does not generate tunes, and bundles no calibration data, ECU address,
  or security key — the owner supplies all of those for their own ECU. It
  provides live datalogging (read-only), map *switching* among maps already
  flashed in the DME (gated, confirmed, precondition-checked), a read-only view
  of map definitions, and an **open calibration-section flasher** (standard UDS
  download services) for a vehicle the owner has already flashed and now needs
  only the calibration section rewritten. Flashing a DME is irreversible and
  safety-critical: the flasher refuses to act without explicit per-flash
  acknowledgment and the owner's own data, reports failures honestly (never a
  false "success"), and is the owner's responsibility. See `docs/FLASHING.md`.
- **Open ENET/DoIP gateway + pluggable SecurityAccess.** The app includes an
  open DoIP/ENET transport and a seed/key SecurityAccess framework whose
  key-derivation algorithm is **supplied by the owner or the community** (the
  `python-udsoncan` `security_algo` model) — no manufacturer algorithm is
  shipped. These are standard, publicly documented diagnostic capabilities for
  an owner working on their own vehicle, and the "all-in" test harness
  (`test/ecusim.js`) lets the community develop against them off-car. The app
  sends nothing to a vehicle until the per-session Connect consent gate is
  satisfied.
- **Vehicle connection requires explicit, per-session consent.** No socket is
  ever opened and no packet is ever sent to the vehicle's diagnostic network
  until the user, on the Connect screen, (1) acknowledges a plain-language
  safety disclosure and (2) explicitly enables the connection. The
  acknowledgment is remembered; whether the connection is *enabled* is not —
  every app launch starts fully disconnected and requires the user to press
  Enable again before anything is sent. See `apps/wali_datalog/src/enetgate.js`
  and `apps/wali_datalog/src/doip.js`.

## Third-party components

This repository vendors **no** third-party source. The only external interfaces
used are:

- the MGU app platform's public app API (manifest + render/signal/diagnostic
  calls), targeted by interface only, and
- ISO 14229 (UDS) and ISO 13400 (DoIP) — open automotive diagnostic standards.
