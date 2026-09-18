/**
 * Stadium Slugger — Cage Edition: phone → laptop cast.
 *
 * Pure static-page WebRTC. No signaling server: the offer/answer are
 * exchanged as QR codes (camera scan) with copy/paste text fallback.
 * Pairing (primary): the laptop shows a 6-digit code, the phone types it in.
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

// PIN pairing state
var BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
var SIGNAL_TOPIC_PREFIX = "stadium-slugger/cast/v1/";
var link = null, republishTimer = null, pairTimeout = null;
var manualStarted = false;

var RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function showPanel(which) {
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
  stopScanning();
  stopPairing();
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  el("cast-panel").classList.add("hidden");
  mode = null;
}

/* ---------------- PIN pairing ---------------- */

function stopPairing() {
  if (republishTimer) { clearInterval(republishTimer); republishTimer = null; }
  if (pairTimeout) { clearTimeout(pairTimeout); pairTimeout = null; }
  if (link) { try { link.close(); } catch (e) {} link = null; }
}

function makePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
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
function broadcastPinFlow() {
  if (typeof MqttLink === "undefined") { pairingUnavailable(); return; }
  el("cast-pin-enter").classList.remove("hidden");
  var input = el("cast-pin-input");
  var entryStatus = el("cast-pin-entry-status");
  input.value = "";
  entryStatus.textContent = "";
  setStatus("Enter the 6-digit code shown on the laptop.");
  el("btn-cast-pair").onclick = function () {
    var pin = (input.value || "").replace(/\D/g, "");
    if (pin.length !== 6) { entryStatus.textContent = "That code needs 6 digits."; return; }
    entryStatus.textContent = "";
    el("cast-pin-enter").classList.add("hidden");
    startBroadcastPairing(pin);
  };
  input.onkeydown = function (ev) { if (ev.key === "Enter") el("btn-cast-pair").click(); };
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
}

function startBroadcastPairing(pin) {
  setStatus("Starting phone camera…");
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    localStream = stream;
    // Wake lock so the phone doesn't sleep mid-session.
    try {
      if (navigator.wakeLock) navigator.wakeLock.request("screen");
    } catch (e) {}
    setStatus("Creating broadcast offer…");
    pc = new RTCPeerConnection(RTC_CFG);
    stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
    preferSingleCodec(pc, "video"); // one codec -> smaller offer
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      return waitIceComplete(pc);
    }).then(function () {
      var offerMsg = encodeMsg("offer", pc.localDescription.sdp);
      var answered = false;
      setStatus("Pairing…");
      link = MqttLink.connect(BROKER_URL, SIGNAL_TOPIC_PREFIX + pin, {
        onReady: function () {
          setStatus("Waiting for the laptop to answer…");
          var sendOffer = function () { if (!answered && link) link.send(JSON.parse(offerMsg)); };
          sendOffer();
          republishTimer = setInterval(sendOffer, 2500); // don't miss a late join
          pairTimeout = setTimeout(function () {
            if (!answered) { stopPairing(); setStatus("No answer from the laptop — check the code and try again."); }
          }, 120000);
        },
        onMessage: function (o) {
          var d;
          try { d = decodeMsg(JSON.stringify(o)); } catch (e) { return; }
          if (d.t !== "answer" || answered) return;
          answered = true;
          stopPairing();
          pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: d.sdp })).then(function () {
            setStatus("✓ Broadcasting — keep this page open. The laptop has your feed.");
          }).catch(function () {
            setStatus("Pairing failed — try again.");
          });
        },
        onError: pairingUnavailable,
        onClose: function () {
          if (!answered) { stopPairing(); setStatus("Pairing connection lost — try again."); }
        }
      });
    });
  }).catch(function () {
    setStatus("Phone camera blocked — allow access and retry.");
  });
}

// Watch (laptop): show the code, wait for the phone, connect automatically.
function watchPinFlow() {
  if (typeof MqttLink === "undefined") { pairingUnavailable(); return; }
  var pin = makePin();
  el("cast-pin").textContent = pin;
  el("cast-pin-show").classList.remove("hidden");
  el("cast-pin-hint").textContent = "Waiting for the phone…";
  setStatus("On your phone: open this page, tap “📡 Phone: broadcast camera”, and enter the code.");
  var gotOffer = false, connected = false;
  link = MqttLink.connect(BROKER_URL, SIGNAL_TOPIC_PREFIX + pin, {
    onReady: function () {
      link.send({ t: "hello" }); // nudge a phone that's already waiting
    },
    onMessage: function (o) {
      if (o.t === "offer" && !gotOffer) { gotOffer = true; applyOfferPin(o); }
    },
    onError: pairingUnavailable,
    onClose: function () {
      if (!connected) { stopPairing(); setStatus("Pairing connection lost — try again."); }
    }
  });
  pairTimeout = setTimeout(function () {
    if (!gotOffer && !connected) {
      el("cast-pin-hint").textContent = "Still waiting… make sure the phone entered the same code.";
    }
  }, 30000);

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
    pc = new RTCPeerConnection(RTC_CFG);
    pc.ontrack = function (ev) {
      var stream = ev.streams && ev.streams[0];
      if (stream && window.SessionApp && window.SessionApp.onRemoteStream) {
        window.SessionApp.onRemoteStream(stream);
      }
      connected = true;
      stopPairing();
      el("cast-pin-show").classList.add("hidden");
      setStatus("✓ Phone camera connected — start the session below.");
    };
    pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: d.sdp }))
      .then(function () { return pc.createAnswer(); })
      .then(function (ans) { return pc.setLocalDescription(ans); })
      .then(function () { return waitIceComplete(pc); })
      .then(function () {
        var answerMsg = encodeMsg("answer", pc.localDescription.sdp);
        var sendAnswer = function () { if (!connected && link) link.send(JSON.parse(answerMsg)); };
        sendAnswer();
        republishTimer = setInterval(sendAnswer, 2500);
        pairTimeout = setTimeout(function () {
          if (!connected) { stopPairing(); setStatus("The phone didn't connect — try pairing again."); }
        }, 120000);
      })
      .catch(function () {
        gotOffer = false;
        setStatus("Connection failed — retry the handshake.");
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

function decodeMsg(text) {
  var o = JSON.parse(text);
  if (!o || (o.t !== "offer" && o.t !== "answer")) throw new Error("bad code");
  var sdp = o.s ? LZString.decompressFromBase64(o.s) : o.sdp; // o.sdp = legacy uncompressed
  if (!sdp) throw new Error("bad code");
  return { t: o.t, sdp: sdp };
}

function waitIceComplete(pc) {
  return new Promise(function (resolve) {
    if (pc.iceGatheringState === "complete") return resolve();
    var to = setTimeout(resolve, 6000); // never hang forever
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
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  }).then(function (stream) {
    localStream = stream;
    // Wake lock so the phone doesn't sleep mid-session.
    try {
      if (navigator.wakeLock) navigator.wakeLock.request("screen");
    } catch (e) {}
    setStatus("Creating broadcast offer…");
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
    pc = new RTCPeerConnection(RTC_CFG);
    pc.ontrack = function (ev) {
      var stream = ev.streams && ev.streams[0];
      if (stream && window.SessionApp && window.SessionApp.onRemoteStream) {
        window.SessionApp.onRemoteStream(stream);
      }
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
  wireManualToggle();
  el("btn-copy-code").addEventListener("click", function () {
    el("cast-text").select();
    try { document.execCommand("copy"); } catch (e) {}
  });
});

})();
