# Channel presets

A preset is a list of channel keys to enable, as a bare JSON array or
`{ "enabled": [ ... ] }`. On the head unit, copy one to the app data dir as
**`preset.json`** and the app enables those channels (unless you've already made
your own selection, which is saved to `channels.json` and takes priority).

- **`b58_mhdplus.json`** — the channel selection from a B58 MHD Flasher
  `LogPresets.csv` export (42 channels), as a worked example.

To make one from your own MHD preset:

```bash
node scripts/preset_from_mhd_csv.js path/to/LogPresets.csv
```

This reads only the parameter names and on/off flags and maps them to channel
keys (see `docs/SIGNALS-AND-DIDS.md`). It does not read or ship any vendor PID
addresses, scaling, code, or signing material.
