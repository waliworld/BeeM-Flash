# Calibration-section flashing (open UDS flasher)

> **This writes to your engine controller. It can damage the engine or
> permanently brick the ECU. Use it only on your own vehicle, with your own
> data, at your own risk.** Read this whole page before using it.

## What this is

An open-source implementation of the "write calibration" step that tuner tools
perform, built entirely from the standard UDS download services (ISO 14229). It
is for the case the user asked for: **a vehicle that has already been flashed**
(its bootloader/unlock is in place) and now needs **only the calibration
section** rewritten — not a full ECU recovery, not a first-time unlock.

It lives in `apps/wali_datalog/flash.js` and rides the same open ENET/DoIP
transport (`doip.js`) and pluggable SecurityAccess framework (`seedkey.js`) as
the rest of the app.

## What this is **not**

- It bundles **no** calibration data, **no** ECU memory addresses, and **no**
  security key or algorithm. You supply all of them, for your own ECU.
- It does **not** generate, validate, or modify a tune. The bytes it writes are
  exactly the bytes you give it.
- It is **not** a magic recovery tool. If the ECU needs a full bootloader flash
  or a first-time unlock, this calibration-only path will not do it.

Nothing in this repository acts on a car by itself. The flasher refuses to do
anything without explicit, per-flash acknowledgment **and** your data.

## The sequence (standard UDS, ISO 14229)

```
 programmingSession (0x10 02)
      │
 SecurityAccess (0x27)  ── requestSeed → your algo(seed) → sendKey   [if required]
      │
 erase calibration region (RoutineControl 0x31, your erase routine) [optional]
      │
 RequestDownload (0x34)  → DME replies with its maxNumberOfBlockLength
      │
 TransferData (0x36) × N  ── blocks of (maxBlock − 2), counter 1,2,…,255,0,…
      │
 RequestTransferExit (0x37)
      │
 verify (RoutineControl 0x31, your check routine)                   [optional]
      │
 ECU reset (0x11)
```

Each step's negative response is surfaced verbatim. If any step fails, the
flasher stops and tells you **where** it stopped and that the ECU may be in an
incomplete state — it never reports a partial write as success.

## How to drive it

### From code

```js
var flash = require('./flash');
flash.flashCalibration(send, {
  acknowledged: true,            // REQUIRED — explicit risk acknowledgment
  data: calBytes,                // your calibration section (array of 0..255)
  address: 0xA0010000,           // your calibration start address
  securityLevel: 0x11,           // if the DME gates the write
  keyFn: function (seed) { /* your algorithm */ },
  eraseRid: 0xFF00,              // your erase routine id (optional)
  checkRid: 0xFF01,              // your verify routine id (optional)
  reset: 0x01                    // ECU reset after flashing (false to skip)
}, function (step) { /* progress */ })
.then(function (res) {
  // res = { ok, confirmed, message, steps }
});
```

`send(bytes) -> Promise<respBytes>` is any UDS transport — the DoIP gateway
(`new doip.DoipGateway({...}); gw.send`), the head unit's own diagnostic
channel, or the test ECU.

### From a descriptor (no code)

Describe the flash declaratively and let `normalizeDescriptor` build the
options. The key algorithm is built from a `seedkey.makeAlgo` spec, so even the
seed/key scheme needs no code:

```json
{
  "address": "0xA0010000",
  "session": 2,
  "security": { "level": 17, "algo": { "type": "xorkey", "key": [1, 2, 3] } },
  "eraseRoutine": "0xFF00",
  "checkRoutine": "0xFF01",
  "blockSize": 256
}
```

```js
var norm = flash.normalizeDescriptor(descriptor, calBytes); // -> { opts } | { error }
norm.opts.acknowledged = true;        // you acknowledge at flash time, deliberately
flash.flashCalibration(send, norm.opts);
```

A descriptor is normalized with `acknowledged: false` on purpose — acknowledging
the risk is always a separate, deliberate act, never baked into a file.

## Before you flash — a checklist

- **Right section, right address.** A calibration written to the wrong address,
  or a calibration that doesn't match your ECU's bootloader/tune, can brick it.
- **Battery / power.** Use a charged battery or a stable bench supply. A voltage
  drop mid-flash can brick the ECU.
- **Don't interrupt it.** Do not turn the key off, pull the cable, or let the
  head unit sleep during a flash. Keep the connection stable.
- **Verify before you drive.** If no verify routine confirmed the write, confirm
  the car starts and runs correctly before driving it.
- **Legality and emissions are your responsibility.** Modifying engine
  calibration may not be road-legal where you are.

## If a flash fails

`flashCalibration` resolves (it does not throw) with `ok: false` and a message
naming the step it failed at. The ECU may be in an incomplete state: **do not
drive the car.** Re-run the flash with a correct, complete calibration, or
recover the ECU with an appropriate tool, before use.

## Testing it off-car

`test/ecusim.js` simulates the full download sequence (0x34/0x36/0x37, erase and
verify routines, ECU reset), optionally gated behind SecurityAccess and a
programming session. `test/run.js` flashes a multi-block BIN through it — both
directly and end-to-end over the ENET/DoIP gateway — and asserts the ECU
received exactly the bytes written, that a wrong key fails honestly without
writing, and that the flasher refuses without acknowledgment, data, or an
address. Run `node test/run.js`.
