# Stadium Slugger Cage Edition — Next Steps Roadmap

**Status:** Laptop-side phone calibration (build `z`) is code-complete but UNPROVEN on the
real phone feed. This roadmap starts the morning after calibration is proven working.
Written 2026-09-18. No Python. Imperial UI, metric math. Fail closed.

**How to read this:** Steps are in priority order. P0 items are things that are
*broken right now* — the session page cannot log a single real swing until they are
fixed. Everything else builds on a working pipeline.

---

## P0 — The swing pipeline is dead on arrival (fix before anything else)

Three independent bugs, each one alone enough to make the session page useless.
All three were found by reading `session.js` on 2026-9-18; none require research,
just fixes.

### P0-1. `COOLDOWN_MS` is undefined — first swing throws

**What/why:** `onSwingDetected()` (session.js:373) does
`swingCooldownUntil = now + COOLDOWN_MS`, but `COOLDOWN_MS` is never declared
anywhere. Strict mode → `ReferenceError` on the very first detected swing.
The counter increments, the beep fires, then the function dies before
`captureSwingClip` and before the swing entry is created. The swing pipeline
has never successfully run once.

**Exists in code:** `var swingCooldownUntil = 0` (session.js:119) is declared;
the constant it is added to is not. A static scan of session.js confirms
`COOLDOWN_MS` is the only undeclared functional identifier.

**Fix:** One line near the other tuning constants (session.js ~line 200):
```js
var COOLDOWN_MS = 2500; // min ms between logged swings
```
2.5 s is right: a swing + follow-through + reset takes ~2 s; shorter risks
double-logging one swing, longer risks swallowing rapid-fire BP swings.
Make it a `SENS_LEVELS`-adjacent constant so it is tunable, not magic.

**Prove it:** Trigger the motion detector (wave a bat through the ROI) and
confirm: swing count increments, no console error, swing card appears in the
log, cooldown suppresses a second immediate trigger. Check the browser console
— before the fix it shows `ReferenceError: COOLDOWN_MS is not defined`.

**Failure mode:** None — this is a pure bug fix. If the ReferenceError
persists, the script did not reload (check the footer build tag).

### P0-2. `window.SessionApp` overwrite wipes the phone calibration

**What/why:** calib.js carefully stashes the solved homography at
`window.SessionApp.phoneCalibration` (calib.js:174, 209, 574 — with
`window.SessionApp = window.SessionApp || {}` guards). Then session.js:699
executes `window.SessionApp = { onRemoteStream: ..., loadProfile: ... }`,
**replacing the whole object** and destroying `phoneCalibration`.
`imageToWorld()` keeps using the hardcoded 2026-9-17 laptop-chair PROFILE.
Every number the session page computes is for the wrong camera, silently.

**Exists in code:** Script load order in index.html is
calibration.js → mqtt.js → cast.js → calib.js → session.js, so session.js
always wins the overwrite. `cast.js` only *reads*
`window.SessionApp.onRemoteStream`, so it is unaffected by a merge.

**Fix:** In session.js, replace the assignment with a merge:
```js
window.SessionApp = window.SessionApp || {};
window.SessionApp.onRemoteStream = function (stream) { ... };
window.SessionApp.loadProfile = function (p) { ... };
```
Then make the metrics pipeline consume it. `imageToWorld()` and
`analyzeSwing()` currently read the module-level `PROFILE` const. Add at the
top of `imageToWorld`:
```js
var cal = (window.SessionApp && window.SessionApp.phoneCalibration) || null;
var H = cal && cal.H ? cal.H : PROFILE.homography.imageToGround;
var cam = cal && cal.camera ? cal.camera : PROFILE.camera;
```
The `cal.camera` needs `{ distanceBehindPlateM, sideOffsetM, heightM }` —
calib.js must store these when solving (it has them from the tap flow;
the "Use last position" preset already carries a `camera` block).
Surface which calibration is live in `profileInfoEl`: label +
`solved-vs-preset-vs-auto` + `verified` flag, so a stale-chair homography
can never masquerade as a phone calibration again.

**Prove it:** Apply the "Use last position" preset (or a tap solve), then
check the session panel's profile line reads the phone calibration label,
not "calibrated (verified=true)". Tap a known ground point via the
ball-on-ground flow (Step 1) — measured position must move when you
re-calibrate, proving the live homography is the phone's.

**Failure mode:** If calib.js has not run yet, `phoneCalibration` is absent
and the code falls back to the embedded PROFILE — which is the *wrong
camera*. The profile line must say so loudly ("FALLBACK: laptop-chair
profile, numbers are wrong for the phone"). Never silently fall back.

### P0-3. Ball detector can never fire — rewrite `detectBallTrail`

**What/why:** `detectBallTrail` (session.js:331) scores each candidate pixel
as `score = motion * (bright/255)` where `motion` is the sum of 3 channel
abs-diffs for a *single pixel* (max 255*3 = 765) and requires
`bestScore > 900`. 765 < 900 always. The gate is mathematically impossible:
every swing logs "no track," forever, no matter how good the video is.

**Exists in code:** The 12-frame capture (`trackBall`, session.js:308),
the search region (upper 2/3, step 4), and the quality gates (≥5 points,
≥8 px displacement, must move up) are all reasonable scaffolding. Only the
per-pixel scoring and the threshold are broken. The trail → `analyzeSwing`
path is intact downstream.

**Research (done):** Per-pixel brightness-maximum search is the wrong
primitive for a small fast ball — it finds the brightest *static* thing
(a window, a light) whenever motion is small. The robust classical
approach, confirmed across the literature (three-frame differencing,
e.g. scialert.net/itj.2014.1863.1867; connected-component labeling
two-pass, e.g. the METU thesis §3.4.1.3), is:

1. **Three-frame differencing:** `D = |F(k)-F(k-1)| AND |F(k+1)-F(k)|`,
   thresholded on luma. The AND kills "ghost" fringes that two-frame
   differencing leaves (the ball's old position in frame k-1 and new
   position in k+1 don't overlap; only the true position at k survives
   both differences).
2. **Connected-component labeling** (two-pass with union-find) on the
   binary motion mask → blobs with centroid, pixel count, bounding box.
3. **Ball filter:** keep blobs with 8–400 px area (at 320×180 proc
   resolution a baseball at 10–25 ft is roughly 6–20 px across),
   aspect ratio 0.5–2.0 (round, not a streak), mean brightness > 140
   (white ball vs darker cage), and centroid inside the outfield half.
4. **Track:** nearest-neighbor link across frames with a max jump
   (~40 px/frame at 30 fps covers 120 mph), keep the longest
   consistent-velocity chain ≥ 5 frames.

This runs on the existing 320×180 proc canvas (not full-res) — ~57k
pixels, two-pass CCL is microseconds. No library, no model, no Python.

**Implementation:** Replace `detectBallTrail(frames, W, H)` internals;
keep the signature and the downstream quality gates. New constants:
```js
var BALL_DIFF_THRESH = 25;      // luma diff to count as motion
var BALL_MIN_AREA = 8, BALL_MAX_AREA = 400; // px at 320x180
var BALL_MIN_BRIGHT = 140;
var BALL_MAX_JUMP_PX = 40;      // per frame at 30fps
```
Note the existing `bright < 150` prefilter and `motion` weighting get
deleted, not tuned — the primitive itself was wrong.

**Prove it:** Roll (don't hit) a ball across the cage floor through the
camera view. The detector must return a trail whose centroids track the
ball left-to-right. Then a soft toss: trail must follow the arc. Log the
per-frame blob count — if it is > 20/frame the mask threshold is too low.

**Failure modes:** Netting flutter creates motion blobs (area filter
rejects most; the aspect filter gets the rest). A white shoe / shirt can
pass the brightness gate — the velocity-consistency chain (≥5 frames,
same direction) is what kills those. Direct sun through the garage door
blows out the luma diff — the exposure-shift `biasRatio` gate from the
motion detector should be shared here.

---

## Step 1. Ball-on-ground verification flow (prove the homography end-to-end)

**What/why:** Tap calibration solves a homography from tapped points, but
nothing has ever checked that the solved matrix maps a *new, unseen* point
correctly. This is the end-to-end proof that the numbers mean anything.

**Exists in code:** calib.js has the full tap/solve/apply flow and
`CageCalibration.solveHomography` / `applyH` in
calibration-wizard/calibration.js. The 2026-9-17 wizard had a verification
screen (ball at known (3 ft, 3 ft) → measured (2.85 ft, 2.95 ft), 2.0 in
error) — that flow did not survive the move to the session page.

**Research (done):** The method is standard photogrammetry practice:
hold out verification points from the solve, then measure reprojection
error on the held-out points. Nothing to invent. The one domain trap,
already learned 2026-9-17: the homography maps the *ground plane* — a ball
on a tee 2.5 ft up reads ~10 ft off even with a perfect calibration.
Verification must use a ball **on the ground**, or the tap point must be
the ground directly below the ball.

**Implementation:** Add a "Verify" mode to the calib panel (after Apply):
1. Prompt: "Place a ball on the ground at a KNOWN spot (e.g. plate apex)
   — or tap any visible ground point whose position you know."
2. User taps the ball in the video → `applyH(H, u, v)` → meters → feet/inches.
3. Show: measured (x, y) in ft/in vs the known position, error in inches.
4. Pass bar: ≤ 6 in (same bar the 2026-9-17 profile passed at 2.0 in).
5. Hold-out variant (stronger): during tap calibration, solve on N−2
   points and verify on the 2 held out; report both errors. This catches
   a mistapped reference point, which a same-point check cannot.

**Prove it:** Ball on the plate apex (known (0,0) by construction):
measured error ≤ 6 in. Then ball at door-edge @ 10.25 ft: error ≤ 6 in.
Two points, two distances — a tilted or shifted homography cannot pass
both by luck.

**Failure modes:** Teed ball (parallax — warn in the UI, refuse to pass a
teed verification). Tapping the ball's *top* instead of its ground
contact point (a 3-in ball at glancing angle shifts the tap ~1–2 in;
acceptable inside the 6-in bar). User mis-measuring the "known" spot —
use the plate apex and door edges, which are defined by construction.

## Step 2. Manual "Mark Swing" button (ground truth for everything)

**What/why:** The motion detector's thresholds (Calm/Normal/Sensitive)
were tuned against eight *simulated* scenarios, never a real swing. Without
labeled ground truth — "a swing happened at 14:32:05" — every detector
tweak is guessing. A manual mark button creates the label stream that all
later tuning depends on.

**Exists in code:** `onSwingDetected()` is the single funnel for
auto-detections (session.js:365). The swing log (`state.swings`,
`renderSwing`) already renders cards with delete buttons. `beep()` exists.

**Implementation:** Add a "Mark Swing" button next to Start/Stop. On click:
```js
function markSwingManual() {
  var now = Date.now();
  // Bypass the motion detector entirely; reuse the pipeline.
  state.swingCount++;
  var entry = { id: state.swingCount, time: new Date().toISOString(),
                sessionTimeSec: (now - state.sessionStart)/1000,
                manual: true };
  beep(880, 150);
  captureSwingClip(state.swingCount); // with pre-roll once Step 4 lands
  trackBall().then(function (trail) { /* same as onSwingDetected */ });
  // Log detector state at mark time for later comparison:
  entry.detector = { consecHot: consecHot, armed: armed,
                     hotFrac: lastHotFrac, motionLevel: motionLevel };
}
```
Refactor `onSwingDetected` to call a shared `logSwing({manual:false})`
so auto and manual entries differ only in the `manual` flag and the card
shows "MANUAL" vs "AUTO". Store `lastHotFrac` in the motion loop (it is
currently discarded after the meter update).

**Prove it:** Take 10 real swings, marking each manually. The log shows 10
MANUAL cards with timestamps. Then compare: how many did the auto-detector
also catch within ±1.5 s? That ratio is the detector's measured recall —
the first honest number this project has ever had for the detector.

**Failure modes:** The user marks late (reaction time ~0.3 s — fine for
recall measurement, and the pre-roll buffer in Step 4 absorbs it). Double
marks — the cooldown (P0-1) dedups.

## Step 3. Pre-roll / post-roll ring buffer (stop missing the swing)

**What/why:** `captureSwingClip` starts the MediaRecorder *at* the trigger —
the swing itself (the 150 ms that matter) is already over. Every clip starts
mid-follow-through. Analysis and the user's own review need ~1.5 s before
and ~2 s after.

**Exists in code:** `captureSwingClip` (session.js:622): 3 s MediaRecorder
on `state.stream`, auto-download + in-page player. `clip-toggle` gates it.

**Research (done):** MediaRecorder has no pre-roll API. Two workable
browser-native designs:
- **(A) Continuous recorder + chunk ring (recommended).** Call
  `recorder.start(500)` (500 ms timeslices) for the whole session, keep
  the last ~8 chunks (≈4 s) in a ring array, on trigger keep recording
  2 s more, then `new Blob(ringChunks)` — chunks from one continuous
  recorder share the EBML header and concatenate into a playable WebM.
  Memory: 4 Mbps × 4 s ≈ 2 MB. CPU: one always-on encoder — Chrome
  handles this fine; it is what dashcam-style web apps do.
- **(B) Canvas frame ring + re-encode.** drawImage the video to canvas
  at 15 fps into a ring of ImageData, on trigger `canvas.captureStream()`
  + MediaRecorder over the ring + live tail. More code, generation loss,
  higher memory. Only if (A) proves unplayable.

Caveat for (A): the blob must start at a keyframe or the first ~second
shows garbage. Mitigation: `recorder.start(500)` with
`videoBitsPerSecond: 4_000_000` — Chrome emits keyframes at chunk
boundaries often enough in practice; verify empirically (Step 10's
playability check covers this).

**Implementation:** Replace `captureSwingClip` with:
```js
var clipRing = [];       // Blobs, oldest first
var CLIP_PREROLL_CHUNKS = 6;   // 3 s at 500 ms timeslices
var CLIP_POSTROLL_MS = 2000;
var sessionRecorder = null;
function startClipRing() {
  sessionRecorder = new MediaRecorder(state.stream,
    { mimeType: pickSupportedMime(), videoBitsPerSecond: 4e6 });
  sessionRecorder.ondataavailable = function (e) {
    if (e.data && e.data.size) {
      clipRing.push(e.data);
      while (clipRing.length > CLIP_PREROLL_CHUNKS + 8) clipRing.shift();
    }
  };
  sessionRecorder.start(500);
}
function captureSwingClip(swingId) {
  if (!clipToggle.checked || !sessionRecorder) return;
  var chunks = clipRing.slice();          // pre-roll, already encoded
  var tail = [];
  var tailRec = new MediaRecorder(state.stream, { mimeType: pickSupportedMime() });
  // Simpler: just extend the ring — keep the session recorder running and
  // snapshot the ring again after post-roll:
  setTimeout(function () {
    var full = clipRing.slice(0, chunks.length + 4); // +2 s post-roll
    var blob = new Blob(full, { type: "video/webm" });
    swingClips.push({ id: swingId, blob: blob });
    attachClipPlayer(swingId, blob);
  }, CLIP_POSTROLL_MS);
}
```
Start `startClipRing()` in `startSession`, stop it in `stopSession`.
Guard: if `state.stream` changes (camera switch), restart the ring —
chunks from two encoders do NOT concatenate.

**Prove it:** Mark a swing manually, open the clip: the bat must be
visible *before* contact (backswing at clip start), ball flight after.
Frame-step the first 0.5 s — if it is blocky/garbage, the keyframe
caveat bit and the timeslice needs shortening to 250 ms.

**Failure modes:** Concatenated blob unplayable in some players (VLC is
lenient, QuickTime is not — test both; Step 10). Ring restart on track
change — forgetting this yields a corrupt clip with two headers.
Memory growth if `clipRing` is not bounded (it is: the while-shift).

## Step 4. Motion-triggered ball search window (stop scanning the whole frame)

**What/why:** Once the ball detector works (P0-3), it still scans the full
upper 2/3 of the frame every swing. The swing ROI already tells us *where*
the motion was. Seeding the ball search from the motion centroid cuts
false positives (windows, lights) and halves the compute.

**Exists in code:** `frameMotion()` returns only `{hotFrac, biasRatio}` —
the spatial information is discarded. `SWING_ROI` bounds the motion
region. `detectBallTrail` searches `x: 15–85%, y: 8–65%`.

**Implementation:** In `frameMotion()`, also accumulate the centroid of
hot pixels (`hotSumX, hotSumY, hotCount`) and return
`{hotFrac, biasRatio, hotX, hotY}` in ROI-normalized coords. Store the
centroid at trigger time (`triggerX, triggerY`). In `detectBallTrail`,
center the search on the trigger centroid ±25% of frame dimensions
instead of the fixed upper-2/3 box, and bias the first-frame blob pick
toward blobs near the centroid. Fall back to the full region if the
centroid is stale (> 5 s old — the ball is long gone, something else
moved).

**Prove it:** Same soft-toss test as P0-3, but with a bright static
distractor in frame (phone screen, window). Before: false lock on the
distractor sometimes. After: first-frame pick is within 60 px of the
motion centroid on ≥ 8/10 tosses.

**Failure modes:** Two rapid motions (batter + ball) pull the centroid
between them — the ±25% window is wide enough to contain both. A
walk-through just before a swing leaves a stale centroid — the 5 s
staleness fallback handles it.

## Step 5. Exit velocity: multi-frame fit, validated (never estimated)

**What/why:** `analyzeSwing` does a linear least-squares fit on 3D points
that assume *every* ball position is at 3 ft height. A grounder at 1 ft and
a fly at 8 ft get the same depth correction — the horizontal speed inherits
that parallax error directly. And no measured EV has ever been compared to
truth.

**Exists in code:** `analyzeSwing` (session.js:380): linear fit for
(vx, vy), vz from image-plane vertical motion scaled by `heightScale`,
sanity gates 25–130 mph, "Insufficient evidence" fail-closed paths.
`heightScale.pxPerM = 177.85` (mean of two 2026-9-17 samples).

**Research (done):** With one camera and a ground homography, the honest
model is: each detection gives a *ray* (camera center → image point);
the ball's 3D position is the point on the ray at the ball's true height,
which is unknown per-frame. Two practical estimators:
- **(A) Ballistic fit (recommended).** Fit the image-plane trail to a
  projectile model: parametrize 3D position as
  `p(t) = p0 + v0*t + 0.5*g*t²` (g = −9.81 z), project each `p(t_i)`
  through the camera model to predicted `(u_i, v_i)`, and solve for
  `(p0, v0)` by Gauss-Newton minimizing reprojection error. This uses
  *all* frames jointly, needs no per-frame height assumption, and the
  residual directly reports fit quality. 6 unknowns, 2×N equations —
  well-conditioned for N ≥ 5.
- **(B) Keep the linear 3D fit but iterate the height.** Current code,
  but replace the fixed 3 ft with: fit → estimate z(t) from vz →
  re-project at the new heights → refit, 3 iterations. Cheaper, less
  principled, keeps the existing code shape.

The camera model for (A): the phone's intrinsics are unknown, but the
ground homography plus camera height gives a usable projective model —
`imageToWorld(u,v,z)` already inverts it (ray-plane intersection), so
the forward projection is `worldToImage`: intersect ray (C→W) with the
image plane… which needs intrinsics. Pragmatic substitute: use the
*inverse* direction — for a candidate 3D point, compute its ground-plane
projection `applyH(H,u,v)` forward? No — `applyH` goes image→ground.
The workable trick: parametrize in *image space + depth*: fit
`(u(t), v(t))` as quadratics in t (ballistic motion projects to
near-quadratic curves for short tracks), differentiate at t=0 for
`(du/dt, dv/dt)` px/s, then convert with the local Jacobian of the
homography at the contact point (∂x/∂u, ∂y/∂u, … — finite differences
of `applyH`) plus the height-scale for z. This is (B)-plus: no new
camera model, uses what exists.

**Implementation:** Replace the vx/vy linear fit with quadratic fits
`u(t) = a_u t² + b_u t + c_u` (same for v), evaluate derivatives at the
first post-contact frame, convert via the homography Jacobian at
`(u0,v0)` and `pxPerM_local` (already computed) for z. Report the fit
RMSE in px; gate: RMSE > 4 px → "Insufficient evidence" (the old
`meanPx <= 6` bar, tightened because the model now has more parameters).
Keep the 25–130 mph plausibility gate and the "never estimate" contract:
any gate failure → `tracked:false` with the reason, exactly as today.

**Prove it:** This needs truth data. Cheapest honest source: hit off a
tee with a radar (a borrowed Pocket Radar / PRGR — the user may know
someone; the 14U team world surely has one). 10 swings, compare
session EV vs radar EV. Pass bar: mean absolute error ≤ 3 mph and no
single swing off by > 6 mph. Without radar access: throw a ball at a
known speed? — no, that is not credible truth. Radar or it stays
"uncalibrated estimate."

**Failure modes:** Motion blur at 30 fps smears the ball over ~30–60 px
at 90 mph — centroid error dominates; the quadratic fit absorbs some of
it, the RMSE gate catches the rest. Rolling shutter on the phone skews
fast horizontal motion (Z Fold6 reads out top-to-bottom; a ball moving
+x tilts) — unmodeled, shows up as systematic spray-angle bias; check
spray vs known pull/oppo. Short tracks (< 6 frames) under-constrain the
quadratic — fall back to linear, widen the gate, label it.

## Step 6. Launch angle from the trajectory (not the image plane)

**What/why:** Current LA comes from `vz` estimated via image-plane
vertical pixel motion scaled by a single `pxPerM` — but vertical in the
image is not vertical in the world when the camera looks down at an
angle, and `pxPerM` was measured at one depth. A 25° LA reading could
easily be 18° or 32°.

**Exists in code:** `analyzeSwing` computes `vz = (dvPx/pxPerM_local)/dt`
with a depth correction `distCalib/distBall` (session.js:410-416).
`launchAngleDeg = atan2(vz, vHoriz)`.

**Implementation:** Do it after Step 5's quadratic fit: the fit gives
`(du/dt, dv/dt)` in px/s at contact. Convert properly:
- Horizontal: Jacobian of `applyH` at contact → `(dx/dt, dy/dt)` in m/s.
- Vertical: the camera looks down at the contact point. The image-plane
  vertical *perpendicular to the ground-plane-projected motion* carries
  the z information. Decompose `(du/dt, dv/dt)` into components parallel
  and perpendicular to the ground-projected velocity direction; the
  perpendicular component, scaled by `pxPerM_local` measured *at the
  contact depth*, is `dz/dt`. (Parallel-component contamination from
  perspective is second-order for the ~10° downward camera tilt here.)
- `LA = atan2(dz/dt, hypot(dx/dt, dy/dt))`.
Gate: if the perpendicular component is within the centroid noise floor
(±1.5 px/frame), report LA as "Insufficient evidence" rather than ~0° —
a worm-burner and a mis-track look identical otherwise.

**Prove it:** Same radar session as Step 5 (most radars report LA now;
Rapsodo/HitTrax definitely do). 10 swings, |LA_session − LA_truth| mean
≤ 4°. Plus a physical sanity: hit grounders intentionally — session must
report negative-to-low LA, not 15°.

**Failure modes:** The decomposition assumes the camera tilt is small;
if the phone ends up mounted looking steeply down, the parallel/perp
split breaks — the auto-adjust delta (Step 8's shift magnitude) is the
canary: large mount changes → re-verify LA. Backspin lift curves the
trajectory within the 12-frame window — the quadratic fit's `a_v` term
absorbs it; report it, don't fight it.

## Step 7. Remote stream forensics: resolution, fps, latency (getStats)

**What/why:** Everything downstream assumes ~1280×720 @ 30 fps. The phone
*requests* 1280×720 ideal; WebRTC negotiates what it wants. If the actual
feed is 640×480 @ 15 fps, the motion thresholds, ball area gates, and
`trackBall`'s 30 fps timing assumption are all wrong — silently.

**Exists in code:** cast.js:165 already polls `getStats()` every 2 s in the
health box but only reads `bytesReceived/bytesSent`. The video element
exposes `videoWidth/videoHeight` once metadata loads.

**Implementation:** Extend the stats poll (cast.js `updateHealthBox`):
```js
st.forEach(function (r) {
  if (r.type === "inbound-rtp" && r.kind === "video") {
    // r.frameWidth, r.frameHeight, r.framesPerSecond,
    // r.framesReceived, r.framesDropped, r.jitter
  }
});
```
Show `1280×720 @ 29.7 fps (dropped 0.2%)` in the health box. Also compute
end-to-end latency: phone stamps `performance.now()` into a canvas
overlay? — simpler: measure `r.jitter` + round-trip via the MQTT
ping the pairing already does. Log a one-line stream fingerprint at
session start into the swing-log JSON (`downloadSession`): resolution,
fps, dropped-frame %, so every later number is traceable to the feed
that produced it.

**Prove it:** Pair the phone, read the health box: it shows measured
(not requested) resolution and fps. Start a session, download the JSON:
the fingerprint block is present and matches the health box.

**Failure modes:** `framesPerSecond` is a rolling average — sample it
over 10 s, not one poll. Some browsers omit `frameWidth` on inbound-rtp;
fall back to `video.videoWidth/videoHeight`. If the phone thermal-
throttles (Z Fold6, summer garage), fps sags mid-session — the
fingerprint at start won't catch it; re-sample at session end and flag
> 10% drift.

## Step 8. Auto-adjust threshold tuning from real session data

**What/why:** The auto-adjust gates (peak ≥ 0.75, margin ≥ 1.15, shift <
150 px, scale 0.85–1.18×, reproj ≤ 6 px) are principled guesses from the
literature, explicitly unmeasured. Wrong thresholds fail in exactly the
two bad ways: rejecting good matches (user re-taps, feature is useless)
or accepting bad ones (wrong numbers, worse than useless).

**Exists in code:** calib.js `doAutoAdjust` (the gates), `nccMatch`
(peak/margin), profile save/load with `refPatches`.

**Implementation:** Add instrumentation first, tuning second:
1. In `doAutoAdjust`, log per-point `{id, peak, margin, kept}` and the
   gate outcomes into `window.SessionApp.autoAdjustLog` (array, capped
   at 20 entries), and offer "Download auto-adjust log" next to the
   profile save. No thresholds change yet.
2. Collect 5+ real sessions (different days/lighting). For each,
   record: did auto-adjust pass, and was the resulting homography right
   (ball-on-ground check, Step 1)?
3. Tune: plot peak/margin histograms of kept-vs-rejected points; move
   thresholds to the valley between the modes. The 150 px shift cap:
   measure actual remount shifts — if they cluster at 20–60 px, tighten
   to 100; if legitimate remounts hit 130, keep 150.
4. Only then change the constants, with the data file committed next
   to the code (`session/autoadjust-thresholds.md` with the histograms
   described, not the raw images).

**Prove it:** 5 consecutive sessions where auto-adjust passes AND the
ball-on-ground error stays ≤ 6 in, with zero manual re-taps. That is the
"calibrate once" promise kept.

**Failure modes:** Tuning to one garage's lighting (overfitting) — the
gates must stay conservative; when in doubt keep the stricter value.
Seasonal light change (winter low sun through the door) invalidates the
histograms — re-run the 5-session protocol when the light regime
changes, calendar-remind in November.

## Step 9. Android tab lifecycle — honest states, not silent death

**What/why:** The phone is the broadcaster. Chrome on Android freezes or
kills background tabs (5-minute background kill is documented behavior),
and a killed tab ends the WebRTC stream with no callback that says why.
Today the laptop just shows a frozen frame and the user has to guess.

**Exists in code:** cast.js requests a wake lock on broadcast start
(:254, :699) — good while the tab is foreground. The health box shows
`track:live/muted`. MQTT pairing can re-pair automatically (PIN
remembered). No `visibilitychange` handling, no track-ended UI.

**Research (done):** Wake lock only works in the foreground; it does not
survive the user switching apps or the screen being forced off by device
policy. `document.visibilitychange` → `hidden` on the phone is the early
warning. On the laptop, `track.onmute` / `pc.onconnectionstatechange →
"disconnected"/"failed"` are the signals. Chrome Android *will* stop the
camera track when the tab is backgrounded — the track fires `mute`, and
if the tab is killed, ICE goes to `disconnected`.

**Implementation:**
- Phone (broadcast side, cast.js): on `visibilitychange → hidden`,
  `setStatus("Tab hidden — stream will freeze. Keep this tab open.")`
  and try to keep the wake lock; on `visible` again, check
  `track.readyState` — if `ended`, show "Camera was killed by the OS.
  Tap Broadcast again to restart." in 48-pt text (the phone is mounted;
  the user reads it from feet away).
- Laptop (watch side): on `track.onmute` or ICE `disconnected` > 5 s,
  replace the video area banner with "PHONE STREAM LOST — check the
  phone tab" and stop the motion loop from logging phantom swings
  (`state.recording` stays true but `armed=false` until the track
  unmutes; log the gap in the session JSON as `streamGaps: [...]`).
- Re-pair path already exists (PIN remembered) — wire the laptop banner
  with a "Re-pair" button that re-runs `watchPinFlow` without a refresh.

**Prove it:** With the stream live, switch the phone to another app for
30 s, then back. Expected: laptop banner appears within ~5 s of muting,
clears on return, session JSON logs one gap, no phantom swings logged
during the gap. Then kill the phone tab entirely: laptop shows the
re-pair banner; tap it; stream resumes without touching the mount.

**Failure modes:** Some Android skins kill the tab without firing
`mute` first — the ICE-timeout path is the backstop. Doze mode can
delay MQTT re-pair messages by minutes — the manual QR fallback stays
available. Battery: an hour of broadcast + screen-on wake lock on a
Z Fold6 is ~25–35%; the 2%-battery incident (2026-9-17) says the
pre-session checklist must include "phone on charger."

## Step 10. Clip export that actually plays (MIME + keyframes)

**What/why:** `captureSwingClip` creates `new Blob(chunks, {type:
"video/webm"})` with no codec string, and `MediaRecorder` is constructed
with no `mimeType` — Chrome picks vp8/vp9/opus defaults that vary by
build. Some players (QuickTime, older VLC) refuse codec-less WebM. And
the pre-roll concatenation from Step 3 is only playable if chunk
boundaries align with keyframes.

**Exists in code:** `captureSwingClip` (session.js:622),
`attachClipPlayer` (auto-download + in-page `<video>`),
`downloadSession` (batch clip download).

**Implementation:**
```js
function pickSupportedMime() {
  var cands = ["video/webm;codecs=vp9", "video/webm;codecs=vp8",
               "video/webm", "video/mp4"];
  for (var i = 0; i < cands.length; i++)
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(cands[i]))
      return cands[i];
  return "";
}
```
Use it for every `new MediaRecorder(...)` and stamp the chosen string on
the Blob type and into the swing-log JSON (`clipMime`). For keyframes:
request them — `recorder.start(500)` timeslices already encourage
Chrome to place keyframes at slice starts; verify, don't assume (see
proof). In-page player test is not sufficient — Chrome plays anything.

**Prove it:** Take 3 clips, download, and play each in (a) the in-page
player, (b) VLC, (c) the user's Windows Photos / QuickTime — whichever
the user actually uses to review. All three play, first frame is not
garbage, duration ≈ 5 s (3 pre + 2 post). If any player chokes, the MIME
choice or the concatenation is wrong — the log says which MIME was
used, so it is debuggable.

**Failure modes:** `video/mp4` in Chrome's MediaRecorder is still
spotty (as of 2026 it exists on some builds, not all) — the candidate
list order prefers WebM for a reason. Concatenated pre-roll clips can
stutter at the seam in strict players — acceptable if the seam is in
pre-roll, not at contact; keep 0.5 s of post-trigger continuous
recording before any seam. iOS Safari cannot play WebM at all — note it
in the UI if the user ever reviews on an iPhone ("download plays in
Chrome/VLC").

## Step 11. Beep + detector end-to-end validation protocol

**What/why:** The beeps are the batter's only feedback (they cannot watch
the laptop mid-swing). `beep()` is wrapped in try/catch and the
AudioContext resume logic has never fired on a real swing — because no
real swing has ever gotten past P0-1. An unheard beep means the detector
is being tuned by a deaf user.

**Exists in code:** `beep(freq, durMs)` (session.js:437), the sound
toggle (btn-sound), `startSession` primes the AudioContext on the click
gesture, 880 Hz on trigger + 1320 Hz on track.

**Implementation:** No code change needed unless the test fails — this
step is a protocol:
1. Laptop speakers on, phone streaming, session live.
2. Clap loudly in the cage (no swing): no beep expected (motion only).
3. Swing and miss: one beep (880) expected within ~0.5 s of the swing.
4. Swing with ball flight: two beeps (880 then 1320) — the second only
   if the ball tracked.
5. Repeat 5×, log beep heard (y/n) and latency estimate.
Also verify the toggle: off → silent session; on → `beep(880,120)`
fires immediately (already wired as the toggle's self-test).

**Prove it:** 5/5 expected beeps heard at the plate position (not at the
laptop — the batter stands 6+ ft from the speakers). If any beep is
missed, check: AudioContext state (autoplay policy re-suspends after
~30 s idle in some builds — re-prime on every swing is the fix),
laptop volume, Bluetooth audio routing delay (adds 200+ ms — use wired
or laptop speakers).

**Failure modes:** Bluetooth speaker latency makes the beep useless as
timing feedback — document "use laptop speakers." Browser throttles the
AudioContext when the tab loses focus — the session tab must stay
foreground on the laptop too.

## Step 12. Height-scale integration for the phone calibration

**What/why:** `PROFILE.heightScale.pxPerM = 177.85` (mean of two 2026-9-17
samples) is baked into the laptop-chair profile and feeds the `vz`
computation. A phone calibration solved from taps has no height scale —
`analyzeSwing` silently uses the chair's number at the phone's depth.
That is a wrong constant wearing a right-looking label.

**Exists in code:** `window.SessionApp.loadProfile` already averages
`p.heightScale.samples` when a wizard profile is loaded (session.js:735).
The 2026-9-17 wizard measured height scale from two samples of a known-
height object. calib.js tap flow has no height step at all.

**Implementation:** Add an optional 8th reference step in the calib
panel: "Height: hold the 36-in bat vertically at the plate, tap its top
and bottom." Two taps → `pxPerM = batPx / 0.9144`, stored in the profile
as `heightScale: { pxPerM, measuredAt: {x,y}, samples: 1 }`, carried
through save/load/auto-adjust (it is mount-specific, so auto-adjust
must re-derive or scale it: scale by the median scale ratio from Step
8's gate — `pxPerM_new = pxPerM_old / medScale`). `analyzeSwing` uses
`cal.heightScale.pxPerM` when present, chair value never.

**Prove it:** Bat at plate: measured pxPerM within 5% of the 177.85
chair value (same camera distance class — it should be close). Then a
toss to ~6 ft height at known depth: `imageToWorld(u,v,z=1.83)` round-
trips within 4 in of the true apex (have someone hold the ball at a
marked height on the net).

**Failure modes:** Bat not vertical (perspective foreshortening
under-reads pxPerM — the UI must say "hold it plumb, like the tower
story"). Bat at the wrong depth — the depth correction in `analyzeSwing`
assumes the sample depth; record `measuredAt` and warn if the ball is
> 10 ft from it.

## Step 13. Full-session validation protocol (the gate to "cage-ready")

**What/why:** Every step above proves a component. Nobody has proven the
*system*: a real BP session, phone mounted, laptop watching, producing a
swing log the user trusts. This is the acceptance test for the whole
Cage Edition.

**Exists in code:** `downloadSession` exports the swing JSON; the log
already carries per-swing `tracked`/`reason`.

**Implementation (protocol, minimal code):** Add `streamGaps`,
`clipMime`, and calibration label to the exported JSON (Steps 7/9/10 —
three small additions to `downloadSession`). Then run:
1. 20-swing BP session, every swing manually marked (Step 2).
2. Scorecard: detector recall (auto marks within ±1.5 s of manual),
   false positives (auto with no manual within ±3 s), ball-track rate
   (tracked / manual swings), EV/LA vs radar on ≥ 5 swings (Steps 5/6).
3. Ship bars: recall ≥ 80%, false positives ≤ 2/session, track rate ≥
   60%, EV MAE ≤ 3 mph. Below any bar → the failing component's step
   reopens; the page keeps saying "uncalibrated estimate."

**Prove it:** The exported JSON + the scorecard, reviewed the same
night. Not a feeling — four numbers.

**Failure modes:** The user (rightly) will not run 20 marked swings
twice — get the instrumentation right *before* this session (Steps
2/7/9 log everything needed). Radar access is the long pole; line it up
before the session, not during.

---

## Deferred / conditional

- **opencv.js ECC auto-adjust v2** (from AUTO-RECALIB-RESEARCH.md): only
  if Step 8 shows NCC failing on lighting swings. 11 MB WASM lazy-load
  for a problem NCC may already solve — do not pay it upfront.
- **Pitch-start detector:** the motion ROI fires on the swing, but a
  "pitch incoming" trigger would enable earlier ball acquisition. No
  design yet; revisit after the swing pipeline is trusted.
- **Pose / swing-mechanics overlay:** explicitly out of scope until
  numbers are validated. Do not build coaching UI on unproven metrics.

---

## Build order (dependency-sorted)

```
P0-1 (COOLDOWN_MS) ─┐
P0-2 (SessionApp) ──┼─→ Step 2 (Mark Swing) ─→ Step 3 (pre-roll)
P0-3 (ball detect) ─┘         │
                              ├─→ Step 4 (search window) ─→ Step 5 (EV fit)
                              │                                     │
Step 1 (verify) ───────────────┘                                     ├─→ Step 6 (LA)
Step 7 (forensics) ─→ Step 10 (MIME)                                 │
Step 8 (thresholds, needs 5 sessions)                                │
Step 9 (lifecycle) ─→ Step 11 (beep protocol)                        │
Step 12 (height) ────────────────────────────────────────────────────┘
Step 13 (full validation — needs 2,5,6 + radar)
```

**Suggested batching for build nights:**
- Night A: P0-1 + P0-2 + P0-3 (the pipeline lives)
- Night B: Step 1 + Step 2 + Step 7 (proof + ground truth + forensics)
- Night C: Step 3 + Step 10 (clips that work)
- Night D: Step 4 + Step 5 (ball → EV)
- Night E: Step 6 + Step 12 (LA + height)
- Ongoing: Step 8 (5 sessions of data), Step 9 + Step 11 (any night)
- Finale: Step 13 (needs radar lined up)

**Honesty contract (unchanged):** every number the page shows is either
validated or labeled "uncalibrated estimate." Fail closed as
"Insufficient evidence." No number is better than a wrong number.
