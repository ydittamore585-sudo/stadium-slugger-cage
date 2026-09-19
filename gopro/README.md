# GoPro HERO8 cage controller

`gopro.mjs` drives the HERO8 over WiFi from the laptop — no phone app needed.
Biggest win for measurement: **start/stop recording without touching the tripod** (no shake).

## One-time setup

1. Camera: swipe down → Preferences → Connections → **Camera Info**.
   Note the WiFi network name and password.
2. Laptop: join that WiFi network. (The laptop loses internet while joined —
   this script needs none.)
3. Needs Node 18+. Check: `node --version`. If missing:
   `winget install -e --id OpenJS.NodeJS.LTS`

## Use

```sh
cd ~/workspace/stadium-slugger-cage/gopro   # or wherever this lives on the laptop
node gopro.mjs status   # verify connection, see camera state
node gopro.mjs start    # start recording
node gopro.mjs stop     # stop recording
node gopro.mjs cage     # EXPERIMENTAL: try 1080p+120fps, then verify on screen
node gopro.mjs probe    # raw status dump (for mapping setting IDs)
```

If the camera ever uses an address other than `10.5.5.9`:
`GOPRO_IP=172.20.10.3 node gopro.mjs status` (Windows PowerShell:
`$env:GOPRO_IP='172.20.10.3'; node gopro.mjs status`).

## Cage-night flow

1. Set on the camera once: **1080p | 120fps | Linear | HyperSmooth Off**.
2. Mount, frame the shot, join WiFi from the laptop.
3. `node gopro.mjs start` when the round begins, `stop` when it ends.
   One file per round, zero tripod bumps.

## ID calibration (5 minutes, do once)

The resolution/fps remote codes are legacy guesses and the lens/stabilization
codes are unknown on HERO8. To lock them in:

1. On the camera, set a known state (e.g. 1080p/120/Linear/HyperSmooth Off).
2. Run `node gopro.mjs probe > probe-linear.txt`.
3. Change one thing (e.g. lens → Wide), run `node gopro.mjs probe > probe-wide.txt`.
4. Send both files to Snoop — the differing setting ID is the lens code.

## Honesty notes

- `status`/`start`/`stop` use the universal shutter/mode/status endpoints —
  solid on every HERO5+.
- `cage` attempts legacy setting IDs and **always reads back**; the camera
  screen is ground truth. If the screen disagrees, set it manually.
- Never tested against real hardware yet (built 2026-09-19, no camera on
  this network). First run is `status` — if that prints JSON, we're live.
