# Notice — independence, interoperability, and safety

## What this project is

**Wali Datalog** is an independent application for the BMW **MGU** head unit
(iDrive 7 and iDrive 8). It reads live vehicle data for datalogging and,
optionally, requests a tune **map switch** on a car that has already been tuned
by its owner. It is written from scratch.

It is built the way a third-party client is built for a platform (the "RideTube
for YouTube" model): it targets a documented, public application interface and
talks to the vehicle over standard, publicly documented diagnostic protocols.

## What this project is **not**

- It is **not** affiliated with, endorsed by, or derived from MHD Tuning, BMW,
  or any tuning vendor. "MHD", "BMW", "iDrive", and "MGU" are the trademarks of
  their respective owners and are used here only to describe compatibility.
- It contains **no** decompiled, reverse-engineered, or copied code from the
  MHD Flasher application or any other third-party app.
- It contains **no** BMW SDK. The BMW on-board application SDK (`oap-sdk` and
  the generated `rhmiData`) is **never** committed to this repository. On the
  head unit, the MGU app platform links the app against the SDK that is already
  present on that unit (supplied from a donor app at build time). See
  `docs/BUILD-AND-INSTALL.md`.

## Data and privacy

- All vehicle data stays on the head unit. Logs are written to the app's own
  writable data directory and exported by the user to a USB stick. No telemetry
  is sent anywhere by this app.
- The optional "MHD Datalog (web)" screen simply opens MHD's own website so the
  user can sign in and use MHD's own datalogging through MHD's own page. This
  app does not capture, store, or forward any MHD credentials. That screen is a
  convenience shortcut, not an integration, and is clearly marked as such.

## Safety

- The app is **read-only by default.** Datalogging only *reads* measured values
  from the vehicle.
- Any action that *writes* to the engine controller (a map switch) is:
  1. disabled unless the user explicitly turns on "Map control" in Settings,
  2. guarded by on-screen confirmation, and
  3. refused unless engine-state preconditions are met (see
     `apps/wali_datalog/src/mapcontrol.js`).
- The user is solely responsible for the tune on their vehicle and for any map
  they select. This software is provided "as is", without warranty, per the MIT
  `LICENSE`.
- **No ECU flashing.** This app does not write calibration/maps to the engine
  controller, does not generate tunes, and does not automate or relay MHD's app
  to flash maps. It provides live datalogging (read-only), map *switching* among
  maps already flashed in the DME (gated, confirmed, precondition-checked), and
  a read-only view of map definitions. Flashing a DME is irreversible and
  safety-critical; it is intentionally out of scope.
- **No ENET-over-WiFi bridge / no security-access unlock.** The app includes a
  read-only DoIP client for its own live-data reads, but it does not expose the
  vehicle's diagnostic network to external tools over WiFi (a "virtual ENET
  adapter"/gateway), and it implements no seed/key SecurityAccess. Both are the
  enabling layer for wireless ECU flashing and broad remote vehicle access, and
  are intentionally out of scope.
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
