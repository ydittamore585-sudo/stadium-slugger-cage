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
  var H = PROFILE.homography.imageToGround;
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
var btnStart = document.getElementById("btn-start");
var btnStop = document.getElementById("btn-stop");
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
  stream: null
};

// Processing canvas (downscaled for speed).
var proc = document.createElement("canvas");
var pctx = proc.getContext("2d", { willReadFrequently: true });
var PROC_W = 320, PROC_H = 180;
proc.width = PROC_W; proc.height = PROC_H;

// Motion detection state.
var prevFrame = null;
var swingCooldownUntil = 0;
var pendingSwing = null; // { t0, ballTrack: [] }

profileInfoEl.textContent =
  "Profile: " + PROFILE.label + " (verified=" + PROFILE.verified + "), " +
  "camera 4 ft high / 6 ft behind plate / 6.5 ft toward 1st base. " +
  "Reprojection 1.54 px mean. " +
  "Place the camera in the calibrated spot before starting.";

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */
function initCamera() {
  var constraints = {
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: false
  };
  return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
    state.stream = stream;
    video.srcObject = stream;
    return new Promise(function (resolve) {
      video.onloadedmetadata = function () {
        overlay.width = video.videoWidth || 1280;
        overlay.height = video.videoHeight || 720;
        resolve();
      };
    });
  });
}

/* ------------------------------------------------------------------ */
/* Motion detection → swing trigger                                    */
/* ------------------------------------------------------------------ */
// Batter's-box ROI in normalized coords (tune: batter near plate, left-center).
var SWING_ROI = { x: 0.25, y: 0.35, w: 0.35, h: 0.45 };
var MOTION_THRESHOLD = 2600;   // summed abs-diff in ROI (empirical)
var COOLDOWN_MS = 2500;        // min gap between swings

function frameDiffEnergy() {
  pctx.drawImage(video, 0, 0, PROC_W, PROC_H);
  var img = pctx.getImageData(0, 0, PROC_W, PROC_H);
  var d = img.data;
  var rx = Math.floor(SWING_ROI.x * PROC_W),
      ry = Math.floor(SWING_ROI.y * PROC_H),
      rw = Math.floor(SWING_ROI.w * PROC_W),
      rh = Math.floor(SWING_ROI.h * PROC_H);
  var energy = 0;
  if (prevFrame) {
    for (var y = ry; y < ry + rh; y += 2) {
      for (var x = rx; x < rx + rw; x += 2) {
        var i = (y * PROC_W + x) * 4;
        // Luma approx from RGB.
        var luma = (d[i] * 3 + d[i+1] * 6 + d[i+2]) / 10;
        var pluma = (prevFrame[i] * 3 + prevFrame[i+1] * 6 + prevFrame[i+2]) / 10;
        energy += Math.abs(luma - pluma);
      }
    }
  }
  prevFrame = new Uint8ClampedArray(d);
  return energy;
}

/* ------------------------------------------------------------------ */
/* Ball tracking (post-swing).                                         */
/* Looks for a small bright blob moving away from the plate region.    */
/* ------------------------------------------------------------------ */
var BALL_TRACK_FRAMES = 12;
var BALL_MIN_DISPLACEMENT_PX = 8; // full-res px over the track

function trackBall() {
  // Capture full-res frames for BALL_TRACK_FRAMES.
  var cap = document.createElement("canvas");
  cap.width = video.videoWidth; cap.height = video.videoHeight;
  var cctx = cap.getContext("2d", { willReadFrequently: true });
  var frames = [];
  return new Promise(function (resolve) {
    var n = 0;
    var iv = setInterval(function () {
      cctx.drawImage(video, 0, 0, cap.width, cap.height);
      frames.push(cctx.getImageData(0, 0, cap.width, cap.height));
      if (++n >= BALL_TRACK_FRAMES) {
        clearInterval(iv);
        resolve(detectBallTrail(frames, cap.width, cap.height));
      }
    }, 1000 / 30);
  });
}

function detectBallTrail(frames, W, H) {
  // Simple approach: frame-to-frame bright-pixel motion in the
  // outfield half (ball moves away from camera after contact).
  // Returns [{u,v,t}] or null if quality gates fail.
  var trail = [];
  var prev = null;
  for (var f = 0; f < frames.length; f++) {
    var d = frames[f].data;
    var best = null, bestScore = 0;
    // Search region: upper 2/3 (away from camera), exclude edges.
    for (var y = Math.floor(H*0.08); y < Math.floor(H*0.65); y += 4) {
      for (var x = Math.floor(W*0.15); x < Math.floor(W*0.85); x += 4) {
        var i = (y * W + x) * 4;
        var bright = (d[i] + d[i+1] + d[i+2]) / 3;
        if (bright < 150) continue; // ball is bright white
        var motion = 0;
        if (prev) {
          var pd = prev.data;
          motion = Math.abs(d[i]-pd[i]) + Math.abs(d[i+1]-pd[i+1]) + Math.abs(d[i+2]-pd[i+2]);
        }
        var score = motion * (bright / 255);
        if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
    }
    prev = frames[f];
    if (best && bestScore > 900) trail.push({ u: best.u !== undefined ? best.u : best.x, v: best.y, t: f / 30 });
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
/* Metrics (imperial out).                                             */
/* ------------------------------------------------------------------ */
var CONTACT_HEIGHT_M = 0.914; // 3 ft assumed contact height

function analyzeSwing(trail) {
  if (!trail) {
    return { tracked: false, reason: "ball not tracked reliably" };
  }
  // 3D positions assuming contact-plane height (fail-closed: labeled estimate).
  var pts = [];
  for (var k = 0; k < trail.length; k++) {
    var w = imageToWorld(trail[k].u, trail[k].v, CONTACT_HEIGHT_M);
    if (!w) return { tracked: false, reason: "projection failed" };
    pts.push({ x: w.x, y: w.y, t: trail[k].t });
  }
  // Linear fit for vx, vy over the track.
  var n = pts.length;
  var sx = 0, sy = 0, st = 0, sxx = 0, sxy = 0, sxt = 0, syt = 0, stt = 0;
  for (var j = 0; j < n; j++) {
    sx += pts[j].x; sy += pts[j].y; st += pts[j].t;
    sxt += pts[j].x * pts[j].t; syt += pts[j].y * pts[j].t; stt += pts[j].t * pts[j].t;
  }
  var denom = n * stt - st * st;
  if (Math.abs(denom) < 1e-9) return { tracked: false, reason: "degenerate fit" };
  var vx = (n * sxt - sx * st) / denom;
  var vy = (n * syt - sy * st) / denom;
  var vHoriz = Math.sqrt(vx*vx + vy*vy);
  if (vHoriz < 3) return { tracked: false, reason: "ball too slow to be a batted ball" };

  // Vertical: from image-plane vertical motion scaled by heightScale.
  // Depth-adjust: scale pxPerM by (dist to ball)/(dist to calibration sample).
  var u0 = trail[0].u, v0 = trail[0].v;
  var u1 = trail[trail.length-1].u, v1 = trail[trail.length-1].v;
  var dt = trail[trail.length-1].t - trail[0].t;
  var dvPx = v0 - v1; // up is negative v; positive dvPx = rising
  var w0 = imageToWorld(u0, v0, CONTACT_HEIGHT_M);
  var distBall = Math.sqrt((w0.x-CAM.x)*(w0.x-CAM.x) + (w0.y-CAM.y)*(w0.y-CAM.y));
  var distCalib = Math.sqrt(1.9*1.9 + 1.5*1.5); // calib sample at ~(1.9,1.5)
  var pxPerM_local = PROFILE.heightScale.pxPerM * (distCalib / distBall);
  var vz = (dvPx / pxPerM_local) / dt;

  var speedMps = Math.sqrt(vx*vx + vy*vy + vz*vz);
  var exitVeloMph = speedMps * MPH_PER_MPS;
  var launchAngleDeg = Math.atan2(vz, vHoriz) * 180 / Math.PI;
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
    note: "2D+height estimate from calibrated cage camera"
  };
}

/* ------------------------------------------------------------------ */
/* Swing pipeline                                                      */
/* ------------------------------------------------------------------ */
function onSwingDetected() {
  var now = Date.now();
  if (now < swingCooldownUntil) return;
  swingCooldownUntil = now + COOLDOWN_MS;
  state.swingCount++;
  mSwings.textContent = state.swingCount;
  drawSwingMarker();
  captureSwingClip(state.swingCount);

  var swingEntry = {
    id: state.swingCount,
    time: new Date().toISOString(),
    sessionTimeSec: (now - state.sessionStart) / 1000
  };

  // Track the ball, then analyze.
  trackBall().then(function (trail) {
    var result = analyzeSwing(trail);
    swingEntry.result = result;
    state.swings.push(swingEntry);
    renderSwing(swingEntry);
    if (result.tracked) {
      mEV.textContent = result.exitVeloMph.toFixed(0) + " mph";
      mLA.textContent = result.launchAngleDeg.toFixed(0) + "°";
    }
  });
}

function renderSwing(entry) {
  var empty = swingLogEl.querySelector(".empty");
  if (empty) empty.remove();
  var div = document.createElement("div");
  var r = entry.result;
  if (r.tracked) {
    div.className = "swing-card tracked";
    div.innerHTML =
      "<h3>Swing #" + entry.id + " — " + r.exitVeloMph.toFixed(0) + " mph</h3>" +
      '<div class="nums"><span>EV <b>' + r.exitVeloMph.toFixed(1) + " mph</b></span>" +
      "<span>LA <b>" + r.launchAngleDeg.toFixed(1) + "°</b></span>" +
      "<span>Direction <b>" + r.direction + "</b></span></div>" +
      '<div class="note">' + r.note + " · " +
      new Date(entry.time).toLocaleTimeString() + "</div>";
  } else {
    div.className = "swing-card notracked";
    div.innerHTML =
      "<h3>Swing #" + entry.id + " — no track</h3>" +
      '<div class="note">' + r.reason + ". No numbers fabricated.</div>";
  }
  swingLogEl.prepend(div);
}

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
var lastFrameTime = 0;
function loop(ts) {
  if (!state.recording) return;
  // Throttle to ~15 fps for motion detection.
  if (ts - lastFrameTime > 66) {
    lastFrameTime = ts;
    try {
      var energy = frameDiffEnergy();
      if (energy > MOTION_THRESHOLD) onSwingDetected();
    } catch (e) { /* keep the session alive */ }
  }
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* Live session (no full recording by default).                        */
/* Optional per-swing clips via the toggle (~3 s each, ~1.5 MB).       */
/* ------------------------------------------------------------------ */
var clipToggle = document.getElementById("clip-toggle");
var swingClips = []; // {id, blob}

function startSession() {
  state.swings = [];
  state.swingCount = 0;
  state.sessionStart = Date.now();
  swingClips = [];
  swingLogEl.innerHTML = '<p class="empty">No swings yet. Take a cut.</p>';
  mSwings.textContent = "0"; mEV.textContent = "—"; mLA.textContent = "—";

  state.recording = true;
  statusEl.textContent = "● Live — watching for swings";
  statusEl.className = "status recording";
  btnStart.classList.add("hidden");
  btnStop.classList.remove("hidden");
  btnStop.disabled = false;
  btnDownload.classList.add("hidden");
  document.getElementById("camera-hint").style.display = "none";
  mRec.textContent = clipToggle.checked ? "CLIPS" : "OFF";
  prevFrame = null;
  requestAnimationFrame(loop);
}

function stopSession() {
  state.recording = false;
  statusEl.textContent = "Session ended";
  statusEl.className = "status idle";
  btnStop.classList.add("hidden");
  btnStart.classList.remove("hidden");
  btnDownload.classList.remove("hidden");
  btnDownload.disabled = false;
  mRec.textContent = "OFF";
}

// Capture a short clip around the swing when the toggle is on.
function captureSwingClip(swingId) {
  if (!clipToggle.checked || !state.stream) return;
  try {
    var rec = new MediaRecorder(state.stream, { videoBitsPerSecond: 4 * 1000 * 1000 });
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      swingClips.push({ id: swingId, blob: new Blob(chunks, { type: "video/webm" }) });
    };
    rec.start();
    setTimeout(function () { if (rec.state !== "inactive") rec.stop(); }, 3000);
  } catch (e) { /* clips are optional; never break the session */ }
}

function downloadSession() {
  // Swing log JSON (the thing to send for analysis).
  var log = {
    exportedAt: new Date().toISOString(),
    profile: { label: PROFILE.label, verified: PROFILE.verified },
    swings: state.swings.map(function (s) {
      var r = s.result || {};
      return {
        id: s.id, time: s.time, sessionTimeSec: +s.sessionTimeSec.toFixed(2),
        tracked: !!r.tracked,
        exitVeloMph: r.tracked ? +r.exitVeloMph.toFixed(1) : null,
        launchAngleDeg: r.tracked ? +r.launchAngleDeg.toFixed(1) : null,
        direction: r.tracked ? r.direction : null,
        note: r.tracked ? r.note : r.reason
      };
    })
  };
  var b2 = document.createElement("a");
  b2.href = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
  b2.download = "cage-session-swings.json";
  b2.click();
  // Per-swing clips, if any.
  swingClips.forEach(function (c) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(c.blob);
    a.download = "swing-" + c.id + ".webm";
    a.click();
  });
}

btnStart.addEventListener("click", startSession);
btnStop.addEventListener("click", stopSession);
btnDownload.addEventListener("click", downloadSession);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
initCamera().then(function () {
  btnStart.disabled = false;
  statusEl.textContent = "Camera ready";
}).catch(function (err) {
  statusEl.textContent = "Camera blocked — allow access and reload";
  statusEl.className = "status idle";
  document.getElementById("camera-hint").textContent =
    "Camera access was denied. Allow camera permission and reload the page.";
});
btnStart.disabled = true;

})();
