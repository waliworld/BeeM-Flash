# beem-bridge — the wireless bridge helper

Lets a phone or laptop reach your car **through the head unit**, so tools that
speak ENET/DoIP can work without plugging an adapter into the OBD port.

```
phone / tool  --Wi-Fi-->  [beem-bridged: access point + DoIP]  --UNIX socket-->  BeeM-Flash
                                                                                     |
                                                                        head unit's diagnostic link
                                                                                     |
                                                                                 DME / EGS
```

## Why a helper is needed

The head unit's app sandbox cannot bring up Wi-Fi or listen on a port. (Probing
the app's own socket paths on the car returns `ENOENT` — "no such file" — rather
than a permission error, which tells us a UNIX *client* connect is allowed; what
is missing is something to connect to.) So this helper owns the network side and
the app attaches to it.

## What decides what reaches the car

**The app, not this helper.** The helper carries bytes. Every relayed request is
judged inside BeeM-Flash against its relay policy and the on-screen consent gate:

* nothing is relayed unless the bridge is turned on **on the car's screen**;
* only the engine (`0x12`) and transmission (`0x18`) controllers are reachable;
* broadcast/functional addressing is refused outright;
* reads are allowed; **writes, flashing and clearing fault memory each need
  their own arming** and are refused otherwise;
* if the app detaches, the helper relays nothing at all.

This helper never widens that policy, and the app never takes an allow-list or a
"mode" from a helper message.

## Install (root shell on the head unit, once)

```sh
sh install.sh --probe     # report ONLY: can this unit host an access point?
sh install.sh             # start it
sh uninstall.sh           # stop and remove; the access point goes down
```

Then on the car: **CONNECT → WIRELESS BRIDGE → BRIDGE: ON**. The screen shows the
network name and password — type those into the phone, then point your tool at
the address shown, port **13400**.

The head unit has no keyboard, so the car *displays* the credentials rather than
asking you to type them. **NEW PASSWORD** generates a fresh passphrase.

## Honesty about what is verified

* The control protocol, the DoIP server and the relay (including every refusal
  path) are covered by the project's automated tests.
* **Bringing up a SoftAP is head-unit specific and is NOT verified on an MGU.**
  Run `--probe` first: it reports whether the Wi-Fi supports AP mode and whether
  `hostapd`/`dnsmasq` exist. If they don't, this unit cannot host its own
  network — use `--no-ap` and reach port 13400 over a network the unit is
  already on.

## Safety

* Writes **no** persistent system configuration (configs live under `/run` and
  are removed on exit) and changes nothing about the car.
* Binds the DoIP listener to the access point's own address when it hosts one.
* Auto-exits after 30 minutes idle, so an access point is never left
  broadcasting for a session you forgot about.
* Serves one app and one tool at a time.

## Protocols and ports (v2.19.0)

The in-app listener serves **three protocols on one port**, auto-detected from
the first bytes of each connection, so one setting fits whatever a tool speaks:

* **DoIP / ISO 13400** (port 13400) — the native protocol on G-series. Proven.
* **HSFZ** (BMW's own, port 6801) — `[len:4][control:2][src][dst][uds]`. The
  diagnostic-data relay is tested; the identification handshake is best-effort
  and marked EXPERIMENTAL. Used by ISTA / E-Sys-style tools on F-series.
* **raw TCP socket** (any port, e.g. 8899) — bare UDS bytes, Wi-Fi-serial style.

Choose the port under SETUP → Bridge port.

## Safe relay vs. FULL GATEWAY

By default the bridge is a **safe relay**: only the engine (`0x12`) and
transmission (`0x18`), reads only, writes behind the flash arm.

**FULL GATEWAY** (CONNECT → WIRELESS BRIDGE → FULL GW, two taps to confirm)
hands the connected tool the **entire car** — every module, every service,
flashing included — over the head unit's TASU link. It is the owner's explicit,
on-screen choice: it only holds while the bridge lease is valid, is **never**
persisted, clears the instant the bridge is turned off, and every relayed
request is still counted in the on-screen audit. One device owns the session at
a time. This exists because the gateway does not answer the head unit over IP
(so a raw IP tunnel is impossible), but TASU can address any module directly.

## How it installs — can the Store do it?

Short answer: **the Store installs the app, not the helper.**

* The MGU Store (`mgu-store`) installs **sandboxed apps** that run as the app
  user (`tm_oap_app`, not root). BeeM-Flash is one of those. A helper installed
  that way would hit the **same walls** the app does — it could not create a
  Wi-Fi access point or bind a privileged port — so a Store app cannot *be* the
  root helper.
* A **root daemon absolutely can run on the MGU** — the unit's own GPU renderer
  (`mgu-renderd`) and Tailscale (`tailscaled`) are exactly that: root services on
  `/var/opt` with a unit on the rootfs. The helper installs the same way. What
  the Store will not do is install a *third-party* root component automatically.

So the helper needs **root once, at install time** — which you already have via
your root-shell / SSH-root tool. That is the intended path:

1. Get the files onto the unit (your root tool, `scp`, a USB copy — any way).
2. Run `sh install.sh` **as root**. With systemd present it installs a service
   that starts at boot and restarts on failure; without it, a detached process.
3. Done — it is now part of the unit until `sh uninstall.sh`.

**Does it need its own repo?** No. It lives in `tools/beem-bridge/` in the
BeeM-Flash repo and ships as plain files. Package it alongside your root tool if
that is how you deploy to units — nothing here needs a separate catalog or
release. Only the *app* goes through the Store; the helper rides with root.
