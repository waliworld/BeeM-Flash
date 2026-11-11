# Build and install

> **The BMW SDK is never in this repository.** The MGU app platform links every
> app against the on-board SDK (`oap-sdk` + generated `rhmiData`) that already
> lives on the head unit. A build therefore needs either the head unit itself or
> a build host that can extract the SDK from a donor BMW app. This repo contains
> only our own app source.

## 0. Prerequisites

- An MGU head unit (iDrive 7 or 8) with the community store installed
  ([mgu-store](https://github.com/robertnisipeanu/mgu-store)) and the
  `mgu-render` renderer tool.
- For building a package off-car: a checkout of the
  [`idrive7-apps`](https://github.com/robertnisipeanu/idrive7-apps) kit, whose
  `kit/tools/extract_sdk.js` rebuilds the SDK from a donor app, and
  `kit/tools/build.py`. Node 14+ and Python 3.12 for the kit's tooling.

## 1. Develop and verify (no car)

```bash
npm test          # pure-logic tests
npm run sim       # headless end-to-end drive + all screens
node scripts/bundle.js runtime/web/preview-entry.js runtime/web/app.bundle.js
npm run shots     # UI screenshots to out/shots/
```

## 2. Build a package (`.mgu`)

The app is written in the kit's app format (`app.json` + `main.js` + `src/`), so
it builds with the kit against the SDK the kit provides:

```bash
# point the build wrapper at your idrive7-apps checkout
export MGU_KIT=/path/to/idrive7-apps
python3 scripts/mgu_build.py wali_datalog apps/wali_datalog
# -> dist/wali_datalog@<version>.mgu
```

`scripts/mgu_build.py` stages `apps/wali_datalog` into the kit's `apps/` folder,
runs `kit/tools/build.py`, and copies the resulting package into `dist/`. If no
kit/SDK is found it exits with a clear message rather than producing a broken
package.

## 3. Install

**Through the store (recommended).** Point the on-car Store at this GitHub
repository. `mgu-repo.json` declares `wali_datalog` as a repo-tree app the Store
can build on the unit (where the SDK is present). Follow the store's
`docs/PUBLISHING.md` for adding a source; the exact repo-tree build fields should
be checked against the store version you run.

**From a built package.** Copy `dist/wali_datalog@<version>.mgu` to the unit and
install it with the store/kit deploy tooling
(`deploy/push-to-car.sh install`, or the store's USB flow). The app then appears
in the head unit's *All apps* list as **Wali Datalog**.

## 4. First run on the car

1. Open **Wali Datalog**. It starts on **Live** showing demo data (badge
   "DEMO DATA") until live signals are verified.
2. In **Settings**, set units and sample rate. Leave **Enable map control** off
   unless you intend to switch maps.
3. Verify live signals and (if logging diagnostic channels) calibrate the DME
   profile — see [`SIGNALS-AND-DIDS.md`](SIGNALS-AND-DIDS.md). Once a signal is
   confirmed, flip `verified:true` and rebuild; the badge changes to "LIVE".
4. On **Datalog**, press **Start** to record; **Export** copies the newest log to
   the USB mount (`mediaDir`).

## Internet (optional)

The **MHD Datalog (web)** screen needs the unit online. Internet on MGU apps is
granted by `mgu-uplink` plus the internet flag in the store manifest
(`package.json` `mguInternet` / `mgu-app.json` `internet:true`). Without it, the
screen explains that internet is unavailable; the rest of the app is offline.

## Device binding checklist

These are the only places that touch unit-specific APIs. They are marked and
isolated so finishing them does not touch app logic:

- `apps/wali_datalog/src/ui/surface.js` — map our draw calls to the real
  `ctx.canvas` primitives (names/options).
- `apps/wali_datalog/main.js` (`_present`, `_show`, `_mediaDir`, `openUrl`) —
  image present, screen switch, USB mount, browser open.
- `apps/wali_datalog/src/diag.js` (`makeCtxTransport`) — the UDS transport over
  the unit's diagnostic channel.
- `apps/wali_datalog/src/signalmap.js` — SOME/IP interface/field names.
