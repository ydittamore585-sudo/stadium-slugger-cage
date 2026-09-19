/**
 * gopro-bridge.js — optional GoPro panel for the Cage Edition session app.
 *
 * On load it probes same-origin /api/health. If the laptop's GoPro bridge
 * (gopro/bridge.mjs) answers, the GoPro panel appears with Start/Stop and a
 * status dot. If there is no bridge — e.g. the app was loaded from GitHub
 * Pages — the panel stays hidden and NOTHING else changes.
 *
 * The bridge tracks start/stop pressed through it; the camera screen stays
 * ground truth for what's actually recording.
 */
(function () {
"use strict";

var POLL_MS = 3000;
var panel = null, dotEl = null, statusEl = null, btnStart = null, btnStop = null;
var pollTimer = null;

function $(id) { return document.getElementById(id); }

async function api(path, method) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, 4000);
  try {
    var r = await fetch(path, { method: method || "GET", cache: "no-store", signal: ctrl.signal });
    var j = null;
    try { j = await r.json(); } catch (e) { /* non-JSON */ }
    return { http: r.status, ok: r.ok, json: j };
  } finally {
    clearTimeout(t);
  }
}

function setStatus(mode, text) {
  // mode: 'rec' | 'idle' | 'down'
  if (dotEl) dotEl.className = "dot dot-" + mode;
  if (statusEl) statusEl.textContent = text;
}

async function refresh() {
  var r;
  try {
    r = await api("/api/gopro/status");
  } catch (e) {
    setStatus("down", "GoPro: bridge lost");
    return;
  }
  if (!r.ok || !r.json) { setStatus("down", "GoPro: bridge error"); return; }
  var j = r.json;
  if (!j.cameraReachable) {
    setStatus("down", "GoPro: camera unreachable" + (j.error ? " — " + j.error : ""));
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    return;
  }
  if (j.bridgeRecording) {
    setStatus("rec", "GoPro: ● RECORDING");
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } else {
    setStatus("idle", "GoPro: idle");
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
  }
}

async function shutter(start) {
  setStatus("idle", "GoPro: sending…");
  var r;
  try {
    r = await api(start ? "/api/gopro/start" : "/api/gopro/stop", "POST");
  } catch (e) {
    setStatus("down", "GoPro: bridge lost");
    return;
  }
  if (r.ok && r.json && r.json.ok) {
    await refresh();
  } else {
    var msg = (r.json && r.json.error) || ("HTTP " + r.http);
    setStatus("down", "GoPro: " + msg);
  }
}

async function init() {
  panel = $("gopro-panel");
  if (!panel) return; // markup not present — nothing to do
  var alive = false;
  try {
    var r = await api("/api/health");
    alive = r.ok && r.json && r.json.bridge === "gopro-bridge";
  } catch (e) { alive = false; }
  if (!alive) return; // no bridge: panel stays hidden, app behaves exactly as before

  dotEl = $("gopro-dot");
  statusEl = $("gopro-status");
  btnStart = $("btn-gopro-start");
  btnStop = $("btn-gopro-stop");
  panel.classList.remove("hidden");

  if (btnStart) btnStart.addEventListener("click", function () { shutter(true); });
  if (btnStop) btnStop.addEventListener("click", function () { shutter(false); });

  await refresh();
  pollTimer = setInterval(refresh, POLL_MS);
  if (pollTimer && typeof pollTimer.unref === "function") { /* browser: no unref */ }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
