/**
 * Stadium Slugger — Cage Calibration Wizard UI.
 * Mobile-first, zero dependencies (besides calibration.js). All state persists
 * to localStorage so a refresh mid-calibration loses nothing.
 *
 * Fail-closed throughout: the Solve and Verify steps surface the math core's
 * {ok:false} reasons verbatim instead of proceeding with a guess.
 */
(function () {
  "use strict";
  var C = window.CageCalibration;
  var $ = function (id) { return document.getElementById(id); };

  var STEP_NAMES = ["Intro", "Measure", "Tap points", "Review", "Height", "Verify", "Profile"];

  // ---- units ---------------------------------------------------------------
  // The wizard UI is imperial (feet/inches). The math core (calibration.js),
  // internal state, and the saved profile JSON stay metric (meters) — the
  // tracking stage and physics all speak SI. Convert at the UI boundary.
  var M_PER_FT = 0.3048;
  var FT_PER_M = 1 / 0.3048;
  var IN_PER_M = 39.3701;
  function m2ft(m) { return m * FT_PER_M; }
  function ft2m(ft) { return ft * M_PER_FT; }
  function ft1(m) { return (m * FT_PER_M).toFixed(1); }   // meters -> "26.0" ft
  function in1(m) { return (m * IN_PER_M).toFixed(1); }   // meters -> "5.9" in

  // Garage dimensions, editable on the reference-points screen (screen 2).
  // Measured 2026-09-17: door edges at 0 / 10.25 / 16.5 / 26.75 ft from the
  // plate line (10'3" doors); window tops 47"/69.5".
  var GARAGE_DEFAULTS = { side: -1, dir: 1, e0Ft: 0, e1Ft: 10.25, e2Ft: 16.5, e3Ft: 26.75,
                          doorHFt: 8, win1In: 47, win2In: 69.5 };
  // [input id, S.garage key] for the editable dimension boxes (screen 2)
  var DIM_FIELDS = [["dimE0", "e0Ft"], ["dimE1", "e1Ft"], ["dimE2", "e2Ft"], ["dimE3", "e3Ft"],
                    ["dimDoorH", "doorHFt"], ["dimWin1", "win1In"], ["dimWin2", "win2In"]];
  var S = {
    screen: 0,
    cage: { lengthM: 9.144, widthM: 3.048, heightM: 3.05 },
    camera: { heightM: 1.40, distanceBehindPlateM: 4.00, sideOffsetM: 0 },
    pack: "garage",           // 'garage' = user's pre-measured reference set, 'generic'
    garage: Object.assign({}, GARAGE_DEFAULTS), // side: -1 wall on 3rd-base side, +1 on 1st-base side;
                                  // dir: +1 doors run toward pitcher, -1 behind plate
    refs: [],               // {id,label,image:[u,v] natural px,world:[x,y]}
    activePreset: null,
    solve: null,
    heightSamples: [],      // solveHeightScale results
    pendingBase: null,
    tapping: null,          // 'ref' | 'heightBase' | 'heightTop' | 'verifyBall'
    view: { z: 1, cx: null, cy: null }, // stage zoom/pan (natural px center); not persisted
    verification: null,
    profile: null,
    source: null,           // 'live' | 'still' | 'demo'
    mediaSize: null,        // {w,h} natural px of current source
    stream: null,
  };

  // ------------------------------------------------------------ persistence
  var LS_KEY = "cageWizardState.v1";
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        cage: S.cage, camera: S.camera, refs: S.refs, pack: S.pack, garage: S.garage,
        heightSamples: S.heightSamples, verification: S.verification,
      }));
      $("saveState").textContent = "progress saved ✓ " + new Date().toLocaleTimeString();
    } catch (e) { /* private mode etc. — non-fatal */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d.cage) S.cage = d.cage;
      if (d.camera) S.camera = d.camera;
      if (d.pack) S.pack = d.pack;
      if (d.garage) S.garage = Object.assign({}, GARAGE_DEFAULTS, d.garage);
      if (d.refs) { S.refs = d.refs; pruneStaleRefs(); }
      if (d.heightSamples) S.heightSamples = d.heightSamples;
      if (d.verification) S.verification = d.verification;
    } catch (e) { /* ignore corrupt state */ }
  }

  // Drop refs whose preset no longer exists (pack geometry updates) — a stale
  // world coordinate would silently poison the solve. Custom points are kept.
  function pruneStaleRefs() {
    var valid = {};
    buildPresets().forEach(function (p) { valid[p.id] = true; });
    S.refs = S.refs.filter(function (r) { return valid[r.id] || r.id.indexOf("custom-") === 0; });
  }

  // ------------------------------------------------------------ navigation
  function showScreen(i) {
    S.screen = i;
    document.querySelectorAll(".screen").forEach(function (el) {
      el.hidden = parseInt(el.dataset.screen, 10) !== i;
    });
    var nav = $("stepNav");
    nav.innerHTML = "";
    STEP_NAMES.forEach(function (name, idx) {
      var d = document.createElement("div");
      d.className = "dot" + (idx < i ? " done" : idx === i ? " now" : "");
      d.title = name;
      nav.appendChild(d);
    });
    window.scrollTo(0, 0);
    // The camera view follows the user: steps 2 (tap), 4 (height), 5 (verify)
    // each have a .stage-slot — the single live view moves into the visible one.
    // (Moving a playing <video> in the DOM does not restart it.)
    var slot = document.querySelector('.screen[data-screen="' + i + '"] .stage-slot');
    var st = $("tapStage");
    if (slot && st && st.parentNode !== slot) {
      slot.appendChild(st);
      layoutMedia();
    }
    if (i === 2) { renderPresets(); renderRefs(); drawDemo(); }
    if (i === 3) renderSolve();
    if (i === 4) drawDemo();
    if (i === 5) drawDemo();
    if (i === 6) renderProfile();
  }
  document.querySelectorAll("[data-next]").forEach(function (b) {
    b.addEventListener("click", function () { showScreen(Math.min(6, S.screen + 1)); });
  });
  document.querySelectorAll("[data-prev]").forEach(function (b) {
    b.addEventListener("click", function () { showScreen(Math.max(0, S.screen - 1)); });
  });

  // ------------------------------------------------------------ measurements
  // All inputs below are FEET; state stays in meters.
  function readMeasurements() {
    var err = $("measureError");
    err.hidden = true;
    function numFt(id, lo, hi, name) {
      var v = parseFloat($(id).value);
      if (!isFinite(v) || v < lo || v > hi)
        throw new Error(name + " must be between " + lo + " and " + hi + " ft.");
      return ft2m(v);
    }
    try {
      S.cage.lengthM = numFt("cageLength", 10, 200, "Cage length");
      S.cage.widthM = numFt("cageWidth", 3, 65, "Cage width");
      var ch = parseFloat($("cageHeight").value);
      S.cage.heightM = isFinite(ch) && ch >= 3 && ch <= 33 ? ft2m(ch) : null;
      S.camera.heightM = numFt("camHeight", 0.7, 33, "Camera height");
      S.camera.distanceBehindPlateM = numFt("camDist", 1.5, 130, "Distance behind plate");
      S.camera.sideOffsetM = numFt("camSide", -33, 33, "Side offset");
      save();
      return true;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return false;
    }
  }
  $("toCameraBtn").addEventListener("click", function () {
    if (readMeasurements()) showScreen(2);
  });
  function fillMeasurements() {
    $("cageLength").value = ft1(S.cage.lengthM);
    $("cageWidth").value = ft1(S.cage.widthM);
    if (S.cage.heightM) $("cageHeight").value = ft1(S.cage.heightM);
    $("camHeight").value = ft1(S.camera.heightM);
    $("camDist").value = ft1(S.camera.distanceBehindPlateM);
    $("camSide").value = ft1(S.camera.sideOffsetM);
  }

  // ------------------------------------------------------------ camera sources
  var stage = $("tapStage"), layer = $("tapLayer");

  function setSourceUI(which) {
    $("liveVideo").hidden = which !== "live";
    $("stillImg").hidden = which !== "still";
    $("demoCanvas").hidden = which !== "demo";
    resetView(); // new source -> zoom back out, recenter
  }
  function stopStream() {
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
  }

  $("liveCamBtn").addEventListener("click", async function () {
    stopStream();
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      S.stream = stream;
      var v = $("liveVideo");
      v.srcObject = stream;
      await v.play();
      S.source = "live";
      S.mediaSize = { w: v.videoWidth || 1280, h: v.videoHeight || 720 };
      setSourceUI("live");
      $("camStatus").textContent = "Live camera running (" + S.mediaSize.w + "×" + S.mediaSize.h + "). Frame the whole cage, then tap points.";
    } catch (e) {
      $("camStatus").textContent = "Camera unavailable (" + e.name + "). Try uploading a still photo instead.";
    }
  });

  $("uploadBtn").addEventListener("click", function () { $("stillFile").click(); });
  $("stillFile").addEventListener("change", function () {
    var f = $("stillFile").files[0];
    if (!f) return;
    stopStream();
    var img = $("stillImg");
    img.onload = function () {
      S.source = "still";
      S.mediaSize = { w: img.naturalWidth, h: img.naturalHeight };
      setSourceUI("still");
      $("camStatus").textContent = "Still loaded (" + S.mediaSize.w + "×" + S.mediaSize.h + ").";
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  });

  // ------------------------------------------------------------ demo cage
  var demo = { W: 960, H: 540, f: 0, cx: 0, cy: 0, ch: 0, pitch: 0 };
  function demoSetup() {
    demo.W = 960; demo.H = 540;
    demo.f = (demo.W / 2) / Math.tan((68 * Math.PI / 180) / 2);
    demo.cx = -S.camera.distanceBehindPlateM;
    demo.cy = S.camera.sideOffsetM;
    demo.ch = S.camera.heightM;
    // aim at (6, 0, 0.5) — mid-cage for a 26 ft cage
    var dx = 6 - demo.cx, dy = demo.ch - 0.5;
    demo.pitch = Math.atan2(dy, dx);
  }
  function demoProject(x, y, z) {
    var dx = x - demo.cx, dy = y - demo.cy, dz = z - demo.ch;
    var cp = Math.cos(demo.pitch), sp = Math.sin(demo.pitch);
    var fwd = cp * dx - sp * dz, up = sp * dx + cp * dz;
    if (fwd <= 0.1) return null;
    return [demo.W / 2 + demo.f * (dy / fwd), demo.H / 2 + demo.f * (-up / fwd)];
  }
  function drawDemo() {
    if (S.source !== "demo") return;
    demoSetup();
    var cv = $("demoCanvas");
    cv.width = demo.W; cv.height = demo.H;
    var g = cv.getContext("2d");
    // night-cage backdrop
    var grad = g.createLinearGradient(0, 0, 0, demo.H);
    grad.addColorStop(0, "#0a0f1a"); grad.addColorStop(0.55, "#101a2a"); grad.addColorStop(1, "#05070c");
    g.fillStyle = grad; g.fillRect(0, 0, demo.W, demo.H);
    var L = S.cage.lengthM, Wd = S.cage.widthM, Hg = S.cage.heightM || 3;
    function line(ax, ay, az, bx, by, bz, style, width) {
      var p = demoProject(ax, ay, az), q = demoProject(bx, by, bz);
      if (!p || !q) return;
      g.strokeStyle = style; g.lineWidth = width || 1;
      g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
    }
    // ground grid, 1 m
    for (var x = 0; x <= L; x += 1) line(x, -Wd / 2, 0, x, Wd / 2, 0, "rgba(90,140,200,0.25)", 1);
    for (var y = -Math.floor(Wd / 2); y <= Math.floor(Wd / 2); y += 1) line(0, y, 0, L, y, 0, "rgba(90,140,200,0.25)", 1);
    // cage wireframe
    var c = "rgba(120,180,255,0.8)";
    [[-Wd / 2, 0], [Wd / 2, 0], [-Wd / 2, L], [Wd / 2, L]].forEach(function (pt) {
      line(pt[1], pt[0], 0, pt[1], pt[0], Hg, c, 2);
    });
    line(0, -Wd / 2, Hg, L, -Wd / 2, Hg, c, 2);
    line(0, Wd / 2, Hg, L, Wd / 2, Hg, c, 2);
    line(0, -Wd / 2, Hg, 0, Wd / 2, Hg, c, 2);
    line(L, -Wd / 2, Hg, L, Wd / 2, Hg, c, 2);
    line(0, -Wd / 2, 0, L, -Wd / 2, 0, c, 2);
    line(0, Wd / 2, 0, L, Wd / 2, 0, c, 2);
    // garage wall (only in garage pack): doors/wall/door along one side,
    // plus the 4 ft plywood seam line
    if (S.pack === "garage") {
      var edges = garageEdgesFt(), totalFt = edges[edges.length - 1][0];
      var gyM = S.garage.side * ft2m(5), wallTopM = ft2m(S.garage.doorHFt), seamM = ft2m(4);
      var x0 = S.garage.dir > 0 ? 0 : -ft2m(totalFt), x1 = S.garage.dir > 0 ? ft2m(totalFt) : 0;
      var wc = "rgba(255,200,100,0.6)";
      line(x0, gyM, 0, x1, gyM, 0, wc, 2);
      line(x0, gyM, wallTopM, x1, gyM, wallTopM, wc, 1);
      line(x0, gyM, seamM, x1, gyM, seamM, "rgba(255,150,150,0.7)", 1);
      edges.forEach(function (pair) {
        var ex = S.garage.dir * ft2m(pair[0]);
        line(ex, gyM, 0, ex, gyM, wallTopM, wc, 2);
      });
    }
    // home plate pentagon
    (function () {
      var pts = [[0.216, -0.2159], [0.216, 0.2159], [0.108, 0.2159], [-0.216, 0], [0.108, -0.2159]];
      g.fillStyle = "rgba(240,240,240,0.9)";
      g.beginPath();
      pts.forEach(function (pt, i) {
        var p = demoProject(pt[0], pt[1], 0.01);
        if (p) { if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]); }
      });
      g.closePath(); g.fill();
    })();
    // distance marker cones (feet)
    [10, 15, 20].forEach(function (ft) {
      var d = ft2m(ft);
      if (d > L) return;
      var p = demoProject(d, 0, 0);
      if (!p) return;
      g.fillStyle = "#f5a623";
      g.beginPath(); g.arc(p[0], p[1], 7, 0, 7); g.fill();
      g.fillStyle = "#1a1206"; g.font = "bold 10px sans-serif"; g.textAlign = "center";
      g.fillText(ft + " ft", p[0], p[1] + 3.5);
    });
    // reference preset markers (only the tappable ones)
    buildPresets().forEach(function (pr) {
      if (pr.custom) return;
      var p = demoProject(pr.world[0], pr.world[1], 0.02);
      if (!p) return;
      g.strokeStyle = "#3fb950"; g.lineWidth = 2;
      g.beginPath(); g.arc(p[0], p[1], 11, 0, 7); g.stroke();
      g.fillStyle = "#3fb950"; g.font = "10px sans-serif"; g.textAlign = "center";
      g.fillText(pr.label, p[0], p[1] - 15);
    });
    // verification ball (only on the verify screen) — inputs are feet
    if (S.screen === 5) {
      var vxIn = parseFloat($("verX").value), vyIn = parseFloat($("verY").value);
      var vx = ft2m(isFinite(vxIn) ? vxIn : 15), vy = ft2m(isFinite(vyIn) ? vyIn : 0);
      var bp = demoProject(vx, vy, 0.12);
      if (bp) {
        g.fillStyle = "#fff"; g.beginPath(); g.arc(bp[0], bp[1], 9, 0, 7); g.fill();
        g.strokeStyle = "#f85149"; g.lineWidth = 2; g.stroke();
      }
    }
    // "DEMO" watermark
    g.fillStyle = "rgba(255,255,255,0.35)"; g.font = "bold 13px sans-serif"; g.textAlign = "left";
    g.fillText("DEMO CAGE — synthetic view, ground truth known", 10, 20);
  }
  $("demoBtn").addEventListener("click", function () {
    stopStream();
    S.source = "demo";
    S.mediaSize = { w: demo.W, h: demo.H };
    setSourceUI("demo");
    drawDemo();
    $("camStatus").textContent = "Demo cage active. Tap the green-circled reference points — the wizard knows the true answers here, so it's a full self-test.";
  });

  // ------------------------------------------------------------ tap mechanics
  function mediaTransform() {
    // maps between stage display px and media natural px.
    // Zoom: the view shows natural coords centered at (cx, cy) scaled by
    // base*z, so taps, markers, and the media rect all share one mapping.
    var r = stage.getBoundingClientRect();
    var mw = S.mediaSize.w, mh = S.mediaSize.h;
    var scale = Math.min(r.width / mw, r.height / mh) * S.view.z;
    var cx = S.view.cx == null ? mw / 2 : S.view.cx;
    var cy = S.view.cy == null ? mh / 2 : S.view.cy;
    return { scale: scale, ox: r.width / 2 - cx * scale, oy: r.height / 2 - cy * scale, r: r };
  }
  function clientToNatural(clientX, clientY) {
    var t = mediaTransform();
    var lx = clientX - t.r.left, ly = clientY - t.r.top;
    return [(lx - t.ox) / t.scale, (ly - t.oy) / t.scale];
  }
  function naturalToDisplay(u, v) {
    var t = mediaTransform();
    return [t.ox + u * t.scale, t.oy + v * t.scale];
  }

  // ---- stage zoom/pan -------------------------------------------------------
  // The media elements are laid out from the SAME mapping the taps use, so a
  // zoomed tap is exactly as accurate as an unzoomed one — this is the
  // precision tool for small/distant points.
  function layoutMedia() {
    if (!S.mediaSize) return;
    var t = mediaTransform();
    var mw = S.mediaSize.w, mh = S.mediaSize.h;
    ["liveVideo", "stillImg", "demoCanvas"].forEach(function (id) {
      var el = $(id);
      el.style.left = t.ox + "px";
      el.style.top = t.oy + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
      el.style.width = (mw * t.scale) + "px";
      el.style.height = (mh * t.scale) + "px";
    });
    renderMarkers();
  }
  function resetView() {
    S.view = { z: 1, cx: null, cy: null };
    layoutMedia();
  }
  function clampView() {
    var mw = S.mediaSize.w, mh = S.mediaSize.h;
    if (S.view.z <= 1) { S.view.z = 1; S.view.cx = null; S.view.cy = null; return; }
    S.view.z = Math.min(8, S.view.z);
    var cx = S.view.cx == null ? mw / 2 : S.view.cx;
    var cy = S.view.cy == null ? mh / 2 : S.view.cy;
    S.view.cx = Math.max(0, Math.min(mw, cx));
    S.view.cy = Math.max(0, Math.min(mh, cy));
  }
  // Zoom about a display point (dx, dy in stage px), keeping the natural point
  // under the cursor fixed.
  function zoomAt(dx, dy, factor) {
    if (!S.mediaSize) return;
    var t = mediaTransform();
    var n = clientToNatural(dx + t.r.left, dy + t.r.top); // natural pt under cursor (old view)
    S.view.z = Math.max(1, Math.min(8, S.view.z * factor));
    if (S.view.z <= 1) { S.view.cx = null; S.view.cy = null; }
    else {
      var base = Math.min(t.r.width / S.mediaSize.w, t.r.height / S.mediaSize.h);
      var s2 = base * S.view.z;
      S.view.cx = n[0] - (dx - t.r.width / 2) / s2;
      S.view.cy = n[1] - (dy - t.r.height / 2) / s2;
    }
    clampView(); layoutMedia();
  }

  // Tap = press-and-release without dragging; drag = pan (when zoomed).
  var pdown = null;
  function stageTargetOk(ev) { return !(ev.target.closest && ev.target.closest(".zoomctl")); }
  stage.addEventListener("pointerdown", function (ev) {
    if (!stageTargetOk(ev)) return;
    if (!S.source || !S.mediaSize) return;
    ev.preventDefault();
    pdown = { x: ev.clientX, y: ev.clientY, cx: S.view.cx, cy: S.view.cy,
              moved: false, id: ev.pointerId };
    if (stage.setPointerCapture) { try { stage.setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  stage.addEventListener("pointermove", function (ev) {
    if (!pdown || ev.pointerId !== pdown.id) return;
    var dx = ev.clientX - pdown.x, dy = ev.clientY - pdown.y;
    if (!pdown.moved && Math.hypot(dx, dy) > 6) pdown.moved = true;
    if (pdown.moved && S.view.z > 1 && S.mediaSize) {
      var t = mediaTransform();
      var mw = S.mediaSize.w, mh = S.mediaSize.h;
      S.view.cx = (pdown.cx == null ? mw / 2 : pdown.cx) - dx / t.scale;
      S.view.cy = (pdown.cy == null ? mh / 2 : pdown.cy) - dy / t.scale;
      clampView(); layoutMedia();
    }
  });
  function endPointer(ev) {
    if (!pdown || ev.pointerId !== pdown.id) return;
    var wasTap = !pdown.moved;
    pdown = null;
    if (!wasTap || !S.mediaSize) return;
    var n = clientToNatural(ev.clientX, ev.clientY);
    if (n[0] < 0 || n[1] < 0 || n[0] > S.mediaSize.w || n[1] > S.mediaSize.h) return;
    if (!S.tapping) {
      // Never silently swallow a tap: tell the user what to do first.
      if (S.screen === 2) $("tapHint").textContent = "👆 Click a named point above first, then tap it in the image.";
      return;
    }
    handleTap(n);
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", function (ev) { if (pdown && ev.pointerId === pdown.id) pdown = null; });
  stage.addEventListener("dblclick", function (ev) {
    if (!stageTargetOk(ev) || !S.mediaSize) return;
    var r = stage.getBoundingClientRect();
    if (S.view.z > 1) { resetView(); }
    else zoomAt(ev.clientX - r.left, ev.clientY - r.top, 3);
  });
  stage.addEventListener("wheel", function (ev) {
    if (!S.mediaSize) return;
    ev.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.deltaY < 0 ? 1.25 : 1 / 1.25);
  }, { passive: false });

  $("zoomInBtn").addEventListener("click", function () {
    var r = stage.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.5);
  });
  $("zoomOutBtn").addEventListener("click", function () {
    var r = stage.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / 1.5);
  });
  $("zoomResetBtn").addEventListener("click", resetView);
  $("fsBtn").addEventListener("click", function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(function () {});
  });
  document.addEventListener("fullscreenchange", function () { layoutMedia(); });

  function armTap(kind, hintText) {
    S.tapping = kind;
    stage.classList.add("armed");
    $("tapHint").textContent = hintText || "tap now";
    document.querySelectorAll("#presetRow .btn").forEach(function (b) { b.classList.remove("armed"); });
  }
  function disarmTap() {
    S.tapping = null;
    stage.classList.remove("armed");
    $("tapHint").textContent = "tap a reference point";
  }

  function handleTap(n) {
    if (S.tapping === "ref") addRef(n);
    else if (S.tapping === "heightBase") {
      S.pendingBase = n; disarmTap();
      $("tapTopBtn").disabled = false;
      $("heightStatus").textContent = "Base tapped. Now tap the TOP of the marker.";
      armTap("heightTop", "tap the TOP of the marker");
    }
    else if (S.tapping === "heightTop") {
      disarmTap();
      var hFt = parseFloat($("markerH").value);
      if (!isFinite(hFt) || hFt <= 0) { $("heightStatus").textContent = "⚠ Enter the marker height in feet first."; return; }
      var res = C.solveHeightScale(S.solve.H, ft2m(hFt), S.pendingBase, n);
      if (!res.ok) { $("heightStatus").textContent = "⚠ " + res.reason; return; }
      S.heightSamples.push(res);
      S.pendingBase = null;
      $("tapTopBtn").disabled = true;
      renderHeight();
      save();
    }
    else if (S.tapping === "verifyBall") {
      disarmTap();
      runVerification(n);
    }
  }

  // ------------------------------------------------------------ reference points
  // Door/wall/door layout along the garage wall, in feet from the plate station,
  // computed from the editable S.garage dimensions (screen 2).
  function ftFmt(x) { return (+x.toFixed(2)).toString(); }
  function garageEdgesFt() {
    var g = S.garage;
    return [[g.e0Ft, "Door edge @ plate"], [g.e1Ft, "Door 1 end"],
            [g.e2Ft, "Wall end"], [g.e3Ft, "Door 2 end"]];
  }
  function buildPresets() {
    var L = S.cage.lengthM, Wd = S.cage.widthM;
    var list = [
      { id: "plate-fl", label: "Plate front-left", world: [0.108, -0.2159] },
      { id: "plate-fr", label: "Plate front-right", world: [0.108, 0.2159] },
      { id: "plate-apex", label: "Plate apex", world: [-0.216, 0] },
      { id: "post-near-l", label: "Near post L", world: [0.5, -Wd / 2] },
      { id: "post-near-r", label: "Near post R", world: [0.5, Wd / 2] },
      { id: "post-far-l", label: "Far post L", world: [L, -Wd / 2] },
      { id: "post-far-r", label: "Far post R", world: [L, Wd / 2] },
    ];
    if (S.pack === "garage") {
      // User's pre-measured setup: wall along one side of the cage at the cage
      // edge (10 ft wide cage -> |y| = 5 ft). Plate center even with the first
      // door edge; door widths / center wall come from the editable dimensions.
      var gy = S.garage.side * 5; // ft, lateral
      garageEdgesFt().forEach(function (pair) {
        var fx = pair[0], x = S.garage.dir * fx;
        list.push({
          id: "g-" + ftFmt(fx),
          label: pair[1] + " (" + ftFmt(fx) + " ft)",
          world: [ft2m(x), ft2m(gy)],
        });
      });
      // batter's boxes: 3 ft between the inside edges -> y = +/-1.5 ft,
      // tapped on the inside chalk line even with plate center (x = 0)
      list.push({ id: "box-l", label: "Box inside edge L", world: [0, ft2m(-1.5)] });
      list.push({ id: "box-r", label: "Box inside edge R", world: [0, ft2m(1.5)] });
    } else {
      [10, 15, 20].forEach(function (ft) {
        var d = ft2m(ft);
        if (d <= L) list.push({ id: "mark-" + ft, label: ft + " ft marker", world: [d, 0] });
      });
    }
    list.push({ id: "custom", label: "Custom…", custom: true });
    return list;
  }

  function updatePackUI() {
    $("packGarageBtn").classList.toggle("preset-on", S.pack === "garage");
    $("packGenericBtn").classList.toggle("preset-on", S.pack === "generic");
    var go = $("garageOpts");
    go.hidden = S.pack !== "garage";
    if (S.pack === "garage") {
      $("wallSideBtn").textContent = "Wall: " + (S.garage.side < 0 ? "3rd-base side" : "1st-base side");
      $("doorDirBtn").textContent = "Doors run: " + (S.garage.dir > 0 ? "toward pitcher" : "behind plate");
    }
    syncGarageUI();
  }
  // Keep every garage-derived label in sync with the editable dimensions:
  // door-edge hint, dimension boxes, height quick-sets, height hint.
  function syncGarageUI() {
    var g = S.garage;
    var e = garageEdgesFt().map(function (p) { return ftFmt(p[0]); });
    var dh = $("garageDimsHint");
    if (dh) dh.textContent = "Garage set: door edges at " + e.join(" / ") + " ft along the wall " +
      "(plate center even with the first edge), plus the batter's box inside edges, 3 ft apart. " +
      "No tape measure — just tap each named point in the picture. Flip the toggles if the wall " +
      "is on the other side. Edit the dimensions above if your measurements change.";
    DIM_FIELDS.forEach(function (pair) {
      var el = $(pair[0]);
      if (el && document.activeElement !== el) el.value = g[pair[1]];
    });
    var wb = $("markWindowBtn"), wb2 = $("markWindow2Btn");
    if (wb) wb.innerHTML = g.win1In + "&Prime;: window top";
    if (wb2) wb2.innerHTML = g.win2In + "&Prime;: 2nd window top";
    var hh = $("heightHint");
    if (hh) hh.textContent = "Your garage: the top of the bottom window pane is " + g.win1In +
      "\u2033 and the top of the second pane is " + g.win2In +
      "\u2033, same on both doors. Take one sample at each window, ideally at different doors, " +
      "for a stronger height reading.";
  }
  // Editable garage dimensions: changing one re-derives every door-edge world
  // coordinate, so taps made under the old geometry are pruned (re-tap them).
  // Door edges must stay in increasing order along the wall.
  DIM_FIELDS.forEach(function (pair) {
    $(pair[0]).addEventListener("change", function () {
      var el = $(pair[0]);
      var v = parseFloat(el.value);
      var isEdge = pair[1].charAt(0) === "e";
      var ok = isFinite(v) && (isEdge ? v >= 0 : v > 0);
      if (ok && isEdge) {
        var trial = { e0Ft: S.garage.e0Ft, e1Ft: S.garage.e1Ft,
                      e2Ft: S.garage.e2Ft, e3Ft: S.garage.e3Ft };
        trial[pair[1]] = v;
        ok = trial.e0Ft < trial.e1Ft && trial.e1Ft < trial.e2Ft && trial.e2Ft < trial.e3Ft;
      }
      if (!ok) { el.value = S.garage[pair[1]]; return; }
      S.garage[pair[1]] = v;
      pruneStaleRefs();
      S.solve = null; S.activePreset = null; disarmTap();
      save(); syncGarageUI(); renderPresets(); renderRefs();
    });
  });
  $("packGarageBtn").addEventListener("click", function () {
    S.pack = "garage"; S.activePreset = null; disarmTap(); save(); updatePackUI(); renderPresets();
  });
  $("packGenericBtn").addEventListener("click", function () {
    S.pack = "generic"; S.activePreset = null; disarmTap(); save(); updatePackUI(); renderPresets();
  });
  $("wallSideBtn").addEventListener("click", function () {
    S.garage.side *= -1; S.refs = []; S.solve = null; S.activePreset = null; disarmTap();
    save(); updatePackUI(); renderPresets(); renderRefs();
  });
  $("doorDirBtn").addEventListener("click", function () {
    S.garage.dir *= -1; S.refs = []; S.solve = null; S.activePreset = null; disarmTap();
    save(); updatePackUI(); renderPresets(); renderRefs();
  });

  function renderPresets() {
    updatePackUI();
    var row = $("presetRow");
    row.innerHTML = "";
    buildPresets().forEach(function (pr) {
      var b = document.createElement("button");
      b.className = "btn small" + (S.activePreset === pr.id ? " preset-on" : "");
      b.textContent = pr.label;
      b.addEventListener("click", function () {
        S.activePreset = pr.id;
        $("customRefRow").hidden = !pr.custom;
        renderPresets();
        armTap("ref", "tap: " + pr.label);
        b.classList.add("armed");
      });
      row.appendChild(b);
    });
  }

  function addRef(n) {
    var pr = buildPresets().find(function (p) { return p.id === S.activePreset; });
    if (!pr) return;
    var world = pr.world;
    if (pr.custom) {
      var x = parseFloat($("customX").value), y = parseFloat($("customY").value);
      if (!isFinite(x) || !isFinite(y)) { alert("Enter numeric X/Y for the custom point."); return; }
      world = [ft2m(x), ft2m(y)];
      pr = { id: "custom-" + Date.now(), label: "Custom (" + x + ", " + y + " ft)" };
    }
    // replace existing tap for the same preset id (re-tap = correction)
    S.refs = S.refs.filter(function (r) { return r.id !== pr.id || pr.custom; });
    S.refs.push({ id: pr.id, label: pr.label, image: [Math.round(n[0]), Math.round(n[1])], world: world });
    // Disarm after every tap: the next tap must pick its own preset first.
    // (Leaving the old preset armed made extra taps silently REPLACE the last
    // point instead of adding a new one.)
    disarmTap();
    document.querySelectorAll("#presetRow .btn").forEach(function (b) { b.classList.remove("armed"); });
    renderRefs();
    save();
  }

  function renderRefs() {
    var list = $("refList");
    list.innerHTML = "";
    if (!S.refs.length) { list.innerHTML = "<li class='muted'>None yet.</li>"; }
    S.refs.forEach(function (r, i) {
      var li = document.createElement("li");
      li.innerHTML = "<span><strong>" + (i + 1) + ".</strong> " + escapeHtml(r.label) +
        " <span class='muted'>(" + ft1(r.world[0]) + ", " + ft1(r.world[1]) + " ft)</span></span>";
      var del = document.createElement("button");
      del.className = "btn small danger"; del.textContent = "✕";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        S.refs.splice(i, 1); S.solve = null;
        renderRefs(); save();
      });
      li.appendChild(del);
      list.appendChild(li);
    });
    var n = S.refs.length;
    $("refCount").textContent = n + " / 4 minimum" + (n >= 6 ? " ✓" : "");
    $("solveBtn").disabled = n < 4;
    renderMarkers();
  }

  function renderMarkers() {
    layer.querySelectorAll(".tap-marker").forEach(function (m) { m.remove(); });
    if (!S.mediaSize) return;
    S.refs.forEach(function (r, i) {
      var d = naturalToDisplay(r.image[0], r.image[1]);
      var m = document.createElement("div");
      m.className = "tap-marker";
      m.style.left = d[0] + "px"; m.style.top = d[1] + "px";
      m.innerHTML = "<span class='n'>" + (i + 1) + "</span>";
      layer.appendChild(m);
    });
  }

  $("clearRefsBtn").addEventListener("click", function () {
    S.refs = []; S.solve = null;
    renderRefs(); save();
  });

  // ------------------------------------------------------------ solve + review
  $("solveBtn").addEventListener("click", function () {
    var err = $("solveError");
    err.hidden = true;
    var res = C.solveHomography(S.refs);
    if (!res.ok) {
      // Fail-closed: show the reason, do not advance.
      err.textContent = "⚠ " + res.reason + " Add or correct points and try again.";
      err.hidden = false;
      return;
    }
    S.solve = res;
    save();
    showScreen(3);
  });

  function errClass(px) { return px < 2 ? "err-green" : px <= 5 ? "err-amber" : "err-red"; }

  function renderSolve() {
    var s = S.solve;
    if (!s) { showScreen(2); return; }
    $("statMeanPx").textContent = s.meanPx.toFixed(1);
    $("statMaxPx").textContent = s.maxPx.toFixed(1);
    $("statMeanIn").textContent = in1(s.meanM);
    var advice = $("fitAdvice"), n = s.numPoints;
    if (s.meanPx <= 2 && n >= 6)
      advice.innerHTML = "Excellent fit. This mapping is trustworthy — proceed to verification.";
    else if (s.meanPx <= 5)
      advice.innerHTML = "Usable, but check the red rows below: an outlier usually means a mis-tapped point. Tap a row to delete it and re-solve.";
    else
      advice.innerHTML = "<strong>Poor fit.</strong> Do not trust this. Likely causes: a mis-tapped point, the camera moved between taps, or points too clustered. Delete the worst rows and re-solve.";
    var list = $("reprojList");
    list.innerHTML = "";
    S.refs.forEach(function (r, i) {
      var e = s.perPoint[i];
      var li = document.createElement("li");
      li.className = "tappable";
      li.innerHTML = "<span><strong>" + (i + 1) + ".</strong> " + escapeHtml(r.label) + "</span>" +
        "<span class='" + errClass(e.reprojPx) + "'>" + e.reprojPx.toFixed(1) + " px · " + in1(e.reprojM) + " in</span>";
      li.title = "Tap to delete this point and re-solve";
      li.addEventListener("click", function () {
        S.refs.splice(i, 1);
        var res = C.solveHomography(S.refs);
        if (!res.ok) { S.solve = null; showScreen(2); }
        else { S.solve = res; renderSolve(); }
        renderRefs(); save();
      });
      list.appendChild(li);
    });
  }

  // ------------------------------------------------------------ height scale
  function needSource(statusEl) {
    if (!S.source) {
      statusEl.textContent = "No camera yet — go back to step 2 and pick Live camera, a still photo, or the demo cage.";
      return false;
    }
    return true;
  }
  $("tapBaseBtn").addEventListener("click", function () {
    if (!S.solve) { $("heightStatus").textContent = "Solve the ground mapping first."; return; }
    if (!needSource($("heightStatus"))) return;
    if (S.source === "demo") drawDemo();
    armTap("heightBase", "tap the BASE of the marker (ground level)");
  });
  $("tapTopBtn").addEventListener("click", function () {
    if (S.pendingBase) armTap("heightTop", "tap the TOP of the marker");
  });
  // quick-set the known marker height from the editable window-top dimensions
  $("markWindowBtn").addEventListener("click", function () { $("markerH").value = (S.garage.win1In / 12).toFixed(3); });
  $("markWindow2Btn").addEventListener("click", function () { $("markerH").value = (S.garage.win2In / 12).toFixed(3); });

  function renderHeight() {
    var list = $("heightList");
    list.innerHTML = "";
    S.heightSamples.forEach(function (smp, i) {
      var li = document.createElement("li");
      li.innerHTML = "<span>Sample " + (i + 1) + ": <strong>" + (smp.pxPerM / FT_PER_M).toFixed(1) +
        " px/ft</strong> at (" + ft1(smp.groundWorld[0]) + ", " + ft1(smp.groundWorld[1]) + " ft)</span>";
      var del = document.createElement("button");
      del.className = "btn small danger"; del.textContent = "✕";
      del.addEventListener("click", function () { S.heightSamples.splice(i, 1); renderHeight(); save(); });
      li.appendChild(del);
      list.appendChild(li);
    });
    $("heightStatus").textContent = S.heightSamples.length
      ? S.heightSamples.length + " height sample(s) recorded. Height is MEASURED for this cage."
      : "No height sample yet. You can skip, but launch angle and exit velocity will stay uncalibrated estimate.";
  }

  // ------------------------------------------------------------ verification
  $("tapBallBtn").addEventListener("click", function () {
    if (!S.solve) { $("verifyHint").textContent = "Solve the ground mapping first."; return; }
    if (!needSource($("verifyHint"))) return;
    if (S.source === "demo") drawDemo();
    armTap("verifyBall", "tap the ball in the image");
  });
  // redraw demo ball when the known position changes
  ["verX", "verY"].forEach(function (id) {
    $(id).addEventListener("change", function () { if (S.source === "demo") drawDemo(); });
  });

  function runVerification(ballPx) {
    var kxFt = parseFloat($("verX").value), kyFt = parseFloat($("verY").value);
    var threshFt = parseFloat($("verThresh").value);
    if (!isFinite(kxFt) || !isFinite(kyFt) || !isFinite(threshFt) || threshFt <= 0) {
      $("verifyHint").textContent = "Enter a valid known position and threshold first.";
      return;
    }
    var kx = ft2m(kxFt), ky = ft2m(kyFt), thresh = ft2m(threshFt);
    var w = C.applyH(S.solve.H, ballPx[0], ballPx[1]);
    if (!w) {
      $("verifyHint").textContent = "⚠ That tap maps outside the calibrated plane — tap the ball again.";
      return;
    }
    var errM = Math.hypot(w[0] - kx, w[1] - ky);
    var passed = errM <= thresh;
    S.verification = {
      method: "known-position-tap",
      knownWorldM: [round3(kx), round3(ky)],
      measuredWorldM: [round2(w[0]), round2(w[1])],
      errorM: round3(errM),
      thresholdM: round3(thresh),
      passed: passed,
    };
    save();
    var box = $("verifyResult");
    box.hidden = false;
    $("verErr").textContent = in1(errM) + " in";
    var v = $("verVerdict");
    v.innerHTML = passed ? "<span class='tag ok'>PASS ✓</span>" : "<span class='tag bad'>FAIL</span>";
    $("verAdvice").innerHTML = passed
      ? "Measured (" + ft1(w[0]) + ", " + ft1(w[1]) + " ft) vs known (" + kxFt + ", " + kyFt + " ft). " +
        "The ground plane is <strong>verified</strong> — the profile will be marked calibrated."
      : "Measured (" + ft1(w[0]) + ", " + ft1(w[1]) + " ft) vs known (" + kxFt + ", " + kyFt + " ft) — " +
        "missed by " + in1(errM) + " in (limit " + (threshFt * 12).toFixed(0) + " in). " +
        "The profile will stay <span class='tag warn'>uncalibrated estimate</span>. " +
        "Fix: re-tap the reference points (check outliers on the Review step), confirm the camera didn't move, " +
        "and make sure the ball is really at the marked position.";
    $("verifyHint").textContent = "Tapped ball → computed (" + ft1(w[0]) + ", " + ft1(w[1]) + " ft).";
  }

  // ------------------------------------------------------------ profile
  $("toProfileBtn").addEventListener("click", function () {
    var built = C.buildProfile({
      cage: S.cage,
      camera: Object.assign({}, S.camera, S.mediaSize ? {
        imageWidth: S.mediaSize.w, imageHeight: S.mediaSize.h,
      } : {}),
      solveResult: S.solve,
      referencePoints: S.refs,
      heightSamples: S.heightSamples,
      verification: S.verification,
      appVersion: "cage-wizard-prototype/0.1.0",
      notes: "source=" + (S.source || "none"),
    });
    if (!built.valid) {
      alert("Profile incomplete:\n- " + built.errors.join("\n- "));
      return;
    }
    S.profile = built.profile;
    try { localStorage.setItem("cageProfile.v1", JSON.stringify(S.profile)); } catch (e) {}
    showScreen(6);
  });

  function renderProfile() {
    var p = S.profile;
    var card = $("profileCard");
    if (!p) { card.innerHTML = "<p class='muted'>No profile built yet.</p>"; return; }
    var vTag = p.verified ? "<span class='tag ok'>CALIBRATED ✓</span>"
                          : "<span class='tag warn'>UNCALIBRATED ESTIMATE</span>";
    var confColor = p.confidence === "high" ? "ok" : p.confidence === "medium" ? "warn" : "bad";
    card.innerHTML =
      "<h2>Cage profile " + vTag + "</h2>" +
      "<p>Confidence: <span class='tag " + confColor + "'>" + p.confidence + "</span>" +
      " · Ground plane: <strong>" + p.capabilities.groundPlane + "</strong>" +
      " · Height: <strong>" + p.heightScale.status + "</strong></p>" +
      "<p class='hint'>Cage " + ft1(p.cage.lengthM) + " × " + ft1(p.cage.widthM) + " ft · " +
      p.homography.numPoints + " reference points · mean reprojection " +
      p.homography.reprojectionErrorPx.mean.toFixed(1) + " px (" +
      in1(p.homography.reprojectionErrorM.mean) + " in)" +
      (p.verification ? " · verification miss " + in1(p.verification.errorM) + " in" : " · not verified") +
      "<br>Created " + p.createdAt + " · profile JSON stores meters (SI), UI shows feet</p>" +
      "<pre class='profile-json'>" + escapeHtml(JSON.stringify(p, null, 1)).slice(0, 4000) + "</pre>";
    var ul = $("unlockList");
    ul.innerHTML = "";
    function li(ok, text) {
      var e = document.createElement("li");
      e.innerHTML = (ok ? "✅ " : "⚠ ") + text;
      ul.appendChild(e);
    }
    li(p.capabilities.groundPlane === "verified",
       "Landing position, spray charts, distance — " +
       (p.capabilities.groundPlane === "verified" ? "calibrated" : "uncalibrated estimate"));
    li(p.heightScale.status === "measured",
       "Launch angle, exit velocity — " +
       (p.heightScale.status === "measured" ? "calibrated" : "uncalibrated estimate") +
       (p.heightScale.status === "measured" ? "" : " (no measured height scale)"));
    if (!p.verified)
      li(false, "Nothing here is verified. Re-run the wizard when the cage is set up properly — " +
         "the tracking stage will refuse calibrated numbers until verification passes.");
  }

  $("downloadBtn").addEventListener("click", function () {
    if (!S.profile) return;
    var blob = new Blob([JSON.stringify(S.profile, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cage-calibration-profile.json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });
  $("copyBtn").addEventListener("click", function () {
    if (!S.profile) return;
    navigator.clipboard.writeText(JSON.stringify(S.profile, null, 2))
      .then(function () { $("copyBtn").textContent = "✓ Copied"; })
      .catch(function () { alert("Copy failed — use Download instead."); });
  });
  $("restartBtn").addEventListener("click", function () {
    if (!confirm("Start over? This clears points, solve, and verification.")) return;
    S.refs = []; S.solve = null; S.heightSamples = []; S.pendingBase = null;
    S.verification = null; S.profile = null; S.activePreset = null;
    disarmTap(); save();
    renderRefs(); renderHeight();
    showScreen(0);
  });

  // ------------------------------------------------------------ load profile
  $("loadProfileBtn").addEventListener("click", function () { $("loadProfileFile").click(); });
  $("loadProfileFile").addEventListener("change", function () {
    var f = $("loadProfileFile").files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var p = JSON.parse(rd.result);
        var chk = C.validateProfile(p);
        if (!chk.ok) { alert("Invalid profile:\n- " + chk.errors.join("\n- ")); return; }
        S.profile = p;
        var vTag = p.verified ? "<span class='tag ok'>CALIBRATED ✓</span>"
                              : "<span class='tag warn'>UNCALIBRATED ESTIMATE</span>";
        $("loadedCard").innerHTML = "<h2>Profile " + vTag + "</h2>" +
          "<p class='hint'>Created " + (p.createdAt || "?") + " · " +
          "ground plane: " + p.capabilities.groundPlane + " · height: " + p.capabilities.height + "</p>" +
          "<pre class='profile-json'>" + escapeHtml(JSON.stringify(p, null, 1)).slice(0, 4000) + "</pre>";
        showScreen(7);
      } catch (e) { alert("Could not read that file: " + e.message); }
    };
    rd.readAsText(f);
  });
  $("backToStart").addEventListener("click", function () { showScreen(0); });

  // ------------------------------------------------------------ helpers
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  window.addEventListener("resize", function () { layoutMedia(); });

  // Build tag + refresh (same pattern as the session page): the tag is read
  // from this script's own ?v= cache-buster so both devices can confirm
  // they're on the same build, and the button force-reloads without
  // closing the tab.
  (function () {
    var build = "dev";
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var m = (scripts[i].src || "").match(/wizard\.js\?v=([0-9A-Za-z]+)/);
        if (m) { build = m[1]; break; }
      }
    } catch (e) {}
    var tag = $("build-tag");
    if (tag) tag.textContent = "build " + build;
    var rb = $("btn-refresh");
    if (rb) rb.addEventListener("click", function () {
      location.replace(location.pathname + "?fresh=" + Date.now());
    });
  })();

  // ------------------------------------------------------------ init
  restore();
  fillMeasurements();
  renderRefs();
  renderHeight();
  if (S.verification) {
    // re-show a previous verification result if the user reloads mid-flow
    // (stored in meters, inputs are feet)
    var v = S.verification;
    $("verX").value = ft1(v.knownWorldM[0]); $("verY").value = ft1(v.knownWorldM[1]);
  }
  showScreen(0);
})();
