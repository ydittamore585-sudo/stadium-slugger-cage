# Cage Edition — Calibration Design

## 1. What this is

The calibration wizard is step 1 of the Cage Edition build order and the
foundation everything else stands on. One 10-minute procedure per cage turns a
phone on a tripod into a measuring device:

> **image pixels (u, v) → cage/world position (x, y, z)**

### Units

**All measurements are imperial in the UI** — feet for distances, inches for
small errors (reprojection, verification miss). The math core
(`calibration.js`), internal state, and the saved profile JSON stay **metric
(meters)** — homography math, the tracking stage, and physics all speak SI.
The wizard converts at the UI boundary (1 ft = 0.3048 m exactly). The profile
schema pins `"units": "meters"` so the tracking stage never has to guess.

It does this by exploiting the one thing a cage gives us that a open field
doesn't: **fixed, known geometry**. The camera never moves; the cage dimensions
are measured once with a tape. That is the easy, reliable tracking case —
the opposite of a hand-held phone on a Little League bleacher.

Prototype: `calibration-wizard/` — dependency-free web app (phone browser),
math core in `calibration.js` (runs in node too; see `test-math.mjs`).

## 2. Physical setup & assumptions

- Phone on tripod, **fixed for the whole session**. Any bump = recalibrate.
- Camera looks at the cage from behind/around home plate (typical: 10–20 ft behind
  plate, 4–5 ft height, roughly centered, slight downward pitch).
- Cage floor is treated as a **plane**. (Turf with wrinkles or a sloped floor
  degrades accuracy; the reprojection error will show it.)
- The ball's relevant action happens near the ground plane and near the plate —
  the region the calibration weights most heavily.

Nothing here assumes a particular phone. Focal length is never needed: the
homography absorbs all intrinsics/extrinsics into one 3×3 matrix.

## 3. World coordinate frame

Matches the existing Stadium Slugger simulator convention exactly
(`groundPhysics.ts`, `FieldPointM`):

| Axis | Meaning | Units |
|---|---|---|
| origin | center of home plate, ground level | — |
| +x | toward the pitcher / outfield | meters |
| +y | lateral, toward **right** field | meters |
| +z | up | meters |

The tracking stage (step 2) already speaks this frame, so a calibrated
`(xM, yM)` drops straight into spray charts, landing zones, and distance.

## 4. The math

### 4.1 Ground-plane homography (the workhorse)

A plane-to-plane projective map `H` (3×3) with `[x, y, 1]ᵀ ∼ H · [u, v, 1]ᵀ`.
Solved from ≥ 4 tapped correspondences — known world points the user taps in
the camera view (plate corners, cage posts, distance markers).

- **Normalized DLT** (Hartley): both point sets translated/scaled to
  centroid-origin, mean distance √2; solve `Ah = 0` via the smallest eigenvector
  of the 9×9 normal-equations matrix (cyclic Jacobi eigensolver, ~60 lines,
  no dependencies); denormalize `H = T_world⁻¹ · H' · T_image`.
- Verified against a synthetic pinhole camera: **exact recovery** (1e-11 px)
  with no noise; with realistic ±1.5 px tap jitter, median error is **3–6 cm**
  near the plate, ~10–16 cm at 12–16 m (oblique-view noise amplification —
  honest physics, surfaced per-point, not hidden).

### 4.2 Reference points & degeneracy guards (fail-closed)

The solve **refuses** (returns `{ok:false, reason}`, wizard shows the reason
verbatim, never advances) when:

- fewer than 4 points ("need at least 4, have N"),
- points are near-collinear in image or world (spread < ε in either axis),
- any coordinate is non-finite,
- the matrix is singular or maps a reference point to infinity.

UI guidance: 6+ points spread across the cage beats 4 clustered ones; the
Review step color-codes per-point reprojection (green < 2 px, amber 2–5 px,
red > 5 px) and lets the user tap-to-delete outliers and re-solve.

### 4.2a Garage reference set (user's cage — no tape measure)

The user's cage sits alongside a garage wall with pre-measured geometry, so
the wizard ships a **"My garage cage" reference pack** (default; "Generic
cage" pack keeps the old cone-marker flow for other cages):

- Wall runs along one side of the cage at the cage edge (|y| = 5 ft for the
  10 ft wide cage). Plate center is even with the first door edge.
- Door edges along the wall at **0 / 10 / 16 / 26 ft** from the plate station
  (10' door, 6' wall, 10' door — exactly the 26 ft cage length).
- Two toggles cover the unknowns without a rebuild: wall side (3rd-base /
  1st-base) and door direction (toward pitcher / behind plate). Flipping
  either clears tapped refs (fail-closed: stale points never mix with a new
  frame).
- Height default is **4 ft** (plywood seam + receptacle height on the wall);
  the 2 ft glass door panels are a backup known-height marker. The user's 36"
  bat is a portable alternative: one-tap quick-set buttons switch the marker
  height between 4 ft (seam) and 3 ft (bat).
- The batter's boxes are a fixed 3 ft apart (inside edge to inside edge), so
  the pack includes "Box inside edge L/R" at (0, ∓1.5 ft) — a known lateral
  reference right at the plate, where accuracy matters most.
- The synthetic demo draws the wall, door divisions, and the 4 ft seam line
  so the user can verify point placement before going to the real camera.

World coordinates are pre-filled; the user only taps each named point in the
image. The same degeneracy guards (§4.2) and verification protocol (§4.5)
apply unchanged.

### 4.3 Reprojection error = the honesty metric

For each reference point, error is measured **both ways**: world→image (pixels)
and image→world (meters, direct — the homography outputs meters). Mean/max of
both go into the profile. Thresholds used by the wizard:

| mean px | reading |
|---|---|
| ≤ 2, with ≥ 6 pts | excellent — high confidence |
| ≤ 5 | usable — check outliers |
| > 5 | poor — do not trust; re-tap |

### 4.4 Height (z): measured, not assumed — or labeled as such

The ground homography cannot measure height. The wizard offers a **measured**
height scale: the user stands a marker of known height (default 0.9 m — a bat
on a tee) at a known ground spot and taps its base, then its top. This yields
a **local pixels-per-meter-vertical** sample at that field location.

This is a documented approximation (locally-affine camera, valid because ball
heights ≪ camera distance in a cage). Multiple samples may be recorded; the
tracking stage uses the nearest sample. Ball height ≈ pixel distance from the
ball to its ground projection ÷ px/m.

If the user skips this step, the profile records `heightScale.status =
"missing"` and **launch angle / exit velocity stay "uncalibrated estimate"**
— while ground-plane quantities (landing spot, spray, distance) can still be
calibrated. The capabilities are tracked independently (see §6).

### 4.5 Verification protocol (what flips the label)

Calibration is **not** verified by a good fit alone — fits can overfit 4
points. The wizard requires an independent check:

1. Ball placed on a **marked, known position** (default: a cone at 15 ft — inside a 26 ft / 7.92 m cage).
2. User taps the ball in the image; wizard computes world position via `H`.
3. Miss distance vs the known position; pass iff ≤ threshold (default 0.15 m,
   user-adjustable).

Pass → `verified: true`, `capabilities.groundPlane: "verified"`,
`label: "calibrated"`. Fail → everything stays **"uncalibrated estimate"**,
with concrete fix guidance (re-tap outliers, check the tripod didn't move,
confirm the ball is really on the mark). A failed verification is a *result*,
not an error — the wizard says so on screen.

## 5. Profile file format

`calibration-wizard/profile-schema.json` (JSON Schema, draft-07). Top-level:

```jsonc
{
  "format": "stadium-slugger/cage-calibration",
  "version": 1,
  "createdAt": "2026-09-16T23:40:00.000Z",   // ISO-8601
  "appVersion": "cage-wizard-prototype/0.1.0",
  "cage":   { "lengthM": 7.92, "widthM": 3.66, "heightM": 3.05, "notes": "26 ft pitching distance" },
  "camera": { "heightM": 1.40, "distanceBehindPlateM": 4.0, "sideOffsetM": 0.0,
              "imageWidth": 1280, "imageHeight": 720, "notes": "" },
  "worldFrame": { "origin": "center of home plate at ground level",
                  "xAxis": "+x toward the pitcher/outfield (meters)",
                  "yAxis": "+y lateral, toward right field (meters)",
                  "zAxis": "+z up (meters)", "units": "meters" },
  "homography": {
    "imageToGround": [[..],[..],[..]],   // 3x3, H[2][2] = 1
    "groundToImage": [[..],[..],[..]],   // 3x3 inverse
    "numPoints": 8,
    "reprojectionErrorPx": { "mean": 1.8, "max": 3.9 },
    "reprojectionErrorM":  { "mean": 0.03, "max": 0.06 },
    "perPointReprojPx": [1.2, 0.8, ...]
  },
  "referencePoints": [
    { "id": "plate-fl", "label": "Plate front-left",
      "imagePx": [612, 518], "worldM": [0.108, -0.2159] }, ...
  ],
  "heightScale": {
    "status": "measured",                 // "measured" | "assumed" | "missing"
    "samples": [
      { "pxPerM": 138.5, "groundWorldM": [3.0, 0.5],
        "markerHeightM": 0.9, "baseTapErrPx": 1.1 } ]
  },
  "verification": {
    "method": "known-position-tap",
    "knownWorldM": [5, 0], "measuredWorldM": [5.03, 0.02],
    "errorM": 0.036, "thresholdM": 0.15, "passed": true
  },
  "capabilities": {
    "groundPlane": "verified",            // "verified" | "unverified"
    "height": "measured"                  // "measured" | "assumed" | "missing"
  },
  "verified": true,
  "confidence": "high",                   // "high" | "medium" | "low"
  "label": "calibrated",                  // or "uncalibrated estimate"
  "notes": "source=live"
}
```

**Invariants enforced by `validateProfile()` (fail-closed):**
- `format`/`version` must match exactly (version 1).
- `homography.imageToGround` must be a finite, non-singular 3×3.
- `verified: true` **requires** `verification.passed: true`,
  `capabilities.groundPlane: "verified"`, and `label: "calibrated"` —
  a tampered profile that flips `verified` without the supporting fields is
  rejected.
- `verified: false` **requires** `label: "uncalibrated estimate"`.

## 6. Capabilities model — what each unlocks

| Capability | State | Unlocks |
|---|---|---|
| `groundPlane` | `verified` | landing position, spray angle/charts, carry distance, bounce/roll mapping — reported as **calibrated** |
| `groundPlane` | `unverified` | all of the above — **"uncalibrated estimate"** |
| `height` | `measured` | launch angle, exit velocity (3D), apex — **calibrated** |
| `height` | `assumed`/`missing` | launch angle, exit velocity — **"uncalibrated estimate"** |

The two axes are independent on purpose: a cage that skips the height step
still gets trustworthy spray charts. The wizard's final screen shows exactly
this table for the profile it just built.

## 7. How the tracking stage (step 2) consumes the profile

The tracking stage must **not** reach into `profile.homography` directly.
`calibration.js` exposes the consumption API, which keeps the fail-closed
contract in one place:

- `imageToGround(profile, u, v)` → `{ok:true, xM, yM, calibrated:true}` or
  `{ok:false, reason}`. Refuses when the profile is invalid **or**
  `capabilities.groundPlane !== "verified"` — the reason string names
  "uncalibrated estimate", which the UI must display verbatim next to the number.
- `groundToImage(profile, xM, yM)` → `{ok:true, u, v}` — for projecting
  predicted/measured field positions back onto the phone display and the TV
  cast view (spray-chart overlays, "where it landed" markers).
- `validateProfile(profile)` → `{ok, errors[]}` — run on load; reject and
  quarantine anything malformed.

**Rules for step 2:**
1. Load profile → `validateProfile`. Invalid → tracking runs in
   "uncalibrated estimate" mode for everything, banner shown.
2. Every frame's ball pixel → `imageToGround`. `ok:false` → drop the point,
   count it toward the "insufficient evidence" gate (the existing
   multi-frame EV fit already fail-closes on < 2 points).
3. Height: only treat as calibrated when `capabilities.height === "measured"`;
   use the nearest `heightScale.samples[].pxPerM`. Otherwise launch angle /
   exit velocity keep the "uncalibrated estimate" label the simulator already
   applies (`simulatorEngine.ts` / `CalibrationPanel.tsx`).
4. The existing native engine's `FieldCalibration` gate (verified +
   reprojection error) maps 1:1 onto this profile: `verified` and
   `reprojectionErrorPx.mean`. The cage profile is what finally lets that
   gate pass with real data instead of the current always-`uncalibrated()` stub.
5. Reuse, don't reinvent: the motion-based `BallDetector` (tripod-static
   assumption already holds in a cage) and `pose_landmarker_lite` (5.6 MB,
   vendored, SHA-256-verified, offline) are the tracking inputs. What's new
   in step 2 is purely the pixel→meter layer this profile provides.

## 8. Relation to the existing Windows app (untouched)

- `~/workspace/stadium_slugger/` is **not modified** by this work. The cage
  edition is new code under `~/workspace/stadium-slugger-cage/`.
- Conventions inherited: `FieldPointM` frame (§3), "Insufficient evidence"
  gating, "uncalibrated estimate" labeling, no invented numbers (spin is never
  invented; neither is height here).
- The simulator's `cameraCalibration.ts` checklist (camera height 3–12 ft,
  distance 8–80 ft, etc.) explicitly does **not** calibrate measurements —
  this wizard is the real calibration flow it was waiting for.

## 9. Known limits (documented, not hidden)

- Far-field accuracy degrades with obliqueness: ~10–35 cm at 12–16 m with
  ±1.5 px tap jitter (measured, `test-math.mjs`). Landing-spot claims near
  the far fence carry this uncertainty — show it, don't round it away.
- Height is a local affine approximation, not true 3D. Launch angle from a
  single camera is inherently ±2–4°; side-by-side validation (step 4 of the
  build order) will quantify it against Rapsodo/HitTrax before any paid claim.
- Non-planar floors, camera bumps, and lens changes (zoom!) invalidate the
  profile. The wizard warns; step 2 should add a quick re-verify tap target
  (one known floor mark per session — cheap, catches bumps).
- Rolling-shutter skew on fast balls is unmodeled; the EV fit's R²/quality
  gate is the backstop.

## 10. Queued for step 2 (not started)

Phone/cast architecture spike: prove on-device capture + tracking (MediaPipe
pose lite + motion ball detection + this profile's `imageToGround`) and a TV
receiver (Chromecast / smart-TV browser) showing the live session view. The
profile JSON is the contract between the two halves — the phone holds it, the
tracking loop reads it through `imageToGround`/`validateProfile`, and the
cast view renders `groundToImage` overlays.
