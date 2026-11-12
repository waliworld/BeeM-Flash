# Build and install

> **The BMW SDK is never in this repository.** The MGU app platform links every
> app against the on-board SDK (`oap-sdk` + generated `rhmiData`) that already
> lives on the head unit. The build here uses a committed placeholder for the
> SDK; the head unit links the real one from a donor app at install time. This
> repo contains only our own app source plus the open-source MGU **app kit**
> (`kit/`, MIT — the same runtime every community MGU app uses).

## How it installs (the short version)

The app is distributed exactly like other community MGU apps (e.g. RideTube): a
GitHub Actions workflow builds the app for iDrive 7 and iDrive 8 and publishes a
**catalog release** (a GitHub release tagged `catalog`). On the head unit you add
this repository as a **source** in the Store, and the Store installs Wali Datalog
from that release. Nothing is "built on your phone" and there is no fragile
build-on-the-unit step — the artifacts are prebuilt by CI.

## 0. Prerequisites

- **To develop/verify (no car):** Node 18+ and Python 3.12. Everything needed to
  build is vendored in `kit/`.
- **To install:** an MGU head unit (iDrive 7 or 8) with the community
  [mgu-store](https://github.com/robertnisipeanu/mgu-store) installed.

## 1. Develop and verify (no car)

```bash
npm test          # 124 pure-logic assertions, 0 dependencies
npm run sim       # headless end-to-end drive + all screens on a simulated ctx
npm run shots     # regenerates the preview bundle + renders every screen to out/shots/
```

## 2. Build the installable packages

The app is in the kit's app format (`app.json` + a flat set of `*.js` modules +
`icon.png`), so the vendored kit builds it directly — no external checkout:

```bash
npm run build:app
#  -> dist/wali_datalog@<version>.tgz   + .mgu   (iDrive 7 OAP package)
#  -> dist/src/wali_datalog8@<version>.tgz        (iDrive 8 source package)
```

Under the hood this is `python3 kit/tools/build.py wali_datalog` (iDrive 7) and
`python3 kit/tools/build.py --hmi ID8 wali_datalog` (iDrive 8). `tools/release.sh`
creates the SDK placeholder automatically; to run `build.py` by hand once, create
it first:

```bash
mkdir -p oap-sdk && echo 'module.exports = {};' > oap-sdk/index.js \
  && echo '{"name":"oap-sdk","version":"0.0.0-placeholder","private":true}' > oap-sdk/package.json
```

## 3. Assemble the catalog release

```bash
npm run release          # = tools/release.sh
#  -> dist/release/catalog.json
#  -> dist/release/wali_datalog@<version>.tgz     (iDrive 7, SDK stripped out)
#  -> dist/release/wali_datalog8@<version>.tgz    (iDrive 8 source package)
#  -> dist/release/wali_datalog.png               (app tile icon)
```

Upload every file in `dist/release/` to a GitHub release tagged `catalog`. The
**`.github/workflows/release.yml`** workflow does exactly this on every push to
`main` (and on manual dispatch): it runs `tools/release.sh` and uploads the
assets to the `catalog` release with `gh release upload … --clobber`.

## 4. Install on the head unit

1. In the **Store** on the car: **Settings → Add source**, enter
   **`waliworld/beem-flash`**, choose **Releases**.
2. Install **Wali Datalog**, then **restart the head unit**.
3. The app appears in the head unit's app list as **Wali Datalog**.

The Store picks the right package automatically: the iDrive 7 OAP package, or the
iDrive 8 source package (catalog `"build": "unit"`), which the unit links against
the SDK of a donor app on first install. Required infrastructure components
(`mgu-render`, and `mgu-inputgate`/`mgu-deploy`) are listed in `catalog.json` and
installed by the Store alongside the app.

## 5. First run on the car

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

The **MHD Datalog (web)** screen needs the unit online. Without internet the
screen explains that it is unavailable; the rest of the app is fully offline.

## What is verified off-car vs. needs a unit

The **build** (both head units), the **boot into the kit** (`require('./kit/mgu')`
beside the staged `app.js`), and the **on-device draw path** (every screen drawn
through the real `kit/runtime/canvas.js` via `surface.js` and pushed to each
screen's `<screen>_GFX` cell) are all verified here, off-car. The remaining
unit-specific bindings are isolated and fail safe (unverified → demo data; writes
→ refused):

- `apps/wali_datalog/diag.js` (`makeCtxTransport`) — the UDS transport over the
  unit's diagnostic channel.
- `apps/wali_datalog/doip.js` (`nodeUdpSocket`) — the UDP socket for vehicle
  discovery on the head unit's network interface (a host/test harness can inject
  one via `ctx.doipSocket()`; see [`VEHICLE-CONNECTION.md`](VEHICLE-CONNECTION.md)).
- `apps/wali_datalog/signalmap.js` / `dme_profiles.js` — SOME/IP field names and
  DME DID layout/scaling (calibrate per car).
- `catalog.json` `requires` versions — the exact Store infrastructure component
  versions; adjust to the Store build you run if a newer set ships.
