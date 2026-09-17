# Stadium Slugger — Cage Edition

**Tagline: "All you need is WiFi & a cage."**

Turn any batting cage into a HitTrax-class experience with hardware the customer
already owns: a smartphone on a tripod + any TV on the same WiFi. No sensors,
no $20,000 box.

This directory holds the **new** Cage Edition code. The Windows desktop app at
`~/workspace/stadium_slugger/` is untouched and ships as-is.

## Build order (user-approved)

1. **Camera calibration wizard** ← you are here (`calibration-wizard/`)
2. Phone/cast architecture spike (on-device tracking + TV receiver) — queued
3. Packaging, Field of Dreams park, pricing/licensing — queued

## What's here

| Path | What |
|---|---|
| `calibration-wizard/` | Working wizard prototype (runs in a phone browser) |
| `DESIGN.md` | Calibration math, profile format, step-2 handoff contract |

## Run the wizard prototype

No build step. No dependencies. Serve the folder over HTTP (getUserMedia requires
a secure context — `localhost` counts):

```bash
cd ~/workspace/stadium-slugger-cage/calibration-wizard
npx -y serve -l 8123
```

Then open `http://localhost:8123/` — on your phone, use your computer's LAN
address (e.g. `http://192.168.1.42:8123/`), same WiFi.

**No camera? No cage?** Use the **🧪 Demo cage** button on step 2. It renders a
synthetic cage from a virtual camera with known ground truth, so you can click
through the entire wizard — tap points, solve, height, verify — as a full
self-test of the math.

## Run the math self-test

```bash
cd ~/workspace/stadium-slugger-cage/calibration-wizard
node test-math.mjs   # 19 checks: synthetic-camera DLT recovery, fail-closed paths, profile round-trip
```

## Product contract (non-negotiable)

- **Fail-closed everywhere.** Thin evidence → "Insufficient evidence", never a guess.
- Every number stays labeled **"uncalibrated estimate"** until calibration is verified.
- **Lightweight:** the wizard is dependency-free vanilla JS (~50 KB total).
  The tracking stage must run MediaPipe-class lite models on-device, offline —
  WiFi is for casting, not tracking.
- No accuracy claims vs HitTrax/Rapsodo until side-by-side validation exists.
