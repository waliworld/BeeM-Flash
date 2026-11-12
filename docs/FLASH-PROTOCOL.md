# MG1 flash protocol — what's confirmed, and our implementation

Research notes from the open-source S58/MG1 tooling, and how BeeM-Flash's flasher
lines up. **Scope reminder:** this is for an **already-unlocked DME**; nothing
here unlocks an ECU or touches its signature.

## Confirmed UDS flash sequence (matches our `flash.js`)

The [MBTune/mgctl](https://github.com/MBTune/mgctl) design (Apache-2.0) specifies
the MG1 "write calibration" flow as:

```
session 0x10 02 (Programming)
  → 0x27 SecurityAccess (seed/key)
  → 0x34 RequestDownload
  → 0x36 TransferData  (block loop, counter & 0xFF)
  → 0x37 RequestTransferExit
  → 0x31 RoutineControl (checksum / integrity recompute)
```

This is exactly the order `apps/wali_datalog/flash.js` already implements. Other
confirmed details we match or adopt:

- **Block size** `0x400` (1 KiB) default; we size each `0x36` block from the
  DME's reported `maxNumberOfBlockLength` and fall back to `0x400`.
- **Sessions**: Default 0x01, Programming 0x02, Extended 0x03, Safety 0x04.
- **SecurityAccess** levels referenced: 1/3/5; seed/key is a 4-byte big-endian
  challenge/response — **owner/community-supplied**, never bundled (our
  `seedkey.js` model).
- **DIDs**: VIN `F190`, ECU-ID `F18A`, SW `F189`, HW `F191`, boot SW `F180`.
- **NRC handling** incl. `0x78` responsePending auto-wait (our `seedkey.sendAwait`),
  `0x33`/`0x35`/`0x36`/`0x73` (block sequence) etc.

## Transport

mgctl targets **D-CAN** (tester `0x6F1`, ECU `0x6F9`, 500 kbps, 11-bit ISO-TP) —
the OBD K+DCAN-cable path. BeeM-Flash instead runs **UDS over the vehicle's own
diagnostic Ethernet (ENET/DoIP)** through the head unit, which carries the same
UDS services. The flash sequence above is transport-agnostic, so it is identical
on either path.

## Integrity model (what to recompute)

mgctl's plan for calibration integrity is **CRC-32 (Ethernet poly) + AES-CMAC-128
recompute** (dev/dry-run, with a known CMAC key). Independently, our own binary
analysis of the BMW MG1CS stock images found a ~256-byte high-entropy
**signature** block plus CRC words (see `data/checksum_schemes/README.md`).

- **CRC** — handled: `checksum.js` corrects it before flashing.
- **AES-CMAC-128 / RSA signature** — a **keyed/cryptographic** integrity value.
  Our checksum engine is pluggable and could recompute an AES-CMAC-128 **if the
  owner supplies the CMAC key** (same model as seed/key); it is not implemented
  yet because that key is not something this project has or bundles. Forging the
  RSA signature is out of scope and not done. On a **bench-unlocked** DME the
  unlock/hardware handles the signature; the CRC (and, if keyed, the CMAC) is the
  part a flasher recomputes.

## Sources & licensing

- [MBTune/mgctl](https://github.com/MBTune/mgctl) — **Apache-2.0**. We reuse only
  design facts/interfaces (step order, DID/NRC lists, session/level numbers),
  attributed here. mgctl ships no real seed/key, addresses, CMAC key or checksum
  ranges, and points to a separate (not used) RE repo for the memory map.
- [rftx-tuning](https://rftx-tuning.github.io/WEBSITE/) `RFTX_SOFTWARE` — **no
  license (all-rights-reserved)** and its MG1 memory map / seed-key / framing are
  **fabricated placeholders that do not work on a real ECU**. We do **not** copy
  its code or trust its values. Only its public statement is cited: *"S58 (MG1/
  MD1): bench unlock required before flashing"* — which confirms our scope.
