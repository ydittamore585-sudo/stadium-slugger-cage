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
  // A low line drive that stays near the z=CONTACT_HEIGHT_M init
  // assumption, projected through the real homography — the fit
  // recovers it exactly (rmse 0, dv 0). Balls arcing well above the
  // 1.22 m camera defeat the linear init; that is solver conditioning,
  // not forensics, and is out of scope here.
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

  // 2b. All-identical timestamps -> linear init singular.
  var flat = run(sb,
    "[0,1,2,3,4].map(function(k){return {u:600+k*10, v:300, t:1.0};});");
  r = run(sb, "ballisticFit(" + JSON.stringify(flat) +
    ", {H:PROFILE.homography.imageToGround,Hinv:invert3(PROFILE.homography.imageToGround),n:8,reprojMeanPx:1,live:false});");
  check("singular-init stage", r.fit === null && r.stage === "linear init fit singular",
    JSON.stringify(r.stage));

  // 2c. Degenerate homography -> unproject failure names the point.
  run(sb, "PROFILE.homography.imageToGround = [[0,0,0],[0,0,0],[0,0,0]];");
  r = run(sb, "ballisticFit(" + JSON.stringify(flat) +
    ", {H:PROFILE.homography.imageToGround,Hinv:[[1,0,0],[0,1,0],[0,0,1]],n:8,reprojMeanPx:1,live:false});");
  check("unproject-failure stage names the point",
    r.fit === null && r.stage === "unproject failed at init (point 0)",
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
  // 2e/2f. Projection-failure injection: GN loop vs final residual.
  var sb = makeSandbox();
  var st = synthTrail(sb);
  var hhSrc = "{H:PROFILE.homography.imageToGround," +
    "Hinv:invert3(PROFILE.homography.imageToGround),n:8,reprojMeanPx:1,live:false}";
  var trailSrc = JSON.stringify(st.trail);
  var n = st.trail.length;
  // Clean run: count worldToImage calls; the final residual loop is the
  // last n calls, so failing call (C - n + 1) hits its first point.
  var C = run(sb,
    "var __w=worldToImage, __c=0;" +
    "worldToImage=function(){__c++; return __w.apply(null,arguments);};" +
    "var __clean=ballisticFit(" + trailSrc + "," + hhSrc + ");" +
    "worldToImage=__w; __c;");
  var clean = run(sb, "ballisticFit(" + trailSrc + "," + hhSrc + ");");
  check("synthetic line drive fits", !!clean.fit && clean.stage === null,
    "stage=" + JSON.stringify(clean.stage));
  console.log("     (worldToImage calls on clean fit: " + C + ")");
  // Fail the first projection call -> inside the Gauss-Newton loop.
  var r = run(sb,
    "var __w2=worldToImage, __k=0;" +
    "worldToImage=function(){__k++; if(__k===1) return null;" +
    " return __w2.apply(null,arguments);};" +
    "var __r2=ballisticFit(" + trailSrc + "," + hhSrc + ");" +
    "worldToImage=__w2; __r2;");
  check("GN projection-failure stage",
    r.fit === null && r.stage === "projection failed (gauss-newton iter 0 point 0)",
    JSON.stringify(r.stage));
  // Fail the first call of the final residual loop.
  r = run(sb,
    "var __w3=worldToImage, __m=0;" +
    "worldToImage=function(){__m++; if(__m===" + (C - n + 1) + ") return null;" +
    " return __w3.apply(null,arguments);};" +
    "var __r3=ballisticFit(" + trailSrc + "," + hhSrc + ");" +
    "worldToImage=__w3; __r3;");
  check("final-residual projection-failure stage",
    r.fit === null && r.stage === "projection failed (final residual, point 0)",
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
    r.tracked === false && r.reason === "trajectory fit failed (linear init fit singular)",
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
