/**
 * Stadium Slugger — Cage Edition: phone → laptop cast.
 *
 * Pure static-page WebRTC. No signaling server: the offer/answer are
 * exchanged as QR codes (camera scan) with copy/paste text fallback.
 * Pairing (primary): the laptop shows a 6-digit code, the phone types it in.
 * The laptop's code is permanent (localStorage) and the phone remembers the
 * last code it used, so re-pairing after a refresh is automatic — pair once.
 * The phone keeps offering until the laptop answers and rejoins the topic
 * after connection blips; the laptop rejoins too.
 * Offer/answer are relayed through a lightweight public MQTT broker over
 * WebSocket — the broker only sees the SDP handshake; the camera media
 * stays peer-to-peer on the LAN, encrypted with DTLS-SRTP.
 * Manual QR / copy-paste codes remain as an offline fallback.
 * Non-trickle ICE, host candidates only (same-WiFi LAN).
 *
 * Roles:
 *   Broadcast (phone):  camera -> RTCPeerConnection -> laptop
 *   Watch (laptop):     receives stream -> SessionApp.onRemoteStream
 */
(function () {
"use strict";

var panel = null, statusEl = null, qrEl = null;
var scanVideo = null, scanCanvas = null;
var pc = null, localStream = null, scanStream = null, scanning = false;
var mode = null; // 'broadcast' | 'watch'
var facingMode = "environment"; // phone broadcast camera; switchable

// NOTE (2026-09-26): this module used to stamp the footer build tag from
// its own ?v= cache-buster, which lied whenever session.js shipped without
// a cast.js change. The footer build tag and the Refresh button are now
// owned solely by session.js (SESSION_BUILD, from session.js?v=) — cast.js
// must not derive or overwrite them.

// Unique per page load: lets the phone distinguish "the laptop refreshed"
// (new sid -> rebroadcast the offer) from "the laptop's command channel
// just rejoined" (same sid -> stay quiet and keep streaming).
var PAGE_SID = "p" + Date.now().toString(36) + Math.floor(Math.random() * 2176782336).toString(36);

// PIN pairing state
var BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
var SIGNAL_TOPIC_PREFIX = "stadium-slugger/cast/v1/";
var link = null, republishTimer = null, pairTimeout = null, pairRetryTimer = null;
// Pairing-run generation: every phone offer cycle bumps broadcastEpoch, and
// stale closures (a dead run's link onMessage, timers, promise chains) bail
// instead of touching the current peer connection. broadcastActive goes
// false when the panel closes so delayed restarts can't resurrect a session.
var broadcastEpoch = 0, broadcastActive = false;
var healthTimer = null;
var manualStarted = false;

// The laptop's code is permanent (survives refreshes), so a phone that's
// already broadcasting re-pairs on its own — nobody has to touch the
// mounted phone again. The phone remembers the last code it used so a
// re-pair is one tap.
var PIN_STORE_KEY = "cage.cast.pin";    // this laptop's permanent code
var LAST_PIN_KEY = "cage.cast.lastPin"; // code the phone last broadcast to

function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function storeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

var RTC_CFG = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  // TURN relay fallback: if the two devices can't reach each other directly
  // (obfuscated host candidates, hairpin NAT, AP isolation), media relays
  // through here instead of failing. DTLS-SRTP stays end-to-end encrypted;
  // the relay sees only packet metadata, never video content.
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443"],
    username: "openrelayproject", credential: "openrelayproject" }
] };

function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function showPanel(which) {
  broadcastActive = false;
  broadcastEpoch++; // a fresh panel means fresh pairing runs
  mode = which;
  el("cast-panel").classList.remove("hidden");
  el("cast-status").textContent = "";
  el("cast-qr").innerHTML = "";
  el("cast-textwrap").classList.add("hidden");
  el("cast-actions").innerHTML = "";
  el("cast-pin-show").classList.add("hidden");
  el("cast-pin-enter").classList.add("hidden");
  el("cast-pin-entry-status").textContent = "";
  el("cast-scan-wrap").classList.add("hidden");
  el("cast-paste-wrap").classList.add("hidden");
  var det = el("cast-manual-details");
  det.open = false;
  manualStarted = false;
  stopPairing();
  if (which === "broadcast") broadcastPinFlow();
  else watchPinFlow();
}

function closePanel() {
  broadcastActive = false;
  broadcastEpoch++; // invalidate any in-flight phone pairing run
  stopScanning();
  stopPairing();
  showSwitchCam(false);
  var rsb = el("btn-switch-cam-remote");
  if (rsb) rsb.classList.add("hidden");
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  clearWatchMonitors();
  watchGapReported = false;
  watchRepairFn = null;
  hideStreamLostBanner();
  hideCastDeadBanner();
  el("cast-panel").classList.add("hidden");
  mode = null;
}

function showSwitchCam(show) {
  var b = el("btn-switch-cam");
  if (b) b.classList.toggle("hidden", !show);
}

// Phone: flip front/rear camera mid-broadcast. Swaps the track on the live
// sender — no re-pairing needed, the laptop keeps receiving the same feed.
function switchCamera() {
  if (mode !== "broadcast" || !pc) return;
  var next = (facingMode === "environment") ? "user" : "environment";
  setStatus("Switching camera…");
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: next, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    var newTrack = stream.getVideoTracks()[0];
    var sender = pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
    var p = (sender && sender.replaceTrack) ? sender.replaceTrack(newTrack) : Promise.reject(new Error("no video sender"));
    return p.then(function () {
      if (localStream) { try { localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
      localStream = stream;
      facingMode = next;
      setStatus("✓ Broadcasting — keep this page open. The laptop has your feed.");
    });
  }).catch(function (err) {
    setStatus("Couldn't switch camera (" + (err && err.message ? err.message : err) + ") — still on the " + (facingMode === "environment" ? "rear" : "front") + " camera.");
  });
}

/* ---------------- Step 9: Android tab lifecycle ----------------
   Chrome on Android kills backgrounded tabs; the wake lock dies with the
   tab and the camera track can be ended by the OS with no warning. Both
   sides now say what happened instead of freezing silently. */

var wakeLock = null, visListenerInstalled = false;   // phone side
var watchRepairFn = null;                            // laptop: re-pair (set in watchPinFlow)
var watchMuteTimer = null, iceMonitorTimer = null, iceDiscSince = 0;
var watchGapReported = false;

function requestWakeLock() {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  try {
    navigator.wakeLock.request("screen").then(function (wl) {
      wakeLock = wl;
      try {
        wl.addEventListener("release", function () { wakeLock = null; });
      } catch (e) {}
    }).catch(function () { wakeLock = null; });
  } catch (e) {}
}

// Registered once (startBroadcastPairing recurses on reconnect — the flag
// keeps the listener from doubling up).
function installVisListener() {
  if (visListenerInstalled) return;
  visListenerInstalled = true;
  document.addEventListener("visibilitychange", function () {
    if (mode !== "broadcast") return;
    if (document.hidden) {
      setStatus("Tab hidden — stream will freeze. Keep this tab open.");
    } else {
      requestWakeLock(); // wake locks do not survive the hidden state
      var dead = false;
      try {
        if (localStream) {
          var trs = localStream.getVideoTracks();
          for (var i = 0; i < trs.length; i++) {
            if (trs[i].readyState === "ended") { dead = true; break; }
          }
        }
      } catch (e) {}
      if (dead) showCastDeadBanner(); else hideCastDeadBanner();
    }
  });
}

function showCastDeadBanner() {
  var b = el("cast-dead-banner");
  if (!b) {
    b = document.createElement("div");
    b.id = "cast-dead-banner";
    b.textContent = "Camera was killed by the OS. Tap Broadcast again to restart.";
    var p = el("cast-panel");
    if (p) p.insertBefore(b, p.firstChild);
  }
}

function hideCastDeadBanner() {
  var b = el("cast-dead-banner");
  if (b && b.parentNode) b.parentNode.removeChild(b);
}

function clearWatchMonitors() {
  if (watchMuteTimer) { clearTimeout(watchMuteTimer); watchMuteTimer = null; }
  if (iceMonitorTimer) { clearInterval(iceMonitorTimer); iceMonitorTimer = null; }
  iceDiscSince = 0;
}

function showStreamLostBanner() {
  var wrap = el("camera-wrap");
  var b = el("stream-lost-banner");
  if (!b && wrap) {
    b = document.createElement("div");
    b.id = "stream-lost-banner";
    var t = document.createElement("div");
    t.textContent = "📵 PHONE STREAM LOST — check the phone tab";
    var btn = document.createElement("button");
    btn.id = "stream-lost-repair";
    btn.textContent = "Re-pair";
    btn.addEventListener("click", function () {
      if (watchRepairFn) watchRepairFn();
      else watchPinFlow();
    });
    b.appendChild(t);
    b.appendChild(btn);
    wrap.appendChild(b);
  }
  if (b) b.classList.remove("hidden");
}

function hideStreamLostBanner() {
  var b = el("stream-lost-banner");
  if (b) b.classList.add("hidden");
}

// Gap bookkeeping crosses into session.js (streamMuted/streamLive) so the
// swing log records exactly when the feed was dead.
function noteStreamLost() {
  showStreamLostBanner();
  if (!watchGapReported) {
    watchGapReported = true;
    try {
      if (window.SessionApp && window.SessionApp.streamMuted) window.SessionApp.streamMuted();
    } catch (e) {}
  }
}

function noteStreamRecovered() {
  hideStreamLostBanner();
  if (watchGapReported) {
    watchGapReported = false;
    try {
      if (window.SessionApp && window.SessionApp.streamLive) window.SessionApp.streamLive();
    } catch (e) {}
  }
}

// Shared by the PIN and manual watch flows: watches one inbound track for
// the two death signals (track mute, ICE disconnect) and offers re-pair.
function monitorWatchTrack(pcRef, track) {
  clearWatchMonitors();
  noteStreamRecovered(); // a new track closes any dangling gap from the old one
  track.onmute = function () {
    if (watchMuteTimer) clearTimeout(watchMuteTimer);
    watchMuteTimer = setTimeout(function () {
      watchMuteTimer = null;
      var stillGone = true;
      try { stillGone = track.muted || track.readyState !== "live"; } catch (e) {}
      if (stillGone) noteStreamLost();
    }, 5000);
  };
  track.onunmute = function () {
    if (watchMuteTimer) { clearTimeout(watchMuteTimer); watchMuteTimer = null; }
    noteStreamRecovered();
  };
  // Backstop: some Android skins kill the tab without firing mute first.
  iceDiscSince = 0;
  iceMonitorTimer = setInterval(function () {
    if (pcRef !== pc) { // replaced by a newer connection — retire
      clearWatchMonitors();
      return;
    }
    var st = "";
    try { st = pcRef.connectionState; } catch (e) {}
    if (st === "disconnected") {
      if (!iceDiscSince) iceDiscSince = Date.now();
      if (Date.now() - iceDiscSince > 5000) {
        iceDiscSince = 0;
        noteStreamLost();
      }
    } else {
      iceDiscSince = 0;
      if (st === "connected") noteStreamRecovered();
    }
  }, 1000);
}

/* ---------------- PIN pairing ---------------- */

function stopPairing() {
  if (republishTimer) { clearInterval(republishTimer); republishTimer = null; }
  if (pairTimeout) { clearTimeout(pairTimeout); pairTimeout = null; }
  if (pairRetryTimer) { clearTimeout(pairRetryTimer); pairRetryTimer = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (link) { try { link.close(); } catch (e) {} link = null; }
}

// Connection-health readout: polls the peer connection every 2s and shows
// ICE/connection state, track state, RTP byte counters, and the inbound
// video stream fingerprint (resolution, measured FPS, frames received /
// dropped, jitter, codec). A black video can be told apart from a dead
// handshake at a glance, and FPS drift > 10% is flagged — the ball
// tracker assumes 30 fps, so a drifting stream silently biases EV.
var lastFramesReceived = -1;
var lastFramesDropped = -1;
var lastFpsCheck = 0;
var nominalFps = 30;
function startHealthPoll(whichPc, dir) {
  var box = el("cast-health");
  if (!box || !whichPc) return;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  box.classList.remove("hidden");
  var pcRef = whichPc;
  lastFramesReceived = -1;
  healthTimer = setInterval(function () {
    var ice = "?", conn = "?", tinfo = "";
    try { ice = pcRef.iceConnectionState; } catch (e) {}
    try { conn = pcRef.connectionState; } catch (e) {}
    try {
      var rec = dir === "in" ? pcRef.getReceivers()[0] : pcRef.getSenders()[0];
      var tr = rec && rec.track;
      if (tr) tinfo = " track:" + tr.readyState + (tr.muted ? "(muted)" : "(live)");
    } catch (e) {}
    box.textContent = "ice:" + ice + " conn:" + conn + tinfo;
    try {
      pcRef.getStats().then(function (st) {
        var bytes = -1, w = 0, h = 0, fps = 0, fr = -1, fd = -1, jit = -1, codec = "";
        st.forEach(function (r) {
          if (r.kind !== "video") return;
          var inbound = dir === "in" && r.type === "inbound-rtp";
          var outbound = dir === "out" && r.type === "outbound-rtp";
          if (!inbound && !outbound) return;
          if (inbound && r.bytesReceived != null) bytes = r.bytesReceived;
          if (outbound && r.bytesSent != null) bytes = r.bytesSent;
          if (r.frameWidth) w = r.frameWidth;
          if (r.frameHeight) h = r.frameHeight;
          if (r.framesPerSecond) fps = r.framesPerSecond;
          if (r.framesReceived != null) fr = r.framesReceived;
          if (r.framesDropped != null) fd = r.framesDropped;
          if (r.jitter != null) jit = r.jitter;
          if (r.codecId) {
            st.forEach(function (c) {
              if (c.id === r.codecId && c.mimeType) codec = c.mimeType.replace("video/", "");
            });
          }
        });
        // Fall back to the video element's intrinsic size when stats lack it.
        if ((!w || !h) && dir === "in") {
          try {
            var vids = document.querySelectorAll("video");
            for (var vi = 0; vi < vids.length; vi++) {
              if (vids[vi].videoWidth) { w = vids[vi].videoWidth; h = vids[vi].videoHeight; break; }
            }
          } catch (e) {}
        }
        var parts = [];
        if (bytes >= 0) parts.push("bytes:" + bytes);
        if (w && h) parts.push(w + "x" + h);
        if (fps) {
          var drift = Math.abs(fps - nominalFps) / nominalFps;
          parts.push("fps:" + fps.toFixed(0) + (drift > 0.10 ? " ⚠DRIFT" : ""));
        }
        if (fr >= 0) {
          var dropPct = "";
          if (fd >= 0 && fr + fd > 0) dropPct = " (drop " + (100 * fd / (fr + fd)).toFixed(1) + "%)";
          parts.push("frames:" + fr + "/" + (fd >= 0 ? fd : "?") + dropPct);
        }
        if (jit >= 0) parts.push("jitter:" + (jit * 1000).toFixed(0) + "ms");
        if (codec) parts.push(codec);
        if (parts.length) box.textContent += " " + parts.join(" ");
        // Stash the fingerprint for the session JSON export.
        try {
          window.__streamFingerprint = {
            at: new Date().toISOString(),
            width: w || null, height: h || null,
            fps: fps || null, framesReceived: fr >= 0 ? fr : null,
            framesDropped: fd >= 0 ? fd : null, jitterSec: jit >= 0 ? +jit.toFixed(4) : null,
            codec: codec || null, bytes: bytes >= 0 ? bytes : null
          };
        } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }, 2000);
}

function makePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getOrMakePin() {
  var pin = storeGet(PIN_STORE_KEY);
  if (!pin || !/^\d{6}$/.test(pin)) {
    pin = makePin();
    storeSet(PIN_STORE_KEY, pin);
  }
  return pin;
}

function pairingUnavailable() {
  stopPairing();
  setStatus("Couldn't reach the pairing service — check internet, or use manual codes below.");
  openManualFallback();
}

function openManualFallback() {
  var det = el("cast-manual-details");
  det.open = true; // the toggle handler starts the manual flow
}

// The manual flow starts lazily the first time the fallback is opened.
function wireManualToggle() {
  el("cast-manual-details").addEventListener("toggle", function () {
    if (el("cast-manual-details").open && !manualStarted) {
      manualStarted = true;
      el("cast-actions").innerHTML = "";
      if (mode === "broadcast") broadcastManualFlow();
      else watchManualFlow();
    }
  });
}

// Broadcast (phone): type the laptop's code, camera pairs automatically.
// The last code is pre-filled, so re-pairing after the phone's page reloads
// is one tap. The phone keeps offering until the laptop answers — it never
// gives up on its own, since nobody can reach it in the mount.
function broadcastPinFlow() {
  if (typeof MqttLink === "undefined") { pairingUnavailable(); return; }
  el("cast-pin-enter").classList.remove("hidden");
  var input = el("cast-pin-input");
  var entryStatus = el("cast-pin-entry-status");
  var lastPin = storeGet(LAST_PIN_KEY);
  if (lastPin && /^\d{6}$/.test(lastPin)) {
    input.value = lastPin;
    entryStatus.textContent = "Last code filled in — tap Pair to resume.";
  } else {
    input.value = "";
    entryStatus.textContent = "";
  }
  setStatus("Enter the 6-digit code shown on the laptop.");
  el("btn-cast-pair").onclick = function () {
    var pin = (input.value || "").replace(/\D/g, "");
    if (pin.length !== 6) { entryStatus.textContent = "That code needs 6 digits."; return; }
    entryStatus.textContent = "";
    storeSet(LAST_PIN_KEY, pin);
    el("btn-cast-pair").disabled = true; // one pairing run at a time
    el("cast-pin-enter").classList.add("hidden");
    startBroadcastPairing(pin);
  };
  input.onkeydown = function (ev) { if (ev.key === "Enter") el("btn-cast-pair").click(); };
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
}

function startBroadcastPairing(pin) {
  broadcastActive = true;
  setStatus("Starting phone camera…");
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    if (!broadcastActive) return; // panel was closed while the camera warmed up
    localStream = stream;
    showSwitchCam(true);
    requestWakeLock();
    installVisListener(); // once: warns on tab-hide, re-locks on visible
    hideCastDeadBanner(); // a fresh broadcast clears the OS-kill warning
    broadcastOfferCycle(pin);
  }).catch(function () {
    setStatus("Phone camera blocked — allow access and retry.");
    var pb = el("btn-cast-pair");
    if (pb) pb.disabled = false;
    el("cast-pin-enter").classList.remove("hidden");
  });
}

// One phone offer cycle: a fresh peer connection + offer, published until
// the laptop answers. Re-runs on connection failure (reusing the camera
// stream — no re-prompt), on handshake stalls, and on repeated answer
// failures. The mounted phone never strands itself on a dead session.
function broadcastOfferCycle(pin, quiet) {
  var epoch = ++broadcastEpoch; // this cycle owns the pairing state from here on
  stopPairing(); // drop the previous cycle's timers/link (epoch NOT bumped here)
  if (!quiet) setStatus("Creating broadcast offer…");
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  var myPc = pc = new RTCPeerConnection(RTC_CFG);
  var tracksOk = false;
  try {
    var trs = localStream ? localStream.getVideoTracks() : [];
    tracksOk = trs.length > 0 && trs[0].readyState === "live";
    if (tracksOk) trs.forEach(function (t) { myPc.addTrack(t, localStream); });
  } catch (e) { tracksOk = false; }
  if (!tracksOk) {
    // The OS killed the camera while we weren't looking — re-request it
    // instead of offering a dead track.
    if (epoch === broadcastEpoch && broadcastActive) {
      setStatus("Camera track lost — restarting camera…");
      setTimeout(function () { if (broadcastActive) startBroadcastPairing(pin); }, 1500);
    }
    return;
  }
  startHealthPoll(myPc, "out");
  preferSingleCodec(myPc, "video"); // one codec -> smaller offer
  var answered = false;
  var pairedLaptopSid = null; // page session that answered us; a hello from anyone else = laptop refreshed
  var answerAttempts = 0;
  var stallTimer = null;

  // Applying the laptop's answer is the step that used to die with
  // "Called in wrong state: stable" and strand the phone on a dead
  // "Pairing failed — try again." with no way back. Every one of those
  // failure modes now retries instead of stranding:
  //   - answer arrives when already stable -> duplicate, ignore silently
  //   - apply fails -> the laptop republishes its answer every 2.5s, so the
  //     next copy retries automatically (attempts shown in the status)
  //   - 3 failed attempts -> mint a fresh offer; the laptop treats a new
  //     offer SDP as a re-pair request and re-handshakes on its own
  var applyPhoneAnswer = function (sdp, sid) {
    if (epoch !== broadcastEpoch || myPc !== pc) return; // superseded
    var sig = "";
    try { sig = myPc.signalingState; } catch (e) {}
    if (sig === "stable") return; // duplicate/late answer — handshake already done
    if (sig !== "have-local-offer") return; // mid-restart; a fresh offer is coming
    if (answered) return; // an apply is already in flight
    answered = true;
    pairedLaptopSid = sid || null; // remember WHO answered: a hello from anyone else = laptop refreshed
    myPc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdp })).then(function () {
      if (epoch !== broadcastEpoch || myPc !== pc) return;
      answerAttempts = 0;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      // Paired: stop the timers but KEEP the link — remote commands
      // (camera switch) arrive over it.
      if (republishTimer) { clearInterval(republishTimer); republishTimer = null; }
      if (pairTimeout) { clearTimeout(pairTimeout); pairTimeout = null; }
      if (pairRetryTimer) { clearTimeout(pairRetryTimer); pairRetryTimer = null; }
      setStatus("✓ Broadcasting — keep this page open. The laptop has your feed.");
    }).catch(function (err) {
      if (epoch !== broadcastEpoch || myPc !== pc) return;
      answered = false; // let the next republished answer retry
      answerAttempts++;
      var why = err && err.message ? err.message : String(err);
      try { console.error("broadcast answer failed (attempt " + answerAttempts + "):", why); } catch (e) {}
      if (answerAttempts >= 3) {
        answerAttempts = 0;
        setStatus("Handshake keeps failing — starting a fresh offer…");
        setTimeout(function () { if (epoch === broadcastEpoch && broadcastActive) broadcastOfferCycle(pin, true); }, 1500);
      } else {
        setStatus("Handshake hiccup — retrying (attempt " + answerAttempts + ")…");
      }
    });
  };

  myPc.createOffer().then(function (offer) {
    if (epoch !== broadcastEpoch) throw new Error("superseded");
    return myPc.setLocalDescription(offer);
  }).then(function () {
    return waitIceComplete(myPc);
  }).then(function () {
    if (epoch !== broadcastEpoch || myPc !== pc) return;
    var offerMsg = fullSdpMsg("offer", myPc.localDescription.sdp);
    // If the paired connection dies (laptop refreshed, network blip), go
    // back to broadcasting a fresh offer. The epoch bump invalidates this
    // cycle immediately so a stale answer can't land on the closed pc; the
    // short delay damps flapping.
    myPc.onconnectionstatechange = function () {
      var st = "";
      try { st = myPc.connectionState; } catch (e) {}
      if ((st === "failed" || st === "closed") && epoch === broadcastEpoch && myPc === pc) {
        broadcastEpoch++;
        setStatus("Connection lost — rebroadcasting…");
        setTimeout(function () { if (broadcastActive) broadcastOfferCycle(pin, true); }, 3000);
      }
    };
    if (!quiet) setStatus("Pairing…");
    // A blipped connection must not strand the mounted phone: wait a few
    // seconds and rejoin the same topic. stopPairing() (panel close) clears
    // pairRetryTimer, so this can't resurrect a closed session.
    var scheduleReconnect = function (msg) {
      if (answered || epoch !== broadcastEpoch) return;
      stopPairing();
      setStatus(msg);
      pairRetryTimer = setTimeout(function () { pairRetryTimer = null; connect(); }, 8000);
    };
    var quietRejoin = function () {
      // Paired already: the link is just the command channel (remote
      // camera switch). Rejoin silently — never touch the status text.
      if (!answered || pairRetryTimer || epoch !== broadcastEpoch) return;
      if (link) { try { link.close(); } catch (e) {} link = null; }
      pairRetryTimer = setTimeout(function () { pairRetryTimer = null; connect(); }, 8000);
    };
    var connect = function () {
      if (epoch !== broadcastEpoch || myPc !== pc || !broadcastActive) return;
      if (link) { try { link.close(); } catch (e) {} link = null; }
      link = MqttLink.connect(BROKER_URL, SIGNAL_TOPIC_PREFIX + pin, {
        onReady: function () {
          if (answered || epoch !== broadcastEpoch) return; // already paired: commands-only
          setStatus("Broadcasting offer — waiting for the laptop (code " + pin + ")…");
          var sendOffer = function () { if (!answered && link && epoch === broadcastEpoch) link.send(JSON.parse(offerMsg)); };
          sendOffer();
          republishTimer = setInterval(sendOffer, 2500); // the laptop may join late
        },
        onMessage: function (o) {
          if (epoch !== broadcastEpoch) return;
          if (o && o.t === "hello") {
            // A laptop page announcing itself. If we're already paired but
            // with a DIFFERENT page session, the laptop refreshed and its
            // half of the handshake is gone — rebroadcast a fresh offer so
            // video comes back with nobody touching the mounted phone.
            // (A hello without a sid is an older laptop build: ignore,
            // exactly as before.)
            if (answered && o.sid && pairedLaptopSid && o.sid !== pairedLaptopSid) {
              broadcastEpoch++;
              setStatus("Laptop restarted — rebroadcasting…");
              setTimeout(function () { if (broadcastActive) broadcastOfferCycle(pin, true); }, 500);
            }
            return;
          }
          // Remote command from the laptop — the mounted phone never
          // needs a touch to flip cameras.
          if (o && o.t === "switch") { switchCamera(); return; }
          var d;
          try { d = decodeMsg(JSON.stringify(o)); } catch (e) { return; }
          if (d.t !== "answer") return;
          applyPhoneAnswer(d.sdp, d.sid);
        },
        onError: function () { if (answered) quietRejoin(); else scheduleReconnect("Pairing service hiccup — retrying…"); },
        onClose: function () { if (answered) quietRejoin(); else scheduleReconnect("Connection blipped — reconnecting…"); }
      });
    };
    connect();
    // Stall guard: if no answer lands within 45s, whatever the laptop saw
    // is stale — mint a fresh offer. The laptop treats a new offer SDP as a
    // re-pair request and re-handshakes automatically.
    stallTimer = setTimeout(function () {
      stallTimer = null;
      if (epoch !== broadcastEpoch || answered || !broadcastActive) return;
      setStatus("No answer from the laptop — refreshing the offer…");
      broadcastOfferCycle(pin, true);
    }, 45000);
  }).catch(function (err) {
    if (epoch !== broadcastEpoch) return;
    var why = (err && err.message) || String(err);
    if (why === "superseded") return;
    try { console.error("broadcast offer failed:", why); } catch (e) {}
    setStatus("Couldn't create the offer (" + why + ") — retrying…");
    setTimeout(function () { if (epoch === broadcastEpoch && broadcastActive) broadcastOfferCycle(pin, true); }, 3000);
  });
}

// Watch (laptop): show the code, wait for the phone, connect automatically.
// The code is permanent for this laptop: refreshing the page shows the same
// code, and a phone that's already broadcasting re-pairs within seconds.
function watchPinFlow() {
  if (typeof MqttLink === "undefined") { pairingUnavailable(); return; }
  var pin = getOrMakePin();
  el("cast-pin").textContent = pin;
  el("cast-pin-show").classList.remove("hidden");
  el("cast-pin-hint").textContent = "Waiting for the phone — this code doesn't change.";
  el("cast-pin-new").onclick = function () {
    storeDel(PIN_STORE_KEY);
    stopPairing();
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    watchPinFlow();
  };
  var gotOffer = false, connected = false, lastOfferSdp = "";
  var quietRejoin = function () {
    // Command channel dropped after pairing: rejoin silently so remote
    // commands (camera switch) keep working. Never touches the status text.
    if (!connected || pairRetryTimer) return;
    if (link) { try { link.close(); } catch (e) {} link = null; }
    pairRetryTimer = setTimeout(function () { pairRetryTimer = null; connect(); }, 8000);
  };
  var connect = function () {
    if (link) { try { link.close(); } catch (e) {} link = null; }
    link = MqttLink.connect(BROKER_URL, SIGNAL_TOPIC_PREFIX + pin, {
      onReady: function () {
        // Nudge a phone that's already waiting — and identify this page
        // session, so a phone paired with a PREVIOUS page knows to
        // rebroadcast its offer instead of sitting on a dead handshake.
        if (!connected) link.send({ t: "hello", sid: PAGE_SID });
      },
      onMessage: function (o) {
        // Offers republish every 2.5s, so dedupe by SDP: an identical SDP is
        // a republish (ignore it), a NEW SDP is the phone re-pairing after a
        // blip (re-handshake even if we thought we were already paired).
        if (!o || o.t !== "offer") return;
        var sdp = "";
        try { sdp = decodeMsg(JSON.stringify(o)).sdp || ""; } catch (e) { return; }
        if (sdp === lastOfferSdp) return;
        lastOfferSdp = sdp;
        gotOffer = true;
        applyOfferPin(o);
      },
      onError: function () {
        if (connected) { quietRejoin(); return; }
        if (!gotOffer) {
          stopPairing();
          setStatus("Pairing service hiccup — retrying…");
          pairRetryTimer = setTimeout(function () { pairRetryTimer = null; connect(); }, 8000);
        } else pairingUnavailable();
      },
      onClose: function () {
        if (connected) { quietRejoin(); return; }
        if (!gotOffer) {
          stopPairing();
          setStatus("Connection blipped — retrying…");
          pairRetryTimer = setTimeout(function () { pairRetryTimer = null; connect(); }, 5000);
        }
      }
    });
  };
  connect();
  pairTimeout = setTimeout(function () {
    if (!gotOffer && !connected) {
      el("cast-pin-hint").textContent = "Still waiting… make sure the phone entered code " + pin + ".";
    }
  }, 30000);

  // Step 9: re-pair without a page refresh — tear down and rejoin the same
  // topic. Wired to the "Re-pair" button on the stream-lost banner.
  // (Do NOT close the session.js gap here: the new track's
  // monitorWatchTrack closes it via streamLive, so the gap stays honest.)
  watchRepairFn = function () {
    connected = false; gotOffer = false; lastOfferSdp = "";
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    stopPairing();
    clearWatchMonitors();
    hideStreamLostBanner();
    setStatus("Re-pairing — listening for the phone…");
    el("cast-pin-show").classList.remove("hidden");
    el("cast-pin-hint").textContent = "Waiting for the phone — this code doesn't change.";
    connect();
  };

  function applyOfferPin(o) {
    if (pairTimeout) { clearTimeout(pairTimeout); pairTimeout = null; }
    var d;
    try {
      d = decodeMsg(JSON.stringify(o));
      if (d.t !== "offer") throw new Error("not an offer");
    } catch (e) {
      gotOffer = false;
      return;
    }
    setStatus("Phone found — connecting…");
    el("cast-pin-hint").textContent = "Phone found — connecting…";
    // Close any previous attempt first: orphaned peer connections pile up
    // (one per failed handshake) and eventually starve the browser.
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    pc = new RTCPeerConnection(RTC_CFG);
    startHealthPoll(pc, "in");
    pc.ontrack = function (ev) {
      var stream = ev.streams && ev.streams[0];
      if (stream && window.SessionApp && window.SessionApp.onRemoteStream) {
        window.SessionApp.onRemoteStream(stream);
      }
      if (ev.track) monitorWatchTrack(pc, ev.track); // Step 9: stream-death watch
      // NOTE: do NOT set connected=true here. ontrack fires during
      // setRemoteDescription, before our answer is even sent. Marking
      // connected here suppresses the answer (sendAnswer gates on
      // !connected) and the phone never completes the handshake.
      // connected flips only in onconnectionstatechange below.
      if (republishTimer) { clearInterval(republishTimer); republishTimer = null; }
      if (pairTimeout) { clearTimeout(pairTimeout); pairTimeout = null; }
      if (pairRetryTimer) { clearTimeout(pairRetryTimer); pairRetryTimer = null; }
      el("cast-pin-show").classList.add("hidden");
      setStatus("Phone found — completing connection…");
      var rsb = el("btn-switch-cam-remote");
      if (rsb) {
        rsb.classList.remove("hidden");
        rsb.onclick = function () { if (link) link.send({ t: "switch" }); };
      }
      var calb = el("btn-calibrate");
      if (calb) {
        calb.classList.remove("hidden");
        calb.onclick = function () {
          if (window.PhoneCalib) {
            window.PhoneCalib.open();
          } else {
            setStatus("Calibration script didn't load — refresh the page (footer Refresh button).");
          }
        };
      }
    };
    pc.onconnectionstatechange = function () {
      var st = "";
      try { st = pc.connectionState; } catch (e) {}
      if (st === "connected" && !connected) {
        connected = true;
        setStatus("✓ Phone camera connected — start the session below.");
      } else if (st === "failed" || st === "closed") {
        connected = false; gotOffer = false;
        try { pc.close(); } catch (e2) {}
        pc = null;
        stopPairing();
        setStatus("Phone went away — listening for its broadcast…");
        connect();
      }
    };
    pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: d.sdp }))
      .then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .then(function () { return waitIceComplete(pc); })
      .then(function () {
        var answerMsg = fullSdpMsg("answer", pc.localDescription.sdp, { sid: PAGE_SID });
        var sendAnswer = function () { if (!connected && link) link.send(JSON.parse(answerMsg)); };
        sendAnswer();
        republishTimer = setInterval(sendAnswer, 2500);
        pairTimeout = setTimeout(function () {
          if (!connected) {
            // Handshake stalled: rejoin the same topic and wait for the
            // phone's next offer republish. Same code, no user action.
            setStatus("Handshake stalled — retrying on the same code…");
            gotOffer = false;
            lastOfferSdp = "";
            if (pc) { try { pc.close(); } catch (e) {} pc = null; }
            stopPairing();
            connect();
          }
        }, 120000);
      })
      .catch(function (err) {
        gotOffer = false;
        lastOfferSdp = ""; // the phone's republish must look new so it retries
        if (pc) { try { pc.close(); } catch (e) {} pc = null; }
        var why = err && err.message ? err.message : String(err);
        var mline = "";
        try {
          mline = (d.sdp || "").split(/\r\n|\n/).filter(function (l) { return l.indexOf("m=") === 0; })[0] || "";
        } catch (e) {}
        try { console.error("watch handshake failed:", why, "got m-line:", mline); } catch (e) {}
        setStatus("Connection failed — retry the handshake. (" + why + (mline ? " | got: " + mline : "") + ")");
      });
  }
}

/* ---------------- SDP helpers ---------------- */

// Strip the SDP to the essentials and compress it, so the whole handshake
// fits in one easily-scannable QR code (a raw offer is several KB and the
// QR library refuses it outright).
//   - one payload type per m= section (first listed codec)
//   - host ICE candidates only (same-WiFi LAN)
//   - drop redundant/informational lines (ssrc, extmap, rtcp-fb, etc.)
//   - LZ-compress the result before QR encoding
function minifySdp(sdp) {
  var out = [];
  var keepPayload = null; // payload type kept for the current m= section
  var lines = sdp.split(/\r\n|\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    if (line.indexOf("m=") === 0) {
      var parts = line.split(" ");
      keepPayload = parts.length > 3 ? parts[3] : null;
      out.push(parts.slice(0, 4).join(" ")); // single payload type
      continue;
    }
    if (line.indexOf("a=candidate:") === 0) {
      if (/ typ host /.test(line)) out.push(line); // LAN candidates only
      continue;
    }
    if (/^a=(rtpmap|fmtp):/.test(line)) {
      // keep codec description only for the chosen payload
      if (keepPayload &&
          (line.indexOf("a=rtpmap:" + keepPayload + " ") === 0 ||
           line.indexOf("a=fmtp:" + keepPayload + " ") === 0)) out.push(line);
      continue;
    }
    // informational / redundant lines: safe to drop for a direct LAN peer
    if (/^a=(rtcp-fb|ssrc|ssrc-group|extmap|x-google-flag|ice-options|end-of-candidates|rtcp-rsize)/.test(line)) continue;
    out.push(line);
  }
  return out.join("\r\n");
}

// Ask the browser to offer just one codec per kind before createOffer, so
// the minified m= line matches what was actually negotiated.
function preferSingleCodec(pc, kind) {
  try {
    var getCaps = window.RTCRtpSender && RTCRtpSender.getCapabilities;
    var codecs = getCaps ? getCaps(kind).codecs || [] : [];
    codecs = codecs.filter(function (c) { return c.mimeType.toLowerCase().indexOf(kind + "/") === 0; });
    if (!codecs.length) return;
    var chosen = codecs[0];
    if (kind === "video") {
      var vp8 = codecs.filter(function (c) { return /\/vp8$/i.test(c.mimeType); })[0];
      if (vp8) chosen = vp8;
    }
    pc.getTransceivers().forEach(function (tr) {
      if (tr.sender && tr.sender.track && tr.sender.track.kind === kind && tr.setCodecPreferences) {
        tr.setCodecPreferences([chosen]);
      }
    });
  } catch (e) { /* codec munging in minifySdp still covers it */ }
}

function encodeMsg(type, sdp) {
  /* global LZString */
  var small = minifySdp(sdp);
  return JSON.stringify({ t: type, s: LZString.compressToBase64(small) });
}

// PIN/MQTT pairing: no size constraint, so send the phone's SDP exactly as
// its WebRTC stack generated it — no minifier in the path. (The minifier
// exists only to fit handshakes into scannable QR codes for manual pairing.)
// `extra` carries small non-SDP fields (e.g. the laptop's page sid).
function fullSdpMsg(type, sdp, extra) {
  var o = { t: type, sdp: sdp };
  if (extra) for (var k in extra) { if (extra[k] !== undefined) o[k] = extra[k]; }
  return JSON.stringify(o);
}

function decodeMsg(text) {
  var o = JSON.parse(text);
  if (!o || (o.t !== "offer" && o.t !== "answer")) throw new Error("bad code");
  var sdp = o.s ? LZString.decompressFromBase64(o.s) : o.sdp; // o.sdp = legacy uncompressed
  if (!sdp) throw new Error("bad code");
  return { t: o.t, sdp: sdp, sid: o.sid || null };
}

function waitIceComplete(pc) {
  return new Promise(function (resolve) {
    if (pc.iceGatheringState === "complete") return resolve();
    var to = setTimeout(resolve, 10000); // never hang forever (TURN gathering can be slow)
    pc.onicegatheringstatechange = function () {
      if (pc.iceGatheringState === "complete") { clearTimeout(to); resolve(); }
    };
  });
}

function showQr(text) {
  qrEl.innerHTML = "";
  /* global QRCode */
  // Try M first (more error correction = easier camera scan); fall back to
  // L (more capacity) before giving up to text.
  var levels = [QRCode.CorrectLevel.M, QRCode.CorrectLevel.L];
  for (var i = 0; i < levels.length; i++) {
    try {
      new QRCode(qrEl, { text: text, width: 264, height: 264, correctLevel: levels[i] });
      return true;
    } catch (e) {
      qrEl.innerHTML = "";
    }
  }
  return false; // too big for QR -> text fallback
}

function showTextFallback(text) {
  el("cast-textwrap").classList.remove("hidden");
  el("cast-text").value = text;
}

function actionButton(label, fn) {
  var b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", fn);
  el("cast-actions").appendChild(b);
  return b;
}

/* ---------------- QR scanner ---------------- */

function stopScanning() {
  scanning = false;
  if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
  el("cast-scan-wrap").classList.add("hidden");
}

function openScanner(onDecode) {
  el("cast-scan-wrap").classList.remove("hidden");
  var ctx = scanCanvas.getContext("2d");
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(function (stream) {
    scanStream = stream;
    scanVideo.srcObject = stream;
    return scanVideo.play();
  }).then(function () {
    scanning = true;
    (function tick() {
      if (!scanning) return;
      try {
        if (scanVideo.readyState >= 2 && scanVideo.videoWidth) {
          scanCanvas.width = scanVideo.videoWidth;
          scanCanvas.height = scanVideo.videoHeight;
          var ctx2 = scanCanvas.getContext("2d");
          ctx2.drawImage(scanVideo, 0, 0);
          var img = ctx2.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
          /* global jsQR */
          var code = jsQR(img.data, scanCanvas.width, scanCanvas.height);
          if (code && code.data) {
            var data = code.data;
            stopScanning();
            onDecode(data);
            return;
          }
        }
      } catch (e) { /* keep scanning */ }
      requestAnimationFrame(tick);
    })();
  }).catch(function () {
    setStatus("Camera unavailable for scanning — use paste instead.");
  });
}

function openPaste(onText) {
  el("cast-paste-wrap").classList.remove("hidden");
  el("btn-apply-code").onclick = function () {
    var v = el("cast-paste").value.trim();
    el("cast-paste-wrap").classList.add("hidden");
    if (v) onText(v);
  };
}

/* ---------------- Broadcast (phone) ---------------- */

function broadcastManualFlow() {
  setStatus("Starting phone camera…");
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    localStream = stream;
    showSwitchCam(true);
    requestWakeLock();
    installVisListener(); // once: warns on tab-hide, re-locks on visible
    hideCastDeadBanner(); // a fresh broadcast clears the OS-kill warning
    setStatus("Creating broadcast offer…");
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    pc = new RTCPeerConnection(RTC_CFG);
    stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
    preferSingleCodec(pc, "video"); // one codec -> smaller offer -> smaller QR
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      return waitIceComplete(pc);
    }).then(function () {
      var msg = encodeMsg("offer", pc.localDescription.sdp);
      setStatus("On the laptop: tap “Watch phone camera”, then scan this code.");
      var ok = showQr(msg);
      if (!ok) { setStatus("Code too big for QR — copy the text instead."); showTextFallback(msg); }
      else actionButton("Copy as text instead", function () { showTextFallback(msg); });
      actionButton("Scan laptop's answer", function () { openScanner(applyAnswer); });
      actionButton("Paste answer text", function () { openPaste(applyAnswer); });
    });
  }).catch(function () {
    setStatus("Phone camera blocked — allow access and retry.");
  });

  function applyAnswer(text) {
    try {
      var o = decodeMsg(text);
      if (o.t !== "answer") throw new Error("not an answer");
      var sig = "";
      try { sig = pc.signalingState; } catch (e) {}
      if (sig === "stable") { // duplicate scan of an already-applied answer
        setStatus("✓ Broadcasting — keep this page open. The laptop has your feed.");
        el("cast-actions").innerHTML = "";
        el("cast-qr").innerHTML = "";
        return;
      }
      pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: o.sdp })).then(function () {
        setStatus("✓ Broadcasting — keep this page open. The laptop has your feed.");
        el("cast-actions").innerHTML = "";
        el("cast-qr").innerHTML = "";
      });
    } catch (e) {
      setStatus("That code didn't work — try scanning again.");
    }
  }
}

/* ---------------- Watch (laptop) ---------------- */

function watchManualFlow() {
  setStatus("Get the offer code from the phone.");
  actionButton("Scan phone's QR", function () { openScanner(applyOffer); });
  actionButton("Paste offer text", function () { openPaste(applyOffer); });

  function applyOffer(text) {
    var o;
    try {
      o = decodeMsg(text);
      if (o.t !== "offer") throw new Error("not an offer");
    } catch (e) {
      setStatus("That code didn't work — try again.");
      return;
    }
    setStatus("Connecting…");
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    pc = new RTCPeerConnection(RTC_CFG);
    pc.ontrack = function (ev) {
      var stream = ev.streams && ev.streams[0];
      if (stream && window.SessionApp && window.SessionApp.onRemoteStream) {
        window.SessionApp.onRemoteStream(stream);
      }
      if (ev.track) monitorWatchTrack(pc, ev.track); // Step 9: stream-death watch
      setStatus("✓ Phone camera connected — start the session below.");
      el("cast-qr").innerHTML = "";
      el("cast-actions").innerHTML = "";
    };
    pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: o.sdp }))
      .then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .then(function () { return waitIceComplete(pc); })
      .then(function () {
        var msg = encodeMsg("answer", pc.localDescription.sdp);
        setStatus("On the phone: “Scan laptop's answer” and point it at this code.");
        var ok = showQr(msg);
        if (!ok) { setStatus("Code too big for QR — copy the text instead."); }
        showTextFallback(msg);
      })
      .catch(function () { setStatus("Connection failed — retry the handshake."); });
  }
}

/* ---------------- boot ---------------- */

document.addEventListener("DOMContentLoaded", function () {
  panel = el("cast-panel");
  statusEl = el("cast-status");
  qrEl = el("cast-qr");
  scanVideo = el("cast-scan-video");
  scanCanvas = el("cast-scan-canvas");
  el("btn-broadcast").addEventListener("click", function () { showPanel("broadcast"); });
  el("btn-watch").addEventListener("click", function () { showPanel("watch"); });
  el("btn-cast-close").addEventListener("click", closePanel);
  var switchCam = el("btn-switch-cam");
  if (switchCam) switchCam.addEventListener("click", switchCamera);
  wireManualToggle();
  el("btn-copy-code").addEventListener("click", function () {
    el("cast-text").select();
    try { document.execCommand("copy"); } catch (e) {}
  });
});

})();
