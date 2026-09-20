# Cage Cast — TV display for the cage

Shows the session on the garage TV (e.g. Vizio via built-in Chromecast):
session state, swing count, and last-swing exit velo / launch angle in
big type readable from across the cage.

## How it works

- `receiver.html` — custom CAF receiver page. Host it on HTTPS (the session
  site on GitHub Pages qualifies). The TV loads this page when you cast.
- `cast-sender.js` — web sender module for the session app. It finds the TV,
  opens a session, and pushes `{session, swing, reset}` messages on the
  namespace `urn:x-cast:com.stadiumslugger.cage`.

The phone stays the brain; the TV is a dumb display. No video is cast —
just tiny JSON messages, so it works fine on the cage Wi-Fi.

## Setup (one time)

1. **Register the receiver.** Go to the Google Cast SDK Developer Console
   (cast.google.com/publish), add a new *Custom Receiver* application, and
   point its URL at the deployed receiver page:
   `https://ydittamore585-sudo.github.io/stadium-slugger-cage/cast/receiver.html`
   You get an **Application ID** (looks like `ABCD1234`).

2. **Put the App ID in the sender.** In the session page's `CageCast.init`
   call, set `appId` to the value from step 1.

3. **Deploy.** Push; GitHub Pages serves the receiver over HTTPS.

4. **Register the TV as a test device** (Developer Console → test devices)
   using the Vizio's Cast serial number, so the unpublished app launches.
   On the TV: Settings → System → Cast → serial shows there. Keep the app
   unpublished while testing; publish only if you ever share it.

5. **Same Wi-Fi.** Phone and TV must be on the same network.

## Testing

1. Open the session page in **Chrome** on the phone (the cast button relies
   on the Cast SDK; other Chromium browsers vary — if the TV never appears
   as a target, switch to Chrome).
2. Tap the 📺 Cast button, pick the Vizio.
3. The TV should show the cage display ("waiting" screen clears on connect).
4. Mark a swing / run a session — numbers appear on the TV within a second.

## Troubleshooting

- **TV not listed:** same Wi-Fi? TV's Cast serial registered as a test
  device? App ID correct in the sender?
- **Connects but stays on "waiting":** the receiver clears it on the first
  message or sender-connected event — check the phone console for
  `[CageCast]` errors.
- **Session drops when the phone sleeps:** keep the session page in the
  foreground during the cage session. (The receiver sets
  `disableIdleTimeout` so the TV side stays up.)

## Files

- `receiver.html` — TV dashboard (build tag in the footer)
- `cast-sender.js` — sender module (`CageCast.init/send/session/swing/reset`)
- `README.md` — this file
