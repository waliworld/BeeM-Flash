# Architecture

## Data flow

```
                    ┌─────────────────────────────────────────┐
                    │                 main.js                  │
                    │  (controller: input, view model, loops)  │
                    └───────────────┬──────────────┬───────────┘
                                    │              │
            reads settings/ctx      │              │  draws
                                    ▼              ▼
   ┌───────────────┐   sample   ┌─────────┐   view   ┌────────────────┐
   │   provider    │──────────► │ engine  │ ───────► │  ui/screens    │
   │ (source mux)  │            │ (log SM)│          │  via ui/draw   │
   └──┬─────┬────┬─┘            └────┬────┘          └───────┬────────┘
      │     │    │                   │                       │
  ┌───▼─┐ ┌─▼──┐ ┌▼────┐        ┌────▼─────┐          ┌──────▼───────┐
  │someip│ │diag│ │demo │        │ storage  │          │  surface     │
  │(bus) │ │(UDS)│ │data │        │ (fs/mem) │          │ (canvas/sim) │
  └──────┘ └──┬─┘ └─────┘        └──────────┘          └──────────────┘
              │
         ┌────▼──────┐
         │ mapcontrol │  (gated writes: DME routine jobs 0x611E/0x60FD)
         └────────────┘
```

- **`provider`** merges live **SOME/IP** bus signals and **diagnostic (UDS)**
  reads into one metric sample keyed by channel, and falls back to **demo** data
  per the `demo` setting. Derived channels (e.g. AFR from lambda) are computed
  here so the gauges and the logger always agree.
- **`engine`** (`logengine.js`) is a host-driven state machine
  (`idle → logging → saving → done`, plus `error`). `main.js` feeds it one
  sample per tick at the configured rate; the engine resolves channels, converts
  units, formats CSV, buffers, and flushes to **storage**.
- **`mapcontrol`** is the only writer. It validates preconditions, runs a
  two-step confirm, and issues UDS `RoutineControl` on the DME map/cooling jobs
  through `diag`.
- **`ui/screens`** are pure render functions over a view model, drawing through
  a small surface contract that both the on-unit canvas and the simulator
  implement.

## Why this shape

- **Pure, injected logic.** The engine takes `storage` and `clock`; the provider
  takes the source objects; map control takes the diagnostic object. Nothing in
  the core imports a device API, so all of it runs in Node tests and the
  headless simulator and, unchanged, on the car.
- **Device specifics are isolated.** Exactly four kinds of on-unit facts live in
  named, documented places: SOME/IP field names (`signalmap.js`), DME DID layout
  (`dme_profiles.js`), the diagnostic transport (`diag.js` `makeCtxTransport`),
  and the UI/USB bindings (`main.js`/`ui/surface.js`, marked `DEVICE`).
- **Node 8 safe.** On-unit code avoids optional chaining / nullish coalescing /
  class fields and uses prototype methods and `module.exports`, because apps run
  under Node 8 on the head unit. Tooling (bundler, simulator, tests) targets
  modern Node.

## Concurrency and failure

- Sampling runs on its own interval at the configured Hz; rendering runs on the
  display refresh via `ctx.loop`. They share only the latest sample and the
  engine, and never block each other.
- Every storage write is wrapped; a failure puts the engine in `error` with a
  message instead of throwing into the UI. Diagnostic reads are round-robined one
  DID per tick and guarded so a slow/absent DME never stalls the app.
- Map writes are refused unless enabled + confirmed + preconditions met; the
  DME's negative responses (NRC) are surfaced verbatim.

## Modules

| File | Responsibility |
|------|----------------|
| `main.js` | App controller; dual-mode (head unit + simulator). |
| `src/logengine.js` | Logging state machine, CSV, sessions, markers, stats. |
| `src/channels.js` | Channel catalogue: source, scaling, units, thresholds. |
| `src/provider.js` | Source multiplexer + demo fallback + derived channels. |
| `src/someip.js` | Live bus signals via `ctx.signals.watch`. |
| `src/diag.js` | UDS poll loop + routine/session/security control. |
| `src/uds.js` | ISO 14229 request builders and response parser (pure). |
| `src/mhdmonitor.js` | MHD live-monitor exchange decode (MG1, read-only). |
| `src/doip.js` | ISO 13400 (DoIP) read transport + vehicle discovery (pure framing). |
| `src/enetgate.js` | Vehicle-connection safety gate: acknowledge → enable, never auto-persists "enabled". |
| `src/mapcontrol.js` | Gated map/cooling switching via DME routines. |
| `src/dme_profiles.js` | Per-DME diagnostic read map (calibration target). |
| `src/signalmap.js` | Logical signal → SOME/IP field + scaling. |
| `src/demo.js` | Demonstration data generator (synthetic). |
| `src/storage.js` | `fsStorage` (car) and `memStorage` (tests). |
| `src/format.js` | CSV, number, time, unit helpers. |
| `src/ui/*` | Theme, widgets, screens, device surface adapter. |
