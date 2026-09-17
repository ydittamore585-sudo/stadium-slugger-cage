/**
 * Stadium Slugger — Cage Edition: phone → laptop cast.
 *
 * Pure static-page WebRTC. No signaling server: the offer/answer are
 * exchanged as QR codes (camera scan) with copy/paste text fallback.
 * Non-trickle ICE, host candidates only (same-WiFi LAN), so each side
 * is a single QR scan.
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

var RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function showPanel(which) {
  mode = which;
  el("cast-panel").classList.remove("hidden");
  el("cast-qr").innerHTML = "";
  el("cast-textwrap").classList.add("hidden");
  el("cast-actions").innerHTML = "";
  if (which === "broadcast") broadcastFlow();
  else watchFlow();
}

function closePanel() {
  stopScanning();
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  el("cast-panel").classList.add("hidden");
  mode = null;
}

/* ---------------- SDP helpers ---------------- */

// Keep host candidates only: same-LAN, much smaller SDP for QR.
function shrinkSdp(sdp) {
  return sdp.split(/\r\n|\n/).filter(function (line) {
    if (line.indexOf("a=candidate:") === 0) return / typ host /.test(line);
    return true;
  }).join("\r\n");
}

function encodeMsg(type, sdp) {
  return JSON.stringify({ t: type, sdp: shrinkSdp(sdp) });
}

function decodeMsg(text) {
  var o = JSON.parse(text);
  if (!o || !o.sdp || (o.t !== "offer" && o.t !== "answer")) throw new Error("bad code");
  return o;
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
  try {
    /* global QRCode */
    new QRCode(qrEl, { text: text, width: 264, height: 264, correctLevel: QRCode.CorrectLevel.M });
    return true;
  } catch (e) {
    return false; // too big for QR -> text fallback
  }
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

function broadcastFlow() {
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

function watchFlow() {
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
  el("btn-copy-code").addEventListener("click", function () {
    el("cast-text").select();
    try { document.execCommand("copy"); } catch (e) {}
  });
});

})();
