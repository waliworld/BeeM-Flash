# Wali Datalog — MGU (iDrive 7/8) datalogging for tuned BMWs

An independent app for the BMW **MGU** head unit (iDrive 7 and iDrive 8) that
**datalogs** a tuned car on the car's own screen and, optionally, **switches
tune maps**. It installs through the community iDrive app store
([mgu-store](https://github.com/robertnisipeanu/mgu-store)) like any other MGU
app, and it is built from scratch — see [`NOTICE.md`](NOTICE.md).

> Independent and unaffiliated. No MHD/BMW code is used; "MHD", "BMW" and
> "iDrive" are used only to describe compatibility. The app is **read-only by
> default**; writing maps to the engine is off unless you explicitly enable it.

![Live gauges](out/shots/live.png)

## Who it's for and what it does

| User | Need it serves |
|------|----------------|
| Driver / owner of a tuned BMW | See boost, timing, mixture, temps live on the iDrive screen; record a pull to a CSV; switch between tune maps without a laptop; keep every log on the car and export to USB. |
| Tuner | Hand a customer a clean, on-screen datalogger; review exported CSV logs in the same format every time; gate map writes behind confirmation and engine-state checks. |

### Features

- **Live dashboard** — RPM + boost radial gauges and six configurable stat
  tiles, with amber/red warnings against per-channel thresholds.
- **Datalogging** — start/stop a session, pick channels, drop markers on a
  pull, self-describing CSV with units in the header, sessions listed on-screen,
  one-button export to USB. Metric or imperial.
- **Map control (opt-in)** — switch tune maps via the DME diagnostic job,
  guarded by on-screen confirmation and "stationary + engine idle" preconditions.
  **Off by default.**
- **MHD Datalog (web)** — a shortcut that opens MHD's own site so you can sign
  in and datalog through MHD's page. A convenience, not an integration; the app
  never sees your MHD login.
- **Works without a car** — a clearly-labelled demo mode drives every screen so
  the app can be reviewed and demonstrated off the vehicle.

## Quick start

```bash
# Run the test suite (pure logic: CSV, UDS codec, engine, gating, provider)
npm test

# Drive the whole app headless (demo drive + logging + every screen)
npm run sim

# Regenerate the UI screenshots in out/shots/ (uses the bundled real app code)
node scripts/bundle.js runtime/web/preview-entry.js runtime/web/app.bundle.js
npm run shots
```

Install on a head unit is covered in
[`docs/BUILD-AND-INSTALL.md`](docs/BUILD-AND-INSTALL.md).

## How it's structured

```
apps/wali_datalog/        the MGU app (ships to the head unit)
  app.json                manifest: id, signals, screens, settings
  main.js                 controller: wiring, input, view model, loops
  src/                    logengine, channels, provider, demo,
                          someip, uds, diag, mapcontrol, storage, format
  src/ui/                 theme, draw widgets, screens, device surface
mgu-repo.json             mgu-store repo-tree descriptor
runtime/                  off-car simulator ctx + browser preview backend
scripts/                  build wrapper, bundler, simulator, screenshots
test/                     zero-dependency test runner
docs/                     architecture, build/install, signals & DIDs, verification
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow.

## What is verified, and what needs a car

All application logic — the logging state machine and CSV, the UDS/ISO-14229
codec, unit conversion, map-control gating, demo fallback, and every screen's
rendering — is covered by `npm test` (43 assertions) and the headless
`npm run sim`, and the screens are rendered to real pixels by `npm run shots`.

Three things are, by their nature, completed on the actual unit and are clearly
isolated and documented, not faked:

1. **SOME/IP signal names** (`src/signalmap.js`) — the live bus field names are
   per-unit; placeholders are marked `verified:false` and suppressed until
   confirmed, so the app never shows a wrong number.
2. **DME measured-value layout** (`src/dme_profiles.js`) — DID/offset/scaling for
   diagnostic channels is per-DME/tune and must be calibrated.
3. **Device bindings** (canvas present, screen switch, diagnostic transport,
   USB mount) — marked `DEVICE` in `main.js`/`src/ui/surface.js`.

Until those are filled in on a unit, the app runs on demo data and says so.
Full detail and the on-car procedure are in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) and
[`docs/SIGNALS-AND-DIDS.md`](docs/SIGNALS-AND-DIDS.md).

## Safety

Datalogging only reads. The one action that writes to the engine controller —
a map switch — is off by default, requires turning on "Enable map control" in
Settings, asks for on-screen confirmation, and refuses unless the car is
stationary with the engine at idle. You are responsible for the tune on your
car. Provided "as is" under the MIT [`LICENSE`](LICENSE).
