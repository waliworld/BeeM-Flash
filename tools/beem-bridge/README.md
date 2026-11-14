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
