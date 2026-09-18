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

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
