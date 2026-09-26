/**
 * Stadium Slugger — Cage Edition: ball detection (blob + streak).
 *
 * Standalone module so it can be unit-tested in Node:
 *   node test-ball-detect.mjs
 * In the browser it loads as a classic script before session.js and
 * exposes detectBallTrail / detectStreakInFrame as globals.
 *
 * Two detectors, one trail:
 *   1. Blob (existing): a slow/close ball is a small bright compact blob.
 *      Three-frame differencing + 4-20 bright px in a 5x5 window.
 *   2. Streak (new): a fast ball at 30 fps motion-blurs into a dim
 *      elongated streak that fails the blob gates. A streak is strong
 *      along its axis and weak across it — we test 4 orientations and
 *      require the best axis to dominate its perpendicular.
 *
 * Per frame we try the blob first (cheap, precise); the streak is the
 * fallback. The trail format is unchanged: [{u, v, t}] with an extra
 * `via` field ("blob"|"streak") for forensics.
 */

var BALL_SCORE_GATE = 120; // achievable: per-pixel max is 765 (motion) * 1 * 1
// A track is accepted only if its end-to-end displacement clears this.
// Justification: even a 25 mph (11.2 m/s) grounder covers 0.37 m/frame at
// 30 fps; at a conservative 150 px/m (cage heightScale measures ~178 px/m
// at the calibration depth) that's ~56 px/frame, so a minimum 5-point
// chain (4 intervals) displaces ~220 px end-to-end. Field jitter trails
// never got close. 100 px keeps 2x margin under the slowest plausible
// ball while random blob jitter can't reach it.
var BALL_MIN_DISPLACEMENT_PX = 100; // full-res px over the track

// Cross-frame association gates (2026-09-26: per-frame winners with no
// continuity produced Frankenstein trails — two session-40 trails hit
// the fitter with 102/115 px RMSE).
var ASSOC_CANDS_PER_FRAME = 3; // top-N candidates per frame enter association
var ASSOC_NMS_PX = 40;         // candidates closer than this are one object
var ASSOC_R_FIRST_PX = 240;    // frame-2 join radius: 1.5x a 90 mph ball's
                               // ~160 px/frame (see the streak comment above)
var ASSOC_R_PRED_PX = 90;      // prediction gate: a constant-velocity
                               // prediction over one frame is good to ~10 px
                               // for a real ball (drag/gravity < 2 px/frame);
                               // 90 px is 9x the noise but far below a
                               // teleport to a different object (200+ px).

/* ------------------------------------------------------------------ */
/* Streak detector constants.                                          */
/* A 90 mph ball at 30 fps moves ~160 px/frame; with auto exposure it  */
/* smears into a streak well below the blob brightness gate (140).     */
/* ------------------------------------------------------------------ */
var STREAK_BRIGHT_MIN = 75;  // per-pixel mean RGB to seed a streak candidate
var STREAK_MOTION_MIN = 60;  // three-frame motion gate (same as blob)
var STREAK_HALF = 18;        // px each way along the axis (37 px window)
var STREAK_ELONG_MIN = 1.7;  // best axis sum must exceed perp sum by this
var STREAK_SUM_MIN = 2400;   // min axis brightness sum (~37 px at ~65 avg)
var STREAK_STEP = 4;         // scan step (px); streaks are big, blobs are not

// 0 deg, 45 deg, 90 deg, 135 deg. Perpendicular pairs: 0<->2, 1<->3.
var STREAK_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1]];

/**
 * Find the best motion streak in one frame.
 * d/dp/dn: Uint8ClampedArray RGBA of frame t / t-1 / t+1.
 * (rx0,rx1,ry0,ry1): search window in full-res px.
 * diag (optional): filled with forensics — candidates, bestAxisSum,
 *   bestElong, bestScore — even when no streak passes.
 * Returns {x, y, ox, oy, len, score} or null.
 * (x,y) is the streak center; (ox,oy) the unit axis; len the window px.
 * When `out` is given, every streak candidate is also pushed into it as
 * {x, y, score} (sorted desc, NMS'd, capped at ASSOC_CANDS_PER_FRAME) —
 * the association step needs more than the single best.
 */
function detectStreakInFrame(d, dp, dn, W, H, rx0, rx1, ry0, ry1, diag, out) {
  var best = null, bestScore = 0;
  var HL = STREAK_HALF;
  // Forensics: how close did we get?
  var candidates = 0, bestAxisSum = 0, bestElong = 0;
  for (var y = ry0; y < ry1; y += STREAK_STEP) {
    for (var x = rx0; x < rx1; x += STREAK_STEP) {
      var i = (y * W + x) * 4;
      var bright = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (bright < STREAK_BRIGHT_MIN) continue;
      var m1 = Math.abs(d[i] - dp[i]) + Math.abs(d[i + 1] - dp[i + 1]) + Math.abs(d[i + 2] - dp[i + 2]);
      var m2 = Math.abs(dn[i] - d[i]) + Math.abs(dn[i + 1] - d[i + 1]) + Math.abs(dn[i + 2] - d[i + 2]);
      var motion = m1 < m2 ? m1 : m2;
      if (motion < STREAK_MOTION_MIN) continue; // must move, not a static edge
      candidates++;
      // Brightness sums along the 4 orientations, HL px each way.
      var s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (var k = -HL; k <= HL; k++) {
        var xa = x + k;
        if (xa >= 0 && xa < W) { var j0 = (y * W + xa) * 4; s0 += (d[j0] + d[j0 + 1] + d[j0 + 2]) / 3; }
        var xb = x + k, yb = y + k;
        if (xb >= 0 && xb < W && yb >= 0 && yb < H) { var j1 = (yb * W + xb) * 4; s1 += (d[j1] + d[j1 + 1] + d[j1 + 2]) / 3; }
        var yc = y + k;
        if (yc >= 0 && yc < H) { var j2 = (yc * W + x) * 4; s2 += (d[j2] + d[j2 + 1] + d[j2 + 2]) / 3; }
        var xd = x - k, yd = y + k;
        if (xd >= 0 && xd < W && yd >= 0 && yd < H) { var j3 = (yd * W + xd) * 4; s3 += (d[j3] + d[j3 + 1] + d[j3 + 2]) / 3; }
      }
      var bi = 0, bs = s0;
      if (s1 > bs) { bi = 1; bs = s1; }
      if (s2 > bs) { bi = 2; bs = s2; }
      if (s3 > bs) { bi = 3; bs = s3; }
      var perp = bi === 0 ? s2 : bi === 1 ? s3 : bi === 2 ? s0 : s1;
      if (bs > bestAxisSum) bestAxisSum = bs;
      var elong = perp > 0 ? bs / perp : 0;
      if (elong > bestElong) bestElong = elong;
      if (bs < STREAK_SUM_MIN) continue;      // not substantial enough
      if (bs < STREAK_ELONG_MIN * perp) continue; // compact, not a streak
      var score = bs * (bright / 255);
      if (out) out.push({ x: x, y: y, score: score });
      if (score > bestScore) {
        bestScore = score;
        best = { x: x, y: y, ox: STREAK_DIRS[bi][0], oy: STREAK_DIRS[bi][1] };
      }
    }
  }
  if (out && out.length > 1) {
    // Sort desc, collapse near-duplicates (same streak, adjacent seeds),
    // cap at the association width.
    out.sort(function (a, b) { return b.score - a.score; });
    var kept = nmsCands(out, ASSOC_NMS_PX);
    out.length = 0;
    for (var oi = 0; oi < kept.length; oi++) out.push(kept[oi]);
  }
  if (diag) {
    diag.streakCandidates = (diag.streakCandidates || 0) + candidates;
    if (bestAxisSum > (diag.bestStreakAxisSum || 0)) diag.bestStreakAxisSum = Math.round(bestAxisSum);
    if (bestElong > (diag.bestStreakElong || 0)) diag.bestStreakElong = +bestElong.toFixed(2);
    if (bestScore > (diag.bestStreakScore || 0)) diag.bestStreakScore = Math.round(bestScore);
  }
  if (!best) return null;
  return { x: best.x, y: best.y, ox: best.ox, oy: best.oy, len: HL * 2 + 1, score: bestScore };
}

// Non-maximum suppression: candidates within r px are one object; keep
// the highest-scoring. Input must be sorted desc by score. Returns at
// most ASSOC_CANDS_PER_FRAME.
function nmsCands(sorted, r) {
  var kept = [];
  for (var i = 0; i < sorted.length && kept.length < ASSOC_CANDS_PER_FRAME; i++) {
    var c = sorted[i], dup = false;
    for (var j = 0; j < kept.length; j++) {
      var dx = c.x - kept[j].x, dy = c.y - kept[j].y;
      if (dx * dx + dy * dy < r * r) { dup = true; break; }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}

// Blob scan returning ALL passing candidates (sorted desc by score,
// NMS'd) instead of only the single best — the association step needs
// alternatives when the brightest blob is the bat, not the ball.
// Each candidate: {x, y, score}.
function scanBlobCands(d, dp, dn, W, H, rx0, rx1, ry0, ry1) {
  var cands = [];
  for (var y = ry0; y < ry1; y += 3) {
    for (var x = rx0; x < rx1; x += 3) {
      var i = (y * W + x) * 4;
      var bright = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (bright < 140) continue;
      var m1 = Math.abs(d[i] - dp[i]) + Math.abs(d[i + 1] - dp[i + 1]) + Math.abs(d[i + 2] - dp[i + 2]);
      var m2 = Math.abs(dn[i] - d[i]) + Math.abs(dn[i + 1] - d[i + 1]) + Math.abs(dn[i + 2] - d[i + 2]);
      var motion = Math.min(m1, m2);
      if (motion < 60) continue;
      var blob = 0;
      for (var yy = -2; yy <= 2; yy++) {
        var yy2 = y + yy;
        if (yy2 < 0 || yy2 >= H) continue;
        for (var xx = -2; xx <= 2; xx++) {
          var xx2 = x + xx;
          if (xx2 < 0 || xx2 >= W) continue;
          var j = (yy2 * W + xx2) * 4;
          if ((d[j] + d[j + 1] + d[j + 2]) / 3 > 120) blob++;
        }
      }
      if (blob < 4 || blob > 20) continue;
      var score = motion * (bright / 255) * (blob < 10 ? blob / 10 : 1);
      if (score > 0) cands.push({ x: x, y: y, score: score });
    }
  }
  cands.sort(function (a, b) { return b.score - a.score; });
  return nmsCands(cands, ASSOC_NMS_PX);
}

function detectBallTrail(frames, W, H, seed, times, diag) {
  // Three-frame differencing + blob check, with streak fallback.
  // motion(x,y,t) = min(|I(t)-I(t-1)|, |I(t+1)-I(t)|): a pixel must differ
  // from BOTH neighbors, which rejects single-frame flashes (sensor noise,
  // compression artifacts) and keeps consistently moving objects.
  //
  // Blob path: a real slow ball is a small bright blob — 4-20 bright px in
  // a 5x5 window. score = motion * (bright/255) * blobFactor.
  // Streak path: a fast ball motion-blurs below the blob gates; detect the
  // elongated streak instead and use its center as the trail point.
  //
  // seed = {x, y} motion centroid, 0-1 frame-normalized, < 5 s old.
  // Seeded search: window around the centroid, biased upward — the ball
  // travels up/away after contact and would exit a centered window in
  // ~3 frames. No/fresh seed: full upper-2/3 fallback region.
  //
  // diag (optional): filled with per-swing forensics — framesSearched,
  // blobPoints, streakPoints, bestBlobScore, streakCandidates,
  // bestStreakAxisSum, bestStreakElong, bestStreakScore, assocChains,
  // assocBreaks, failReason.
  //
  // Cross-frame association (2026-09-26): the old code picked one global
  // winner per frame independently, so trails combined the bat, body, net
  // glints and ball into a Frankenstein that the fitter rejected with
  // 100+ px RMSE. Now each frame contributes up to ASSOC_CANDS_PER_FRAME
  // candidates, and a greedy chain keeps only points near the
  // constant-velocity prediction from the last 1-2 accepted points. A
  // rejected jump closes the chain and restarts it; the longest
  // continuous run wins. This is the nearest-neighbor continuity the
  // old code lacked.
  diag = diag || {};
  diag.framesSearched = 0;
  diag.blobPoints = 0;
  diag.streakPoints = 0;
  diag.bestBlobScore = 0;
  diag.assocChains = 0;
  diag.assocBreaks = 0;
  var rx0, rx1, ry0, ry1;
  if (seed) {
    var cx = seed.x * W, cy = seed.y * H;
    rx0 = Math.max(0, Math.floor(cx - 0.25 * W));
    rx1 = Math.min(W, Math.ceil(cx + 0.25 * W));
    ry0 = Math.max(0, Math.floor(cy - 0.35 * H));
    ry1 = Math.min(H, Math.ceil(cy + 0.15 * H));
  } else {
    rx0 = Math.floor(W * 0.15); rx1 = Math.ceil(W * 0.85);
    ry0 = Math.floor(H * 0.08); ry1 = Math.ceil(H * 0.65);
  }
  // Per frame: candidate list (blob path first, streak fallback), each
  // {x, y, score, via}.
  var frameCands = [];
  for (var f = 1; f < frames.length - 1; f++) {
    diag.framesSearched++;
    var d = frames[f].data;
    var dp = frames[f - 1].data, dn = frames[f + 1].data;
    var t = (times && times[f] != null) ? times[f] : f / 30;
    var cands, via;
    var blobs = scanBlobCands(d, dp, dn, W, H, rx0, rx1, ry0, ry1);
    if (blobs.length && blobs[0].score > BALL_SCORE_GATE) {
      cands = blobs; via = "blob";
      if (blobs[0].score > diag.bestBlobScore) diag.bestBlobScore = Math.round(blobs[0].score);
    } else {
      var streaks = [];
      detectStreakInFrame(d, dp, dn, W, H, rx0, rx1, ry0, ry1, diag, streaks);
      cands = streaks; via = "streak";
    }
    for (var ci = 0; ci < cands.length; ci++) cands[ci].via = via;
    frameCands.push({ t: t, cands: cands });
  }
  // Greedy nearest-neighbor chain with a velocity prediction gate.
  var chains = [];
  var chain = [];
  function closeChain() { if (chain.length) { chains.push(chain); chain = []; } }
  for (var fi = 0; fi < frameCands.length; fi++) {
    var fc = frameCands[fi];
    if (!fc.cands.length) continue; // gap: coast on prediction, don't break
    if (!chain.length) {
      chain.push({ u: fc.cands[0].x, v: fc.cands[0].y, t: fc.t, via: fc.cands[0].via });
      continue;
    }
    var last = chain[chain.length - 1];
    var px, py, gate;
    if (chain.length >= 2) {
      var prev = chain[chain.length - 2];
      var dt1 = last.t - prev.t, dt2 = fc.t - last.t;
      var s = dt1 > 1e-6 ? dt2 / dt1 : 1; // scale for gaps / uneven cadence
      px = last.u + (last.u - prev.u) * s;
      py = last.v + (last.v - prev.v) * s;
      gate = ASSOC_R_PRED_PX;
    } else {
      px = last.u; py = last.v; gate = ASSOC_R_FIRST_PX;
    }
    var best = null, bestD2 = Infinity;
    for (var cj = 0; cj < fc.cands.length; cj++) {
      var c = fc.cands[cj];
      var ddx = c.x - px, ddy = c.y - py;
      var dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < bestD2) { bestD2 = dd2; best = c; }
    }
    if (best && bestD2 <= gate * gate) {
      chain.push({ u: best.x, v: best.y, t: fc.t, via: best.via });
    } else {
      // Jump rejected: close this chain, restart from this frame's best.
      diag.assocBreaks++;
      closeChain();
      chain.push({ u: fc.cands[0].x, v: fc.cands[0].y, t: fc.t, via: fc.cands[0].via });
    }
  }
  closeChain();
  diag.assocChains = chains.length;
  // Longest continuous run wins.
  var trail = [];
  for (var hi = 0; hi < chains.length; hi++) {
    if (chains[hi].length > trail.length) trail = chains[hi];
  }
  for (var ti = 0; ti < trail.length; ti++) {
    if (trail[ti].via === "blob") diag.blobPoints++; else diag.streakPoints++;
  }
  // Quality gates.
  if (trail.length < 5) { diag.failReason = "too few points (" + trail.length + ")"; return null; }
  var dx = trail[trail.length-1].u - trail[0].u;
  var dy = trail[trail.length-1].v - trail[0].v;
  var disp = Math.sqrt(dx*dx + dy*dy);
  if (disp < BALL_MIN_DISPLACEMENT_PX) { diag.failReason = "displacement " + disp.toFixed(1) + "px"; return null; }
  // NOTE: No vertical-direction gate. Field forensics (2026-09-23, session 29)
  // showed the ball moving DOWN in the image (positive dy, 6-275px) on real
  // cage footage — the "must move up" assumption was backwards for this camera
  // angle. Displacement + motion gates are sufficient; direction is not a
  // reliable ball-vs-not signal.
  diag.failReason = null;
  diag.dy = +dy.toFixed(1); // forensics: which way did it go?
  return trail;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectBallTrail: detectBallTrail,
    detectStreakInFrame: detectStreakInFrame,
    scanBlobCands: scanBlobCands,
    nmsCands: nmsCands,
    BALL_SCORE_GATE: BALL_SCORE_GATE,
    BALL_MIN_DISPLACEMENT_PX: BALL_MIN_DISPLACEMENT_PX,
    ASSOC_CANDS_PER_FRAME: ASSOC_CANDS_PER_FRAME,
    ASSOC_NMS_PX: ASSOC_NMS_PX,
    ASSOC_R_FIRST_PX: ASSOC_R_FIRST_PX,
    ASSOC_R_PRED_PX: ASSOC_R_PRED_PX,
    STREAK_BRIGHT_MIN: STREAK_BRIGHT_MIN,
    STREAK_MOTION_MIN: STREAK_MOTION_MIN,
    STREAK_HALF: STREAK_HALF,
    STREAK_ELONG_MIN: STREAK_ELONG_MIN,
    STREAK_SUM_MIN: STREAK_SUM_MIN
  };
}
