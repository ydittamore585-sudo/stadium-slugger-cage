/**
 * Math self-test for calibration.js — no browser needed.
 * Builds a synthetic pinhole camera over a cage, projects known world points
 * to image pixels, adds tap noise, then checks that solveHomography recovers
 * the mapping within tolerance. Also exercises fail-closed paths.
 *
 * Run: node test-math.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const C = require("./calibration.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// --- synthetic camera: pinhole, 1280x720, looking at a cage from behind plate
const W = 1280, Hh = 720;
const fovHdeg = 68;
const f = (W / 2) / Math.tan((fovHdeg * Math.PI / 180) / 2); // focal px
const camH = 1.4;                 // camera height, m
const camX = -4.0, camY = 0.6;    // camera ground position (behind plate, slight offset)
// camera looks toward +x with slight downward pitch
const pitch = -0.10;              // radians, downward

// world -> camera coords: translate then rotate about y-axis by pitch
function worldToCam(x, y, z) {
  const dx = x - camX, dy = y - camY, dz = z - camH;
  // rotate so camera looks along +x with pitch
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // camera frame: Xc right, Yc down, Zc forward
  const fwd = cp * dx - sp * dz;
  const up = sp * dx + cp * dz;
  return [dy, -up, fwd]; // right=dy, down=-up, forward=fwd
}
function project(x, y, z) {
  const [Xc, Yc, Zc] = worldToCam(x, y, z);
  if (Zc <= 0.1) return null;
  return [W / 2 + f * (Xc / Zc), Hh / 2 + f * (Yc / Zc)];
}

// deterministic pseudo-noise (tap jitter), seeded
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

// --- reference points: plate corners + cage posts + distance markers
const refs = [];
const plate = [
  { id: "plate-fl", w: [0.108, -0.2159] },
  { id: "plate-fr", w: [0.108, 0.2159] },
  { id: "plate-apex", w: [-0.324, 0] },
];
const cage = [
  { id: "post-near-l", w: [0.5, -1.83] },
  { id: "post-near-r", w: [0.5, 1.83] },
  { id: "post-far-l", w: [20.0, -1.83] },
  { id: "post-far-r", w: [20.0, 1.83] },
  { id: "mark-10m", w: [10.0, 0] },
];
for (const r of [...plate, ...cage]) {
  const px = project(r.w[0], r.w[1], 0);
  if (!px) { console.log("synthetic point behind camera: " + r.id); process.exit(2); }
  // add ~1.5px tap noise
  refs.push({
    id: r.id,
    image: [px[0] + (rnd() - 0.5) * 3, px[1] + (rnd() - 0.5) * 3],
    world: r.w,
    truthPx: px,
  });
}

console.log("== DLT recovery test ==");
const sol = C.solveHomography(refs);
check("solve ok", sol.ok, sol.reason);
if (sol.ok) {
  check("mean reproj <= 3px", sol.meanPx <= 3, sol.meanPx.toFixed(2) + "px");
  check("max reproj <= 8px", sol.maxPx <= 8, sol.maxPx.toFixed(2) + "px");
  // check mapping at fresh test points (not used in solve).
  // Near-field must be tight; far-field (12m+, oblique view) amplifies tap
  // noise — the wizard surfaces this honestly via per-point reprojection.
  // Use 25 noise trials and check medians (a single draw is seed-luck).
  const trialPts = [[2, -1], [5, 0.8], [0.108, 0]];
  const trialFar = [[12, -0.5], [16, 1.2]];
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const nearErrs = [], farErrs = [];
  let tseed = 7;
  const trnd = () => { tseed = (tseed * 1103515245 + 12345) & 0x7fffffff; return tseed / 0x7fffffff; };
  for (let t = 0; t < 25; t++) {
    const noisy = refs.map((r) => ({
      image: [r.truthPx[0] + (trnd() - 0.5) * 3, r.truthPx[1] + (trnd() - 0.5) * 3],
      world: r.world,
    }));
    const s = C.solveHomography(noisy);
    if (!s.ok) continue;
    for (const [tx, ty] of trialPts) {
      const px = project(tx, ty, 0), e = C.applyH(s.H, px[0], px[1]);
      nearErrs.push(Math.hypot(e[0] - tx, e[1] - ty));
    }
    for (const [tx, ty] of trialFar) {
      const px = project(tx, ty, 0), e = C.applyH(s.H, px[0], px[1]);
      farErrs.push(Math.hypot(e[0] - tx, e[1] - ty));
    }
  }
  const nearMed = med(nearErrs), farMed = med(farErrs);
  check("near-field median mapping err <= 0.08m", nearMed <= 0.08, nearMed.toFixed(3) + "m");
  check("far-field median mapping err <= 0.20m (noise-amplified, reported)", farMed <= 0.20, farMed.toFixed(3) + "m");
  console.log("   meanPx=" + sol.meanPx.toFixed(2) + " maxPx=" + sol.maxPx.toFixed(2) +
              " meanM=" + (sol.meanM * 100).toFixed(1) + "cm");
}

console.log("== height scale test ==");
// marker: 0.9m pole at (3, 0.5)
const mBase = project(3, 0.5, 0), mTop = project(3, 0.5, 0.9);
const hs = C.solveHeightScale(sol.H, 0.9,
  [mBase[0] + 1, mBase[1] - 1], [mTop[0] - 1, mTop[1] + 1]);
check("height solve ok", hs.ok, hs.reason);
if (hs.ok) {
  // estimate height of a ball at 1.2m over (4, -0.3): tap ball + ground below it
  const bPx = project(4, -0.3, 1.2), gPx = project(4, -0.3, 0);
  const zEst = C.estimateHeight([bPx[0] + 1, bPx[1]], gPx, hs.pxPerM);
  check("height estimate within 0.15m", Math.abs(zEst - 1.2) <= 0.15,
        "est=" + zEst.toFixed(2) + "m");
  console.log("   pxPerM=" + hs.pxPerM.toFixed(1) + " est=" + zEst.toFixed(2) + "m (true 1.20m)");
}

console.log("== fail-closed tests ==");
check("reject <4 points", !C.solveHomography(refs.slice(0, 3)).ok);
check("reject collinear", !C.solveHomography([
  { image: [100, 100], world: [0, 0] },
  { image: [200, 200], world: [1, 1] },
  { image: [300, 300], world: [2, 2] },
  { image: [400, 400], world: [3, 3] },
]).ok);
check("reject NaN", !C.solveHomography([
  { image: [100, 100], world: [0, 0] },
  { image: [200, 150], world: [1, 0] },
  { image: [150, 300], world: [0, 1] },
  { image: [NaN, 300], world: [1, 1] },
]).ok);
check("reject bad marker height", !C.solveHeightScale(sol.H, 0, [1, 1], [1, 50]).ok);

console.log("== profile build/validate ==");
const built = C.buildProfile({
  cage: { lengthM: 21.34, widthM: 3.66, heightM: 3.05 },
  camera: { heightM: 1.4, distanceBehindPlateM: 4.0, sideOffsetM: 0.6, imageWidth: 1280, imageHeight: 720 },
  solveResult: sol,
  referencePoints: refs,
  heightSamples: [hs],
  verification: {
    knownWorldM: [10, 0], measuredWorldM: [10.03, 0.02],
    errorM: Math.hypot(0.03, 0.02), thresholdM: 0.15, passed: true,
  },
  appVersion: "test",
});
check("profile builds valid", built.valid, built.errors.join("; "));
check("profile verified", built.profile.verified === true);
check("profile validates", C.validateProfile(built.profile).ok);
const g = C.imageToGround(built.profile, refs[0].truthPx[0], refs[0].truthPx[1]);
check("imageToGround calibrated", g.ok && g.calibrated &&
      Math.hypot(g.xM - refs[0].world[0], g.yM - refs[0].world[1]) < 0.05);

// unverified profile must fail-closed on tracking reads
const unv = C.buildProfile({
  cage: { lengthM: 21.34, widthM: 3.66 },
  camera: { heightM: 1.4 },
  solveResult: sol, referencePoints: refs,
  verification: { knownWorldM: [10, 0], measuredWorldM: [11, 0], errorM: 1.0, thresholdM: 0.15, passed: false },
});
check("failed verification -> unverified", unv.profile.verified === false);
check("unverified label", unv.profile.label === "uncalibrated estimate");
check("tracking read fail-closed", !C.imageToGround(unv.profile, 100, 100).ok);
check("tampered verified rejected",
  !C.validateProfile(Object.assign({}, built.profile, { verified: true, label: "oops" })).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
