# Vehicle connection (ENET / DoIP) — the safety gate

This describes the **Connect** screen and the consent model behind it. Read
this alongside `NOTICE.md`, which states the project's scope (no flashing, no
ENET-over-WiFi bridge, no security-access unlock).

## What it is

A read-only connection from the app to the vehicle's own diagnostic network
(ENET / ISO 13400 DoIP), used to read live data for the logger and the live
dashboard. It is independent of MHD (see `data/SOURCES.md`).

## The gate

No socket is ever opened and no packet is ever sent to the vehicle until the
user, on the **Connect** screen (Live → **D**), does both of the following, in
order:

1. **Acknowledge** — read and accept a plain-language safety disclosure.
2. **Enable** — explicitly permit a connection, this session.

```
          ┌──────────┐  Acknowledge  ┌──────────┐    Enable    ┌───────────┐   Scan finds a
 Locked ─►│ Locked   │──────────────►│ Disabled │─────────────►│ Enabled,  │──────────────►  Connected
          │ (default)│               │ (ack'd)  │               │ searching │   vehicle      (read-only)
          └──────────┘               └──────────┘               └───────────┘
                                            ▲                          │
                                            └───────── Disable ────────┘
```

Key properties, enforced in `apps/wali_datalog/enetgate.js`:

- **Acknowledgment persists** across app restarts (stored in `enet.json`), so
  the disclosure doesn't need to be re-read every single launch.
- **"Enabled" is never persisted.** Every app session starts with the
  connection fully disabled — the user must press Enable again each time.
  Nothing auto-connects on boot, ever.
- **Disabling forgets the vehicle.** Toggling off clears the discovered
  host/address; reconnecting requires scanning again.
- **Scanning itself is gated.** `EnetGate.scan()` refuses (resolves an empty
  list, opens no socket) unless the connection is enabled — so no network
  traffic of any kind is sent while disabled.

## Discovery (no manual IP entry)

Real ENET adapters find the car by broadcasting a **Vehicle Identification
Request** on UDP 13400 and reading the gateway's **Vehicle Announcement**
(VIN + logical address) back, using the response datagram's source address as
the vehicle's IP. `src/doip.js` implements this (an original implementation of
the published ISO 13400 standard — see `data/SOURCES.md`), so the Connect
screen's **Scan** button needs no manual IP address.

## What the connection can and cannot do

- **Can:** read measured values via UDS `0x22` / the MHD monitor exchange
  (`0x2C`) / `ReadMemoryByAddress` (`0x23`) — whatever the rest of the app
  already issues.
- **Cannot:** write to the engine controller or any other module. There is no
  calibration-write, no map-flash, no SecurityAccess (seed/key) code anywhere
  in this transport. See `NOTICE.md`.
- **Is not** a gateway: the app opens no listening socket and relays no
  traffic between the vehicle and any other device.

## Device binding

Real discovery needs a UDP socket on the vehicle's diagnostic network.
`src/doip.js` provides a Node `dgram` adapter (`nodeUdpSocket()`) for the head
unit / a desktop Node host. A host or test harness can inject its own via
`ctx.doipSocket()` (see `App._makeDiscoverySocket` in `main.js`) — this is how
the simulator and tests exercise the full flow without real hardware.

## Verifying it

```bash
npm test   # enetgate.js + doip.js discovery + a full app-level
           # acknowledge -> enable -> scan -> connect -> disable -> restart
           # round-trip, all under test/run.js
```
