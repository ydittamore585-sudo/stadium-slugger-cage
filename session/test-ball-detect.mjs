/* Unit tests for ball-detect.js — blob + streak ball detection.
 * Synthetic frames modeled on the 2026-09-23 cage session failure:
 * a 90 mph ball at 30 fps motion-blurs into a dim streak that the
 * compact-blob gates (bright>140, 4-20 px) cannot see.
 * Run: node test-ball-detect.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
var mod = require("./ball-detect.js");
var detectBallTrail = mod.detectBallTrail;
var detectStreakInFrame = mod.detectStreakInFrame;

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("ok   " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

// --- Synthetic frame helpers ---------------------------------------
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
// Thick line segment (the motion-blurred ball).
function drawStreak(fr, x0, y0, x1, y1, w, bright) {
  var dx = x1 - x0, dy = y1 - y0;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / len, ny = dx / len; // normal
  var steps = Math.ceil(len);
  for (var s = 0; s <= steps; s++) {
    var px = x0 + dx * s / steps, py = y0 + dy * s / steps;
    for (var k = -w / 2; k <= w / 2; k++) setPx(fr, px + nx * k, py + ny * k, bright);
  }
}

var W = 640, H = 360, BG = 25;

// --- Test 1: slow bright blob (the case that already worked) --------
(function () {
  var frames = [];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 100 + f * 20, 250 - f * 14, 4, 210);
    frames.push(fr);
  }
  var trail = detectBallTrail(frames, W, H, null, null);
  check("blob: trail found", !!trail, "got null");
  if (trail) {
    check("blob: >=5 points", trail.length >= 5, "got " + trail.length);
    check("blob: all via blob", trail.every(function (p) { return p.via === "blob"; }));
    check("blob: moves up-right", trail[trail.length - 1].u > trail[0].u && trail[trail.length - 1].v < trail[0].v - 4);
  }
})();

// --- Test 2: fast dim streak (the 2026-09-23 failure mode) -----------
(function () {
  var frames = [];
  // 50px streak, 5px wide, brightness 110 (below the 140 blob gate),
  // moving 80px/frame right and 5px/frame up — stays inside the null-seed
  // fallback region (upper 2/3) for frames 1..5. No inter-frame overlap
  // (80px motion > 50px streak), like a real 90mph ball at 30fps.
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    var cx = 100 + f * 80, cy = 220 - f * 5;
    drawStreak(fr, cx - 25, cy, cx + 25, cy, 5, 110);
    frames.push(fr);
  }
  var trail = detectBallTrail(frames, W, H, null, null);
  check("streak: trail found", !!trail, "got null — streak detector missed it");
  if (trail) {
    check("streak: >=5 points", trail.length >= 5, "got " + trail.length);
    var nStreak = trail.filter(function (p) { return p.via === "streak"; }).length;
    check("streak: points via streak", nStreak >= 5, nStreak + "/"+ trail.length + " via streak");
    var maxErr = 0;
    for (var k = 0; k < trail.length; k++) {
      var f = k + 1; // trail[0] is frame 1
      var ex = 100 + f * 80, ey = 220 - f * 5;
      var err = Math.sqrt(Math.pow(trail[k].u - ex, 2) + Math.pow(trail[k].v - ey, 2));
      if (err > maxErr) maxErr = err;
    }
    check("streak: center error < 8px", maxErr < 8, "maxErr=" + maxErr.toFixed(1));
  }
})();

// --- Test 3: blob detector must NOT see the dim streak (proves the gap)
(function () {
  var frames = [];
  for (var f = 0; f < 3; f++) {
    var fr = makeFrame(W, H, BG);
    var cx = 200 + f * 80, cy = 200;
    drawStreak(fr, cx - 25, cy, cx + 25, cy, 5, 110);
    frames.push(fr);
  }
  // Direct streak check on the middle frame.
  var st = detectStreakInFrame(frames[1].data, frames[0].data, frames[2].data,
    W, H, 0, W, 0, H);
  check("streak: direct detection", !!st, "got null");
  if (st) {
    check("streak: horizontal orientation", st.ox === 1 && st.oy === 0,
      "got (" + st.ox + "," + st.oy + ")");
    check("streak: center near true", Math.abs(st.x - 280) < 8 && Math.abs(st.y - 200) < 8,
      "got (" + st.x + "," + st.y + ")");
  }
})();

// --- Test 4: static bright bar — motion gate must reject ------------
(function () {
  var frames = [];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    drawStreak(fr, 100, 100, 300, 100, 6, 180); // static, bright
    frames.push(fr);
  }
  var trail = detectBallTrail(frames, W, H, null, null);
  check("static: no trail", trail === null, "got a trail from a static bar");
  var st = detectStreakInFrame(frames[1].data, frames[0].data, frames[2].data,
    W, H, 0, W, 0, H);
  check("static: no streak", st === null, "streak fired on static edge");
})();

// --- Test 5: empty frames ---------------------------------------------
(function () {
  var frames = [];
  for (var f = 0; f < 7; f++) frames.push(makeFrame(W, H, BG));
  check("empty: no trail", detectBallTrail(frames, W, H, null, null) === null);
})();

// --- Test 6: downward motion ACCEPTED (field forensics 2026-09-23 showed
// the ball moves down in the real cage camera image; the up-only gate was
// backwards). Direction is not a ball-vs-not signal.
(function () {
  var frames = [];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    var cx = 60 + f * 80, cy = 100 + f * 20; // moving DOWN (stays in H=360 fallback region)
    drawStreak(fr, cx - 25, cy, cx + 25, cy, 5, 110);
    frames.push(fr);
  }
  var diag = {};
  var trail = detectBallTrail(frames, W, H, null, null, diag);
  check("downward: accepted", !!trail, "got null — dy=" + diag.dy);
  if (trail) check("downward: dy positive", diag.dy > 0, "dy=" + diag.dy);
})();

// --- Test 7: vertical streak orientation ------------------------------
(function () {
  var frames = [];
  for (var f = 0; f < 3; f++) {
    var fr = makeFrame(W, H, BG);
    drawStreak(fr, 300, 80 + f * 0, 300, 140, 5, 110); // vertical, static pos
    // shift it so there's motion: redraw per frame at different y
    frames.push(fr);
  }
  // Rebuild with real motion (upward).
  frames = [];
  for (var g = 0; g < 3; g++) {
    var fr2 = makeFrame(W, H, BG);
    var yy = 200 - g * 60;
    drawStreak(fr2, 300, yy - 25, 300, yy + 25, 5, 110);
    frames.push(fr2);
  }
  var st = detectStreakInFrame(frames[1].data, frames[0].data, frames[2].data,
    W, H, 0, W, 0, H);
  check("vertical: detected", !!st, "got null");
  if (st) check("vertical: orientation", st.ox === 0 && st.oy === 1,
    "got (" + st.ox + "," + st.oy + ")");
})();

// --- Test 8: compact blob is NOT a streak (no double counting) -------
(function () {
  var frames = [];
  for (var f = 0; f < 3; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 200 + f * 30, 200, 4, 210); // moving compact blob
    frames.push(fr);
  }
  var st = detectStreakInFrame(frames[1].data, frames[0].data, frames[2].data,
    W, H, 0, W, 0, H);
  check("blob not streak", st === null, "streak fired on a compact blob");
})();

// --- Test 9: diag forensics are populated -------------------------------
(function () {
  // Positive case: dim moving streak (upper 2/3, unseeded fallback region).
  var frames = [];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    var cx = 100 + f * 80, cy = 200 - f * 20;
    drawStreak(fr, cx - 25, cy - 25, cx + 25, cy + 25, 5, 110);
    frames.push(fr);
  }
  var diag = {};
  var trail = detectBallTrail(frames, W, H, null, null, diag);
  check("diag: trail found", !!trail, "got null");
  check("diag: framesSearched", diag.framesSearched === 5, "got " + diag.framesSearched);
  check("diag: streakPoints", diag.streakPoints >= 5, "got " + diag.streakPoints);
  check("diag: failReason null", diag.failReason === null, "got " + diag.failReason);
  check("diag: bestStreakScore > 0", (diag.bestStreakScore || 0) > 0, "got " + diag.bestStreakScore);

  // Negative case: empty frames — forensics must explain the miss.
  var empty = [];
  for (var f2 = 0; f2 < 7; f2++) empty.push(makeFrame(W, H, BG));
  var d2 = {};
  var t2 = detectBallTrail(empty, W, H, null, null, d2);
  check("diag: empty -> null", t2 === null);
  check("diag: empty failReason", !!d2.failReason, "no failReason");
  check("diag: empty streakCandidates 0", d2.streakCandidates === 0,
    "got " + d2.streakCandidates);
})();

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
