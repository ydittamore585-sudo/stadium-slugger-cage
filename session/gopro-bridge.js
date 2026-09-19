/**
 * gopro-bridge.js — optional GoPro panel for the Cage Edition session app.
 *
 * Three ways to connect:
 *  1. Auto-detect: if this page was served BY the laptop bridge
 *     (gopro/bridge.mjs), same-origin /api/health answers and the GoPro
 *     panel appears on its own.
 *  2. Manual WiFi: the "Connect GoPro" button asks for the bridge address
 *     (printed by `node bridge.mjs` on the laptop, e.g.
 *     http://10.5.5.101:8090), probes it, and connects on success. The
 *     address is remembered in localStorage and retried on next load.
 *  3. Bluetooth: the "GoPro Bluetooth" button pairs with the camera over
 *     Web Bluetooth and sends shutter commands directly — no laptop, no
 *     WiFi needed. (For HERO8 units whose WiFi radio misbehaves.)
 *
 * Without a reachable bridge / paired camera the panel stays hidden and
 * NOTHING else changes.
 *
 * Honest limits:
 *  - WiFi path: the browser cannot talk to the camera directly (no CORS on
 *    the GoPro API, and one WiFi at a time anyway) — the bridge proxy is
 *    required. A page loaded over HTTPS (GitHub Pages) cannot fetch an
 *    http:// bridge (mixed content). In the cage, load the app FROM the
 *    bridge URL itself.
 *  - Bluetooth path: needs a browser with Web Bluetooth (Chrome / Edge /
 *    Opera on phone or laptop) and a secure context (https or localhost).
 *    The camera takes ONE Bluetooth connection at a time — disconnect the
 *    Quik app first. Recording state is tracked from our own start/stop
 *    commands; the camera screen stays ground truth.
 */
(function () {
"use strict";

var POLL_MS = 3000;
var LS_KEY = "goproBridgeUrl";
var panel = null, dotEl = null, statusEl = null;
var btnStart = null, btnStop = null, btnConnect = null, btnBle = null;
var pollTimer = null;
var base = ""; // bridge base URL; "" = same origin (auto-detected)
var transport = null; // null | "bridge" | "ble"

function $(id) { return document.getElementById(id); }

function showPanel(on) { if (panel) panel.classList.toggle("hidden", !on); }

/* ================= WiFi bridge transport ================= */

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

function setBridgeUI(on) {
  if (on) transport = "bridge";
  else if (transport === "bridge") transport = null;
  showPanel(transport !== null);
  if (btnConnect) {
    btnConnect.textContent = on ? "📷 GoPro: connected — change" : "📷 Connect GoPro";
    btnConnect.title = on
      ? "Connected to the GoPro bridge at " + (base || "this page's server") + " — tap to switch to a different bridge"
      : "Connect to the laptop GoPro bridge (node bridge.mjs on the GoPro WiFi)";
  }
}

function bridgeTeardown() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
  bleTeardown();
  setBleUI(false);
  base = candidateBase;
  saveUrl(candidateBase);
  setBridgeUI(true);
  if (btnStart) btnStart.onclick = function () { shutter(true); };
  if (btnStop) btnStop.onclick = function () { shutter(false); };
  refresh();
  bridgeTeardown();
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
      setBridgeUI(false);
      alert("No GoPro bridge answered at\n" + url +
        "\n\nCheck: 1) laptop is on the GoPro WiFi, 2) `node bridge.mjs` is\n" +
        "running on the laptop, 3) the IP matches what it printed." +
        (location.protocol === "https:"
          ? "\n\nThis page is HTTPS — browsers block http:// bridge calls.\nOpen the bridge URL directly (http://<laptop-ip>:8090) instead."
          : ""));
    }
  });
}

/* ================= Bluetooth transport (Web Bluetooth) ================= */
/* Open GoPro BLE: service 0xFEA6, legacy command bytes confirmed on HERO8. */

var BLE_SVC = "0000fea6-0000-1000-8000-00805f9b34fb";
var BLE_CMD = "b5f90072-aa8d-11e3-9046-0002a5d5c51b";
var BLE_CMD_RESP = "b5f90073-aa8d-11e3-9046-0002a5d5c51b";
var BLE_SHUTTER_START = [0x03, 0x01, 0x01, 0x01];
var BLE_SHUTTER_STOP = [0x03, 0x01, 0x01, 0x00];
var BLE_KEEPALIVE = [0x02, 0x01, 0x42];
var BLE_KEEPALIVE_MS = 3000;

var bleDevice = null, bleCmdChar = null, bleKeepTimer = null, bleName = "";
var bleRecording = null; // null = unknown; camera screen is ground truth

function bleSupported() {
  return !!(typeof navigator !== "undefined" && navigator.bluetooth);
}

function setBleUI(on) {
  if (on) transport = "ble";
  else if (transport === "ble") transport = null;
  showPanel(transport !== null);
  if (btnBle) {
    btnBle.textContent = on ? "🔵 Bluetooth: " + bleName + " — disconnect" : "🔵 GoPro Bluetooth";
    btnBle.title = on
      ? "Bluetooth connected to " + bleName + " — tap to disconnect"
      : "Pair with the GoPro over Bluetooth (no laptop / WiFi needed)";
  }
}

function bleTeardown() {
  if (bleKeepTimer) { clearInterval(bleKeepTimer); bleKeepTimer = null; }
  if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
    try { bleDevice.gatt.disconnect(); } catch (e) { /* already gone */ }
  }
  bleDevice = null; bleCmdChar = null; bleRecording = null; bleName = "";
}

async function bleWrite(bytes) {
  var data = new Uint8Array(bytes);
  try {
    await bleCmdChar.writeValue(data);
  } catch (e) {
    // some stacks only accept write-without-response on this characteristic
    await bleCmdChar.writeValueWithoutResponse(data);
  }
}

function bleRefreshUI() {
  if (bleRecording === true) {
    setStatus("rec", "GoPro: ● RECORDING (as commanded)");
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
  } else if (bleRecording === false) {
    setStatus("idle", "GoPro: idle (as commanded)");
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
  } else {
    setStatus("idle", "GoPro: Bluetooth connected — state unknown");
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = false;
  }
}

function bleOnDrop() {
  bleTeardown();
  setBleUI(false);
  setStatus("down", "GoPro: Bluetooth disconnected");
}

async function bleShutter(start) {
  setStatus("idle", "GoPro: sending…");
  try {
    await bleWrite(start ? BLE_SHUTTER_START : BLE_SHUTTER_STOP);
    bleRecording = start;
    bleRefreshUI();
  } catch (e) {
    setStatus("down", "GoPro: Bluetooth send failed");
  }
}

function bleToggle() {
  if (transport === "ble" && bleDevice) {
    bleOnDrop();
    return;
  }
  if (!bleSupported()) {
    alert("This browser can't do Bluetooth.\nOpen this page in Chrome, Edge, or Opera (phone or laptop).");
    return;
  }
  // requestDevice MUST be called synchronously inside the click's user
  // gesture — no confirm()/await before it, or the browser rejects it with
  // "Must be handling a user gesture to show a permission request".
  // The Quik-disconnect reminder lives as visible text under the button
  // instead of a blocking confirm() for exactly this reason.
  var devicePromise;
  try {
    devicePromise = navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SVC] }],
      optionalServices: [BLE_SVC]
    });
  } catch (e) {
    alert("Bluetooth connect failed: " + (e.message || e) +
      "\n\nMake sure Quik is disconnected and the camera is nearby.");
    return;
  }
  if (btnBle) { btnBle.disabled = true; btnBle.textContent = "🔵 Pairing…"; }
  bleFinishPair(devicePromise);
}

async function bleFinishPair(devicePromise) {
  try {
    var device = await devicePromise;
    device.addEventListener("gattserverdisconnected", bleOnDrop);
    var server = await device.gatt.connect();
    var service = await server.getPrimaryService(BLE_SVC);
    var cmdChar = await service.getCharacteristic(BLE_CMD);
    var respChar = await service.getCharacteristic(BLE_CMD_RESP);
    respChar.addEventListener("characteristicvaluechanged", function (ev) {
      var v = new Uint8Array(ev.target.value.buffer);
      var hex = Array.prototype.map.call(v, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join(" ");
      console.log("[gopro-ble] camera response:", hex);
    });
    await respChar.startNotifications();
    // success — commit to the BLE transport
    bridgeTeardown();
    setBridgeUI(false);
    bleDevice = device;
    bleCmdChar = cmdChar;
    bleName = device.name || "GoPro";
    bleRecording = null;
    bleKeepTimer = setInterval(function () {
      if (bleCmdChar) bleWrite(BLE_KEEPALIVE).catch(function () { /* drop will fire */ });
    }, BLE_KEEPALIVE_MS);
    if (btnStart) btnStart.onclick = function () { bleShutter(true); };
    if (btnStop) btnStop.onclick = function () { bleShutter(false); };
    setBleUI(true);
    bleRefreshUI();
  } catch (e) {
    bleTeardown();
    if (transport !== "bridge") showPanel(false);
    setBleUI(false);
    // NotFoundError = user cancelled the picker; stay quiet for that one
    if (e && e.name !== "NotFoundError") {
      alert("Bluetooth connect failed: " + (e.message || e) +
        "\n\nMake sure Quik is disconnected and the camera is nearby.");
    }
  } finally {
    if (btnBle) btnBle.disabled = false;
  }
}

async function init() {
  panel = $("gopro-panel");
  btnConnect = $("btn-gopro-connect");
  btnBle = $("btn-gopro-ble");
  if (btnConnect) btnConnect.addEventListener("click", manualConnect);
  if (btnBle) {
    if (!bleSupported()) {
      btnBle.disabled = true;
      btnBle.title = "Bluetooth not available in this browser — use Chrome, Edge, or Opera";
    } else {
      btnBle.addEventListener("click", bleToggle);
    }
  }
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
  // else: stay hidden, Connect buttons are the manual paths
  setBridgeUI(false);
  setBleUI(false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
