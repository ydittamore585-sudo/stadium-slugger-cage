/**
 * Stadium Slugger Cage Session — laptop-side phone camera calibration.
 *
 * The phone moves every session, so calibration happens HERE on the laptop,
 * tapping reference points on the live phone feed. Uses the shared
 * CageCalibration math core (ground-plane homography).
 *
 * Garage preset (user's measured geometry, feet -> meters):
 *   door edges along the wall at x = 0 / 10.25 / 16.5 / 26.75 ft, y = +5 ft
 *   (wall on +y / 1st-base side, confirmed)
 *   batter's box inside edges at (0, +/-1.5 ft)
 *   plate corners / apex near origin
 */
(function () {
  "use strict";

  var FT = 0.3048;
  var $ = function (id) { return document.getElementById(id); };

  // Reference points: id, label, world [x, y] in meters.
  // +x toward pitcher/outfield, +y lateral (+ = 1st-base/wall side).
  var REF_POINTS = [
    { id: "plate-apex", label: "Plate apex", world: [-0.216, 0] },
    { id: "plate-fl", label: "Plate front-left", world: [0.108, -0.2159] },
    { id: "plate-fr", label: "Plate front-right", world: [0.108, 0.2159] },
    { id: "door0", label: "Door edge @ plate (0 ft)", world: [0, 5 * FT] },
    { id: "door1", label: "Door 1 end (10.25 ft)", world: [10.25 * FT, 5 * FT] },
    { id: "door2", label: "Wall end (16.5 ft)", world: [16.5 * FT, 5 * FT] },
    { id: "door3", label: "Door 2 end (26.75 ft)", world: [26.75 * FT, 5 * FT] },
    { id: "box-l", label: "Box inside edge L", world: [0, -1.5 * FT] },
    { id: "box-r", label: "Box inside edge R", world: [0, 1.5 * FT] },
  ];

  var taps = {};          // id -> {u, v} in video pixels
  var selectedId = null;
  var active = false;
  var profile = null;     // solved CageCalibration profile
  var touchHandler = null;

  function videoEl() { return $("cam"); }

  function setStatus(msg) {
    var el = $("calib-status");
    if (el) el.textContent = msg;
  }

  function renderList() {
    var box = $("calib-points");
    if (!box) return;
    box.innerHTML = "";
    REF_POINTS.forEach(function (rp) {
      var tapped = !!taps[rp.id];
      var b = document.createElement("button");
      b.className = "calib-pt" + (tapped ? " done" : "") + (rp.id === selectedId ? " sel" : "");
      b.textContent = (tapped ? "✓ " : "○ ") + rp.label;
      b.onclick = function () {
        selectedId = rp.id;
        renderList();
        setStatus("Tap where '" + rp.label + "' appears in the video.");
      };
      box.appendChild(b);
    });
    var n = Object.keys(taps).length;
    $("calib-count").textContent = n + " / " + REF_POINTS.length + " tapped";
    $("calib-solve").disabled = n < 4;
  }

  function videoPos(ev) {
    var v = videoEl();
    if (!v || !v.videoWidth) return null;
    var r = v.getBoundingClientRect();
    // Convert CSS pixels to video pixels.
    var u = (ev.clientX - r.left) / r.width * v.videoWidth;
    var vv = (ev.clientY - r.top) / r.height * v.videoHeight;
    // Ignore clicks outside the video frame.
    if (u < 0 || vv < 0 || u > v.videoWidth || vv > v.videoHeight) return null;
    return { u: Math.round(u), v: Math.round(vv) };
  }

  function onVideoClick(ev) {
    if (!active || !selectedId) return;
    var p = videoPos(ev);
    if (!p) return;
    taps[selectedId] = p;
    setStatus("Tapped '" + labelOf(selectedId) + "' at (" + p.u + ", " + p.v + "). Pick the next point.");
    // Auto-advance to the next untapped point.
    var next = REF_POINTS.filter(function (rp) { return !taps[rp.id]; })[0];
    selectedId = next ? next.id : null;
    renderList();
    drawMarkers();
  }

  function labelOf(id) {
    var rp = REF_POINTS.filter(function (r) { return r.id === id; })[0];
    return rp ? rp.label : id;
  }

  function drawMarkers() {
    var layer = $("calib-markers");
    var v = videoEl();
    if (!layer || !v) return;
    layer.innerHTML = "";
    var r = v.getBoundingClientRect();
    Object.keys(taps).forEach(function (id) {
      var t = taps[id];
      var x = t.u / v.videoWidth * r.width;
      var y = t.v / v.videoHeight * r.height;
      var d = document.createElement("div");
      d.className = "calib-marker";
      d.style.left = x + "px";
      d.style.top = y + "px";
      d.title = labelOf(id);
      // Click a marker to remove that tap.
      d.onclick = function (e) {
        e.stopPropagation();
        delete taps[id];
        renderList();
        drawMarkers();
        setStatus("Removed '" + labelOf(id) + "'.");
      };
      layer.appendChild(d);
    });
  }

  function solve() {
    var refs = [];
    REF_POINTS.forEach(function (rp) {
      if (taps[rp.id]) {
        refs.push({
          image: { u: taps[rp.id].u, v: taps[rp.id].v },
          world: { x: rp.world[0], y: rp.world[1] },
        });
      }
    });
    if (refs.length < 4) {
      setStatus("Need at least 4 tapped points.");
      return;
    }
    var res;
    try {
      res = CageCalibration.solveHomography(refs);
    } catch (e) {
      setStatus("Solve failed: " + (e && e.message ? e.message : e));
      return;
    }
    if (!res.ok) {
      setStatus("Insufficient evidence: " + (res.reason || "solve failed") + " — re-tap spread-out points.");
      return;
    }
    var meanPx = res.meanPx, maxPx = res.maxPx;
    var verdict = meanPx <= 6
      ? "Good — mean reprojection " + meanPx.toFixed(1) + " px (max " + maxPx.toFixed(1) + " px)."
      : "Poor — mean reprojection " + meanPx.toFixed(1) + " px. Re-tap more carefully (zoom in).";
    setStatus(verdict + " You can Apply anyway, but numbers will be shaky.");
    $("calib-apply").disabled = false;
    $("calib-save").disabled = false;
    try {
      profile = CageCalibration.buildProfile({
        cage: { lengthM: 30 * FT, widthM: 10 * FT },
        camera: { note: "mounted phone, position varies per session" },
        solveResult: res,
        heightSamples: [],
        verification: null,
        appVersion: "session",
        notes: "Laptop-side tap calibration on live phone feed.",
      });
    } catch (e) {
      profile = { solveResult: res };
    }
    // Stash the homography where the session detector can use it.
    try {
      window.SessionApp = window.SessionApp || {};
      window.SessionApp.phoneCalibration = {
        H: res.H, Hinv: res.Hinv,
        meanPx: meanPx, maxPx: maxPx,
        numPoints: refs.length,
        verified: false,
      };
    } catch (e) {}
  }

  function apply() {
    if (!profile) return;
    setStatus("Calibration applied — ground-plane measurements are live. (Unverified: treat numbers as estimates until you run a ball-on-ground check.)");
    // Keep the panel open so the user sees the status; close tap mode.
    stopTapMode();
  }

  function useLastPosition() {
    setStatus("Loading last validated position…");
    fetch("last-position-preset.json?v=20260917a")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (preset) {
        // Stash the homography where the session detector can use it.
        window.SessionApp = window.SessionApp || {};
        window.SessionApp.phoneCalibration = {
          H: preset.H, Hinv: preset.Hinv,
          meanPx: preset.meanPx, maxPx: preset.maxPx,
          numPoints: preset.numPoints,
          verified: false,
          approximate: true,
          label: preset.label,
        };
        profile = { preset: preset };
        setStatus("Loaded '" + preset.label + "' — APPROXIMATE (phone within inches of that spot, not exact). Treat numbers as estimates. For best accuracy, do the 6-tap calibration.");
        $("calib-apply").disabled = false;
        $("calib-save").disabled = false;
      })
      .catch(function (e) {
        setStatus("Couldn't load last position: " + (e && e.message ? e.message : e));
      });
  }

  function save() {
    if (!profile) return;
    var blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "phone-calibration-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); }, 500);
  }

  function startTapMode() {
    var v = videoEl();
    if (!v || !v.videoWidth) {
      setStatus("No live phone feed — pair the phone first.");
      return;
    }
    active = true;
    taps = {};
    profile = null;
    selectedId = REF_POINTS[0].id;
    $("calib-panel").classList.remove("hidden");
    $("calib-apply").disabled = true;
    $("calib-save").disabled = true;
    // Listen on the container, not the video: overlay layers can swallow
    // clicks on the video element itself. videoPos() maps to video pixels.
    // Support both mouse clicks and touchscreen taps.
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.addEventListener("click", onVideoClick);
      touchHandler = function (ev) {
        // Convert the first touch to a click-like event.
        if (ev.touches && ev.touches.length > 0) {
          var t = ev.touches[0];
          onVideoClick(t);
          ev.preventDefault();
        }
      };
      wrap.addEventListener("touchstart", touchHandler, { passive: false });
      wrap.style.cursor = "crosshair";
    }
    renderList();
    drawMarkers();
    setStatus("Tap where '" + labelOf(selectedId) + "' appears in the video. Click a marker to remove it.");
    window.addEventListener("resize", drawMarkers);
  }

  function stopTapMode() {
    active = false;
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.removeEventListener("click", onVideoClick);
      if (touchHandler) wrap.removeEventListener("touchstart", touchHandler);
      wrap.style.cursor = "";
    }
    touchHandler = null;
    window.removeEventListener("resize", drawMarkers);
    var layer = $("calib-markers");
    if (layer) layer.innerHTML = "";
  }

  function close() {
    stopTapMode();
    $("calib-panel").classList.add("hidden");
  }

  // Public API
  window.PhoneCalib = {
    open: startTapMode,
    close: close,
    solve: solve,
    apply: apply,
    save: save,
    isActive: function () { return active; },
    getProfile: function () { return profile; },
  };

  // Wire panel buttons once the DOM is ready.
  function wire() {
    var s = $("calib-solve"), a = $("calib-apply"), sv = $("calib-save"), c = $("calib-close"), ul = $("calib-use-last");
    if (s) s.onclick = solve;
    if (a) a.onclick = apply;
    if (sv) sv.onclick = save;
    if (c) c.onclick = close;
    if (ul) ul.onclick = useLastPosition;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
