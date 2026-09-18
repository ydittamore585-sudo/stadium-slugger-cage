// Regression tests for the laptop-side calibration solve (session/calib.js
// talking to calibration-wizard/calibration.js).
//
// The 2026-09-18 bug: calib.js built refs as { image:{u,v}, world:{x,y} }
// OBJECTS, but solveHomography's contract is ARRAYS ({ image:[u,v],
// world:[x,y] }). r.image[0] was undefined, so EVERY solve failed with
// "reference point 1 has non-finite coordinates" — the solver could never
// succeed. A second bug doubled the prefix: "Insufficient evidence:
// Insufficient evidence: ...".
//
// Run: node test-calibration.mjs   (exit 1 on any failure)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require("../calibration-wizard/calibration.js");
const calibSrc = readFileSync(join(here, "calib.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

// The 8 garage-cage world references (meters), all but plate-apex.
const FT = 0.3048;
const WORLD = [
  [0.108, -0.2159], [0.108, 0.2159],
  [0, 5 * FT], [10.25 * FT, 5 * FT], [16.5 * FT, 5 * FT], [26.75 * FT, 5 * FT],
  [0, -1.5 * FT], [0, 1.5 * FT],
];

// Ground-truth world->image homography (plausible phone view, nonsingular).
const Htrue = [
  [520, 40, 640],
  [30, -480, 900],
  [0.02, -0.015, 1],
];
function applyH33(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w,
          (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}
// Tap simulation: project, round to integer pixels (like videoPos does).
const PIX = WORLD.map(([x, y]) => applyH33(Htrue, x, y).map(Math.round));

// 1. Array shape (the contract) solves cleanly on exact synthetic data.
{
  const refs = WORLD.map(([x, y], i) => ({ image: [PIX[i][0], PIX[i][1]], world: [x, y] }));
  const res = C.solveHomography(refs);
  ok(res.ok === true, "array-shape refs solve (ok:true)");
  ok(res.ok && res.meanPx < 1.0, "reprojection tiny on exact data (meanPx=" + (res.ok ? res.meanPx.toFixed(3) : "?") + ")");
}

// 2. The old object shape must fail exactly the way the user saw it.
{
  const refs = WORLD.map(([x, y], i) => ({ image: { u: PIX[i][0], v: PIX[i][1] }, world: { x, y } }));
  const res = C.solveHomography(refs);
  ok(res.ok === false, "object-shape refs fail closed (ok:false, never a bogus matrix)");
  ok(!res.ok && /non-finite coordinates/.test(res.reason),
     "object shape fails with the reported message (got: " + (res.ok ? "ok" : res.reason) + ")");
}

// 3. Static guard: session/calib.js no longer builds object-shaped refs
//    for either solveHomography call site (manual solve + auto-adjust).
{
  ok(!/image:\s*\{\s*u:\s*taps/.test(calibSrc), "manual solve() builds image:[u,v] arrays, not {u,v} objects");
  ok(!/image:\s*\{\s*u:\s*f\.image\.u/.test(calibSrc), "auto-adjust re-solve builds image:[u,v] arrays, not {u,v} objects");
}

// 4. Static guard: no doubled "Insufficient evidence:" prefix on res.reason.
{
  ok(!/Insufficient evidence: "\s*\+\s*\(?res\.reason/.test(calibSrc),
     "calib.js does not prepend 'Insufficient evidence:' to res.reason");
}

// 5. Height / Verify ball start disabled and unlock only when a
//    calibration exists (fresh solve or loaded preset) — they must never
//    look clickable and then "do nothing".
{
  ok(/hh\.disabled\s*=\s*true/.test(calibSrc), "wire() starts Height disabled");
  ok(/vb\.disabled\s*=\s*true/.test(calibSrc), "wire() starts Verify ball disabled");
  const unlockCalls = (calibSrc.match(/unlockCalibActions\(\);/g) || []).length;
  ok(unlockCalls >= 2, "unlockCalibActions() runs on solve success and preset load (" + unlockCalls + " calls)");
  ok(/function startHeightMode\(\) \{\s*\n\s*var cal = null;/.test(calibSrc),
     "Height's guard is H-based (a loaded preset qualifies, not just a fresh solve)");
}

// 6. Calibration persistence: a solved calibration survives a laptop
//    refresh via localStorage, so a patch-day reload never forces a
//    re-tap when the phone hasn't moved.
{
  ok(/function persistCalibration\(\)/.test(calibSrc), "persistCalibration() is defined");
  ok(/function restoreCalibration\(\)/.test(calibSrc), "restoreCalibration() is defined");
  ok(/localStorage\.setItem\(CALIB_STORE_KEY/.test(calibSrc), "persist writes to localStorage");
  ok(/localStorage\.getItem\(CALIB_STORE_KEY/.test(calibSrc), "restore reads from localStorage");
  const persistCalls = (calibSrc.match(/^\s*persistCalibration\(\);/gm) || []).length;
  ok(persistCalls >= 5, "persistCalibration() runs at every mutation point (solve, preset, height, verify, auto-adjust, file load — found " + persistCalls + ")");
  ok(/restoreCalibration\(\);\n  \}/.test(calibSrc), "wire() restores the calibration on page load");
  ok(/over 12h old/.test(calibSrc), "restored state warns when the calibration is stale");
}

// 7. The persisted payload round-trips through JSON intact and stays small
//    enough for localStorage (5MB quota; a profile with 8 base64 patches).
{
  const fakePatch = Buffer.alloc(48 * 48, 128).toString("base64"); // 48x48 gray
  const payload = {
    v: 1, savedAt: Date.now(),
    phone: {
      H: [[1.2, 0.1, 640], [0.05, -1.1, 900], [0.0002, -0.0001, 1]],
      Hinv: [[0.8, 0.05, -500], [-0.03, -0.9, 800], [0.0001, 0.0002, 1]],
      meanPx: 1.54, maxPx: 4.09, numPoints: 8, verified: true,
      heightScalePxPerM: 177.5,
    },
    manual: null,
    profile: {
      refPatches: {
        frameW: 480, frameH: 270, videoW: 1280, videoH: 720,
        patches: Array.from({ length: 8 }, (_, i) => ({
          id: "pt" + i, world: [i * 0.3, 1.524], refU: 100 + i * 10, refV: 200,
          patch: fakePatch,
        })),
      },
      heightScale: { pxPerM: 177.5, samples: 1, method: "36-in bat vertical at plate" },
    },
    lastHeightScale: { pxPerM: 177.5, samples: 1 },
    hasSolvedProfile: true,
  };
  const json = JSON.stringify(payload);
  ok(json.length < 100000, "persisted payload is small (" + json.length + " bytes, quota is ~5MB)");
  const back = JSON.parse(json);
  ok(back.phone.H[2][2] === 1 && back.phone.verified === true, "H matrix and flags survive the round-trip");
  ok(back.profile.refPatches.patches.length === 8 &&
     back.profile.refPatches.patches[0].patch === fakePatch, "all 8 reference patches survive the round-trip");
  ok(back.profile.heightScale.pxPerM === 177.5, "height scale survives the round-trip");
}

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);