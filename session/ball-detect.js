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
var BALL_MIN_DISPLACEMENT_PX = 8; // full-res px over the track

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
 * Returns {x, y, ox, oy, len, score} or null.
 * (x,y) is the streak center; (ox,oy) the unit axis; len the window px.
 */
function detectStreakInFrame(d, dp, dn, W, H, rx0, rx1, ry0, ry1) {
  var best = null, bestScore = 0;
  var HL = STREAK_HALF;
  for (var y = ry0; y < ry1; y += STREAK_STEP) {
    for (var x = rx0; x < rx1; x += STREAK_STEP) {
      var i = (y * W + x) * 4;
      var bright = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (bright < STREAK_BRIGHT_MIN) continue;
      var m1 = Math.abs(d[i] - dp[i]) + Math.abs(d[i + 1] - dp[i + 1]) + Math.abs(d[i + 2] - dp[i + 2]);
      var m2 = Math.abs(dn[i] - d[i]) + Math.abs(dn[i + 1] - d[i + 1]) + Math.abs(dn[i + 2] - d[i + 2]);
      var motion = m1 < m2 ? m1 : m2;
      if (motion < STREAK_MOTION_MIN) continue; // must move, not a static edge
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
      if (bs < STREAK_SUM_MIN) continue;      // not substantial enough
      if (bs < STREAK_ELONG_MIN * perp) continue; // compact, not a streak
      var score = bs * (bright / 255);
      if (score > bestScore) {
        bestScore = score;
        best = { x: x, y: y, ox: STREAK_DIRS[bi][0], oy: STREAK_DIRS[bi][1] };
      }
    }
  }
  if (!best) return null;
  return { x: best.x, y: best.y, ox: best.ox, oy: best.oy, len: HL * 2 + 1, score: bestScore };
}

function detectBallTrail(frames, W, H, seed, times) {
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
  var trail = [];
  for (var f = 1; f < frames.length - 1; f++) {
    var d = frames[f].data;
    var dp = frames[f - 1].data, dn = frames[f + 1].data;
    var t = (times && times[f] != null) ? times[f] : f / 30;
    var best = null, bestScore = 0;
    for (var y = ry0; y < ry1; y += 3) {
      for (var x = rx0; x < rx1; x += 3) {
        var i = (y * W + x) * 4;
        var bright = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (bright < 140) continue; // ball is bright white
        var m1 = Math.abs(d[i] - dp[i]) + Math.abs(d[i + 1] - dp[i + 1]) + Math.abs(d[i + 2] - dp[i + 2]);
        var m2 = Math.abs(dn[i] - d[i]) + Math.abs(dn[i + 1] - d[i + 1]) + Math.abs(dn[i + 2] - d[i + 2]);
        var motion = m1 < m2 ? m1 : m2;
        if (motion < 60) continue; // must be moving across frames, not static
        // Blob check: ball-sized bright cluster, not a speck or a wall.
        var blob = 0;
        for (var dy = -2; dy <= 2; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (var dx = -2; dx <= 2; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            var j = (yy * W + xx) * 4;
            if ((d[j] + d[j + 1] + d[j + 2]) / 3 > 120) blob++;
          }
        }
        if (blob < 4 || blob > 20) continue;
        var score = motion * (bright / 255) * (blob < 10 ? blob / 10 : 1);
        if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
    }
    if (best && bestScore > BALL_SCORE_GATE) {
      trail.push({ u: best.x, v: best.y, t: t, via: "blob" });
    } else {
      // Fallback: the ball may be a motion-blurred streak, not a blob.
      var st = detectStreakInFrame(d, dp, dn, W, H, rx0, rx1, ry0, ry1);
      if (st) trail.push({ u: st.x, v: st.y, t: t, via: "streak" });
    }
  }
  // Quality gates.
  if (trail.length < 5) return null;
  var dx = trail[trail.length-1].u - trail[0].u;
  var dy = trail[trail.length-1].v - trail[0].v;
  var disp = Math.sqrt(dx*dx + dy*dy);
  if (disp < BALL_MIN_DISPLACEMENT_PX) return null;
  // Must move generally away (up in image = toward outfield).
  if (dy > -4) return null;
  return trail;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectBallTrail: detectBallTrail,
    detectStreakInFrame: detectStreakInFrame,
    BALL_SCORE_GATE: BALL_SCORE_GATE,
    BALL_MIN_DISPLACEMENT_PX: BALL_MIN_DISPLACEMENT_PX,
    STREAK_BRIGHT_MIN: STREAK_BRIGHT_MIN,
    STREAK_MOTION_MIN: STREAK_MOTION_MIN,
    STREAK_HALF: STREAK_HALF,
    STREAK_ELONG_MIN: STREAK_ELONG_MIN,
    STREAK_SUM_MIN: STREAK_SUM_MIN
  };
}
