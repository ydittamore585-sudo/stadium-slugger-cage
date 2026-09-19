/* Unit tests for swing-detect.js — synthetic motion sequences modeled on
 * field observations (2026-09-18):
 *  - swing: quiet set -> step/load ramp -> explosive spike -> decay
 *  - heavyBatSwing: same shape, lower peak (3.5 lb trainer bat)
 *  - waggle: continuous low ripple (batter staying loose)
 *  - gettingUp: slow ramp to a sustained plateau (kid off the ground)
 *  - walking: moderate sustained motion + traveling centroid
 *  - still: nothing
 * Run: node test-swing-detect.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
var mod = require("./swing-detect.js");
var createSwingDetector = mod.createSwingDetector;

var FRAME_MS = 1000 / 15; // detector runs ~15fps
var failures = 0;

function check(name, cond, detail) {
  if (cond) { console.log("ok   " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

// Feed frames through push(); on spike, keep feeding postMs then validate.
// Simulates the real two-stage operation: spikes fire fast, validation
// comes ~postMs later, and only validated spikes count.
function runSequence(det, frames, postMs) {
  postMs = postMs == null ? 600 : postMs;
  var spikes = [];
  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];
    var ev = det.push({ t: i * FRAME_MS, h: f.h, cx: f.cx, cy: f.cy });
    if (ev) spikes.push({ ev: ev, idx: i });
  }
  var validated = [];
  spikes.forEach(function (s) {
    var v = det.validate(s.ev);
    if (v.pending) { /* not enough post data in synthetic run; treat as no */ }
    if (v.valid) validated.push({ spike: s.ev, prominence: v.prominence });
  });
  return {
    spikes: spikes.length,
    validated: validated.length,
    prominence: validated.length ? validated[0].prominence : 0
  };
}

function frames(hs, cx, cy) {
  return hs.map(function (h, i) {
    return {
      h: h,
      cx: cx == null ? 0.5 : (typeof cx === "function" ? cx(i) : cx),
      cy: cy == null ? 0.6 : (typeof cy === "function" ? cy(i) : cy)
    };
  });
}
function rep(v, n) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }
function ramp(a, b, n) {
  var r = [];
  for (var i = 0; i < n; i++) r.push(a + (b - a) * (i / (n - 1)));
  return r;
}

// --- sequences -------------------------------------------------------
function swingSeq() {
  return frames(
    rep(0.010, 30)
      .concat(ramp(0.020, 0.045, 6))   // step + load
      .concat([0.085])                  // contact spike
      .concat([0.060, 0.040])           // follow-through
      .concat(ramp(0.030, 0.010, 10))
      .concat(rep(0.010, 20))           // post window for validation
  );
}
function heavyBatSwingSeq() {
  return frames(
    rep(0.010, 30)
      .concat(ramp(0.015, 0.035, 8))
      .concat([0.052])
      .concat([0.040, 0.028])
      .concat(ramp(0.022, 0.010, 10))
      .concat(rep(0.010, 20))
  );
}
function waggleSeq() {
  var hs = [];
  for (var i = 0; i < 90; i++) hs.push(0.015 + 0.008 * Math.sin(i * 0.9));
  return frames(hs);
}
function gettingUpSeq() {
  // slow ramp, sustained plateau with one jerky lurch mid-way
  var hs = rep(0.010, 10)
    .concat(ramp(0.010, 0.070, 20))
    .concat(rep(0.065, 10))
    .concat([0.040, 0.066])             // lurch: quick jump mid-plateau
    .concat(rep(0.068, 18))
    .concat(ramp(0.068, 0.012, 15))
    .concat(rep(0.010, 20));
  // centroid drops as the kid rises (y decreases upward in frame)
  return frames(hs, 0.5, function (i) { return 0.75 - 0.25 * Math.min(1, i / 40); });
}
function walkingSeq() {
  var hs = rep(0.045, 60).concat(rep(0.010, 20));
  return frames(hs, function (i) { return 0.1 + 0.8 * Math.min(1, i / 60); }, 0.6);
}
function stillSeq() { return frames(rep(0.005, 60)); }

// --- tests -----------------------------------------------------------
var r;

r = runSequence(createSwingDetector(), swingSeq());
check("swing spikes", r.spikes >= 1);
check("swing validates", r.validated >= 1, "prominence=" + r.prominence.toFixed(3));

r = runSequence(createSwingDetector(), heavyBatSwingSeq());
check("heavy-bat swing spikes", r.spikes >= 1);
check("heavy-bat swing validates", r.validated >= 1, "prominence=" + r.prominence.toFixed(3));

r = runSequence(createSwingDetector(), waggleSeq());
check("waggle never spikes", r.spikes === 0);

r = runSequence(createSwingDetector(), gettingUpSeq());
check("getting-up never validates (plateau, low prominence)", r.validated === 0,
  "spikes=" + r.spikes + " (spikes are ok if rejected)");

r = runSequence(createSwingDetector(), walkingSeq());
check("walking never validates (sustained, not a spike)", r.validated === 0,
  "spikes=" + r.spikes);

r = runSequence(createSwingDetector(), stillSeq());
check("still never spikes", r.spikes === 0);

// BP cadence: valid swings 5s apart both validate (cooldown is 3s).
(function () {
  var d = createSwingDetector({ cooldownMs: 3000 });
  var t = 0, validated = 0;
  function pushSeq(seq) {
    for (var j = 0; j < seq.length; j++) {
      var e = d.push({ t: t, h: seq[j].h, cx: 0.5, cy: 0.6 });
      if (e) {
        // advance past postMs, then validate
        var vt = t;
        for (var k = 0; k < 12; k++) { vt += FRAME_MS; d.push({ t: vt, h: 0.01, cx: 0.5, cy: 0.6 }); }
        var v = d.validate(e);
        if (v.valid) validated++;
        t = vt;
      }
      t += FRAME_MS;
    }
  }
  pushSeq(swingSeq());
  t += 5000; // 5s gap (BP cadence)
  // quiet gap frames
  for (var q = 0; q < 30; q++) { d.push({ t: t, h: 0.008, cx: 0.5, cy: 0.6 }); t += FRAME_MS; }
  pushSeq(swingSeq());
  check("BP cadence: two swings 5s apart both validate", validated === 2, "got " + validated);
})();

// Waggle before a swing: waggle doesn't trigger, swing still validates.
(function () {
  var d = createSwingDetector();
  var t = 0, spikes = 0, validated = 0, sp = null;
  var wag = waggleSeq();
  for (var j = 0; j < wag.length; j++) {
    var e = d.push({ t: t, h: wag[j].h, cx: 0.5, cy: 0.6 });
    if (e) spikes++;
    t += FRAME_MS;
  }
  var sw = swingSeq();
  for (var k = 0; k < sw.length; k++) {
    var e2 = d.push({ t: t, h: sw[k].h, cx: 0.5, cy: 0.6 });
    if (e2 && !sp) sp = e2;
    t += FRAME_MS;
  }
  if (sp) {
    for (var m = 0; m < 12; m++) { d.push({ t: t, h: 0.01, cx: 0.5, cy: 0.6 }); t += FRAME_MS; }
    var v = d.validate(sp);
    if (v.valid) validated++;
  }
  check("waggle-then-swing: swing validates", validated === 1);
  check("waggle-then-swing: waggle caused no spike", spikes === 0, "spikes=" + spikes);
})();

// Mirrored centroid (lefty vs righty): displacement gate is direction-agnostic.
(function () {
  function swingMirrored() {
    // Same heat as swingSeq but centroid moves left instead of right.
    var s = swingSeq();
    return s.map(function (f, i) {
      return { h: f.h, cx: 0.5 - (i / s.length) * 0.25, cy: 0.6 };
    });
  }
  var r2 = runSequence(createSwingDetector(), swingMirrored());
  check("mirrored (lefty) swing validates", r2.validated >= 1);
})();

// Cooldown: frames pushed within cooldownMs of a validated swing are suppressed.
(function () {
  var d = createSwingDetector({ cooldownMs: 3000 });
  var seq = swingSeq(), sp = null;
  for (var j = 0; j < seq.length; j++) {
    var e2 = d.push({ t: j * FRAME_MS, h: seq[j].h, cx: 0.5, cy: 0.6 });
    if (e2 && !sp) sp = e2;
  }
  var v = d.validate(sp);
  check("first swing validates (cooldown test setup)", v.valid === true);
  // Immediately push hot frames inside the cooldown window: must be suppressed.
  var suppressed = true;
  for (var k = 0; k < 10; k++) {
    var e3 = d.push({ t: sp.t + 500 + k * FRAME_MS, h: 0.09, cx: 0.5, cy: 0.6 });
    if (e3) suppressed = false;
  }
  check("cooldown suppresses spikes within 3s of a validated swing", suppressed === true);
  // After the cooldown expires, spikes fire again.
  var firesAgain = false;
  for (var m = 0; m < 10; m++) {
    var e4 = d.push({ t: sp.t + 4000 + m * FRAME_MS, h: m < 3 ? 0.01 : 0.09, cx: 0.5, cy: 0.6 });
    if (e4) firesAgain = true;
  }
  check("detector re-arms after cooldown expires", firesAgain === true);
})();

// Pending: validate() before postMs of data returns pending, not a verdict.
(function () {
  var d = createSwingDetector();
  var seq = swingSeq(), sp = null, i = 0;
  for (; i < seq.length; i++) {
    var e = d.push({ t: i * FRAME_MS, h: seq[i].h, cx: 0.5, cy: 0.6 });
    if (e) { sp = e; break; }
  }
  var v = d.validate(sp); // no post-peak frames fed yet
  check("early validate() returns pending", v.pending === true && v.valid === false);
})();

// Sensitivity mapping: 'sensitive' catches a smaller spike, 'calm' ignores it.
(function () {
  var small = frames(rep(0.008, 30).concat(ramp(0.015, 0.030, 6)).concat([0.042]).concat(rep(0.012, 25)));
  var rs = runSequence(createSwingDetector({ spikeMin: 0.020, riseMin: 0.012, promMin: 0.015 }), small);
  var rc = runSequence(createSwingDetector({ spikeMin: 0.065, riseMin: 0.030, promMin: 0.040 }), small);
  check("sensitive level catches a small spike", rs.validated >= 1);
  check("calm level ignores the same spike", rc.spikes === 0);
})();

console.log(failures ? "\n" + failures + " FAILURES" : "\nall pass");
process.exit(failures ? 1 : 0);
