# GoPro bridge — laptop server for the Cage Edition session app

The phone's browser can't talk to the GoPro directly: the camera hosts its own
WiFi network and the phone can only join one WiFi at a time. `bridge.mjs` runs
on the **laptop** and does two jobs:

1. **Serves the session app itself** — the phone loads the Cage Edition from
   the laptop over the camera's WiFi (no internet needed once loaded).
2. **GoPro JSON API** — start/stop recording and status, which the app's GoPro
   panel uses (the panel only appears when the bridge is reachable; without a
   bridge the app behaves exactly as before).

## Setup (cage session)

1. **Laptop:** join the GoPro's WiFi network.
   (Camera: swipe down → Preferences → Connections → Camera Info for the
   network name and password.)
2. **Laptop:** run the bridge (needs Node 18+):
   ```
   cd gopro
   node bridge.mjs
   ```
   It prints URLs like `http://10.5.5.101:8090/` — that's the address for step 4.
3. **Phone:** join the **same** GoPro WiFi network.
   (The phone loses internet while on it — that's fine, the app comes from the laptop.)
4. **Phone:** open the printed URL in the browser → the session app loads with
   a GoPro panel (⏺ Start / ⏹ Stop + status dot).
5. Run the session normally. Mark Swing still logs swings; the GoPro buttons
   are separate so the camera only rolls when you say so.

## Rules of the road

- **One controller at a time.** If the Quik app is also connected, don't fight
  it for the shutter — close Quik or leave its record button alone.
- The panel's "RECORDING" state is tracked by the bridge from start/stop
  presses **through the bridge**. The camera screen is ground truth.
- If the camera isn't reachable, the panel shows red and the buttons disable —
  nothing crashes, nothing is retried in a loop.
- The bridge serves with `no-store` caching so the phone never runs a stale
  build from cache. The page footer still shows the build tag — both devices
  should match.

## API

- `GET  /api/health` — `{ ok, bridge:'gopro-bridge', version, goproIp }`
- `GET  /api/gopro/status` — `{ ok, cameraReachable, bridgeRecording, raw? }`
  (`raw` is the camera's untouched `/gp/gpControl/status` for inspection.)
- `POST /api/gopro/start` / `POST /api/gopro/stop` — shutter control.

Env overrides: `GOPRO_IP` (default `10.5.5.9`), `PORT` (default `8090`).

## Files

- `bridge.mjs` — the server (zero dependencies).
- `gopro.mjs` — the standalone CLI (status/start/stop/cage/probe); still works
  on its own from the laptop on the GoPro WiFi.
- `../session/gopro-bridge.js` — the in-app client; inert without a bridge.
