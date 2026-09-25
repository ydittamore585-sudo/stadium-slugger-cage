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
  var IN = 0.0254;
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
    { id: "box-l", label: "Box inside L @ plate", world: [0, -1.5 * FT] },
    { id: "box-r", label: "Box inside R @ plate", world: [0, 1.5 * FT] },
  ];
  // Height refs (2026-09-24: Yancy — "add the height as click points like the
  // doors"): top of bottom pane (47") and top of 2nd pane (69.5") at each door
  // x-position, plus the 2' batting tee at the plate. Tapped like ground
  // points; solve() converts them to a px/m height scale via the homography.
  [0, 10.25, 16.5, 26.75].forEach(function (xft, i) {
    REF_POINTS.push({
      id: "hpane-lo-" + i, label: "📏 Pane low (47\") @ " + xft + " ft",
      world: [xft * FT, 5 * FT], heightM: 47 * IN,
    });
    REF_POINTS.push({
      id: "hpane-hi-" + i, label: "📏 Pane high (69.5\") @ " + xft + " ft",
      world: [xft * FT, 5 * FT], heightM: 69.5 * IN,
    });
  });
  REF_POINTS.push({
    id: "tee-top", label: "📏 Tee top (2') @ plate",
    world: [0, 0], heightM: 2 * FT,
  });

  var taps = {};          // id -> {u, v} in video pixels
  var selectedId = null;
  var active = false;
  var profile = null;     // solved CageCalibration profile
  var touchHandler = null;
  var hasSolvedProfile = false; // solve() ran on this page load
  var lastHeightScale = null;   // Step 12: bat-measured {pxPerM,...}, survives re-solves
  var heightActive = false, heightTaps = []; // Step 12: bat tap mode
  var verifyActive = false, verifyTap = null; // Step 1: ball verification mode

  // --- Calibration persistence -----------------------------------------
  // The laptop's solved calibration survives a page refresh: every
  // mutation persists the state to localStorage, and wire() restores it on
  // load. A refresh after a patch-day deploy no longer forces a re-tap when
  // the phone hasn't moved. Restored state is timestamped in the status
  // line; if the phone WAS remounted, re-tap or Auto-adjust as usual.
  // Persistence never breaks calibration: any storage error is swallowed.
  var CALIB_STORE_KEY = "cage.calibration.v1";

  function persistCalibration() {
    try {
      var s = window.SessionApp || {};
      var data = {
        v: 1,
        savedAt: Date.now(),
        phone: s.phoneCalibration || null,
        manual: s.manualCalibration || null,
        profile: profile || null,
        lastHeightScale: lastHeightScale || null,
        hasSolvedProfile: !!hasSolvedProfile
      };
      // profile.refPatches holds base64 48x48 patches (~3KB each) — small.
      localStorage.setItem(CALIB_STORE_KEY, JSON.stringify(data));
    } catch (e) { /* storage full/blocked: session works, just won't survive refresh */ }
  }

  function restoreCalibration() {
    var raw = null;
    try { raw = localStorage.getItem(CALIB_STORE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data) return false;
    // Case 1: a solved/applied calibration — the common case. Restore it
    // wholesale so the detector keeps working after a refresh.
    if (data.phone && data.phone.H) {
      window.SessionApp = window.SessionApp || {};
      window.SessionApp.phoneCalibration = data.phone;
      if (data.manual) window.SessionApp.manualCalibration = data.manual;
      if (data.profile) profile = data.profile;
      if (data.lastHeightScale) lastHeightScale = data.lastHeightScale;
      hasSolvedProfile = !!data.hasSolvedProfile;
      var t = "";
      try { t = new Date(data.savedAt).toLocaleTimeString(); } catch (e) {}
      var ageH = (Date.now() - (data.savedAt || 0)) / 3600000;
      var n = data.phone.numPoints != null ? data.phone.numPoints : "?";
      var mp = (typeof data.phone.meanPx === "number") ? data.phone.meanPx.toFixed(1) : "?";
      var flags = (data.phone.autoAdjusted ? " [auto-adjusted]" : "") +
                  (data.phone.approximate ? " [APPROXIMATE]" : "") +
                  (data.phone.verified ? " [verified]" : "");
      var stale = ageH > 12
        ? " — over 12h old: re-tap or Auto-adjust to be safe."
        : " — if the phone moved since, re-tap or Auto-adjust.";
      setStatus("Restored calibration from " + t + " (" + n + " pts, " + mp + "px)" + flags + stale);
      var ab = $("calib-apply"); if (ab) ab.disabled = false;
      var sv = $("calib-save"); if (sv) sv.disabled = false;
      unlockCalibActions();
      return true;
    }
    // Case 2: a profile was loaded (file) but never solved/applied — keep
    // it staged for Auto-adjust rather than dropping it on the floor.
    if (data.profile && data.profile.refPatches && data.profile.refPatches.patches) {
      profile = data.profile;
      if (data.lastHeightScale) lastHeightScale = data.lastHeightScale;
      setStatus("Restored your loaded profile (" + data.profile.refPatches.patches.length + " reference patches, not yet applied) — hit Auto-adjust.");
      var au = $("calib-auto"); if (au) au.disabled = false;
      return true;
    }
    return false;
  }

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
    var ng = 0;
    REF_POINTS.forEach(function (rp) { if (taps[rp.id] && !rp.heightM) ng++; });
    $("calib-count").textContent = n + " / " + REF_POINTS.length + " tapped (" + ng + " ground)";
    $("calib-solve").disabled = ng < 4;
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
    var refs = [], heightRefs = [];
    REF_POINTS.forEach(function (rp) {
      if (taps[rp.id]) {
        // solveHomography's contract is arrays: image:[u,v], world:[x,y].
        // Passing {u,v}/{x,y} objects silently trips its isFinite guard as
        // "non-finite coordinates" (r.image[0] is undefined). Never regress.
        var entry = {
          id: rp.id,
          image: [taps[rp.id].u, taps[rp.id].v],
          world: [rp.world[0], rp.world[1]],
        };
        if (rp.heightM) {
          entry.heightM = rp.heightM;
          heightRefs.push(entry);
        } else {
          refs.push(entry);
        }
      }
    });
    if (refs.length < 4) {
      setStatus("Need at least 4 tapped ground points (height 📏 points don't count for the ground solve).");
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
      // res.reason already carries the "Insufficient evidence:" prefix —
      // don't prepend it again.
      setStatus(res.reason + " — re-tap spread-out points.");
      return;
    }
    var meanPx = res.meanPx, maxPx = res.maxPx;
    // Height scale from 📏 tap points: project each point's ground (x,y)
    // through Hinv to image, measure px to the elevated tap, divide by
    // known height. Median across samples for robustness.
    // (2026-09-24: Yancy — height as tap points like the doors.)
    var heightSamples = [];
    if (res.Hinv) {
      for (var hi = 0; hi < heightRefs.length; hi++) {
        var hr = heightRefs[hi];
        var g = applyHLocal(res.Hinv, hr.world[0], hr.world[1]);
        if (g) {
          var dpix = Math.hypot(hr.image[0] - g[0], hr.image[1] - g[1]);
          if (dpix > 1 && hr.heightM > 0) {
            heightSamples.push({
              id: hr.id, pxPerM: dpix / hr.heightM,
              px: Math.round(dpix), heightM: hr.heightM,
            });
          }
        }
      }
    }
    var heightScale = null;
    if (heightSamples.length) {
      var sorted = heightSamples.map(function (s) { return s.pxPerM; }).sort(function (a, b) { return a - b; });
      var med = sorted[Math.floor(sorted.length / 2)];
      heightScale = { pxPerM: med, samples: heightSamples, source: "pane taps" };
      lastHeightScale = heightScale;
    }
    var verdict = meanPx <= 6
      ? "Good — mean reprojection " + meanPx.toFixed(1) + " px (max " + maxPx.toFixed(1) + " px)."
      : "Poor — mean reprojection " + meanPx.toFixed(1) + " px. Re-tap more carefully (zoom in).";
    if (heightScale) {
      verdict += " Height: " + heightScale.pxPerM.toFixed(1) + " px/m from " +
        heightSamples.length + " pane tap" + (heightSamples.length > 1 ? "s" : "") + ".";
    }
    setStatus(verdict + " You can Apply anyway, but numbers will be shaky.");
    $("calib-apply").disabled = false;
    $("calib-save").disabled = false;
    unlockCalibActions();
    try {
      profile = CageCalibration.buildProfile({
        cage: { lengthM: 30 * FT, widthM: 10 * FT },
        camera: { note: "mounted phone, position varies per session" },
        solveResult: res,
        heightSamples: heightSamples,
        verification: null,
        appVersion: "session",
        notes: "Laptop-side tap calibration on live phone feed.",
      });
    } catch (e) {
      profile = { solveResult: res };
    }
    // Step 12: carry the height scale across re-solves — the mount didn't
    // move, only the taps did. lastHeightScale is the fresh tap result when
    // 📏 points were tapped, else the carried-over value.
    if (lastHeightScale && profile && typeof profile === "object") {
      profile.heightScale = lastHeightScale;
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
      if (lastHeightScale) {
        window.SessionApp.phoneCalibration.heightScalePxPerM = lastHeightScale.pxPerM;
      }
      // Keep the manual result in its own slot — auto-adjust never overwrites it.
      window.SessionApp.manualCalibration = window.SessionApp.phoneCalibration;
    } catch (e) {}
    hasSolvedProfile = true;
    // Capture reference patches for future auto-adjust (calibrate once).
    try {
      var rp = captureRefPatches(refs);
      if (rp && profile && typeof profile === "object") {
        profile.refPatches = rp;
      }
    } catch (e) {}
    persistCalibration();
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
        hasSolvedProfile = false;
        setStatus("Loaded '" + preset.label + "' — APPROXIMATE (phone within inches of that spot, not exact). Treat numbers as estimates. For best accuracy, do the 6-tap calibration.");
        $("calib-apply").disabled = false;
        $("calib-save").disabled = false;
        unlockCalibActions();
        persistCalibration();
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
    hasSolvedProfile = false;
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
    stopHeightMode();
    stopVerifyMode();
    $("calib-panel").classList.add("hidden");
  }

  // === Step 12: height-scale calibration ===
  // A phone solve has no pxPerM — without this, analyzeSwing silently uses
  // the old laptop-chair number at the phone's depth (a wrong constant
  // wearing a right-looking label). Hold the 36-in bat vertically at the
  // plate, tap top then bottom: pxPerM = batPx / 0.9144.
  var BAT_M = 0.9144; // 36 in exactly

  function startHeightMode() {
    var cal = null;
    try { cal = window.SessionApp && window.SessionApp.phoneCalibration; } catch (e) {}
    // Needs a calibration with a homography — a fresh solve or a loaded
    // preset both qualify. (The bat measurement itself is fresh pixels.)
    if (!profile || !cal || !cal.H) {
      setStatus("Solve the tap calibration first.");
      return;
    }
    stopTapMode();
    stopVerifyMode();
    var v = videoEl();
    if (!v || !v.videoWidth) {
      setStatus("No live phone feed — pair the phone first.");
      return;
    }
    heightActive = true;
    heightTaps = [];
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.addEventListener("click", onHeightClick);
      wrap.style.cursor = "crosshair";
    }
    setStatus("Hold the 36-in bat VERTICALLY at the plate, plumb. Tap the TOP of the bat.");
  }

  function onHeightClick(ev) {
    if (!heightActive) return;
    var p = videoPos(ev);
    if (!p) return;
    heightTaps.push(p);
    if (heightTaps.length === 1) {
      setStatus("Top tapped at (" + p.u + ", " + p.v + "). Now tap the BOTTOM of the bat.");
    } else {
      var top = heightTaps[0], bot = heightTaps[1];
      var batPx = Math.hypot(top.u - bot.u, top.v - bot.v);
      var pxPerM = batPx / BAT_M;
      var midU = Math.round((top.u + bot.u) / 2), midV = Math.round((top.v + bot.v) / 2);
      lastHeightScale = {
        pxPerM: pxPerM,
        measuredAt: { u: midU, v: midV },
        samples: 1,
        method: "36-in bat vertical at plate"
      };
      if (profile && typeof profile === "object") profile.heightScale = lastHeightScale;
      try {
        if (window.SessionApp && window.SessionApp.phoneCalibration) {
          window.SessionApp.phoneCalibration.heightScalePxPerM = pxPerM;
        }
      } catch (e) {}
      setStatus("Height scale: " + Math.round(pxPerM) + " px/m from the bat. Saved with the profile — tap Height again any time to redo it.");
      stopHeightMode();
      persistCalibration();
    }
  }

  function stopHeightMode() {
    heightActive = false;
    heightTaps = [];
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.removeEventListener("click", onHeightClick);
      if (!verifyActive && !active) wrap.style.cursor = "";
    }
  }

  // === Step 1: ball-on-ground verification ===
  // Proves the homography end-to-end: a ball ON THE GROUND at a known
  // spot, tapped in the video, mapped through H, error read in inches.
  // A ball on a tee is invalid — height causes parallax error.
  var FT_PER_M_LOCAL = 3.28084, IN_PER_FT = 12;

  // Local applyH fallback (same math as session.js) for when
  // CageCalibration.applyH is unavailable.
  function applyHLocal(H, u, v) {
    var w = H[2][0]*u + H[2][1]*v + H[2][2];
    if (!isFinite(w) || Math.abs(w) < 1e-12) return null;
    return [
      (H[0][0]*u + H[0][1]*v + H[0][2]) / w,
      (H[1][0]*u + H[1][1]*v + H[1][2]) / w
    ];
  }

  function startVerifyMode() {
    var cal = null;
    try { cal = window.SessionApp && window.SessionApp.phoneCalibration; } catch (e) {}
    if (!cal || !cal.H) {
      setStatus("Solve/apply a calibration first.");
      return;
    }
    stopTapMode();
    stopHeightMode();
    var v = videoEl();
    if (!v || !v.videoWidth) {
      setStatus("No live phone feed — pair the phone first.");
      return;
    }
    verifyActive = true;
    verifyTap = null;
    clearVerifyBox();
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.addEventListener("click", onVerifyClick);
      wrap.style.cursor = "crosshair";
    }
    setStatus("Put a ball ON THE GROUND at a known spot (NOT on a tee — height causes parallax error). Tap the ball in the video.");
  }

  function onVerifyClick(ev) {
    if (!verifyActive) return;
    var p = videoPos(ev);
    if (!p) return;
    verifyTap = p;
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.removeEventListener("click", onVerifyClick);
      wrap.style.cursor = "";
    }
    showVerifyBox(p);
    setStatus("Ball tapped at (" + p.u + ", " + p.v + "). Enter the ball's true ground position, then Check.");
  }

  function showVerifyBox(p) {
    clearVerifyBox();
    var box = document.createElement("div");
    box.id = "calib-verify-box";
    box.innerHTML =
      '<label>Known X (ft) <input id="calib-verify-x" type="number" step="0.1" value="3"></label>' +
      '<label>Known Y (ft) <input id="calib-verify-y" type="number" step="0.1" value="3"></label>' +
      '<button id="calib-verify-check" class="btn primary">Check</button>' +
      '<button id="calib-verify-retap" class="btn ghost">Re-tap</button>' +
      '<div id="calib-verify-result" class="hint"></div>';
    var st = $("calib-status");
    if (st && st.parentNode) st.parentNode.insertBefore(box, st.nextSibling);
    else if ($("calib-panel")) $("calib-panel").appendChild(box);
    $("calib-verify-check").onclick = function () { runVerifyCheck(p); };
    $("calib-verify-retap").onclick = function () {
      clearVerifyBox();
      verifyActive = true;
      var wrap = $("camera-wrap");
      if (wrap) {
        wrap.addEventListener("click", onVerifyClick);
        wrap.style.cursor = "crosshair";
      }
      setStatus("Tap the ball in the video.");
    };
  }

  function clearVerifyBox() {
    var box = $("calib-verify-box");
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function runVerifyCheck(p) {
    var kx = parseFloat($("calib-verify-x").value);
    var ky = parseFloat($("calib-verify-y").value);
    var res = $("calib-verify-result");
    if (!isFinite(kx) || !isFinite(ky)) {
      res.textContent = "Enter the ball's known X and Y in feet.";
      return;
    }
    var H = null;
    try { H = window.SessionApp.phoneCalibration.H; } catch (e) {}
    if (!H) { res.textContent = "No calibration — solve first."; return; }
    var g = null;
    try {
      if (typeof CageCalibration !== "undefined" && CageCalibration.applyH) {
        g = CageCalibration.applyH(H, p.u, p.v);
      } else {
        g = applyHLocal(H, p.u, p.v);
      }
    } catch (e) { g = null; }
    if (!g || !isFinite(g[0]) || !isFinite(g[1])) {
      res.textContent = "Insufficient evidence: homography mapping failed at that pixel — re-tap or recalibrate.";
      return;
    }
    var mx = g[0] * FT_PER_M_LOCAL, my = g[1] * FT_PER_M_LOCAL;
    var errorIn = Math.hypot(mx - kx, my - ky) * IN_PER_FT;
    var passed = errorIn <= 6;
    res.textContent = (passed ? "✓ PASS" : "✗ FAIL") +
      " — ball at (" + kx + ", " + ky + ") ft, measured (" +
      mx.toFixed(2) + ", " + my.toFixed(2) + ") ft, error " +
      errorIn.toFixed(1) + " in (bar 6 in)." +
      (passed ? "" : " Re-tap or recalibrate.");
    try {
      var ver = {
        knownFt: { x: kx, y: ky },
        measuredFt: { x: +mx.toFixed(3), y: +my.toFixed(3) },
        errorIn: +errorIn.toFixed(2),
        passed: passed,
        at: new Date().toISOString()
      };
      if (profile && typeof profile === "object") profile.verification = ver;
      window.SessionApp.phoneCalibration.verified = passed;
      persistCalibration();
    } catch (e) {}
  }

  function stopVerifyMode() {
    verifyActive = false;
    verifyTap = null;
    var wrap = $("camera-wrap");
    if (wrap) {
      wrap.removeEventListener("click", onVerifyClick);
      if (!heightActive && !active) wrap.style.cursor = "";
    }
    clearVerifyBox();
  }

  // Public API
  window.PhoneCalib = {
    open: startTapMode,
    close: close,
    solve: solve,
    apply: apply,
    save: save,
    autoAdjust: autoAdjust,
    loadProfileFile: loadProfileFile,
    testCapture: testCapture,
    isActive: function () { return active; },
    getProfile: function () { return profile; },
  };

  // === Auto-recalibration: NCC patch matching ===
  // Calibrate once manually (saves refPatches). Next session, auto-adjust
  // finds the patches in the new frame and re-solves. Fail-closed.

  var REF_W = 480, REF_H = 270;
  var PATCH_SIZE = 48;
  var SEARCH_RADIUS = 40; // ±px in ref-frame coords

  function captureRefFrame() {
    var v = videoEl();
    if (!v || !v.videoWidth) return null;
    var c = document.createElement("canvas");
    c.width = REF_W; c.height = REF_H;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(v, 0, 0, REF_W, REF_H);
    } catch (e) { return null; }
    var img;
    try {
      img = ctx.getImageData(0, 0, REF_W, REF_H);
    } catch (e) { return null; }
    var gray = new Uint8Array(REF_W * REF_H);
    for (var i = 0; i < gray.length; i++) {
      var r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    }
    return { w: REF_W, h: REF_H, data: gray };
  }

  function extractPatch(frame, cx, cy) {
    var half = PATCH_SIZE / 2;
    var patch = new Uint8Array(PATCH_SIZE * PATCH_SIZE);
    for (var y = 0; y < PATCH_SIZE; y++) {
      for (var x = 0; x < PATCH_SIZE; x++) {
        var sx = Math.round(cx - half + x);
        var sy = Math.round(cy - half + y);
        if (sx < 0) sx = 0; else if (sx >= frame.w) sx = frame.w - 1;
        if (sy < 0) sy = 0; else if (sy >= frame.h) sy = frame.h - 1;
        patch[y * PATCH_SIZE + x] = frame.data[sy * frame.w + sx];
      }
    }
    return patch;
  }

  function bytesToBase64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function base64ToBytes(b64) {
    var s = atob(b64);
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function patchStats(patch) {
    var n = patch.length, sum = 0;
    for (var i = 0; i < n; i++) sum += patch[i];
    var mean = sum / n;
    var norm = 0;
    for (var j = 0; j < n; j++) {
      var d = patch[j] - mean;
      norm += d * d;
    }
    return { mean: mean, norm: Math.sqrt(norm) };
  }

  function buildIntegral(gray, w, h) {
    var W1 = w + 1;
    var sum = new Float64Array(W1 * (h + 1));
    var sq = new Float64Array(W1 * (h + 1));
    for (var y = 0; y < h; y++) {
      var rs = 0, rq = 0;
      for (var x = 0; x < w; x++) {
        var v = gray[y * w + x];
        rs += v; rq += v * v;
        sum[(y + 1) * W1 + (x + 1)] = sum[y * W1 + (x + 1)] + rs;
        sq[(y + 1) * W1 + (x + 1)] = sq[y * W1 + (x + 1)] + rq;
      }
    }
    return { sum: sum, sq: sq, w: w };
  }

  function rectSum(ii, x0, y0, x1, y1, isSq) {
    var W1 = ii.w + 1;
    var a = isSq ? ii.sq : ii.sum;
    return a[y1 * W1 + x1] - a[y0 * W1 + x1] - a[y1 * W1 + x0] + a[y0 * W1 + x0];
  }

  // NCC template match. Returns {x, y, peak, margin}.
  function nccMatch(frame, ii, patch, pMean, pNorm, cx, cy, radius) {
    var N = PATCH_SIZE * PATCH_SIZE;
    var half = PATCH_SIZE / 2;
    if (pNorm < 1e-6) return { x: cx, y: cy, peak: 0, margin: 0 };
    var diam = radius * 2 + 1;
    var scores = new Float32Array(diam * diam);
    var xs = new Int16Array(diam * diam);
    var ys = new Int16Array(diam * diam);
    var count = 0;
    // Zero-mean patch once
    var zp = new Float32Array(N);
    for (var i = 0; i < N; i++) zp[i] = patch[i] - pMean;
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        var x = Math.round(cx + dx), y = Math.round(cy + dy);
        var x0 = x - half, y0 = y - half;
        if (x0 < 0 || y0 < 0 || x0 + PATCH_SIZE > frame.w || y0 + PATCH_SIZE > frame.h) continue;
        var s = rectSum(ii, x0, y0, x0 + PATCH_SIZE, y0 + PATCH_SIZE, false);
        var s2 = rectSum(ii, x0, y0, x0 + PATCH_SIZE, y0 + PATCH_SIZE, true);
        var mean = s / N;
        var vari = s2 / N - mean * mean;
        if (vari < 1e-6) continue;
        var std = Math.sqrt(vari);
        var cross = 0;
        for (var py = 0; py < PATCH_SIZE; py++) {
          var fo = (y0 + py) * frame.w + x0;
          var po = py * PATCH_SIZE;
          for (var px = 0; px < PATCH_SIZE; px++) {
            cross += zp[po + px] * frame.data[fo + px];
          }
        }
        var ncc = cross / (pNorm * std * Math.sqrt(N));
        scores[count] = ncc;
        xs[count] = x; ys[count] = y;
        count++;
      }
    }
    if (count === 0) return { x: cx, y: cy, peak: 0, margin: 0 };
    // Find best
    var bi = 0;
    for (var k = 1; k < count; k++) if (scores[k] > scores[bi]) bi = k;
    var peak = scores[bi], bx = xs[bi], by = ys[bi];
    // Find best outside 3px radius
    var second = -2;
    for (var m = 0; m < count; m++) {
      var ddx = xs[m] - bx, ddy = ys[m] - by;
      if (ddx * ddx + ddy * ddy < 9) continue;
      if (scores[m] > second) second = scores[m];
    }
    var margin = second > 1e-6 ? peak / second : (peak > 0 ? 99 : 0);
    return { x: bx, y: by, peak: peak, margin: margin };
  }

  // Capture refPatches after a successful manual solve. Called from solve().
  function captureRefPatches(refs) {
    try {
      var frame = captureRefFrame();
      if (!frame) return null;
      var v = videoEl();
      var sx = REF_W / v.videoWidth, sy = REF_H / v.videoHeight;
      var patches = [];
      for (var i = 0; i < refs.length; i++) {
        var r = refs[i];
        var cx = r.image[0] * sx, cy = r.image[1] * sy;
        var patch = extractPatch(frame, cx, cy);
        patches.push({
          id: r.id || ("pt" + i),
          world: [r.world[0], r.world[1]],
          refU: Math.round(cx), refV: Math.round(cy),
          patch: bytesToBase64(patch),
        });
      }
      return {
        frameW: REF_W, frameH: REF_H,
        videoW: v.videoWidth, videoH: v.videoHeight,
        patches: patches,
      };
    } catch (e) {
      return null;
    }
  }

  function autoAdjust() {
    var prof = profile;
    if (!prof || !prof.refPatches || !prof.refPatches.patches || prof.refPatches.patches.length < 4) {
      setStatus("Auto-adjust needs a manual calibration with saved reference patches first. Tap points + Solve, then try again. (Or load a saved profile.)");
      return;
    }
    setStatus("Auto-adjust: capturing frame…");
    $("calib-auto").disabled = true;
    setTimeout(function () {
      try {
        doAutoAdjust(prof);
      } catch (e) {
        setStatus("Auto-adjust error: " + (e && e.message ? e.message : e) + " — tap manually.");
      }
      var ab = $("calib-auto");
      if (ab) ab.disabled = false;
    }, 60);
  }

  function doAutoAdjust(prof) {
    var rp = prof.refPatches;
    var frame = captureRefFrame();
    if (!frame) { setStatus("Auto-adjust: no video frame — pair the phone first."); return; }
    var v = videoEl();
    var sx = v.videoWidth / REF_W, sy = v.videoHeight / REF_H;
    var ii = buildIntegral(frame.data, frame.w, frame.h);
    var found = [];
    var total = rp.patches.length;
    var attempts = []; // per-patch diagnostics (2026-09-24: "0 of 8" told us nothing)
    for (var i = 0; i < total; i++) {
      var p = rp.patches[i];
      setStatus("Auto-adjust: matching point " + (i + 1) + "/" + total + " (" + p.id + ")…");
      var patch = base64ToBytes(p.patch);
      var st = patchStats(patch);
      var m = nccMatch(frame, ii, patch, st.mean, st.norm, p.refU, p.refV, SEARCH_RADIUS);
      attempts.push({ id: p.id, peak: m.peak, margin: m.margin });
      if (m.peak >= 0.75 && m.margin >= 1.15) {
        found.push({
          id: p.id,
          image: { u: m.x * sx, v: m.y * sy },
          world: { x: p.world[0], y: p.world[1] },
          peak: m.peak,
          refU: p.refU * sx, refV: p.refV * sy, // old position in current full-res px
        });
      }
    }
    if (found.length < 4) {
      // Show the best peaks so it's clear whether we're close or in a different universe.
      attempts.sort(function (a, b) { return b.peak - a.peak; });
      var det = attempts.slice(0, 3).map(function (a) {
        return a.id + " " + a.peak.toFixed(2) + "/" + a.margin.toFixed(2);
      }).join(", ");
      setStatus("Auto-adjust failed: only " + found.length + " of " + total + " matched (need 4+, bar 0.75/1.15). Best: " + det + ". " +
        (attempts[0] && attempts[0].peak < 0.5
          ? "Different camera/viewpoint — retap manually."
          : "So close — try better light or wipe the lens, then retry."));
      return;
    }
    // Gate: implied shift < 150px at full res (mean centroid shift)
    var ox = 0, oy = 0, nx = 0, ny = 0;
    for (var j = 0; j < found.length; j++) {
      ox += found[j].refU; oy += found[j].refV;
      nx += found[j].image.u; ny += found[j].image.v;
    }
    ox /= found.length; oy /= found.length;
    nx /= found.length; ny /= found.length;
    var shiftPx = Math.hypot(nx - ox, ny - oy);
    if (shiftPx > 150) {
      setStatus("Auto-adjust failed: camera shifted ~" + Math.round(shiftPx) + "px (limit 150px) — different mount, tap manually.");
      return;
    }
    // Gate: scale change 0.85–1.18x (median pairwise distance ratio)
    var ratios = [];
    for (var a = 0; a < found.length; a++) {
      for (var b = a + 1; b < found.length; b++) {
        var od = Math.hypot(found[a].refU - found[b].refU, found[a].refV - found[b].refV);
        var nd = Math.hypot(found[a].image.u - found[b].image.u, found[a].image.v - found[b].image.v);
        if (od > 1e-6) ratios.push(nd / od);
      }
    }
    ratios.sort(function (x, y) { return x - y; });
    var medScale = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
    if (medScale < 0.85 || medScale > 1.18) {
      setStatus("Auto-adjust failed: scale changed " + medScale.toFixed(2) + "x (allowed 0.85–1.18) — tap manually.");
      return;
    }
    // Re-solve (array shape per solveHomography's contract — see solve()).
    var refs = found.map(function (f) {
      return { image: [f.image.u, f.image.v], world: [f.world.x, f.world.y] };
    });
    var res;
    try {
      res = CageCalibration.solveHomography(refs);
    } catch (e) {
      setStatus("Auto-adjust failed: solve error — tap manually.");
      return;
    }
    if (!res.ok || res.meanPx > 6) {
      setStatus("Auto-adjust failed: reprojection " + (res.meanPx ? res.meanPx.toFixed(1) : "?") + "px over 6px bar — tap manually.");
      return;
    }
    // Success — store in the auto slot, NEVER overwrite manual.
    window.SessionApp = window.SessionApp || {};
    window.SessionApp.phoneCalibration = {
      H: res.H, Hinv: res.Hinv,
      meanPx: res.meanPx, maxPx: res.maxPx,
      numPoints: found.length,
      verified: false,
      autoAdjusted: true,
    };
    window.SessionApp.manualCalibration = window.SessionApp.manualCalibration || null; // manual slot untouched
    var dx = Math.round(nx - ox), dy = Math.round(ny - oy);
    // Step 12: carry the bat-measured height scale — features grew by
    // medScale, so px-per-meter grows by the same factor.
    var hsNote = "";
    try {
      var hsSrc = (prof.heightScale && isFinite(prof.heightScale.pxPerM)) ? prof.heightScale
        : ((lastHeightScale && isFinite(lastHeightScale.pxPerM)) ? lastHeightScale : null);
      if (hsSrc) {
        var newPxPerM = hsSrc.pxPerM * medScale;
        lastHeightScale = {
          pxPerM: newPxPerM,
          measuredAt: hsSrc.measuredAt || null,
          samples: 1,
          method: (hsSrc.method || "bat") + " (scaled " + medScale.toFixed(2) + "x by auto-adjust)"
        };
        prof.heightScale = lastHeightScale;
        if (window.SessionApp && window.SessionApp.phoneCalibration) {
          window.SessionApp.phoneCalibration.heightScalePxPerM = newPxPerM;
        }
        hsNote = ", height scale " + Math.round(newPxPerM) + " px/m";
      }
    } catch (e) {}
    setStatus("Auto-adjusted ✓ " + found.length + "/" + total + " points, shift (" + dx + ", " + dy + ")px, scale " + medScale.toFixed(2) + "x, mean error " + res.meanPx.toFixed(1) + "px" + hsNote + ". Numbers live — tap Apply or re-tap manually if this looks off.");
    var ab2 = $("calib-apply");
    if (ab2) ab2.disabled = false;
    persistCalibration();
  }

  // Diagnostic: prove the laptop can grab pixels from the phone feed.
  // Shows the 480x270 grayscale frame the matcher uses. If this works,
  // tap capture and auto-adjust have what they need.
  function testCapture() {
    var frame = captureRefFrame();
    if (!frame) {
      setStatus("Capture test FAILED: no pixels from the phone feed. Pair the phone first, then try again.");
      return;
    }
    // Render the grayscale frame into a small preview canvas in the panel.
    var prev = $("calib-capture-preview");
    if (!prev) {
      prev = document.createElement("canvas");
      prev.id = "calib-capture-preview";
      prev.width = REF_W; prev.height = REF_H;
      prev.style.cssText = "width:240px;height:135px;border:1px solid #666;margin-top:8px;image-rendering:pixelated;";
      var st = $("calib-status");
      if (st && st.parentNode) st.parentNode.insertBefore(prev, st.nextSibling);
    }
    var ctx = prev.getContext("2d");
    var img = ctx.createImageData(REF_W, REF_H);
    for (var i = 0; i < frame.data.length; i++) {
      img.data[i * 4] = frame.data[i];
      img.data[i * 4 + 1] = frame.data[i];
      img.data[i * 4 + 2] = frame.data[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Quick sanity: measure frame variance (a black/flat frame = broken capture)
    var mean = 0;
    for (var j = 0; j < frame.data.length; j++) mean += frame.data[j];
    mean /= frame.data.length;
    var vari = 0;
    for (var k = 0; k < frame.data.length; k++) {
      var d = frame.data[k] - mean;
      vari += d * d;
    }
    vari = Math.sqrt(vari / frame.data.length);
    if (vari < 5) {
      setStatus("Capture test: got pixels, but frame looks flat/black (stddev " + vari.toFixed(1) + ") — is the phone camera covered or the video frozen?");
    } else {
      setStatus("Capture test PASSED: 480x270 grayscale, stddev " + vari.toFixed(1) + ". Tap calibration and auto-adjust can read the feed.");
    }
  }

  // Invert a 3x3 matrix (for Hinv when loading a saved homography).
  function invert3(m) {
    var a = m[0][0], b = m[0][1], c = m[0][2],
        d = m[1][0], e = m[1][1], f = m[1][2],
        g = m[2][0], h = m[2][1], i = m[2][2];
    var A = e*i - f*h, B = f*g - d*i, C = d*h - e*g;
    var det = a*A + b*B + c*C;
    if (!det) throw new Error("singular matrix");
    var inv = 1/det;
    return [
      [A*inv, (c*h - b*i)*inv, (b*f - c*e)*inv],
      [B*inv, (a*i - c*g)*inv, (c*d - a*f)*inv],
      [C*inv, (b*g - a*h)*inv, (a*e - b*d)*inv]
    ];
  }

  function loadProfileFile(file) {
    if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var p = JSON.parse(rd.result);
        if (!p.refPatches || !p.refPatches.patches) {
          setStatus("That file has no reference patches — it was saved before auto-adjust existed. Do a manual calibration first.");
          return;
        }
        profile = p;
        var n = p.refPatches.patches.length;
        // If the file carries a solved homography, use it directly — don't
        // force auto-adjust (which fails if lighting/camera shifted).
        // (2026-09-24: Load was setting profile but never pushing H to the
        // session, so "load calibration" silently did nothing.)
        var H = null;
        try {
          H = p.profile && p.profile.homography && p.profile.homography.imageToGround;
        } catch (e) { H = null; }
        if (H && H.length === 3) {
          try {
            window.SessionApp = window.SessionApp || {};
            // Invert H for ground->image (needed by the overlay).
            var Hinv = invert3(H);
            window.SessionApp.phoneCalibration = {
              H: H, Hinv: Hinv,
              meanPx: (p.profile.verification && p.profile.verification.meanPx) || 6.0,
              maxPx: (p.profile.verification && p.profile.verification.maxPx) || 11.0,
              numPoints: n,
              verified: false,
              label: p.profile.label || "loaded from file"
            };
            window.SessionApp.manualCalibration = window.SessionApp.phoneCalibration;
            hasSolvedProfile = true;
            setStatus("Loaded calibration with " + n + " points — homography applied. No need to retap unless the camera moved.");
          } catch (e) {
            setStatus("Loaded profile with " + n + " reference patches, but couldn't apply the homography: " + (e && e.message || e) + ". Hit Auto-adjust.");
          }
        } else {
          setStatus("Loaded profile with " + n + " reference patches (" + (p.label || p.notes || "saved calibration") + "). Hit Auto-adjust.");
        }
        var ab = $("calib-auto");
        if (ab) ab.disabled = false;
        persistCalibration();
      } catch (e) {
        setStatus("Couldn't parse that file: " + (e && e.message ? e.message : e));
      }
    };
    rd.readAsText(file);
  }

  // Height / Verify ball are only meaningful once a calibration (fresh
  // solve or loaded preset) exists. They start disabled so they never
  // look clickable and then "do nothing".
  function unlockCalibActions() {
    var hh = $("calib-height"), vb = $("calib-verify");
    if (hh) hh.disabled = false;
    if (vb) vb.disabled = false;
  }

  // Wire panel buttons once the DOM is ready.
  function wire() {
    var s = $("calib-solve"), a = $("calib-apply"), sv = $("calib-save"), c = $("calib-close"), ul = $("calib-use-last"), au = $("calib-auto"), tc = $("calib-test-capture"), lf = $("calib-load-file"), cl = $("calib-clear");
    var hh = $("calib-height"), vb = $("calib-verify");
    if (s) s.onclick = solve;
    if (cl) cl.onclick = function () {
      // Clear ONLY the current taps — the solved/applied profile stays intact.
      // (2026-09-24: was also nulling profile + persisting null, which wiped
      // the good calibration from localStorage.)
      taps = {};
      selectedId = REF_POINTS[0].id;
      renderList();
      drawMarkers();
      s.disabled = true;
      setStatus("Taps cleared. Tap the reference points again. Applied calibration unchanged.");
      // Do NOT persist here — persistCalibration() would save profile:null
      // and wipe the stored calibration. Taps are session state, not stored.
    };
    if (a) a.onclick = apply;
    if (sv) sv.onclick = save;
    if (c) c.onclick = close;
    if (ul) ul.onclick = useLastPosition;
    if (au) au.onclick = autoAdjust;
    if (tc) tc.onclick = testCapture;
    if (hh) { hh.onclick = startHeightMode; hh.disabled = true; }
    if (vb) { vb.onclick = startVerifyMode; vb.disabled = true; }
    if (lf) lf.onchange = function () {
      if (lf.files && lf.files[0]) loadProfileFile(lf.files[0]);
      lf.value = "";
    };
    // Tap-on-video: load a recorded clip into the preview so reference
    // points can be tapped on paused, clear frames (zoom works the same).
    // The video must be from the session camera position — the phone must
    // not move between the video and the session.
    var vf = $("calib-video-file"), lv = $("calib-live");
    var savedStream = null, videoURL = null;
    if (vf) vf.onchange = function () {
      var v = videoEl();
      if (!v || !vf.files || !vf.files[0]) return;
      savedStream = v.srcObject;
      if (videoURL) URL.revokeObjectURL(videoURL);
      videoURL = URL.createObjectURL(vf.files[0]);
      v.srcObject = null;
      v.src = videoURL;
      v.controls = true;
      v.play().catch(function () {});
      if (lv) lv.classList.remove("hidden");
      setStatus("Video loaded — pause on a clear frame, then tap the points. The camera must stay where it was for the session.");
      vf.value = "";
    };
    if (lv) lv.onclick = function () {
      var v = videoEl();
      if (!v) return;
      if (videoURL) { URL.revokeObjectURL(videoURL); videoURL = null; }
      v.src = "";
      v.controls = false;
      if (savedStream) { v.srcObject = savedStream; savedStream = null; }
      lv.classList.add("hidden");
      setStatus("Back on the live feed.");
    };
    // A solved calibration survives refreshes: restore it so a patch-day
    // reload never forces a re-tap when the phone hasn't moved.
    restoreCalibration();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
