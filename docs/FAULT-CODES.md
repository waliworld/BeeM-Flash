# Fault codes — whole-vehicle reader & clearer

The **Codes** page (Diag → Codes) reads stored fault codes (DTCs) from every
module on the car and, with confirmation, clears them. It uses the standard UDS
diagnostic services over the same open ENET/DoIP link the live logger uses.

- **Reading is read-only** — `ReadDTCInformation` (0x19). It only reads.
- **Clearing erases fault memory** — `ClearDiagnosticInformation` (0x14). It is
  a write, so the page asks you to press **Clear** twice (arm, then confirm)
  before anything is erased. Clearing never touches the tune or any calibration.

## What you see

Each module scanned gets a row: its name, how many codes it has (or *no codes* /
*no response*), and the decoded code list. Codes are shown in SAE J2012 form
(`P0300`, `C0501`, `U0123`, …); a trailing **`?`** marks a *pending* (not yet
confirmed) code. The footer totals codes across the modules that answered.

```
 Diag ──► Codes
            A Scan    read codes from every module in scope
            B Clear   (press twice) erase fault memory on the modules reached
            C Scope   toggle ALL MODULES  ⇄  ENGINE ONLY
            D Back
```

## Modules it scans

A scan walks a list of modules, each with a DoIP **logical (diagnostic)
address**. The built-in list is a **community-reference starting point** and is
marked unverified — BMW addresses vary by chassis (F- vs G-series) and
equipment. Confirm them for your car and override as needed.

Configure the list in `app.json` under `config`, or drop a `modules.json` on the
unit. `config.modules` **replaces** the defaults; `config.extraModules` is
appended.

```json
{
  "config": {
    "modules": [
      { "key": "dme",  "name": "DME (engine)",        "address": "0x1000", "verified": true, "primary": true },
      { "key": "egs",  "name": "EGS (transmission)",  "address": "0x1800", "verified": true },
      { "key": "zgw",  "name": "Body gateway (ZGW)",  "address": "0x0010" }
    ]
  }
}
```

An address that no module answers at is reported as **no response** (the request
times out and the scan moves on); it never hangs the page. **Engine only** scope
scans just the `primary`/`dme` module for a quick check.

## How it works (standard UDS)

```
 ReadDTCInformation 0x19 02 FF         → 0x59 02 <avail> [DTC(3) status(1)] …
 ClearDiagnosticInformation 0x14 FFFFFF → 0x54         (all groups)
```

Reading sends subfunction `0x02` (reportDTCByStatusMask) with mask `0xFF` (all
stored codes). After a clear, the page re-reads to confirm: if an active fault
comes straight back, it says so rather than claiming success. The codec, the
per-module scan, and the clear flow are in `apps/wali_datalog/dtc.js`; the module
catalog is in `apps/wali_datalog/modules.js`.

## Testing it off-car

`test/ecusim.js` answers 0x19/0x14 and can host several modules behind one fake
DoIP gateway. `test/run.js` reads codes from multiple modules end-to-end over the
gateway, verifies an absent module times out instead of hanging, and verifies the
two-step clear erases each reachable module. Run `node test/run.js`.
