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

// --- Test 1: bright blob (the case that already worked) ---------------
(function () {
  var frames = [];
  // 36px/frame — a realistic batted-ball image motion. Must clear the
  // 100px end-to-end displacement gate over the 5-point track.
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 100 + f * 30, 250 - f * 20, 4, 210);
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

// --- Test 10: teleport breaks the chain; longest run wins -----------
(function () {
  var frames = [];
  // Ball moves 35px/frame for f=0..5, then teleports 200px and continues
  // smoothly. The jump must break the chain, and the 5-point pre-teleport
  // run must win over the 2-point post-teleport run.
  for (var f = 0; f < 9; f++) {
    var fr = makeFrame(W, H, BG);
    var cx = f <= 5 ? 80 + f * 35 : 80 + 5 * 35 + 200 + (f - 6) * 35;
    drawBlob(fr, cx, 220, 4, 210);
    frames.push(fr);
  }
  var d = {};
  var trail = detectBallTrail(frames, W, H, null, null, d);
  check("assoc: longest chain wins", !!trail, "got null: " + d.failReason);
  check("assoc: one break", d.assocBreaks === 1, "got " + d.assocBreaks);
  check("assoc: two chains", d.assocChains === 2, "got " + d.assocChains);
  if (trail) {
    check("assoc: 5 points", trail.length === 5, "got " + trail.length);
    check("assoc: all pre-teleport", trail.every(function (p) { return p.u < 300; }));
  }
})();

// --- Test 11: brighter distractor off the path is ignored ------------
(function () {
  var frames = [];
  // Ball: 35px/frame at y=220, bright 200. Distractor: BRIGHTER (235),
  // moving smoothly at y=110 — the old per-frame-winner code would have
  // followed it. Association must stay on the ball's predicted path.
  for (var f = 0; f < 9; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 80 + f * 35, 220, 4, 200);
    if (f >= 3 && f <= 6) drawBlob(fr, 400 + f * 15, 110, 4, 235);
    frames.push(fr);
  }
  var d = {};
  var trail = detectBallTrail(frames, W, H, null, null, d);
  check("assoc: distractor ignored, trail found", !!trail, "got null: " + d.failReason);
  check("assoc: no breaks", d.assocBreaks === 0, "got " + d.assocBreaks);
  if (trail) {
    check("assoc: 7 points", trail.length === 7, "got " + trail.length);
    var maxErr = 0;
    for (var k = 0; k < trail.length; k++) {
      var f = k + 1; // searched frames are f=1..7
      var ex = Math.abs(trail[k].u - (80 + f * 35));
      var ey = Math.abs(trail[k].v - 220);
      if (ex > maxErr) maxErr = ex;
      if (ey > maxErr) maxErr = ey;
    }
    check("assoc: follows the ball", maxErr < 12, "maxErr=" + maxErr.toFixed(1));
  }
})();

// --- Test 12: jitter can't clear the displacement gate ---------------
(function () {
  var frames = [];
  // Fixed jitter pattern: the chain holds (gates pass) but end-to-end
  // displacement is ~3px — far under the 100px minimum for a real ball.
  var jx = [0, 8, -6, 4, -9, 7, -3], jy = [0, 5, 9, -7, -4, 8, 6];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 300 + jx[f], 180 + jy[f], 4, 210);
    frames.push(fr);
  }
  var d = {};
  var trail = detectBallTrail(frames, W, H, null, null, d);
  check("assoc: jitter rejected", !trail, "got trail");
  check("assoc: jitter reason", d.failReason && d.failReason.indexOf("displacement") === 0,
    "got " + d.failReason);
  check("assoc: jitter single chain", d.assocChains === 1, "got " + d.assocChains);
})();

// --- Test 13: a 2-frame detection gap coasts, not breaks ---------------
(function () {
  var frames = [];
  // Ball at 35px/frame, but frames 3-4 are empty (occlusion / blur miss).
  // Searched frames are 1..7; frames 3,4 yield zero candidates. The chain
  // must coast across the gap — the gap-scaled prediction (s = dt2/dt1)
  // lands exactly on the reappearing ball — not break into two chains.
  for (var f = 0; f < 9; f++) {
    var fr = makeFrame(W, H, BG);
    if (f !== 3 && f !== 4) drawBlob(fr, 80 + f * 35, 220, 4, 210);
    frames.push(fr);
  }
  var d = {};
  var trail = detectBallTrail(frames, W, H, null, null, d);
  check("assoc: gap coasts, trail found", !!trail, "got null: " + d.failReason);
  check("assoc: no breaks across the gap", d.assocBreaks === 0, "got " + d.assocBreaks);
  check("assoc: single chain", d.assocChains === 1, "got " + d.assocChains);
  if (trail) {
    check("assoc: 5 points span the gap", trail.length === 5, "got " + trail.length);
    // The post-gap points are the real detections, at the right places.
    var last = trail[trail.length - 1];
    check("assoc: post-gap position correct",
      Math.abs(last.u - (80 + 7 * 35)) < 12, "u=" + last.u.toFixed(1));
  }
})();

// --- Forensics: detectBallTrail records the raw trail in ballDiag ----
(function () {
  var frames = [];
  for (var f = 0; f < 7; f++) {
    var fr = makeFrame(W, H, BG);
    drawBlob(fr, 100 + f * 30, 250 - f * 20, 4, 210);
    frames.push(fr);
  }
  var d = {};
  var trail = detectBallTrail(frames, W, H, null, null, d);
  check("forensics: trail found", !!trail, "got null: " + d.failReason);
  if (trail) {
    check("forensics: trailPts recorded",
      Array.isArray(d.trailPts) && d.trailPts.length === trail.length,
      "got " + JSON.stringify(d.trailPts && d.trailPts.length));
    var p0 = d.trailPts[0];
    check("forensics: trailPts entries are rounded [u,v,t]",
      p0.length === 3 && Math.abs(p0[0] - trail[0].u) < 0.06 &&
      Math.abs(p0[1] - trail[0].v) < 0.06 && Math.abs(p0[2] - trail[0].t) < 0.0006,
      JSON.stringify(p0));
  }
})();

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
