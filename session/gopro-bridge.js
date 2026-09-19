/**
 * gopro-bridge.js — optional GoPro panel for the Cage Edition session app.
 *
 * Two ways to connect:
 *  1. Auto-detect: if this page was served BY the laptop bridge
 *     (gopro/bridge.mjs), same-origin /api/health answers and the GoPro
 *     panel appears on its own.
 *  2. Manual: the "Connect GoPro" button asks for the bridge address
 *     (printed by `node bridge.mjs` on the laptop, e.g.
 *     http://10.5.5.101:8090), probes it, and connects on success. The
 *     address is remembered in localStorage and retried on next load.
 *
 * Without a reachable bridge the panel stays hidden and NOTHING else changes.
 *
 * Honest limits:
 *  - The browser cannot talk to the camera directly (no CORS on the GoPro
 *    API, and one WiFi at a time anyway) — the bridge proxy is required.
 *  - A page loaded over HTTPS (GitHub Pages) cannot fetch an http:// bridge
 *    (mixed content). In the cage, load the app FROM the bridge URL itself.
 *  - The panel's "RECORDING" state is tracked by the bridge from start/stop
 *    presses through it; the camera screen stays ground truth.
 */
(function () {
"use strict";

var POLL_MS = 3000;
var LS_KEY = "goproBridgeUrl";
var panel = null, dotEl = null, statusEl = null;
var btnStart = null, btnStop = null, btnConnect = null;
var pollTimer = null;
var base = ""; // bridge base URL; "" = same origin (auto-detected)

function $(id) { return document.getElementById(id); }

function loadSaved() {
  try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
}
function saveUrl(u) {
  try { localStorage.setItem(LS_KEY, u); } catch (e) { /* private mode */ }
}

function normUrl(u) {
  u = (u || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = "http://" + u;
  return u;
}

async function api(path, method) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, 4000);
  try {
    var r = await fetch(base + path, { method: method || "GET", cache: "no-store", signal: ctrl.signal });
    var j = null;
    try { j = await r.json(); } catch (e) { /* non-JSON */ }
    return { http: r.status, ok: r.ok, json: j };
  } finally {
    clearTimeout(t);
  }
}

// probe without clobbering `base` on failure
async function isBridge(candidateBase) {
  var prev = base;
  base = candidateBase;
  var alive = false;
  try {
    var r = await api("/api/health");
    alive = r.ok && r.json && r.json.bridge === "gopro-bridge";
  } catch (e) { alive = false; }
  if (!alive) base = prev;
  return alive;
}

function setStatus(mode, text) {
  // mode: 'rec' | 'idle' | 'down'
  if (dotEl) dotEl.className = "dot dot-" + mode;
  if (statusEl) statusEl.textContent = text;
}

function setConnectedUI(on) {
  if (panel) panel.classList.toggle("hidden", !on);
  if (btnConnect) {
    btnConnect.textContent = on ? "📷 GoPro: connected — change" : "📷 Connect GoPro";
    btnConnect.title = on
      ? "Connected to the GoPro bridge at " + (base || "this page's server") + " — tap to switch to a different bridge"
      : "Connect to the laptop GoPro bridge (node bridge.mjs on the GoPro WiFi)";
  }
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

function connectSucceeded(candidateBase) {
  base = candidateBase;
  saveUrl(candidateBase);
  setConnectedUI(true);
  if (btnStart) btnStart.onclick = function () { shutter(true); };
  if (btnStop) btnStop.onclick = function () { shutter(false); };
  refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

function manualConnect() {
  var saved = loadSaved();
  var def = saved || "http://10.5.5.101:8090";
  var hint = "Bridge address printed by `node bridge.mjs` on the laptop\n" +
    "(laptop must be on the GoPro WiFi).";
  if (location.protocol === "https:") {
    hint += "\n\nNote: this page is on HTTPS, so the browser blocks plain-HTTP\n" +
      "bridge addresses. In the cage, open the bridge URL itself instead\n" +
      "(http://<laptop-ip>:8090) — the panel then appears automatically.";
  }
  var input = prompt(hint + "\n\nBridge address:", def);
  if (input === null) return; // cancelled
  var url = normUrl(input);
  if (!url) return;
  if (btnConnect) { btnConnect.disabled = true; btnConnect.textContent = "📷 Connecting…"; }
  isBridge(url).then(function (alive) {
    if (btnConnect) btnConnect.disabled = false;
    if (alive) {
      connectSucceeded(url);
    } else {
      setConnectedUI(false);
      alert("No GoPro bridge answered at\n" + url +
        "\n\nCheck: 1) laptop is on the GoPro WiFi, 2) `node bridge.mjs` is\n" +
        "running on the laptop, 3) the IP matches what it printed." +
        (location.protocol === "https:"
          ? "\n\nThis page is HTTPS — browsers block http:// bridge calls.\nOpen the bridge URL directly (http://<laptop-ip>:8090) instead."
          : ""));
    }
  });
}

async function init() {
  panel = $("gopro-panel");
  btnConnect = $("btn-gopro-connect");
  if (btnConnect) btnConnect.addEventListener("click", manualConnect);
  if (!panel) return;

  dotEl = $("gopro-dot");
  statusEl = $("gopro-status");
  btnStart = $("btn-gopro-start");
  btnStop = $("btn-gopro-stop");

  // 1) same-origin auto-detect (page served by the bridge)
  if (await isBridge("")) { connectSucceeded(""); return; }
  // 2) remembered bridge address
  var saved = normUrl(loadSaved());
  if (saved && await isBridge(saved)) { connectSucceeded(saved); return; }
  // else: stay hidden, Connect button is the manual path
  setConnectedUI(false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
