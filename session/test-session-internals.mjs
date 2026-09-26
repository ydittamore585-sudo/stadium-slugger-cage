/* Unit tests for session.js internals that need no browser:
 *   - preservePreRoll (the Bug A crack-pre-roll helper)
 *   - ballisticFit failure-stage forensics
 *   - analyzeSwing reason threading into the log path
 *
 * The functions under test are extracted VERBATIM from session.js (brace
 * matched) and evaluated in a vm sandbox with stubbed browser globals.
 * The source of truth stays in session.js; this file only tests it.
 * Run: node test-session-internals.mjs
 */
import { readFileSync } from "fs";
import vm from "vm";

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("ok   " + name); return true; }
  failures++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
  return false;
}

var SRC = readFileSync(new URL("./session.js", import.meta.url), "utf8");

function extractFn(name) {
  var m = SRC.match(new RegExp("function " + name + "\\s*\\("));
  if (!m) throw new Error("function " + name + " not found in session.js");
  var start = m.index, brace = SRC.indexOf("{", start), depth = 0;
  for (var i = brace; i < SRC.length; i++) {
    var ch = SRC[i];
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

// Extract `var NAME = <literal>;` — bracket/string/comment aware.
function extractVar(name) {
  var key = "var " + name + " = ";
  var si = SRC.indexOf(key);
  if (si < 0) throw new Error("var " + name + " not found in session.js");
  var i = si + key.length;
  while (SRC[i] === " " || SRC[i] === "\t") i++;
  var start = i, depth = 0, instr = null, inLine = false, inBlock = false;
  for (; i < SRC.length; i++) {
    var ch = SRC[i], nx = SRC[i + 1];
    if (instr) { if (ch === instr && SRC[i - 1] !== "\\") instr = null; continue; }
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (ch === '"' || ch === "'") { instr = ch; continue; }
    if (ch === "/" && nx === "/") { inLine = true; i++; continue; }
    if (ch === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0)
      return "var " + name + " = " + SRC.slice(start, i) + ";";
  }
  throw new Error("unterminated var " + name);
}

var FN_NAMES = ["applyH", "invert3", "linFit", "solveN", "activeHomography",
  "activeHeightScale", "imageToWorld", "worldToImage", "ballisticFit",
  "analyzeSwing", "preservePreRoll"];
var VAR_NAMES = ["PROFILE", "CAM", "CONTACT_HEIGHT_M", "FIT_RMSE_GATE_PX",
  "VPERP_NOISE_PXPS", "CONTACT_LAG_S", "MPH_PER_MPS", "CLIP_PREROLL_MS"];

function makeSandbox() {
  var parts = VAR_NAMES.map(extractVar)
    .concat(FN_NAMES.map(extractFn))
    .concat(["var clipRing = [];", "var CageCalibration = {};"]);
  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(parts.join("\n"), sandbox, { filename: "session-extract.mjs" });
  return sandbox;
}
function run(sb, code) { return vm.runInContext(code, sb); }

// ---- 1. preservePreRoll (Bug A helper) ----
(function () {
  var sb = makeSandbox();
  // 24-chunk healthy ring, 500 ms spacing — the field shape.
  var ring = [];
  for (var i = 0; i < 24; i++) ring.push({ blob: null, t: i * 500 });
  run(sb, "clipRing = " + JSON.stringify(ring) + ";");
  var pre = run(sb, "preservePreRoll(8000);");
  check("preservePreRoll keeps the 4 s spike window",
    Array.isArray(pre) && pre.length === 9, "got " + (pre && pre.length));
  check("preservePreRoll window bounds",
    pre && pre[0].t === 4000 && pre[pre.length - 1].t === 8000,
    pre && (pre[0].t + "–" + pre[pre.length - 1].t));
  // Same instant twice must return an equal window (pure function).
  var again = run(sb, "preservePreRoll(8000);");
  check("preservePreRoll is pure (equal windows)",
    JSON.stringify(again) === JSON.stringify(pre));
  // Empty ring -> empty pre-roll, never throws.
  run(sb, "clipRing = [];");
  var empty = run(sb, "preservePreRoll(8000);");
  check("preservePreRoll on empty ring", Array.isArray(empty) && empty.length === 0);
})();

// ---- 2. ballisticFit stage forensics ----
function synthTrail(sb, opts) {
  // A low line drive projected through the real homography — the fit
  // recovers it (rmse ~0, dv ~0). The 2026-09-26 grid+LM init also handles
  // balls arcing well above the 1.22 m camera (see the forward-sim sweep
  // in section 7); the old linear init could not.
  return run(sb, "(" + (function (o) {
    var Hh = {
      H: PROFILE.homography.imageToGround,
      Hinv: invert3(PROFILE.homography.imageToGround),
      n: 8, reprojMeanPx: 1.0, live: false
    };
    var p0 = { x: 0, y: 0, z: 0.9 }, v0 = { x: 20, y: 1, z: 1.5 };
    var trail = [];
    for (var k = 0; k < 8; k++) {
      var t = k / 30;
      var uv = worldToImage(Hh,
        p0.x + v0.x * t, p0.y + v0.y * t, p0.z + v0.z * t - 4.905 * t * t);
      trail.push({ u: uv[0], v: uv[1], t: t });
    }
    return { Hh: Hh, trail: trail, v0: v0 };
  }).toString() + ")(" + JSON.stringify(opts || {}) + ");");
}

(function () {
  var sb = makeSandbox();

  // 2a. Fewer than 4 points.
  var r = run(sb, "ballisticFit([{u:1,v:2,t:0},{u:3,v:4,t:0.033},{u:5,v:6,t:0.066}], null);");
  check("fewer-than-4 stage", r.fit === null && r.stage === "fewer than 4 points (3)",
    JSON.stringify(r.stage));

  // 2b. All-identical timestamps -> velocity columns of the Jacobian are
  // zero, so even the damped normal equations are singular. Fail-closed
  // with a named stage (the old linear init reported this differently;
  // the contract is fail-closed + named, not the exact string).
  var flat = run(sb,
    "[0,1,2,3,4].map(function(k){return {u:600+k*10, v:300, t:1.0};});");
  r = run(sb, "ballisticFit(" + JSON.stringify(flat) +
    ", {H:PROFILE.homography.imageToGround,Hinv:invert3(PROFILE.homography.imageToGround),n:8,reprojMeanPx:1,live:false});");
  check("flat-timestamps stage", r.fit === null && r.stage === "normal equations singular (iter 0)",
    JSON.stringify(r.stage));

  // 2c. Degenerate homography -> anchor unproject fails with a named stage.
  run(sb, "PROFILE.homography.imageToGround = [[0,0,0],[0,0,0],[0,0,0]];");
  r = run(sb, "ballisticFit(" + JSON.stringify(flat) +
    ", {H:PROFILE.homography.imageToGround,Hinv:[[1,0,0],[0,1,0],[0,0,1]],n:8,reprojMeanPx:1,live:false});");
  check("unproject-failure stage",
    r.fit === null && r.stage === "unproject failed at init",
    JSON.stringify(r.stage));
})();

(function () {
  // 2d. Constant projection -> singular normal equations.
  var sb = makeSandbox();
  var flat = run(sb,
    "[0,1,2,3,4].map(function(k){return {u:600+k*10, v:300, t:k/30};});");
  var r = run(sb, "ballisticFit(" + JSON.stringify(flat) +
    ", {H:PROFILE.homography.imageToGround,Hinv:[[0,0,5],[0,0,3],[0,0,1]],n:8,reprojMeanPx:1,live:false});");
  check("singular-normal-equations stage",
    r.fit === null && /normal equations singular \(iter \d+\)/.test(r.stage),
    JSON.stringify(r.stage));
})();

(function () {
  // 2e/2f. Projection-failure injection: LM residual vs LM jacobian.
  // The grid does exactly 8*8*24 starts x n worldToImage calls before the
  // first LM iteration (no injection during the grid, so every start
  // projects); failing a call inside LM iter 0 must fail closed with the
  // LM phase named.
  var sb = makeSandbox();
  var st = synthTrail(sb);
  var hhSrc = "{H:PROFILE.homography.imageToGround," +
    "Hinv:invert3(PROFILE.homography.imageToGround),n:8,reprojMeanPx:1,live:false}";
  var trailSrc = JSON.stringify(st.trail);
  var n = st.trail.length;
  // Call layout: the grid does 8*8*24*n projections, then the initial
  // sseOf does n, then each LM iteration interleaves per point: 1 residual
  // predict + 6 jacobian perturbs. So LM iter 0's residual point 0 is call
  // (gridCalls + n + 1) and its jacobian point 0 param 0 is (+n+2).
  var gridCalls = 8 * 8 * 24 * n;
  var clean = run(sb, "ballisticFit(" + trailSrc + "," + hhSrc + ");");
  check("synthetic line drive fits", !!clean.fit && clean.stage === null,
    "stage=" + JSON.stringify(clean.stage));
  // Fail the residual projection of LM iter 0 point 0.
  var r = run(sb,
    "var __w2=worldToImage, __k=0;" +
    "worldToImage=function(){__k++; if(__k===" + (gridCalls + n + 1) + ") return null;" +
    " return __w2.apply(null,arguments);};" +
    "var __r2=ballisticFit(" + trailSrc + "," + hhSrc + ");" +
    "worldToImage=__w2; __r2;");
  check("LM residual projection-failure stage",
    r.fit === null && r.stage === "projection failed (lm iter 0 point 0)",
    JSON.stringify(r.stage));
  // Fail the jacobian projection of LM iter 0 point 0 param 0.
  r = run(sb,
    "var __w3=worldToImage, __m=0;" +
    "worldToImage=function(){__m++; if(__m===" + (gridCalls + n + 2) + ") return null;" +
    " return __w3.apply(null,arguments);};" +
    "var __r3=ballisticFit(" + trailSrc + "," + hhSrc + ");" +
    "worldToImage=__w3; __r3;");
  check("LM jacobian projection-failure stage",
    r.fit === null && r.stage === "projection failed (lm jacobian iter 0 point 0 param 0)",
    JSON.stringify(r.stage));
})();

(function () {
  // 2g. A real ballistic trail fits, with null stage.
  var sb = makeSandbox();
  var st = synthTrail(sb);
  var r = run(sb, "ballisticFit(" + JSON.stringify(st.trail) + "," +
    " {H:PROFILE.homography.imageToGround,Hinv:invert3(PROFILE.homography.imageToGround),n:8,reprojMeanPx:1,live:false});");
  check("ballistic trail fits", !!r.fit && r.stage === null,
    "stage=" + JSON.stringify(r.stage));
  if (r.fit) {
    check("fit explains the trail (< 2 px RMSE)", r.fit.rmsePx < 2,
      r.fit.rmsePx.toFixed(3) + " px");
    var dv = Math.hypot(r.fit.v0.x - st.v0.x, r.fit.v0.y - st.v0.y, r.fit.v0.z - st.v0.z);
    check("fit recovers v0", dv < 1.5, dv.toFixed(3) + " m/s off");
    console.log("     (v0 " + r.fit.v0.x.toFixed(1) + "," + r.fit.v0.y.toFixed(1) +
      "," + r.fit.v0.z.toFixed(1) + " m/s, " + r.fit.iters + " iters)");
  }
})();

// ---- 3. analyzeSwing: reasons survive into the result/log path ----
(function () {
  var sb = makeSandbox();
  // 3a. Short trail -> honest tracked:false with reason.
  var r = run(sb, "analyzeSwing([{u:1,v:2,t:0},{u:3,v:4,t:0.033}]);");
  check("short trail -> tracked:false", r.tracked === false && r.reason === "trail too short (2 points)",
    JSON.stringify(r.reason));
  // 3b. Fit stage threads into the analysis reason verbatim.
  var flat = run(sb,
    "[0,1,2,3,4].map(function(k){return {u:600+k*10, v:300, t:1.0};});");
  r = run(sb, "analyzeSwing(" + JSON.stringify(flat) + ");");
  check("fit stage survives into analyzeSwing reason",
    r.tracked === false && r.reason === "trajectory fit failed (normal equations singular (iter 0))",
    JSON.stringify(r.reason));
})();

// ---- 4. No bare `return null` remains in ballisticFit ----
(function () {
  var body = extractFn("ballisticFit");
  var bare = body.match(/^\s*return null;$/gm);
  check("ballisticFit has no bare return null", !bare,
    bare ? bare.length + " found" : "");
  check("ballisticFit returns {fit, stage} objects",
    /return \{ fit: null, stage:/.test(body) &&
    /return \{\s*fit: \{\s*v0:/.test(body) && /stage: null\s*\}/.test(body));
})();

// ---- 4b. Grid-init + LM fitter: forward-sim ground-truth sweep ----
// Synthetic trails with KNOWN ground truth through the real PROFILE
// homography: speeds 9/15/25/35 m/s x launches 5/20/35 deg, 6 points at
// 30 fps, +/-0.5 px deterministic noise. The old Gauss-Newton init went
// "normal equations singular" on every one of these (the 9 m/s @ 20 deg
// case is the Sept 2026 field forensics case); the grid+LM fitter must
// converge with |speed| < 10%, |launch| < 5 deg, rmse < 2 px.
(function () {
  var sb = makeSandbox();
  function simTrailTruth(speed, launchDeg) {
    return run(sb, "(" + (function (sp, la) {
      var Hh = {
        H: PROFILE.homography.imageToGround,
        Hinv: invert3(PROFILE.homography.imageToGround)
      };
      var lr = la * Math.PI / 180;
      var vx = sp * Math.cos(lr), vy = 0, vz = sp * Math.sin(lr);
      var trail = [];
      for (var k = 0; k < 6; k++) {
        var t = k / 30;
        var uv = worldToImage(Hh, vx * t, vy * t,
          CONTACT_HEIGHT_M + vz * t - 4.905 * t * t);
        // Deterministic +/-0.5 px noise (not random: the suite must be stable).
        trail.push({
          u: uv[0] + 0.5 * Math.sin(k * 2.39 + 1.7),
          v: uv[1] + 0.5 * Math.cos(k * 3.71 + 0.6),
          t: t
        });
      }
      var seed = worldToImage(Hh, 0, 0, CONTACT_HEIGHT_M);
      return { trail: trail, seedPx: { u: seed[0], v: seed[1] } };
    }).toString() + ")(" + speed + "," + launchDeg + ");");
  }
  var hhSrc = "{H:PROFILE.homography.imageToGround," +
    "Hinv:invert3(PROFILE.homography.imageToGround)}";
  [9, 15, 25, 35].forEach(function (sp) {
    [5, 20, 35].forEach(function (la) {
      var st = simTrailTruth(sp, la);
      var r = run(sb, "ballisticFit(" + JSON.stringify(st.trail) + "," +
        hhSrc + "," + JSON.stringify(st.seedPx) + ");");
      var name = "fitter " + sp + "m/s @" + la + "deg";
      if (!r.fit) {
        check(name, false, "no fit, stage=" + JSON.stringify(r.stage));
        return;
      }
      var v = r.fit.v0;
      var spdHat = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      var laHat = Math.atan2(v.z, Math.sqrt(v.x * v.x + v.y * v.y)) * 180 / Math.PI;
      check(name + " converges",
        Math.abs(spdHat - sp) / sp < 0.10 && Math.abs(laHat - la) < 5 && r.fit.rmsePx < 2,
        "speed " + spdHat.toFixed(2) + " (truth " + sp + "), launch " +
        laHat.toFixed(1) + " (truth " + la + "), rmse " + r.fit.rmsePx.toFixed(2) + "px");
    });
  });
  // The exact forensics case: 9 m/s at 20 deg must recover ~20 mph.
  var fx = simTrailTruth(9, 20);
  var fr = run(sb, "ballisticFit(" + JSON.stringify(fx.trail) + "," + hhSrc + "," +
    JSON.stringify(fx.seedPx) + ");");
  var fv = fr.fit.v0;
  var fspd = Math.sqrt(fv.x * fv.x + fv.y * fv.y + fv.z * fv.z);
  check("forensics case 9m/s@20deg recovers ~20mph",
    !!fr.fit && Math.abs(fspd * 2.23694 - 20.1) < 2.5,
    fr.fit ? (fspd * 2.23694).toFixed(1) + " mph, rmse " + fr.fit.rmsePx.toFixed(2) + "px"
           : "stage=" + JSON.stringify(fr.stage));
  // No-seed fallback (anchor = first trail point) still converges.
  var ns = run(sb, "ballisticFit(" + JSON.stringify(fx.trail) + "," + hhSrc + ",null);");
  check("no-seed fallback converges", !!ns.fit && ns.fit.rmsePx < 2,
    ns.fit ? "rmse " + ns.fit.rmsePx.toFixed(2) + "px" : "stage=" + JSON.stringify(ns.stage));
})();

// ---- 4c. Garbage trail fails closed: named stage, never numbers ----
(function () {
  var sb = makeSandbox();
  // Seeded random walk: erratic +/-200 px jumps a ballistic model cannot
  // explain. Must fail closed — no exit velo, no launch angle, ever.
  var rnd = run(sb, "(function(){var a=12345;return function(){" +
    "a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);" +
    "t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};})();");
  var pts = [], gu = 640, gv = 360;
  for (var k = 0; k < 8; k++) {
    gu += (rnd() - 0.5) * 400; gv += (rnd() - 0.5) * 400;
    pts.push({ u: gu, v: gv, t: k / 30 });
  }
  var hhSrc = "{H:PROFILE.homography.imageToGround," +
    "Hinv:invert3(PROFILE.homography.imageToGround)}";
  var diag = {};
  sb.__diag = diag;
  var r = run(sb, "analyzeSwing(" + JSON.stringify(pts) + ",__diag);");
  check("garbage trail -> tracked:false",
    r.tracked === false && typeof r.reason === "string" && r.reason.length > 0,
    JSON.stringify(r.reason));
  check("garbage trail reports no numbers",
    r.exitVeloMph === undefined && r.launchAngleDeg === undefined,
    JSON.stringify(r));
  // Fail-closed forensics: either the fit itself died with a named stage,
  // or it converged with an rmse the 4px gate rejected (the reason names it).
  var gate = run(sb, "FIT_RMSE_GATE_PX;");
  check("garbage trail fails closed with forensics",
    (typeof diag.fitStage === "string" && diag.fitStage.length > 0) ||
    (typeof diag.fitRmsePx === "number" && diag.fitRmsePx > gate &&
     /trajectory fit too loose/.test(r.reason)),
    JSON.stringify({ stage: diag.fitStage, rmsePx: diag.fitRmsePx, reason: r.reason }));
})();

// ---- 4d. Fit forensics land in ballDiag ----
(function () {
  var sb = makeSandbox();
  var st = synthTrail(sb);
  var diag = {};
  sb.__diag = diag;
  run(sb, "var __hh={H:PROFILE.homography.imageToGround," +
    "Hinv:invert3(PROFILE.homography.imageToGround)};");
  var r = run(sb, "analyzeSwing(" + JSON.stringify(st.trail) + ",__diag);");
  check("tracked swing fills fit forensics",
    r.tracked === true && diag.fitStage === null &&
    typeof diag.fitRmsePx === "number" && typeof diag.fitSpeedMph === "number",
    JSON.stringify(diag));
})();

// ---- 5. watchStreamEnded: dead camera stops the clip ring ----
(function () {
  // watchStreamEnded + stopClipRing + state, with stubbed recorder globals.
  var parts = ["state", "sessionRecorder", "sessionRecorderStream",
    "clipRing", "clipHeaderChunk"].map(function (n) {
      try { return extractVar(n); }
      catch (e) {
        return n === "state" ? null :
          "var " + n + " = " + (n === "clipRing" ? "[]" : "null") + ";";
      }
    }).filter(Boolean)
    .concat([extractFn("stopClipRing"), extractFn("watchStreamEnded")]);
  var sb = {};
  vm.createContext(sb);
  vm.runInContext(parts.join("\n"), sb);

  function fakeStream(nTracks) {
    var handlers = [];
    var tracks = [];
    for (var i = 0; i < nTracks; i++) {
      tracks.push({
        readyState: "live",
        addEventListener: function (ev, fn) { if (ev === "ended") handlers.push(fn); }
      });
    }
    return {
      tracks: tracks, handlers: handlers,
      getTracks: function () { return tracks; },
      kill: function () {
        tracks.forEach(function (t) { t.readyState = "ended"; });
        handlers.forEach(function (fn) { fn(); });
      }
    };
  }

  // Case A: current stream dies -> recorder stopped, ring cleared.
  var s1 = fakeStream(2);
  sb.__s1 = s1; sb.__rec = { stopped: false, state: "recording",
    stop: function () { this.stopped = true; } };
  run(sb, "state.stream = __s1; sessionRecorder = __rec;" +
    "sessionRecorderStream = __s1; clipRing = [{t:1}]; clipHeaderChunk = new Uint8Array([1]);");
  run(sb, "watchStreamEnded(__s1);");
  s1.kill();
  var stopped = run(sb, "({ rec: sessionRecorder, ring: clipRing.length })");
  check("dead stream stops the recorder", stopped.rec === null && sb.__rec.stopped === true,
    JSON.stringify({ recNull: stopped.rec === null, stopCalled: sb.__rec.stopped }));
  check("dead stream clears the ring", stopped.ring === 0, "ring=" + stopped.ring);

  // Case B: one track ends but another is live -> ring keeps running.
  var s2 = fakeStream(2);
  sb.__s2 = s2;
  sb.__rec2 = { stopped: false, state: "recording", stop: function () { this.stopped = true; } };
  run(sb, "state.stream = __s2; sessionRecorder = __rec2; sessionRecorderStream = __s2;");
  run(sb, "watchStreamEnded(__s2);");
  s2.tracks[0].readyState = "ended";
  s2.handlers.forEach(function (fn) { fn(); });
  check("partial track end keeps the ring",
    sb.__rec2.stopped === false && run(sb, "sessionRecorder === __rec2;") === true);

  // Case C: old stream's ended fires after a switch -> must not stop the new ring.
  var s3 = fakeStream(1), s4 = fakeStream(1);
  sb.__s3 = s3; sb.__s4 = s4;
  sb.__rec4 = { stopped: false, state: "recording", stop: function () { this.stopped = true; } };
  run(sb, "watchStreamEnded(__s3);");
  run(sb, "state.stream = __s4; sessionRecorder = __rec4; sessionRecorderStream = __s4;");
  s3.kill(); // stale ended event from the pre-switch stream
  check("stale ended event after switch is ignored", sb.__rec4.stopped === false);
})();

// ---- 6. Footer ownership: session.js stamps, cast.js doesn't ----
(function () {
  var castSrc = readFileSync(new URL("./cast.js", import.meta.url), "utf8");
  check("cast.js never touches #build-tag",
    castSrc.indexOf('build-tag') < 0, "found a build-tag reference in cast.js");
  check("cast.js never wires #btn-refresh",
    castSrc.indexOf('btn-refresh') < 0, "found a btn-refresh reference in cast.js");
  // session.js's DOMContentLoaded block must stamp both tags and wire Refresh.
  var dlStart = SRC.indexOf('document.addEventListener("DOMContentLoaded"');
  var dlBlock = SRC.slice(dlStart, SRC.indexOf("});", dlStart) + 3);
  check("session.js stamps #build-tag from SESSION_BUILD",
    dlBlock.indexOf('getElementById("build-tag")') >= 0 &&
    dlBlock.indexOf("SESSION_BUILD") >= 0);
  check("session.js stamps #build-tag-top",
    dlBlock.indexOf('getElementById("build-tag-top")') >= 0);
  check("session.js wires #btn-refresh with a cache-busting reload",
    dlBlock.indexOf('getElementById("btn-refresh")') >= 0 &&
    dlBlock.indexOf('location.replace(location.pathname + "?fresh=" + Date.now())') >= 0);
})();

console.log(failures ? "\n" + failures + " FAILURES" : "\nall pass");
process.exit(failures ? 1 : 0);
