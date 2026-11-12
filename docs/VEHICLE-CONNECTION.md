# Vehicle connection (ENET / DoIP) — the safety gate

This describes the **Connect** screen and the consent model behind it. Read
this alongside `NOTICE.md` (project scope and independence) and, for the write
paths an owner can use on their own vehicle, `docs/FLASHING.md` (the open
calibration-section flasher and the pluggable SecurityAccess framework).

The **live-data path** described below is read-only: the logger and dashboard
only ever *read* from the vehicle. Writing (map switch, calibration flashing)
is a separate, explicitly-gated action, never part of connecting or logging.

## What it is

A read-only connection from the app to the vehicle's own diagnostic network
(ENET / ISO 13400 DoIP), used to read live data for the logger and the live
dashboard. It is a standard open diagnostic transport (see `data/SOURCES.md`).

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

- **Can:** read measured values via UDS `0x22` / the fast block-read exchange
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

## UDS SecurityAccess (seed/key) — an open framework

`seedkey.js` implements the standard UDS SecurityAccess exchange (service `0x27`):
request a seed, compute a key, send the key, for a security level on **a vehicle
you own**, over its diagnostic port. It follows python-udsoncan's model: the
library drives the request-seed / send-key handshake and responsePending (`0x78`)
handling, while the **key-derivation algorithm is pluggable and supplied by you
or the community** — `algo(seed, level, params) -> key`. **No manufacturer key
algorithm is bundled in this repository.** Without an algorithm, `unlock()`
refuses and sends nothing.

`test/ecusim.js` is a fake UDS ECU (sessions, seed/key, gated DIDs, routines)
that lets contributors develop and test these flows off-car; it is test-only and
is not part of the installed app.

## The ENET/DoIP gateway (open diagnostic connection)

`doip.js` is the app's own ISO 13400 (DoIP) connection to the car over its
diagnostic Ethernet — the open-source equivalent of an ENET adapter's link. It
discovers the vehicle (UDP Vehicle Identification), performs routing activation,
and carries **any** UDS request the caller builds (reads, sessions, and the
SecurityAccess handshake from `seedkey.js`). It is a client that connects out to
the car on a connection the user has enabled (`enetgate.js`); it is not a network
bridge and opens no listener.

`DoipGateway` composes the transport with a promise-based `send()`, routing
activation, a TesterPresent keep-alive, and `session()` / `unlock(level, algo)`
convenience methods. `test/ecusim.js` answers DoIP framing like a real gateway,
so the whole path (discover → activate → unlock → read) is tested off-car.
