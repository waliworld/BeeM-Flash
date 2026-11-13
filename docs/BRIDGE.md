# Wireless bridge (phone / xHP → MGU → car) — design & status

**Status: feasibility-gated groundwork. No bridge ships yet. It is OFF by design
and cannot run until an owner settles the on-car probes below.** This records what
is proven, what is not, the architecture, and the security model, so the build is
honest at every step.

## The goal

Let an external tool (e.g. **xHP**, a ZF8HP transmission tuner that speaks
ENET/DoIP) connect to the head unit over Wi-Fi/tether and reach the car's modules
**through the MGU**, so no ENET cable or paid Wi-Fi-ENET adapter is needed. The
owner's own car; open-source; **built secure and consent-gated** or not at all.

## What is and isn't possible (verified)

- **The iDrive app cannot be the bridge.** The app sandbox has no network
  capability — no socket field anywhere in the app model, and no app in the proven
  on-car corpus opens an IP socket. A listener MUST live in a privileged daemon.
- **A root system daemon CAN run on the MGU.** Proven by the MIT `mgu-renderd`
  daemon (systemd unit + UNIX socket) and by Tailscale (root `tailscaled`). It is
  installed via the community deploy path or the Store, persists on `/var/opt` with
  a unit on the rootfs.
- **The app can be a UNIX-socket *client*** to that daemon (the MIT `redline` app
  does exactly this to talk to `renderd`).
- **TASU reaches the modules** (`InternalTasu`, already how BeeM-Flash reads the DME
  `0x12` and, per the MIT `zf8hp` app, the EGS `0x18` — no cable).
- **UNKNOWN, and the make-or-break:** whether a phone on the hotspot can open a TCP
  connection to a listener on the MGU's `wlan0`. Nothing in any repo shows it.
  **Only an on-car probe settles it.**
- **NOT pursued:** a head-unit route straight to the car's gateway DoIP endpoint —
  zero grounding; kept only as an optional, unverified track if a probe finds one.

## Chosen architecture: DoIP-front / TASU-back

```
  phone / xHP ──Wi-Fi, ISO 13400 DoIP──▶  beem-bridged (root daemon)
                                               │  local UNIX socket (root:tm_oap_app, 0660)
                                               ▼
                                         BeeM-Flash app  ──TASU (SOME/IP)──▶  DME 0x12 / EGS 0x18
```

The daemon owns the Wi-Fi listener and the ISO 13400 server; it speaks **only** to
`wlan0` and a local socket, **never to the car's network**. The **app is the single
policy authority**: it re-validates every relayed frame (`relaypolicy.js`) and never
accepts an allow-list or a "flashing" flag from the daemon, which is treated as
untrusted toward the car. The car-side leg is TASU — the same path the app's own
flasher already uses — so the relay adds **no new vehicle-side unknown**.

## Security model (already built, with tests)

`bridgegate.js` + `relaypolicy.js` + `test/run.js` pin these invariants today:

- **Off by default; three deliberate on-HU tiers.** Acknowledge (persisted) →
  enable (never persisted) → arm a **time-boxed lease** (heartbeat; fails closed in
  seconds on loss, disarm, app exit, sleep, ignition-off, or motion). Flashing is a
  **separate** write-arm for one named ECU, reusing the local flasher's confirm chain.
- **Strict re-validation in the app.** Relayed frames may address only an ECU
  allow-list (default `0x12`, `0x18`); **functional/broadcast from the phone is
  refused**; `clearDTC` and all writes are separately armed; disallowed frames get a
  UDS negative, not silent passthrough. The phone's tester source is collapsed to the
  one TASU tester (`0xF2`).
- **One pinned peer.** Bind the `wlan0` address only (never `0.0.0.0`); accept one
  connection pinned to the approved IP/MAC; others get RST. A scoped firewall rule is
  added only while armed and removed on disarm/stop.
- **No secrets, no content trust, plaintext disclosure.** The bridge bundles no keys
  or calibration and cannot validate a third-party tool's flash content; the Wi-Fi leg
  is plaintext (xHP presents no token), so safety rests on the WPA2 hotspot + in-car
  approval + source pinning. USB tether preferred where client-isolation is weak.
- **Protects what works.** A missing/stopped daemon leaves install, live data, the
  flasher and the theme fully functional (the app is only a client).

## On-car probes (run these first — nothing depends on code until they pass)

See `tools/bridge-probes/`. Run as **root** on the head unit; read-only except a
temporary listener/firewall rule that are removed.

- **P1 — app↔daemon socket.** `node tools/bridge-probes/p1-daemon.js`, then set the
  app's `config.bridgeProbe=true`; the app reports `P1 OK …` on its error banner if it
  reaches the daemon. *Foundation of the whole design.*
- **P2 + P3 — inbound Wi-Fi reachability (make-or-break).**
  `sh tools/bridge-probes/probe-car.sh`; from the phone, `nc <MGU-wlan0-ip> 13400`.
  Text arriving = GO. Nothing either way = no wireless bridge (try USB tether).
- **P6 — TASU reads** (already in the app): tap SCAN on the CODES tab; fault codes
  appearing confirms the car-side leg.
- **P7 — TASU flash capacity** (bench only, a consented ECU): before any flash relay.

## Kill criteria (we stop and say so, rather than ship something that doesn't work)

- P1 fails (app can't reach a daemon socket) → architecture has no foundation.
- P3 fails **and** USB tether is unavailable → no wireless/tethered bridge.
- P6 fails (TASU doesn't answer reads) → the whole premise collapses.
- P7 shows TASU can't carry flash-grade UDS **and** no gateway route → the bridge can
  still ship **read/diagnostics only**; flashing-through-the-MGU is not deliverable.
- No root shell / Store won't install a third-party component → undeployable.

## Licensing

Our own `doip.js` (ISO 13400 codec) is MIT and seeds the daemon's codec. The deploy
and UNIX-socket-framing **patterns** from the MIT `idrive7-apps` repo are reusable
with attribution. **Not copyable:** `idrive7-apps/kit/renderd/src` (GPL-3.0) and
anything under `IterioDev/car-apps` (PolyForm Strict). The daemon is written clean.
