/* Regression tests for ball-detector sensitivity modes (2026-10-04).
 * A 280-swing garage session produced zero tracks — the ball never cleared
 * the normal brightness gates. "sensitive" lowers the brightness floors
 * while keeping the shape gates (elongation, motion, displacement).
 * Run: node test-ball-sensitivity.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
var mod = require("./ball-detect.js");

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("ok   " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

function makeFrame(W, H, fill) {
  var data = new Uint8ClampedArray(W * H * 4);
  for (var i = 0; i < W * H; i++) {
    data[i * 4] = fill; data[i * 4 + 1] = fill; data[i * 4 + 2] = fill; data[i * 4 + 3] = 255;
  }
  return { data: data, width: W, height: H };
}
function setPx(fr, x, y, b) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= fr.width || y < 0 || y >= fr.height) return;
  var i = (y * fr.width + x) * 4;
  fr.data[i] = b; fr.data[i + 1] = b; fr.data[i + 2] = b;
}
function drawBlob(fr, cx, cy, r, bright) {
  for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setPx(fr, x, y, bright);
}

// A dim ball: bright=110, below the normal blob gate (140) but above
// the sensitive gate (100). Moves 20 px/frame so motion clears and the
// 8-frame trail displaces ~140px > the 100px minimum.
function dimBallFrames(W, H, n, bright) {
  var frames = [];
  for (var f = 0; f < n; f++) {
    var fr = makeFrame(W, H, 25);
    // ball present in frames 1..n-2 (three-frame differencing needs neighbors)
    // r=2 -> ~12 bright px, inside the 4-20 blob size gate.
    drawBlob(fr, 100 + f * 20, 180, 2, bright);
    frames.push(fr);
  }
  return frames;
}

var W = 640, H = 360;

// 1. Default is normal.
mod.setBallSensitivity("normal");
check("default normal", mod.getBallSensitivity() === "normal");
check("normal blob gate 140", mod.BALL_SENSITIVITY.normal.blobBrightMin === 140);

// 2. Unknown mode falls back to normal.
check("unknown -> normal", mod.setBallSensitivity("calm") === "normal");
check("still normal", mod.getBallSensitivity() === "normal");

// 3. Sensitive lowers the floors but keeps shape gates.
mod.setBallSensitivity("sensitive");
check("sensitive active", mod.getBallSensitivity() === "sensitive");
check("sensitive blob gate 100", mod.BALL_SENSITIVITY.sensitive.blobBrightMin === 100);
check("sensitive score gate 80", mod.BALL_SENSITIVITY.sensitive.blobScoreGate === 80);
check("displacement gate unchanged", mod.BALL_MIN_DISPLACEMENT_PX === 100);
check("elongation gate unchanged", mod.STREAK_ELONG_MIN === 1.7);

// 4. A dim ball (bright=110) is invisible in normal mode...
mod.setBallSensitivity("normal");
var frames110 = dimBallFrames(W, H, 8, 110);
var diagN = {};
var trailN = mod.detectBallTrail(frames110, W, H, null, null, diagN);
check("dim ball: normal finds nothing", trailN === null,
  trailN ? "found " + trailN.length + " pts" : diagN.failReason || "");

// 5. ...but the sensitive mode picks it up.
mod.setBallSensitivity("sensitive");
var diagS = {};
var frames9 = dimBallFrames(W, H, 9, 110);
var trailS = mod.detectBallTrail(frames9, W, H, null, null, diagS);
check("dim ball: sensitive finds trail", trailS !== null && trailS.length >= 5,
  trailS ? trailS.length + " pts" : (diagS.failReason || "null"));

// 6. Sensitivity resets cleanly.
mod.setBallSensitivity("normal");
check("reset to normal", mod.getBallSensitivity() === "normal");

if (failures) { console.log("\n" + failures + " FAILURES"); process.exit(1); }
console.log("\nALL PASS");
