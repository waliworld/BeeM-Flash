# beem-probe — one-command connectivity probe (no manual per-use shell)

A tiny, throwaway daemon that settles the two feasibility questions the app cannot
answer by itself, so you don't have to type anything into a shell each time:

- **P1** — opens `/run/beem-probe/p.sock` (owned by the app group `tm_oap_app`), so
  **SETUP → DIAGNOSTICS → RUN** in BeeM-Flash shows **P1 … OK** instead of `ENOENT`.
  This proves the app can reach a bridge daemon — the foundation of the whole design.
- **P3** — opens a **TCP echo listener on the head unit's `wlan0` address** (port
  13400), so a phone or laptop on the same hotspot can prove it can reach the unit.

**It sends NOTHING to the car.** It has no TASU, no UDS, no path to any module — it
only echoes text. It binds the Wi-Fi interface address (never `0.0.0.0`), **auto-exits
after 30 minutes**, and `uninstall.sh` removes it with no trace.

## Install (once, as root — you already have shell access)

```sh
sh install.sh
```

It copies the daemon to `/var/opt/beem-probe/`, starts it detached (logging to
`/var/opt/beem-probe/probe.log`), and prints the exact `nc` command to run on your
phone. Node is taken from `/usr/bin/node` (override with `NODE=/path/to/node`).

## Then

1. **On the car:** BeeM-Flash → **SETUP → DIAG → RUN**. The **P1** line should now read
   **OK** for `/run/beem-probe/p.sock`. (That confirms P1.)
2. **From a phone/laptop on the same hotspot:** run the `nc <head-unit-ip> 13400` line
   the installer printed (phone: Termux `nc …`, or any TCP‑client app; laptop:
   `nc`/`ncat`). Type something. If it echoes back — and the head unit's `probe.log`
   logs *"a device REACHED the head unit"* — **P3 is a GO.**
3. Watch what it saw: `cat /var/opt/beem-probe/probe.log`.

## Remove

```sh
sh uninstall.sh
```

It also auto-exits after 30 minutes on its own, and a reboot clears it (it is not
installed as a persistent service on purpose).

## What each result means

| You see | Meaning |
|---|---|
| DIAG shows **P1 OK** | the app can reach a daemon socket — the bridge's foundation is real |
| phone/laptop echo works, `probe.log` logs the connection | **P3 GO** — a device can reach the head unit; the wireless bridge is feasible |
| DIAG P1 still `EACCES` | the socket exists but the app's sandbox can't use it — tell me, it changes the socket path/owner |
| nothing reaches the unit on P3, even on the same hotspot | inbound is blocked (AP client‑isolation) — we try USB tether instead |

See `../../docs/BRIDGE.md` for how this fits the full architecture and the security
model of the real bridge (which, unlike this probe, is consent‑gated and relays to
the car only under explicit in‑car arming).
