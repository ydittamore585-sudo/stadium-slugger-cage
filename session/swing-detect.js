/* Swing detector: prominence-based spike recognition.
 *
 * Watches motion energy over time and recognizes the SIGNATURE of a
 * swing: an explosive spike (fast rise, high peak, quick decay) — not
 * just motion volume. A kid getting up off the ground makes MORE total
 * motion than a swing, but it's a slow plateau, not a spike. Bat waggle
 * is a ripple. Prominence (peak height above the surrounding baseline)
 * separates them with cheap arithmetic.
 *
 * Two stages, because the ball is already flying at spike time:
 *  1. SPIKE (immediate, ~1 frame): fast rise detected. Caller starts
 *     ball tracking and clip capture NOW — no waiting.
 *  2. VALIDATE (~500ms later): prominence confirms a real swing vs a
 *     plateau. Caller beeps/logs ONLY on validation, so the swing log
 *     never fills with false positives.
 *
 * Pure module: no DOM, no side effects. Feed {t, h, cx, cy} per frame.
 * t in ms, h = hot fraction 0..1, cx/cy = motion centroid 0..1 (or null
 * when nothing is hot).
 *
 * Tunables (per sensitivity level):
 *  spikeMin   absolute hot-fraction floor for a spike
 *  riseMin    min rise over riseFrames (explosive onset)
 *  riseFrames frames back for the rise comparison (~200ms at 15fps)
 *  promMin    min prominence (peak minus surrounding baseline)
 *  preMs      window before the peak for the baseline min
 *  postMs     window after the peak for the baseline min (sets the
 *             validation delay)
 *  jumpMax    max centroid displacement (normalized 0..1) from the
 *             recent median — rejects walk-throughs
 *  cooldownMs min ms between validated swings
 */

function createSwingDetector(o) {
  o = o || {};
  var spikeMin   = o.spikeMin   != null ? o.spikeMin   : 0.035;
  var riseMin    = o.riseMin    != null ? o.riseMin    : 0.020;
  var riseFrames = o.riseFrames != null ? o.riseFrames : 3;
  var promMin    = o.promMin    != null ? o.promMin    : 0.025;
  var preMs      = o.preMs      != null ? o.preMs      : 1000;
  var postMs     = o.postMs     != null ? o.postMs     : 600;
  var jumpMax    = o.jumpMax    != null ? o.jumpMax    : 0.20;
  var cooldownMs = o.cooldownMs != null ? o.cooldownMs : 3000;
  var historyMs  = Math.max(preMs + 500, 3000);

  var hist = []; // {t, h, cx, cy}, oldest first
  var lastValidatedAt = -Infinity;

  function prune(now) {
    var cut = now - historyMs - postMs;
    while (hist.length && hist[0].t < cut) hist.shift();
  }

  function medianCentroid(msBack, now) {
    var xs = [], ys = [];
    for (var i = hist.length - 1; i >= 0; i--) {
      var f = hist[i];
      if (now - f.t > msBack) break;
      if (f.cx != null && f.cy != null) { xs.push(f.cx); ys.push(f.cy); }
    }
    if (!xs.length) return null;
    xs.sort(function (a, b) { return a - b; });
    ys.sort(function (a, b) { return a - b; });
    var m = Math.floor(xs.length / 2);
    return { x: xs[m], y: ys[m] };
  }

  // Push one frame. Returns a spike event or null.
  // {t, h, cx, cy, idx} — idx lets validate() find the peak frame.
  function push(f) {
    prune(f.t);
    hist.push({ t: f.t, h: f.h, cx: f.cx, cy: f.cy });
    var n = hist.length;
    if (n <= riseFrames) return null;
    if (f.t - lastValidatedAt < cooldownMs) return null;

    var cur = hist[n - 1];
    var ref = hist[n - 1 - riseFrames];
    if (!(cur.h >= spikeMin)) return null;
    var rise = cur.h - ref.h;
    if (!(rise >= riseMin)) return null;

    // Centroid gate: the burst must be near where the batter has been.
    // A walk-through moves the centroid across the frame; a swing stays
    // in the box.
    if (cur.cx != null && cur.cy != null) {
      var med = medianCentroid(1000, f.t);
      if (med) {
        var dx = cur.cx - med.x, dy = cur.cy - med.y;
        if (Math.sqrt(dx * dx + dy * dy) > jumpMax) return null;
      }
    }

    return { t: cur.t, h: cur.h, cx: cur.cx, cy: cur.cy, idx: n - 1 };
  }

  // Validate a spike ~postMs after it fired. Returns
  // {valid, prominence, peakH, baseH} — always an object, never throws.
  function validate(spike) {
    if (!spike) return { valid: false, prominence: 0, peakH: 0, baseH: 0 };
    var t0 = spike.t, peakH = spike.h;
    var minBefore = Infinity, minAfter = Infinity;
    for (var i = 0; i < hist.length; i++) {
      var f = hist[i], dt = f.t - t0;
      if (dt >= -preMs && dt <= -100) {
        if (f.h < minBefore) minBefore = f.h;
      } else if (dt >= 100 && dt <= postMs) {
        if (f.h < minAfter) minAfter = f.h;
      }
    }
    if (minBefore === Infinity) minBefore = peakH; // no baseline: distrust
    if (minAfter === Infinity) {
      // Not enough post-peak data yet — caller should retry, not decide.
      return { valid: false, prominence: 0, peakH: peakH, baseH: 0, pending: true };
    }
    var baseH = Math.max(minBefore, minAfter);
    var prominence = peakH - baseH;
    var valid = prominence >= promMin;
    if (valid) lastValidatedAt = t0;
    return { valid: valid, prominence: prominence, peakH: peakH, baseH: baseH };
  }

  function reset() {
    hist.length = 0;
    lastValidatedAt = -Infinity;
  }

  return { push: push, validate: validate, reset: reset };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createSwingDetector: createSwingDetector };
}
