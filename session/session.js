/**
 * Stadium Slugger — Cage Edition: Session Recorder + Swing Analyzer.
 *
 * Loads the validated cage calibration profile, records the session via
 * MediaRecorder, auto-detects swings from motion energy, tracks the ball
 * post-contact, and computes per-swing metrics in imperial units.
 *
 * Units: math core stays metric (meters). UI boundary converts to
 * imperial (1 ft = 0.3048 m exactly). All user-facing numbers are
 * feet, mph, degrees.
 *
 * Honesty: if the ball track fails quality gates, the swing is logged
 * as "no track" — never a fabricated number.
 */
(function () {
"use strict";

/* ------------------------------------------------------------------ */
/* Validated calibration profile (embedded for offline cage use).      */
/* Source: cage-calibration-profile-validated.json, 2026-09-17.        */
/* Camera: 4 ft high, ~6 ft behind plate, ~6.5 ft toward 1st base.     */
/* ------------------------------------------------------------------ */
var PROFILE = {
  homography: {
    imageToGround: [
      [0.004914287302388143, 0.018420795950945958, -16.08360332080008],
      [-0.007497504306005231, 0.015441288766461855, -3.029988240288624],
      [-0.0011574761337856312, -0.004265839813953498, 1]
    ]
  },
  camera: { heightM: 1.2192, distanceBehindPlateM: 1.8288, sideOffsetM: 1.9812 },
  heightScale: { pxPerM: 177.85 }, // mean of 173.73 / 181.97 samples
  verified: true,
  label: "calibrated"
};

// Camera center in world meters: x behind plate (-), y toward 1st (+), z up.
var CAM = {
  x: -PROFILE.camera.distanceBehindPlateM,
  y:  PROFILE.camera.sideOffsetM,
  z:  PROFILE.camera.heightM
};

var FT_PER_M = 1 / 0.3048;   // 3.28084
var MPH_PER_MPS = 2.23694;

/* ------------------------------------------------------------------ */
/* 3D math: image (u,v) + assumed height z -> world (x,y,z).           */
/* Ray from camera center through the ground-projected point.          */
/* ------------------------------------------------------------------ */
function imageToWorld(u, v, zAssumedM) {
  // Prefer the live phone calibration (tap-calibrated on this session's feed)
  // over the built-in profile. Falls back to PROFILE when no live calibration
  // has been applied yet. Both are 3x3 nested arrays, meters.
  var H = activeHomography().H;
  if (!H) return null;
  var g = CageCalibration.applyH
    ? CageCalibration.applyH(H, u, v)
    : applyH(H, u, v);
  if (!g) return null;
  var xg0 = g[0], yg0 = g[1];
  // Ray: C + t*(G0 - C), solve for z(t) = zAssumedM.
  var t = (CAM.z - zAssumedM) / CAM.z;
  if (!isFinite(t)) return null;
  return {
    x: CAM.x + t * (xg0 - CAM.x),
    y: CAM.y + t * (yg0 - CAM.y),
    z: zAssumedM
  };
}

// Local fallback if CageCalibration.applyH is unavailable.
function applyH(H, u, v) {
  var w = H[2][0]*u + H[2][1]*v + H[2][2];
  if (!isFinite(w) || Math.abs(w) < 1e-12) return null;
  return [
    (H[0][0]*u + H[0][1]*v + H[0][2]) / w,
    (H[1][0]*u + H[1][1]*v + H[1][2]) / w
  ];
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */
var video = document.getElementById("cam");
var overlay = document.getElementById("overlay");
var octx = overlay.getContext("2d");
// Camera-live check: the swing detector runs automatically whenever the
// camera feed is actually delivering frames. Saving (state.recording) is
// a separate user choice — it only controls whether swings are logged.
function cameraLive() {
  return !!(video.srcObject && video.readyState >= 2);
}
var btnStart = document.getElementById("btn-start");
var btnStop = document.getElementById("btn-stop");
var btnMark = document.getElementById("btn-mark");
if (btnMark) btnMark.addEventListener("click", function () {
  if (cameraLive()) markSwingManual();
});
// CageCast TV display — App ID from localStorage (set after Cast SDK registration)
var btnCast = document.getElementById("btn-cast");
if (window.CageCast && btnCast) {
  var castAppId = null;
  try { castAppId = localStorage.getItem('cagecast_app_id'); } catch (e) {}
  CageCast.init({
    appId: castAppId || '62FE612A',
    button: btnCast,
    onStateChange: function(connected) {
      if (connected) CageCast.session(cameraLive() ? 'live' : 'idle');
    }
  });
}
var btnDownload = document.getElementById("btn-download");
var statusEl = document.getElementById("session-status");
var swingLogEl = document.getElementById("swing-log");
var profileInfoEl = document.getElementById("profile-info");

var mSwings = document.getElementById("m-swings");
var mEV = document.getElementById("m-ev");
var mLA = document.getElementById("m-la");
var mRec = document.getElementById("m-rec");

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */
var state = {
  recording: false,
  mediaRecorder: null,
  recordedChunks: [],
  sessionStart: 0,
  swings: [],
  swingCount: 0,
  stream: null,
  // Step 9: stream-lifecycle forensics.
  streamGaps: [],   // [{startSec, endSec}] — the inbound feed was dead
  streamOK: true,   // false while the phone track is muted/disconnected
  gapStart: 0,      // session-seconds when the current gap began
  clipMime: null    // MIME string chosen for the clip recorder
};

// Processing canvas (downscaled for speed).
var proc = document.createElement("canvas");
var pctx = proc.getContext("2d", { willReadFrequently: true });
var PROC_W = 320, PROC_H = 180;
proc.width = PROC_W; proc.height = PROC_H;

// Motion detection state.
var prevFrame = null;
var swingCooldownUntil = 0;
var COOLDOWN_MS = 3000; // min ms between logged swings (debounce double-triggers)
var pendingSwing = null; // { t0, ballTrack: [] }
var wakeLock = null;

profileInfoEl.textContent =
  "Profile: " + PROFILE.label + " (verified=" + PROFILE.verified + "), " +
  "camera 4 ft high / 6 ft behind plate / 6.5 ft toward 1st base. " +
  "Reprojection 1.54 px mean. " +
  "Place the camera in the calibrated spot before starting.";

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */
/* Camera picker: enumerate this device's cameras, remember the choice in
   localStorage, and allow switching mid-session. The detector loop and
   ball tracker read the live `video` element, so they follow the swap;
   the clip ring restarts itself on the new stream via ensureClipRing. */
var CAM_DEVICE_KEY = "cage.cameraDeviceId";

function savedCameraDeviceId() {
  try { return localStorage.getItem(CAM_DEVICE_KEY) || ""; } catch (e) { return ""; }
}
function saveCameraDeviceId(id) {
  try {
    if (id) localStorage.setItem(CAM_DEVICE_KEY, id);
    else localStorage.removeItem(CAM_DEVICE_KEY);
  } catch (e) {}
}
function activeCameraDeviceId() {
  try {
    var t = state.stream && state.stream.getVideoTracks()[0];
    var s = t && t.getSettings();
    return (s && s.deviceId) || "";
  } catch (e) { return ""; }
}

function initCamera(deviceId) {
  var id = (deviceId === undefined) ? savedCameraDeviceId() : deviceId;
  var constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: false
  };
  if (id) constraints.video.deviceId = { exact: id };
  else constraints.video.facingMode = "environment";
  return navigator.mediaDevices.getUserMedia(constraints).then(attachLocalStream, function (err) {
    // Saved camera vanished (unplugged)? Forget it and try the default once.
    if (id) {
      saveCameraDeviceId("");
      return initCamera("");
    }
    throw err;
  });
}

function attachLocalStream(stream) {
  state.stream = stream;
  video.srcObject = stream;
  return new Promise(function (resolve) {
    var settled = false;
    function done() {
      if (settled) return;
      settled = true;
      overlay.width = video.videoWidth || 1280;
      overlay.height = video.videoHeight || 720;
      resolve();
    }
    video.onloadedmetadata = done;
    if (video.readyState >= 1) done(); // swap path: metadata may already be present
  });
}

function listCameras() {
  var sel = document.getElementById("camera-select");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  var want = savedCameraDeviceId() || activeCameraDeviceId();
  navigator.mediaDevices.enumerateDevices().then(function (devs) {
    var cams = devs.filter(function (d) { return d.kind === "videoinput"; });
    var prev = sel.value;
    sel.innerHTML = "";
    if (!cams.length) {
      var o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = "No cameras found";
      sel.appendChild(o0);
      return;
    }
    cams.forEach(function (d, i) {
      var o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || ("Camera " + (i + 1));
      sel.appendChild(o);
    });
    var pick = "";
    for (var i = 0; i < cams.length; i++) {
      if (cams[i].deviceId === want) { pick = want; break; }
    }
    sel.value = pick || prev;
    if (!sel.value && cams.length) sel.value = cams[0].deviceId;
  }).catch(function () {});
}

function switchLocalCamera(deviceId) {
  if (remoteMode || !deviceId || deviceId === activeCameraDeviceId()) return;
  saveCameraDeviceId(deviceId);
  if (state.stream) {
    try { state.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  }
  state.stream = null;
  statusEl.textContent = "Switching camera…";
  btnStart.disabled = true;
  initCamera(deviceId).then(function () {
    btnStart.disabled = false;
    statusEl.textContent = "Camera live — swings show on TV, hit Save to log them";
    ensureLoop();
    listCameras();
  }).catch(function () {
    statusEl.textContent = "Couldn't open that camera — pick another.";
    btnStart.disabled = false;
  });
}

/* ------------------------------------------------------------------ */
/* Motion detection → swing trigger                                    */
/* ------------------------------------------------------------------ */
// A swing is big, fast, SUSTAINED motion — not a one-frame shimmer.
// Per frame we measure, inside the swing ROI:
//   hotFrac    fraction of sampled pixels whose luma changed hard
//   biasRatio  |sum of signed diffs| / sum of |diffs|
//              (~1 = the whole frame got brighter/darker = auto-exposure,
//              not a swing)
// A swing needs hotFrac above the sensitivity threshold for several
// frames in a row; then the scene must go quiet before re-arming, so one
// long motion can't log a burst of phantom swings.
// The trigger ROI covers the full cage width: the batter's position in
// the frame moves with the phone mount, and a hardcoded box in the middle
// of the frame silently misses real swings (30+ unlogged) while firing on
// irrelevant motion elsewhere. Thresholds are scaled for the larger area
// (hotFrac is a fraction of ROI pixels).
var SWING_ROI = { x: 0, y: 0.25, w: 1.0, h: 0.55 };
var HOT_PX_DIFF = 14;        // |luma diff| for a pixel to count as moving hard
var BIAS_REJECT = 0.6;       // biasRatio above this = exposure shift: ignore
var SENS_LEVELS = {
  calm:      { spikeMin: 0.055, promMin: 0.040, riseMin: 0.030 },
  normal:    { spikeMin: 0.035, promMin: 0.025, riseMin: 0.020 },
  sensitive: { spikeMin: 0.020, promMin: 0.015, riseMin: 0.012 }
};
var motionLevel = "normal";
var swingDetector = null; // created in startSession/reset
var pendingSpike = null;  // {spike, ballTrackPromise} — awaiting validation
var lastHotFrac = 0; // latest motion reading, for manual-mark detector snapshots
var motionSeed = null; // {x, y (0-1 frame-normalized), t} — freshest motion centroid

function createDetector() {
  var s = SENS_LEVELS[motionLevel] || SENS_LEVELS.normal;
  swingDetector = createSwingDetector({
    spikeMin: s.spikeMin, promMin: s.promMin, riseMin: s.riseMin,
    riseFrames: 3, preMs: 1000, postMs: 600, jumpMax: 0.20, cooldownMs: 3000
  });
  pendingSpike = null;
}

function frameMotion() {
  pctx.drawImage(video, 0, 0, PROC_W, PROC_H);
  var img = pctx.getImageData(0, 0, PROC_W, PROC_H);
  var d = img.data;
  var rx = Math.floor(SWING_ROI.x * PROC_W),
      ry = Math.floor(SWING_ROI.y * PROC_H),
      rw = Math.floor(SWING_ROI.w * PROC_W),
      rh = Math.floor(SWING_ROI.h * PROC_H);
  var hot = 0, total = 0, energy = 0, signed = 0;
  var hotSumX = 0, hotSumY = 0; // centroid of hot pixels (Step 4: seed the ball search)
  if (prevFrame) {
    for (var y = ry; y < ry + rh; y += 2) {
      for (var x = rx; x < rx + rw; x += 2) {
        var i = (y * PROC_W + x) * 4;
        // Luma approx from RGB.
        var luma = (d[i] * 3 + d[i+1] * 6 + d[i+2]) / 10;
        var pluma = (prevFrame[i] * 3 + prevFrame[i+1] * 6 + prevFrame[i+2]) / 10;
        var diff = luma - pluma;
        var ad = diff < 0 ? -diff : diff;
        energy += ad;
        signed += diff;
        total++;
        if (ad > HOT_PX_DIFF) { hot++; hotSumX += x; hotSumY += y; }
      }
    }
  }
  prevFrame = new Uint8ClampedArray(d);
  return {
    hotFrac: total ? hot / total : 0,
    biasRatio: energy > 0 ? Math.abs(signed) / energy : 0,
    // Centroid of motion in PROC-space px, or null when nothing is hot.
    hotX: hot ? hotSumX / hot : null,
    hotY: hot ? hotSumY / hot : null
  };
}

/* ------------------------------------------------------------------ */
/* Ball tracking (post-swing).                                         */
/* Looks for a small bright blob moving away from the plate region.    */
/* ------------------------------------------------------------------ */
var BALL_TRACK_FRAMES = 24;      // unique frames (~0.8 s at 30 fps of ball flight)
var BALL_TRACK_TIMEOUT_MS = 3000;
var BALL_MIN_DISPLACEMENT_PX = 8; // full-res px over the track

// Cheap duplicate-frame detector: the phone stream often runs below
// 30 fps, and three-frame differencing on duplicate frames sees zero
// motion — which silently kills the ball search. Sampled luma checksum.
function frameHash(img) {
  var d = img.data, h = 0;
  var step = Math.max(4, Math.floor(d.length / 256 / 4) * 4);
  for (var i = 0; i < d.length; i += step) h = (h * 31 + d[i]) | 0;
  return h;
}

function trackBall(seed) {
  // Capture UNIQUE frames for up to ~0.8 s of real ball flight.
  // requestVideoFrameCallback grabs on actual new presented frames;
  // the setTimeout fallback skips duplicates via frameHash.
  var cap = document.createElement("canvas");
  cap.width = video.videoWidth; cap.height = video.videoHeight;
  var cctx = cap.getContext("2d", { willReadFrequently: true });
  var frames = [], times = [];
  return new Promise(function (resolve) {
    var t0 = performance.now(), done = false;
    var lastHash = 0, haveHash = false, frozen = 0;
    function finish() {
      if (done) return;
      done = true;
      resolve(detectBallTrail(frames, cap.width, cap.height, seed, times));
    }
    // Watchdog: rVFC stops firing if the stream freezes, so the timeout
    // must not depend on grab() being called again.
    setTimeout(finish, BALL_TRACK_TIMEOUT_MS);
    function grab() {
      if (done) return;
      cctx.drawImage(video, 0, 0, cap.width, cap.height);
      var img = cctx.getImageData(0, 0, cap.width, cap.height);
      var h = frameHash(img);
      if (!haveHash || h !== lastHash) {
        haveHash = true; lastHash = h; frozen = 0;
        frames.push(img);
        times.push((performance.now() - t0) / 1000);
      } else if (++frozen > 60) { finish(); return; } // stream frozen mid-track
      if (frames.length >= BALL_TRACK_FRAMES) { finish(); return; }
      if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(function () { grab(); });
      else setTimeout(grab, 34);
    }
    grab();
  });
}

var BALL_SCORE_GATE = 120; // achievable: per-pixel max is 765 (motion) * 1 * 1

function detectBallTrail(frames, W, H, seed, times) {
  // Three-frame differencing + blob check.
  // motion(x,y,t) = min(|I(t)-I(t-1)|, |I(t+1)-I(t)|): a pixel must differ
  // from BOTH neighbors, which rejects single-frame flashes (sensor noise,
  // compression artifacts) and keeps consistently moving objects.
  // A real ball is a small bright blob: 4-20 bright px in a 5x5 window.
  // score = motion * (bright/255) * blobFactor; per-pixel max = 765*1*1.
  // The old gate (>900) was mathematically impossible — no trail ever passed.
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
    if (best && bestScore > BALL_SCORE_GATE) trail.push({ u: best.x, v: best.y, t: (times && times[f] != null) ? times[f] : f / 30 });
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

/* ------------------------------------------------------------------ */
/* Small linear algebra for the trajectory fits.                       */
/* ------------------------------------------------------------------ */
function invert3(m) {
  var a = m[0][0], b = m[0][1], c = m[0][2];
  var d = m[1][0], e = m[1][1], f = m[1][2];
  var g = m[2][0], h = m[2][1], i = m[2][2];
  var A = e*i - f*h, B = f*g - d*i, C = d*h - e*g;
  var det = a*A + b*B + c*C;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [A / det, (c*h - b*i) / det, (b*f - c*e) / det],
    [B / det, (a*i - c*g) / det, (c*d - a*f) / det],
    [C / det, (b*g - a*h) / det, (a*e - b*d) / det]
  ];
}

// General NxN linear solve: Gaussian elimination with partial pivoting.
// Null when singular.
function solveN(M, rhs) {
  var n = rhs.length;
  var A = M.map(function (row) { return row.slice(); });
  var x = rhs.slice();
  for (var col = 0; col < n; col++) {
    var piv = col;
    for (var r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      var t = A[col]; A[col] = A[piv]; A[piv] = t;
      var tx = x[col]; x[col] = x[piv]; x[piv] = tx;
    }
    for (var r2 = col + 1; r2 < n; r2++) {
      var f = A[r2][col] / A[col][col];
      for (var c2 = col; c2 < n; c2++) A[r2][c2] -= f * A[col][c2];
      x[r2] -= f * x[col];
    }
  }
  var out = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    var s = x[i];
    for (var j = i + 1; j < n; j++) s -= A[i][j] * out[j];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    out[i] = s / A[i][i];
  }
  return out;
}

// 3x3 linear solve (Gaussian elimination, partial pivoting). Null if singular.
function solve3(M, rhs) {
  return solveN(M, rhs);
}

// Ballistic fit: p(t) = p0 + v0*t - 0.5*g*t^2 in z, Gauss-Newton over the
// 6 params [x0,y0,z0,vx,vy,vz] minimizing reprojection error in px.
// Exact perspective handling — no per-frame height assumption, no
// image-space polynomial approximation. Returns {v0, p0, rmsePx} or null.
// NOTE: v0 is the velocity at the FIRST TRAIL POINT (~1 frame after
// contact); analyzeSwing gravity-corrects vz back to contact time.
function ballisticFit(trail, Hh) {
  var n = trail.length;
  if (n < 4) return null; // 2n equations, 6 unknowns — need margin
  var G = 9.81;
  // Initial guess: unproject at contact height, linear fit for velocity.
  var ts = [], xs = [], ys = [];
  for (var k = 0; k < n; k++) {
    var w = imageToWorld(trail[k].u, trail[k].v, CONTACT_HEIGHT_M);
    if (!w) return null;
    ts.push(trail[k].t - trail[0].t); xs.push(w.x); ys.push(w.y);
  }
  var fx = linFit(ts, xs), fy = linFit(ts, ys);
  if (!fx || !fy) return null;
  var th = [fx.c, fy.c, CONTACT_HEIGHT_M, fx.b, fy.b, 0]; // [x0,y0,z0,vx,vy,vz]

  function predict(th, t) {
    return worldToImage(Hh,
      th[0] + th[3] * t,
      th[1] + th[4] * t,
      th[2] + th[5] * t - 0.5 * G * t * t);
  }

  var iter = 0;
  for (iter = 0; iter < 15; iter++) {
    var r = new Array(2 * n);
    var J = [];
    for (var k2 = 0; k2 < 2 * n; k2++) J.push([0, 0, 0, 0, 0, 0]);
    var ok = true;
    for (var k3 = 0; k3 < n; k3++) {
      var t = trail[k3].t - trail[0].t;
      var pr = predict(th, t);
      if (!pr) { ok = false; break; }
      r[2 * k3] = pr[0] - trail[k3].u;
      r[2 * k3 + 1] = pr[1] - trail[k3].v;
      for (var p = 0; p < 6; p++) {
        var h = Math.max(1e-7, Math.abs(th[p]) * 1e-6);
        var th2 = th.slice(); th2[p] += h;
        var pr2 = predict(th2, t);
        if (!pr2) { ok = false; break; }
        J[2 * k3][p] = (pr2[0] - pr[0]) / h;
        J[2 * k3 + 1][p] = (pr2[1] - pr[1]) / h;
      }
      if (!ok) break;
    }
    if (!ok) return null;
    // Normal equations: (J^T J) d = -J^T r.
    var JTJ = [], JTr = [0, 0, 0, 0, 0, 0];
    for (var a = 0; a < 6; a++) {
      JTJ.push([0, 0, 0, 0, 0, 0]);
      for (var b = 0; b < 6; b++) {
        var s = 0;
        for (var m = 0; m < 2 * n; m++) s += J[m][a] * J[m][b];
        JTJ[a][b] = s;
      }
      var sr = 0;
      for (var m2 = 0; m2 < 2 * n; m2++) sr += J[m2][a] * r[m2];
      JTr[a] = -sr;
    }
    var d = solveN(JTJ, JTr);
    if (!d) return null;
    var maxStep = 0;
    for (var q = 0; q < 6; q++) {
      th[q] += d[q];
      if (Math.abs(d[q]) > maxStep) maxStep = Math.abs(d[q]);
    }
    if (maxStep < 1e-9) break;
  }
  var se = 0;
  for (var k4 = 0; k4 < n; k4++) {
    var t4 = trail[k4].t - trail[0].t;
    var pr4 = predict(th, t4);
    if (!pr4) return null;
    se += (pr4[0] - trail[k4].u) * (pr4[0] - trail[k4].u) +
          (pr4[1] - trail[k4].v) * (pr4[1] - trail[k4].v);
  }
  return {
    v0: { x: th[3], y: th[4], z: th[5] },
    p0: { x: th[0], y: th[1], z: th[2] },
    rmsePx: Math.sqrt(se / (2 * n)),
    iters: iter + 1
  };
}

// Linear least squares: p(t) = b*t + c. Initial-guess workhorse.
function linFit(ts, ps) {
  var n = ts.length;
  if (n < 2) return null;
  var St = 0, Sp = 0, Stt = 0, Stp = 0;
  for (var i = 0; i < n; i++) {
    St += ts[i]; Sp += ps[i]; Stt += ts[i] * ts[i]; Stp += ts[i] * ps[i];
  }
  var denom = n * Stt - St * St;
  if (Math.abs(denom) < 1e-12) return null;
  var b = (n * Stp - St * Sp) / denom;
  var c = (Sp - b * St) / n;
  var se = 0;
  for (var j = 0; j < n; j++) {
    var r = ps[j] - (b * ts[j] + c);
    se += r * r;
  }
  return { a: 0, b: b, c: c, rmse: Math.sqrt(se / n) };
}

/* ------------------------------------------------------------------ */
/* Active calibration: live phone homography preferred, PROFILE fallback.
   Always returns {H, Hinv} as 3x3 nested arrays.                       */
/* ------------------------------------------------------------------ */
function activeHomography() {
  var live = (typeof window !== "undefined" && window.SessionApp &&
              window.SessionApp.phoneCalibration) || null;
  var H = (live && live.H) ? live.H : PROFILE.homography.imageToGround;
  var Hinv = (live && live.Hinv) ? live.Hinv : invert3(H);
  return { H: H, Hinv: Hinv };
}

// Step 12: height scale for the vz noise floor. Prefer the phone
// calibration's bat-measured value (mount-specific) over the baked-in
// laptop-chair number — silently using the chair value at the phone's
// depth is a wrong constant wearing a right-looking label.
function activeHeightScale() {
  try {
    var live = window.SessionApp && window.SessionApp.phoneCalibration;
    var h = live && live.heightScalePxPerM;
    if (isFinite(h) && h > 0) return h;
  } catch (e) {}
  return PROFILE.heightScale.pxPerM;
}

// worldToImage: invert the ray model. World (x,y) at height z (m) -> pixel.
// From imageToWorld: (x,y) = C_xy + t*(G0-C_xy), t=(C.z-z)/C.z,
// so G0 = C_xy + ((x,y)-C_xy)/t, then (u,v) = applyH(Hinv, G0).
function worldToImage(Hh, x, y, z) {
  if (!Hh.Hinv || !isFinite(CAM.z) || Math.abs(CAM.z) < 1e-6) return null;
  var t = (CAM.z - z) / CAM.z;
  if (Math.abs(t) < 1e-6) return null;
  var gx = CAM.x + (x - CAM.x) / t;
  var gy = CAM.y + (y - CAM.y) / t;
  return applyH(Hh.Hinv, gx, gy);
}

/* ------------------------------------------------------------------ */
/* Metrics (imperial out).                                             */
/* ------------------------------------------------------------------ */
var CONTACT_HEIGHT_M = 0.914; // 3 ft assumed contact height
var FIT_RMSE_GATE_PX = 4;     // ballistic fit must explain the trail to 4 px
var VPERP_NOISE_PXPS = 45;    // 1.5 px/frame @ 30 fps: below this, LA is noise
var CONTACT_LAG_S = 1 / 30;   // first trail point lags contact by ~1 frame;
                              // vz is gravity-corrected back to contact time

function analyzeSwing(trail) {
  if (!trail) {
    return { tracked: false, reason: "ball not tracked reliably" };
  }
  var n = trail.length;
  if (n < 4) return { tracked: false, reason: "trail too short (" + n + " points)" };

  var Hh = activeHomography();
  if (!Hh.H || !Hh.Hinv) return { tracked: false, reason: "no calibration available" };

  // Joint 3D ballistic fit — the residual is the honest fit quality.
  var fit = ballisticFit(trail, Hh);
  if (!fit) return { tracked: false, reason: "trajectory fit failed" };
  if (fit.rmsePx > FIT_RMSE_GATE_PX) {
    return { tracked: false, reason: "trajectory fit too loose (" + fit.rmsePx.toFixed(1) + " px RMSE)" };
  }

  var vx = fit.v0.x, vy = fit.v0.y;
  // The fit's vz is at the first trail point (~1 frame after contact).
  // Gravity-correct back to contact time for an honest launch angle.
  var vz = fit.v0.z + 9.81 * CONTACT_LAG_S;
  var vHoriz = Math.sqrt(vx * vx + vy * vy);
  if (vHoriz < 3) return { tracked: false, reason: "ball too slow to be a batted ball" };

  // Launch angle: the fitted vz, gated by the centroid noise floor.
  // Below the floor, LA is "insufficient evidence" — never a fake ~0°.
  var launchAngleDeg = null;
  var w0 = imageToWorld(trail[0].u, trail[0].v, CONTACT_HEIGHT_M);
  if (w0) {
    var distBall = Math.sqrt((w0.x - CAM.x) * (w0.x - CAM.x) + (w0.y - CAM.y) * (w0.y - CAM.y));
    var distCalib = Math.sqrt(1.9 * 1.9 + 1.5 * 1.5); // calib sample at ~(1.9,1.5)
    var pxPerM_local = activeHeightScale() * (distCalib / distBall);
    var vzNoise = VPERP_NOISE_PXPS / pxPerM_local; // m/s
    if (Math.abs(vz) >= vzNoise) {
      launchAngleDeg = Math.atan2(vz, vHoriz) * 180 / Math.PI;
    }
  }

  var speedMps = Math.sqrt(vx * vx + vy * vy + vz * vz);
  var exitVeloMph = speedMps * MPH_PER_MPS;
  var sprayDeg = Math.atan2(vy, vx) * 180 / Math.PI; // 0 = straightaway center

  // Sanity gates (fail-closed).
  if (exitVeloMph < 25 || exitVeloMph > 130) {
    return { tracked: false, reason: "exit velo outside plausible range (" + exitVeloMph.toFixed(0) + " mph)" };
  }

  var direction;
  if (sprayDeg > 15) direction = "pull (left)";
  else if (sprayDeg < -15) direction = "oppo (right)";
  else direction = "center";

  return {
    tracked: true,
    exitVeloMph: exitVeloMph,
    launchAngleDeg: launchAngleDeg,
    sprayDeg: sprayDeg,
    direction: direction,
    fitRmsePx: +fit.rmsePx.toFixed(2),
    fitModel: "ballistic-3d",
    note: "uncalibrated estimate — needs radar truth data"
  };
}

/* Audible swing feedback: one beep = swing detected, a second higher
   beep = ball tracked with numbers. Lets the batter tune the detector by
   ear without watching the laptop. */
var audioCtx = null, soundOn = true;
function beep(freq, durMs) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    var t = audioCtx.currentTime;
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + durMs / 1000 + 0.05);
  } catch (e) { /* audio is a nicety; never break the session */ }
}
document.getElementById("btn-sound").addEventListener("click", function (ev) {
  soundOn = !soundOn;
  ev.target.textContent = soundOn ? "🔊 Sound on" : "🔇 Sound off";
  if (soundOn) beep(880, 120);
});

/* ------------------------------------------------------------------ */
/* Swing pipeline: two-stage recognition                               */
/*  1. SPIKE (immediate): motion signature starts. Preserve pre-roll   */
/*     and start ball tracking NOW — the ball is already flying.       */
/*  2. VALIDATE (~600ms later): prominence confirms a real swing.       */
/*     Only then: beep, log, assemble clip.                            */
/*  If validation rejects, the provisional work is discarded silently. */
/* ------------------------------------------------------------------ */
function onSpike(spike) {
  // Preserve the pre-roll window immediately (time-based, not count-based).
  var tSpike = spike.t;
  var preStart = tSpike - CLIP_PREROLL_MS;
  var preChunks = [];
  for (var i = 0; i < clipRing.length; i++) {
    if (clipRing[i].t >= preStart && clipRing[i].t <= tSpike) preChunks.push(clipRing[i]);
  }
  // Start ball tracking NOW — don't wait for validation.
  var ballPromise = null;
  try {
    if (motionSeed) ballPromise = trackBall(motionSeed);
  } catch (e) { ballPromise = null; }
  pendingSpike = { spike: spike, preChunks: preChunks, ballPromise: ballPromise, tSpike: tSpike };
}

function onSpikeRejected(ps) {
  // Validation said "not a swing" (waggle, getting up, walking).
  // Discard the provisional ball track; keep the pre-roll chunks in the
  // ring (they're still valid history for the next spike).
  if (ps.ballPromise && ps.ballPromise.cancel) {
    try { ps.ballPromise.cancel(); } catch (e) {}
  }
  // No beep, no log, no clip. Silent by design.
}

function onSwingValidated(ps) {
  logSwing(false, ps);
}

function markSwingManual() {
  logSwing(true, null);
}

// Single funnel for auto-detected and manually marked swings.
// Manual marks are ground truth: they bypass the cooldown entirely (a
// manual mark is never suppressed by a nearby auto event, nor does it
// suppress auto events). Auto and manual events within ±1.5 s are linked
// by ID so detector recall can be measured honestly afterward.
// Detection is automatic (camera live = detector on). Saving is the user's
// choice: only when state.recording is true are swings logged to the
// session, clips captured, and recall links built. The TV always gets
// tracked swings.
// ps: pending spike {spike, preChunks, ballPromise, tSpike} for auto;
//     null for manual (starts its own ball track + clip).
var RECALL_LINK_MS = 1500;
function logSwing(manual, ps) {
  var now = Date.now();
  if (!manual) {
    if (now < swingCooldownUntil) return;
    swingCooldownUntil = now + COOLDOWN_MS;
  }
  // Live counter always increments — the TV shows every detected swing.
  state.swingCount++;
  mSwings.textContent = state.swingCount;
  drawSwingMarker();
  beep(880, 150);

  // Freeze the saving decision at detection time: a swing spotted while
  // saving is on gets logged even if the user hits Done mid-track.
  var saving = state.recording;
  if (saving) {
    captureSwingClip(state.swingCount, ps);
  }

  // Build the session-log entry only when saving. id is session-relative;
  // liveN is the absolute live count (matches what the TV showed).
  var swingEntry = null;
  if (saving) {
    swingEntry = {
      id: state.swings.length + 1,
      liveN: state.swingCount,
      time: new Date().toISOString(),
      sessionTimeSec: (now - state.sessionStart) / 1000,
      manual: !!manual,
      // Detector state at mark time — for later recall comparison.
      detector: {
        hotFrac: lastHotFrac, motionLevel: motionLevel,
        spikeT: ps ? ps.spike.t : null,
        validated: !manual,
        trigger: manual ? "manual" : ((ps && ps.audio) ? "crack" : "motion")
      }
    };

    // Link to counterpart events within ±1.5 s for recall measurement.
    // (Both directions: manual-after-auto and auto-after-manual.)
    var linked = [];
    for (var i = 0; i < state.swings.length; i++) {
      var other = state.swings[i];
      if (!!other.manual === !!manual) continue; // only cross-link auto<->manual
      var dt = Math.abs(other.sessionTimeSec - swingEntry.sessionTimeSec) * 1000;
      if (dt <= RECALL_LINK_MS) {
        linked.push(other.id);
        if (!other.linkedIds) other.linkedIds = [];
        if (other.linkedIds.indexOf(swingEntry.id) < 0) other.linkedIds.push(swingEntry.id);
      }
    }
    if (linked.length) swingEntry.linkedIds = linked;
  }

  // Ball track: for auto swings, use the track that started at spike time
  // (the ball is already 600ms into flight). For manual, start one now.
  var seed = (motionSeed && now - motionSeed.t < 5000) ? motionSeed : null;
  if (saving && swingEntry) {
    swingEntry.motionSeed = seed ? { x: +seed.x.toFixed(3), y: +seed.y.toFixed(3) } : null;
  }

  var ballPromise;
  if (ps && ps.ballPromise) {
    ballPromise = ps.ballPromise;
  } else {
    try { ballPromise = trackBall(seed); } catch (e) { ballPromise = Promise.resolve(null); }
  }
  ballPromise.then(function (trail) {
    var result = analyzeSwing(trail);
    if (saving && swingEntry) {
      swingEntry.result = result;
      state.swings.push(swingEntry);
      renderSwing(swingEntry);
    }
    // Push to TV via CageCast — always, when connected and the ball was tracked.
    if (window.CageCast && CageCast.isConnected() && result.tracked) {
      CageCast.swing({
        n: state.swingCount,
        exitVeloMph: result.exitVeloMph,
        launchAngleDeg: result.launchAngleDeg,
        at: new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
      });
    }
    if (result.tracked) {
      beep(1320, 120); // second, higher beep: the ball was tracked
      mEV.textContent = result.exitVeloMph.toFixed(0) + " mph";
      mLA.textContent = fmtLA(result.launchAngleDeg, 0);
    }
  });
}

// Null LA = insufficient evidence (a worm-burner and a mis-track look
// identical) — display "—", never a fake 0°.
function fmtLA(la, digits) {
  return (la === null || la === undefined || !isFinite(la)) ? "—" : la.toFixed(digits) + "°";
}

function renderSwing(entry) {
  var empty = swingLogEl.querySelector(".empty");
  if (empty) empty.remove();
  var div = document.createElement("div");
  div.dataset.swingId = entry.id;
  var delBtn = '<button class="swing-del" data-id="' + entry.id + '" title="Delete this entry">✕</button>';
  var srcBadge = entry.manual
    ? ' <span class="src-badge manual">MANUAL</span>'
    : ' <span class="src-badge auto">AUTO</span>';
  var r = entry.result;
  if (r.tracked) {
    div.className = "swing-card tracked";
    div.innerHTML = delBtn +
      "<h3>Swing #" + entry.id + srcBadge + " — " + r.exitVeloMph.toFixed(0) + " mph</h3>" +
      '<div class="nums"><span>EV <b>' + r.exitVeloMph.toFixed(1) + " mph</b></span>" +
      "<span>LA <b>" + fmtLA(r.launchAngleDeg, 1) + "</b></span>" +
      "<span>Direction <b>" + r.direction + "</b></span></div>" +
      '<div class="note">' + r.note + " · " +
      new Date(entry.time).toLocaleTimeString() + "</div>";
  } else {
    div.className = "swing-card notracked";
    div.innerHTML = delBtn +
      "<h3>Swing #" + entry.id + srcBadge + " — no track</h3>" +
      '<div class="note">' + r.reason + ". No numbers fabricated.</div>";
  }
  swingLogEl.prepend(div);
}

// False alarms happen (walk-throughs, net wobble): let the user delete them.
swingLogEl.addEventListener("click", function (ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest(".swing-del") : null;
  if (!btn) return;
  var id = +btn.getAttribute("data-id");
  var card = swingLogEl.querySelector('[data-swing-id="' + id + '"]');
  if (card) card.remove();
  state.swings = state.swings.filter(function (s) { return s.id !== id; });
  for (var i = swingClips.length - 1; i >= 0; i--) {
    if (swingClips[i].id === id) swingClips.splice(i, 1);
  }
  if (!swingLogEl.querySelector(".swing-card")) {
    swingLogEl.innerHTML = '<p class="empty">No swings yet. Take a cut.</p>';
  }
});

// Wipe the slate: clears the log, pending clips, and the swing counter.
document.getElementById("btn-clear-swings").addEventListener("click", function () {
  if (!state.swings.length && !swingLogEl.querySelector(".swing-card")) return;
  if (!window.confirm("Clear all swing entries? This can't be undone.")) return;
  state.swings = [];
  state.swingCount = 0;
  swingClips.length = 0;
  mSwings.textContent = "0";
  mEV.textContent = "—";
  mLA.textContent = "—";
  swingLogEl.innerHTML = '<p class="empty">No swings yet. Take a cut.</p>';
});

function drawSwingMarker() {
  var W = overlay.width, H = overlay.height;
  octx.strokeStyle = "#4ade80"; octx.lineWidth = 4;
  octx.strokeRect(W*0.3, H*0.3, W*0.4, H*0.4);
  setTimeout(function () {
    octx.clearRect(0, 0, W, H);
  }, 600);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
// The loop runs whenever video is live: the motion meter is always on so
// the detector can be tuned before the session; swings only trigger while
// recording.
var loopRunning = false;
var lastFrameTime = 0;
var lastMeterUpdate = 0;
var motionFillEl = null, motionThreshEl = null;

function ensureLoop() {
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(loop);
}

function updateMotionMeter(hotFrac) {
  if (!motionFillEl) {
    motionFillEl = document.getElementById("motion-fill");
    motionThreshEl = document.getElementById("motion-thresh");
    if (!motionFillEl) return;
  }
  var s = SENS_LEVELS[motionLevel];
  // Threshold line sits at 50%; the bar turns green past the spike floor.
  motionFillEl.style.width = Math.min(100, (hotFrac / (s.spikeMin * 2)) * 100).toFixed(1) + "%";
  motionFillEl.classList.toggle("hot", hotFrac >= s.spikeMin);
}

function loop(ts) {
  requestAnimationFrame(loop);
  // Throttle to ~15 fps for motion detection.
  if (ts - lastFrameTime <= 66) return;
  lastFrameTime = ts;
  try {
    var m = frameMotion();
    lastHotFrac = m.hotFrac;
    if (m.hotX !== null && m.hotY !== null) {
      motionSeed = { x: m.hotX / PROC_W, y: m.hotY / PROC_H, t: Date.now() };
    }
    if (ts - lastMeterUpdate > 200) {
      lastMeterUpdate = ts;
      updateMotionMeter(m.hotFrac);
    }
    // Detector runs automatically when the camera is live — no Start press
    // needed. state.recording (saving) only controls whether swings are logged.
    if (!cameraLive()) return;
    if (!state.streamOK) {
      // Step 9: stream lost — the frame is frozen, so any "motion" here
      // would be phantom swings. The meter above keeps updating; the
      // detector is gated until the feed recovers.
      return;
    }
    if (!swingDetector) createDetector();
    // Feed the prominence detector: h = motion level, cx/cy = centroid.
    // Exposure-shift guard: biasRatio near 1 means global illumination
    // change, not motion — feed zero so it can't spike.
    var h = m.biasRatio < BIAS_REJECT ? m.hotFrac : 0;
    var cx = m.hotX !== null ? m.hotX / PROC_W : null;
    var cy = m.hotY !== null ? m.hotY / PROC_H : null;
    var spike = null;
    try {
      spike = swingDetector.push({ t: Date.now(), h: h, cx: cx, cy: cy });
    } catch (e) { spike = null; }
    if (spike && !pendingSpike) {
      onSpike(spike);
    }
    // Validate the pending spike after postMs of data (~600ms).
    if (pendingSpike) {
      var v = null;
      try { v = swingDetector.validate(pendingSpike.spike); } catch (e) {}
      if (v && v.status !== "pending") {
        var ps = pendingSpike;
        pendingSpike = null;
        if (v.valid) onSwingValidated(ps); else onSpikeRejected(ps);
      }
    }
  } catch (e) { /* keep the session alive */ }
}

document.getElementById("motion-sens").addEventListener("change", function (ev) {
  motionLevel = ev.target.value in SENS_LEVELS ? ev.target.value : "normal";
  createDetector(); // rebuild with new sensitivity
});

/* ------------------------------------------------------------------ */
/* Bat-crack audio detector (mic).                                      */
/* The crack of the bat is a sharp broadband transient that does not   */
/* care how far the camera is. On trigger it feeds logSwing directly —  */
/* the crack IS the validation signal, no motion spike needed.         */
/* ------------------------------------------------------------------ */
var crackDetector = null;
var crackToggleEl = null, audioFillEl = null, crackStatusEl = null;

/* Mic picker: the crack detector must listen on a mic that actually hears
   the cage. Enumerate inputs, remember the choice, restart the detector
   on switch. Mirrors the camera picker. */
var MIC_DEVICE_KEY = "cage.micDeviceId";

function savedMicDeviceId() {
  try { return localStorage.getItem(MIC_DEVICE_KEY) || ""; } catch (e) { return ""; }
}
function saveMicDeviceId(id) {
  try {
    if (id) localStorage.setItem(MIC_DEVICE_KEY, id);
    else localStorage.removeItem(MIC_DEVICE_KEY);
  } catch (e) {}
}

function listMics() {
  var sel = document.getElementById("mic-select");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  var want = savedMicDeviceId();
  navigator.mediaDevices.enumerateDevices().then(function (devs) {
    var mics = devs.filter(function (d) { return d.kind === "audioinput"; });
    var prev = sel.value;
    sel.innerHTML = "";
    if (!mics.length) {
      var o0 = document.createElement("option");
      o0.value = "";
      o0.textContent = "No microphones found";
      sel.appendChild(o0);
      return;
    }
    mics.forEach(function (d, i) {
      var o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || ("Mic " + (i + 1));
      sel.appendChild(o);
    });
    var pick = "";
    for (var i = 0; i < mics.length; i++) {
      if (mics[i].deviceId === want) { pick = want; break; }
    }
    sel.value = pick || prev;
    if (!sel.value && mics.length) sel.value = mics[0].deviceId;
  }).catch(function () {});
}

function onBatCrack(info) {
  // No camera, no ball track — ignore.
  try { if (!cameraLive()) return; } catch (e) { return; }
  flashAudioMeter();
  // Pseudo-ps: no motion spike, so logSwing starts its own ball track
  // from the fresh motion seed. trigger:"crack" marks the source.
  logSwing(false, { audio: true, spike: { t: (info && info.t) || Date.now() } });
}

function updateAudioMeter() {
  if (!crackDetector || !crackDetector.isRunning()) return;
  if (!audioFillEl) audioFillEl = document.getElementById("audio-fill");
  if (!audioFillEl) return;
  var lv = crackDetector.level();
  audioFillEl.style.width = (lv * 100).toFixed(1) + "%";
  audioFillEl.style.background = lv >= 0.66 ? "#4ade80" : "#2a5aa0";
  requestAnimationFrame(updateAudioMeter);
}

function flashAudioMeter() {
  if (!audioFillEl) audioFillEl = document.getElementById("audio-fill");
  if (!audioFillEl) return;
  audioFillEl.style.width = "100%";
  audioFillEl.style.background = "#4ade80";
}

function setCrackToggleUI(on, label) {
  if (!crackToggleEl) crackToggleEl = document.getElementById("crack-toggle");
  if (!crackToggleEl) return;
  if (!crackStatusEl) crackStatusEl = document.getElementById("crack-status");
  crackToggleEl.textContent = on ? "🎤 Crack detect: on" : "🎤 Crack detect: off";
  crackToggleEl.classList.toggle("armed", !!on);
  if (crackStatusEl) crackStatusEl.textContent = label || "";
}

function startCrackDetector() {
  // (Re)start the crack detector on the picked mic (or OS default).
  // Called from the toggle click = user gesture, satisfying autoplay policy.
  setCrackToggleUI(false, "listening…");
  crackDetector = createCrackDetector(onBatCrack);
  crackDetector.start(crackStatusHandler, savedMicDeviceId() || null);
}

function crackStatusHandler(status) {
  // calibrating | on | denied | mic-gone | error | off
  if (status === "on") {
    setCrackToggleUI(true, "mic live — clap to test");
    updateAudioMeter();
  } else if (status === "calibrating") {
    setCrackToggleUI(false, "stay quiet — calibrating…");
  } else if (status === "denied") {
    crackDetector = null;
    setCrackToggleUI(false, "mic blocked — allow microphone");
  } else if (status === "mic-gone") {
    // Saved mic unplugged: forget it, fall back to the default input.
    saveMicDeviceId("");
    listMics();
    crackDetector = null;
    startCrackDetector();
  } else if (status === "error") {
    crackDetector = null;
    setCrackToggleUI(false, "no mic on this device");
  } else {
    setCrackToggleUI(false, "");
  }
}

document.getElementById("crack-toggle").addEventListener("click", function () {
  // Click = user gesture: satisfies the AudioContext autoplay policy.
  if (crackDetector && crackDetector.isRunning()) {
    crackDetector.stop();
    crackDetector = null;
    setCrackToggleUI(false, "");
    return;
  }
  startCrackDetector();
});

// Mic picker wiring.
(function () {
  var sel = document.getElementById("mic-select");
  if (sel) sel.addEventListener("change", function () {
    saveMicDeviceId(sel.value);
    if (crackDetector && crackDetector.isRunning()) {
      crackDetector.stop();
      crackDetector = null;
      startCrackDetector(); // still inside the change gesture
    }
  });
  var rescan = document.getElementById("mic-rescan");
  if (rescan) rescan.addEventListener("click", function () { listMics(); });
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", function () { listMics(); });
    }
  } catch (e) {}
})();

/* ------------------------------------------------------------------ */
/* Live session (no full recording by default).                        */
/* Optional per-swing clips via the toggle (~3 s each, ~1.5 MB).       */
/* ------------------------------------------------------------------ */
var clipToggle = document.getElementById("clip-toggle");
var swingClips = []; // {id, blob}
var downloadedClipIds = {}; // ids already saved to the folder

function attachClipPlayer(swingId, blob) {
  var url = URL.createObjectURL(blob);
  // 1) Drop it in the folder immediately (Downloads).
  // Session-stamped filename: swing-20260918-193022-03.webm (no parens/
  // spaces, so the browser never renames with " (1)").
  try {
    var a = document.createElement("a");
    a.href = url;
    a.download = (typeof clipFileName === "function")
      ? clipFileName(state.sessionStart, swingId)
      : "swing-" + swingId + ".webm";
    document.body.appendChild(a);
    a.click();
    a.remove();
    downloadedClipIds[swingId] = true;
  } catch (e) { /* in-page player still works */ }
  // 2) In-page replay on the swing card.
  var card = swingLogEl.querySelector('[data-swing-id="' + swingId + '"]');
  if (card && !card.querySelector("video.swing-clip")) {
    var v = document.createElement("video");
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.src = url;
    v.className = "swing-clip";
    card.appendChild(v);
  }
}

function startSession() {
  state.swings = [];
  // state.swingCount (live counter) keeps going — the TV shows every swing.
  state.sessionStart = Date.now();
  state.streamGaps = [];   // Step 9: reset the stream-death ledger
  state.streamOK = true;
  state.gapStart = 0;
  swingClips = [];
  // Stream fingerprint at session start (from cast.js health poll, if paired).
  try {
    state.streamStart = window.__streamFingerprint
      ? JSON.parse(JSON.stringify(window.__streamFingerprint)) : null;
  } catch (e) { state.streamStart = null; }
  swingLogEl.innerHTML = '<p class="empty">No swings yet. Take a cut.</p>';
  mSwings.textContent = "0"; mEV.textContent = "—"; mLA.textContent = "—";

  // Wake lock: a phone running the session solo must not sleep mid-session.
  try {
    if (navigator.wakeLock) {
      navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
    }
  } catch (e) {}

  state.recording = true;
  statusEl.textContent = "● Saving — swings logged to session";
  statusEl.className = "status recording";
  if (window.CageCast && CageCast.isConnected()) CageCast.session('live', 'Saving swings');
  startClipRing(); // continuous recorder feeds the pre-roll ring
  btnStart.classList.add("hidden");
  btnStop.classList.remove("hidden");
  btnStop.disabled = false;
  if (btnMark) btnMark.classList.remove("hidden");
  btnDownload.classList.add("hidden");
  document.getElementById("camera-hint").style.display = "none";
  mRec.textContent = clipToggle.checked ? "CLIPS" : "OFF";
  prevFrame = null;
  createDetector(); // fresh prominence detector for the session
  // Prime audio on the user's click so swing beeps aren't blocked later.
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
  ensureLoop();
}

function stopSession() {
  state.recording = false;
  stopClipRing();
  // Detector keeps running if the camera is live — only saving stops.
  if (window.CageCast && CageCast.isConnected()) {
    CageCast.session(cameraLive() ? 'live' : 'idle', cameraLive() ? 'Not saving' : 'Session ended');
  }
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  statusEl.textContent = cameraLive() ? "Camera live — hit Save to log swings" : "Session ended";
  statusEl.className = "status idle";
  btnStop.classList.add("hidden");
  btnStart.classList.remove("hidden");
  if (btnMark) btnMark.classList.add("hidden");
  btnDownload.classList.remove("hidden");
  btnDownload.disabled = false;
  mRec.textContent = "OFF";
}

/* ------------------------------------------------------------------ */
/* Clip ring buffer: continuous recorder for pre-roll + post-roll.     */
/* MediaRecorder has no pre-roll API, so we record the whole session   */
/* in 500 ms chunks and keep a ring; a swing clip = 3 s pre-roll +     */
/* 2 s post-roll sliced from the ring. The first chunk (EBML header)   */
/* is saved separately and prepended to mid-ring slices so every clip  */
/* is a playable file.                                                 */
/* Caveat: the blob should start at a keyframe or the first ~second    */
/* shows garbage — Chrome emits keyframes at chunk boundaries often    */
/* enough in practice; if clips start blocky, shorten the timeslice.   */
/* ------------------------------------------------------------------ */
var clipRing = [];           // Blobs, oldest first
var CLIP_CHUNK_MS = 500;
var CLIP_CHUNK_MS = 500; // MediaRecorder timeslice
var CLIP_PREROLL_MS = 4000; // 4 s pre-roll: set, feet, step, load
var CLIP_POSTROLL_MS = 2000; // 2 s post-roll: follow-through
var CLIP_RING_MAX = 24;      // ~12 s window; bounds memory (~6 MB at 4 Mbps)
var CLIP_MIN_MS = 1500;      // reject "just a picture" clips
var sessionRecorder = null;
var sessionRecorderStream = null;
var clipHeaderChunk = null;  // first chunk = EBML header (Uint8Array); saved
                             // separately so mid-ring clips get a valid init
var clipRing = [];           // [{blob, t}] — t = Date.now() at arrival

function pickSupportedMime() {
  var cands = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4"
  ];
  for (var i = 0; i < cands.length; i++) {
    try {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    } catch (e) {}
  }
  return "";
}

function startClipRing() {
  stopClipRing();
  if (!state.stream || !window.MediaRecorder) return;
  try {
    var mime = pickSupportedMime();
    state.clipMime = mime || null; // Step 10 forensics: stamp the chosen codec
    var opts = { videoBitsPerSecond: 4 * 1000 * 1000 };
    if (mime) opts.mimeType = mime;
    sessionRecorder = new MediaRecorder(state.stream, opts);
    sessionRecorderStream = state.stream;
    clipRing = [];
    clipHeaderChunk = null;
    sessionRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size) {
        var entry = { blob: e.data, t: Date.now() };
        if (!clipHeaderChunk) {
          // First chunk has the EBML header — stash its bytes separately.
          // (Read once; the ring keeps the Blob for potential reuse.)
          var rd = new FileReader();
          rd.onload = function () { clipHeaderChunk = new Uint8Array(rd.result); };
          rd.readAsArrayBuffer(e.data);
        }
        clipRing.push(entry);
        while (clipRing.length > CLIP_RING_MAX) clipRing.shift();
      }
    };
    sessionRecorder.onerror = function () { /* ring is best-effort */ };
    sessionRecorder.start(CLIP_CHUNK_MS);
  } catch (e) {
    sessionRecorder = null;
    sessionRecorderStream = null;
  }
}

function stopClipRing() {
  if (sessionRecorder) {
    try { if (sessionRecorder.state !== "inactive") sessionRecorder.stop(); } catch (e) {}
    sessionRecorder = null;
  }
  sessionRecorderStream = null;
  clipRing = [];
  clipHeaderChunk = null;
}

// Chunks from two different encoders do NOT concatenate — if the stream
// changed (camera switch), restart the ring before clipping.
function ensureClipRing() {
  if (state.stream && state.stream !== sessionRecorderStream) startClipRing();
}

// Capture a coaching clip: 4 s pre-roll (set, feet, step, load) + 2 s
// post-roll (follow-through), assembled with structural verification.
// ps: pending spike for auto (has preChunks); null for manual.
function captureSwingClip(swingId, ps) {
  if (!clipToggle.checked) return;
  ensureClipRing();
  if (!sessionRecorder || sessionRecorder.state === "inactive") return;
  if (!clipHeaderChunk || !clipHeaderChunk.length) return; // no header, no clip
  var tTrigger = ps ? ps.tSpike : Date.now();
  // Wait for post-roll to accumulate, then assemble.
  setTimeout(function () {
    try {
      // Select chunks by TIME, not count. Pre-chunks were preserved at
      // spike time; post-chunks are everything since the trigger.
      var t0 = tTrigger - CLIP_PREROLL_MS, t1 = tTrigger + CLIP_POSTROLL_MS;
      var sel = [];
      for (var i = 0; i < clipRing.length; i++) {
        var c = clipRing[i];
        if (c.t >= t0 && c.t <= t1) sel.push(c);
      }
      if (!sel.length) return;
      // Convert Blobs to Uint8Arrays for the assembler.
      var pending = sel.length, bufs = new Array(sel.length), failed = false;
      sel.forEach(function (c, idx) {
        var rd = new FileReader();
        rd.onload = function () {
          bufs[idx] = { bytes: new Uint8Array(rd.result), t: c.t };
          if (--pending === 0 && !failed) assemble();
        };
        rd.onerror = function () { failed = true; };
        rd.readAsArrayBuffer(c.blob);
      });
      function assemble() {
        try {
          var clip = assembleClip(clipHeaderChunk, bufs, tTrigger,
            CLIP_PREROLL_MS, CLIP_POSTROLL_MS, CLIP_MIN_MS);
          if (!clip) return; // fail closed: no corrupt/still clips saved
          var blob = new Blob([clip.data], { type: "video/webm" });
          var fix = (typeof fixWebmDuration === "function")
            ? fixWebmDuration(blob, clip.durationMs)
            : Promise.resolve(blob);
          fix.then(function (fixed) {
            swingClips.push({ id: swingId, blob: fixed, durationMs: clip.durationMs });
            attachClipPlayer(swingId, fixed);
          });
        } catch (e) { /* clips are optional; never break the session */ }
      }
    } catch (e) { /* clips are optional; never break the session */ }
  }, CLIP_POSTROLL_MS);
}

function downloadSession() {
  // Swing log JSON (the thing to send for analysis).
  var streamEnd = null;
  try {
    streamEnd = window.__streamFingerprint
      ? JSON.parse(JSON.stringify(window.__streamFingerprint)) : null;
  } catch (e) {}
  var log = {
    exportedAt: new Date().toISOString(),
    // Self-identifying build: ends the "which build made this export" guessing.
    build: (function () {
      try {
        var t = document.getElementById("build-tag");
        return t ? t.textContent.replace(/^build\s+/, "") : null;
      } catch (e) { return null; }
    })(),
    profile: { label: PROFILE.label, verified: PROFILE.verified },
    streamStart: state.streamStart || null,
    streamEnd: streamEnd,
    streamGaps: state.streamGaps || [],
    // Self-diagnosis: if a future export ever shows zero swings again,
    // this block says why (detections vs logged, saving state, camera).
    diagnostics: {
      detections: state.swingCount,
      loggedSwings: state.swings.length,
      wasSavingAtExport: !!state.recording,
      crackDetectOn: (function () {
        try { return !!(crackDetector && crackDetector.isRunning()); }
        catch (e) { return null; }
      })(),
      crackTriggers: (function () {
        try { return crackDetector ? crackDetector.triggerCount() : 0; }
        catch (e) { return null; }
      })(),
      // What the mic has actually heard: peak band energy vs floor/baseline.
      // If swings aren't triggering, this says whether the crack reaches
      // the mic at all.
      crackMic: (function () {
        try { return (crackDetector && crackDetector.isRunning()) ? crackDetector.telemetry() : null; }
        catch (e) { return null; }
      })(),
      cameraLive: (function () { try { return cameraLive(); } catch (e) { return null; } })(),
      videoSize: (function () {
        try { return (video.videoWidth || 0) + "x" + (video.videoHeight || 0); }
        catch (e) { return null; }
      })()
    },
    clipMime: state.clipMime || null,
    calibration: (function () {
      try {
        var lc = window.SessionApp && window.SessionApp.phoneCalibration;
        if (!lc) return null;
        return {
          label: lc.label || null,
          autoAdjusted: !!lc.autoAdjusted,
          meanPx: isFinite(lc.meanPx) ? +lc.meanPx.toFixed(2) : null
        };
      } catch (e) { return null; }
    })(),
    swings: state.swings.map(function (s) {
      var r = s.result || {};
      return {
        id: s.id, time: s.time, sessionTimeSec: +s.sessionTimeSec.toFixed(2),
        manual: !!s.manual, detector: s.detector || null,
        linkedIds: s.linkedIds || [],
        tracked: !!r.tracked,
        exitVeloMph: r.tracked ? +r.exitVeloMph.toFixed(1) : null,
        launchAngleDeg: r.tracked && isFinite(r.launchAngleDeg) ? +r.launchAngleDeg.toFixed(1) : null,
        fitRmsePx: r.tracked ? r.fitRmsePx : null,
        fitModel: r.tracked ? r.fitModel : null,
        direction: r.tracked ? r.direction : null,
        note: r.tracked ? r.note : r.reason
      };
    })
  };
  var b2 = document.createElement("a");
  b2.href = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
  b2.download = "cage-session-swings.json";
  b2.click();
  // Per-swing clips not already saved to the folder.
  swingClips.forEach(function (c) {
    if (downloadedClipIds[c.id]) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(c.blob);
    a.download = (typeof clipFileName === "function")
      ? clipFileName(state.sessionStart, c.id)
      : "swing-" + c.id + ".webm";
    a.click();
  });
}

btnStart.addEventListener("click", startSession);
btnStop.addEventListener("click", stopSession);
btnDownload.addEventListener("click", downloadSession);

/* ------------------------------------------------------------------ */
/* Boot: camera source picker + remote (cast) support                  */
/* ------------------------------------------------------------------ */
var remoteMode = false;
var localInited = false;

function setSrcActive(id) {
  ["src-local", "btn-broadcast", "btn-watch"].forEach(function (x) {
    var b = document.getElementById(x);
    if (b) b.classList.toggle("active", x === id);
  });
  // The camera picker only applies to this device's camera.
  var cpr = document.getElementById("camera-picker-row");
  if (cpr) cpr.style.display = (id === "src-local") ? "" : "none";
}

function setProfileWarning(msg) {
  var w = document.getElementById("profile-warn");
  if (w) w.textContent = msg || "";
}

function selectLocal() {
  setSrcActive("src-local");
  var hint = document.getElementById("camera-hint");
  if (hint && !remoteMode) hint.style.display = "";
  if (localInited || remoteMode) return;
  localInited = true;
  btnStart.disabled = true;
  listCameras(); // populate early (labels fill in after permission is granted)
  listMics();
  initCamera().then(function () {
    btnStart.disabled = false;
    statusEl.textContent = "Camera live — swings show on TV, hit Save to log them";
    ensureLoop();
    listCameras(); // refresh: real device labels need the granted permission
    listMics();
  }).catch(function () {
    statusEl.textContent = "Camera blocked — allow access and reload";
    document.getElementById("camera-hint").textContent =
      "Camera access was denied. Allow camera permission and reload the page.";
  });
}

document.getElementById("src-local").addEventListener("click", selectLocal);
["btn-broadcast", "btn-watch"].forEach(function (id) {
  document.getElementById(id).addEventListener("click", function () { setSrcActive(id); });
});

// Camera picker wiring.
(function () {
  var sel = document.getElementById("camera-select");
  if (sel) sel.addEventListener("change", function () {
    switchLocalCamera(sel.value);
  });
  var rescan = document.getElementById("camera-rescan");
  if (rescan) rescan.addEventListener("click", function () { listCameras(); });
  // Pick up cameras plugged in after page load (e.g. GoPro connected late).
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", function () { listCameras(); });
    }
  } catch (e) {}
})();

// Called by cast.js when the phone's stream arrives.
// Merge, don't replace: calib.js stashes the live phone calibration on this
// same object, and replacing it would silently drop the calibration.
window.SessionApp = window.SessionApp || {};
window.SessionApp.onRemoteStream = function (stream) {
    remoteMode = true;
    if (state.stream) {
      try { state.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    }
    state.stream = stream;
    video.srcObject = stream;
    video.onloadedmetadata = function () {
      overlay.width = video.videoWidth || 1280;
      overlay.height = video.videoHeight || 720;
    };
    if (video.readyState >= 1) {
      overlay.width = video.videoWidth || 1280;
      overlay.height = video.videoHeight || 720;
    }
    btnStart.disabled = false;
    statusEl.textContent = "Phone camera connected — ready";
    document.getElementById("camera-hint").innerHTML =
      "Viewing the phone's camera — analysis runs on this laptop.<br>" +
      "Load the phone's calibration file below for accurate numbers.";
    setProfileWarning("Using the laptop calibration with the phone camera: numbers are approximate until you load the phone's own calibration export.");
  };
  window.SessionApp.loadProfile = function (p) {
    if (!p || p.format !== "stadium-slugger/cage-calibration" ||
        !p.homography || !p.homography.imageToGround) {
      throw new Error("not a cage calibration profile");
    }
    PROFILE.homography = p.homography;
    if (p.camera) {
      PROFILE.camera = p.camera;
      CAM.x = -p.camera.distanceBehindPlateM;
      CAM.y = p.camera.sideOffsetM;
      CAM.z = p.camera.heightM;
    }
    if (p.heightScale && p.heightScale.samples && p.heightScale.samples.length) {
      var s = p.heightScale.samples;
      PROFILE.heightScale.pxPerM = s.reduce(function (a, b) { return a + b.pxPerM; }, 0) / s.length;
    }
    PROFILE.verified = !!p.verified;
    PROFILE.label = p.label || "custom";
    profileInfoEl.textContent =
      "Profile: " + PROFILE.label + " (verified=" + PROFILE.verified + ") loaded from file.";
    setProfileWarning(p.verified ? "" : "Profile is not verified — numbers are uncalibrated estimates.");
  };

  // Step 9: stream-lifecycle hooks, called by cast.js's watch monitor.
  // streamMuted opens a gap in the session ledger and disarms the
  // detector; streamLive closes the gap. Idempotent — safe to call twice.
  window.SessionApp.streamMuted = function () {
    if (!cameraLive()) return;
    if (state.streamOK) {
      state.streamOK = false;
      state.gapStart = (Date.now() - state.sessionStart) / 1000;
    }
    // Detector gated by streamOK in loop(); nothing to disarm.
  };
  window.SessionApp.streamLive = function () {
    if (!state.streamOK && state.gapStart) {
      state.streamGaps.push({
        startSec: +state.gapStart.toFixed(1),
        endSec: +((Date.now() - state.sessionStart) / 1000).toFixed(1)
      });
    }
    state.streamOK = true;
    state.gapStart = 0;
  };

document.getElementById("profile-file").addEventListener("change", function (ev) {
  var f = ev.target.files && ev.target.files[0];
  if (!f) return;
  var r = new FileReader();
  r.onload = function () {
    try {
      window.SessionApp.loadProfile(JSON.parse(r.result));
    } catch (e) {
      setProfileWarning("Couldn't read that file — export JSON from the calibration wizard.");
    }
  };
  r.readAsText(f);
});

// Default: this device's camera (previous behavior).
selectLocal();

})();
