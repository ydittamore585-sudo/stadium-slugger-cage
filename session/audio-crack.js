/* ------------------------------------------------------------------ */
/* Bat-crack audio detector.                                            */
/*                                                                      */
/* Listens on the microphone for the sharp broadband transient of       */
/* bat-on-ball. In a quiet cage the crack is orders of magnitude above  */
/* ambient, so a band-energy jump detector is reliable — and it does    */
/* not care how far the camera is from the batter.                      */
/*                                                                      */
/* Detection: per poll, sum the 1.5–8 kHz band of the FFT, compare      */
/* against a slow ambient baseline plus a calibrated absolute floor,    */
/* and require the energy to be high-frequency dominant (rejects net    */
/* thuds) with a time-domain peak gate (rejects digital noise).         */
/*                                                                      */
/* The crack IS the validation signal: on trigger the callback fires   */
/* straight into logSwing — no motion spike needed.                     */
/*                                                                      */
/* IMPORTANT: the mic stream is opened with echoCancellation,           */
/* noiseSuppression and autoGainControl all OFF. Browser "enhancements" */
/* squash fast transients — exactly what we are listening for.          */
/* ------------------------------------------------------------------ */
function createCrackDetector(onCrack) {
  var FFT_SIZE = 2048;
  var BAND_LO_HZ = 1500;
  var BAND_HI_HZ = 8000;
  var RATIO = 6;             // band energy must exceed baseline x RATIO
  var MIN_RATIO_HF = 0.30;   // band/total energy — crack is HF-dominant
  var MIN_PEAK = 0.08;       // time-domain peak (0..1) — rejects noise floor
  var COOLDOWN_MS = 2500;     // one crack = one swing; net thud lands inside
  var POLL_MS = 30;

  var ctx = null, analyser = null, stream = null, src = null;
  var freqBytes = null, timeBytes = null;
  var timer = null;
  var running = false;
  var base = 0;              // slow EMA of band energy (ambient)
  var floorAbs = 1200;       // calibrated absolute floor (see calibrate)
  var cooldownUntil = 0;
  var freezeBaseUntil = 0;   // don't let the crack pollute the baseline
  var triggers = 0;
  var lastLevel = 0;         // 0..1 for the meter
  var lastBandE = 0;
  var maxBandE = 0;          // peak-hold of band energy while running
  var maxTotE = 0;           // peak-hold of TOTAL energy — distinguishes a
                             // band-math bug (totE>0, bandE=0) from true silence
  var lastErr = null;        // last exception inside poll(), if any
  var pollCount = 0;         // proves poll() is actually executing
  var statusCb = null;
  var binHz = 0, binLo = 0, binHi = 0;

  function setStatus(s) { if (statusCb) { try { statusCb(s); } catch (e) {} } }

  function calibrate(done) {
    // 1 s of ambient: measure the cage's own noise floor, then set the
    // absolute trigger floor well above it.
    var samples = [];
    var n = 0;
    var calTimer = setInterval(function () {
      if (!running) { clearInterval(calTimer); return; }
      analyser.getByteFrequencyData(freqBytes);
      var e = bandEnergy();
      samples.push(e);
      if (++n >= 30) {
        clearInterval(calTimer);
        var mean = 0;
        for (var i = 0; i < samples.length; i++) mean += samples[i];
        mean /= samples.length || 1;
        base = mean;
        floorAbs = Math.max(mean * 6, 1200);
        setStatus("on");
        if (done) done();
      }
    }, POLL_MS);
    setStatus("calibrating");
  }

  function bandEnergy() {
    var e = 0;
    for (var i = binLo; i <= binHi && i < freqBytes.length; i++) e += freqBytes[i];
    return e;
  }

  function totalEnergy() {
    var e = 0;
    for (var i = 0; i < freqBytes.length; i++) e += freqBytes[i];
    return e;
  }

  function timePeak() {
    analyser.getByteTimeDomainData(timeBytes);
    var peak = 0;
    for (var i = 0; i < timeBytes.length; i++) {
      var v = Math.abs(timeBytes[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  function poll() {
    if (!running) return;
    var now = Date.now();
    pollCount++;
    try {
    if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    analyser.getByteFrequencyData(freqBytes);
    var bandE = bandEnergy();
    var totE = totalEnergy();
    var peak = timePeak();
    lastBandE = bandE;
    if (bandE > maxBandE) maxBandE = bandE;
    if (totE > maxTotE) maxTotE = totE;
    // Meter: band energy relative to the trigger floor.
    lastLevel = Math.max(0, Math.min(1, bandE / (floorAbs * 1.5)));

    if (now < freezeBaseUntil) {
      // let the room settle after a trigger before re-learning ambient
    } else {
      base = base + (bandE - base) * 0.03; // ~1 s time constant
    }

    var hfRatio = totE > 0 ? bandE / totE : 0;
    if (now >= cooldownUntil &&
        bandE > floorAbs &&
        bandE > base * RATIO &&
        hfRatio > MIN_RATIO_HF &&
        peak > MIN_PEAK) {
      cooldownUntil = now + COOLDOWN_MS;
      freezeBaseUntil = now + 600;
      triggers++;
      try { onCrack({ t: now, bandE: bandE, peak: peak }); } catch (e) {}
    }
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }

  function start(cb, deviceId) {
    // cb(status) — "calibrating" | "on" | "denied" | "mic-gone" | "error" | "off"
    // deviceId: optional exact mic to use (from the mic picker); without it
    // the browser uses the OS default input.
    statusCb = cb || null;
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("error");
      return;
    }
    // NOTE: the AudioContext MUST be created synchronously here, inside the
    // click gesture. Creating it inside the getUserMedia promise (async)
    // leaves it "suspended" under the autoplay policy and the analyser
    // hears silence forever.
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { setStatus("error"); return; }
    try {
      ctx = new AC();
      if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    } catch (e) { setStatus("error"); return; }
    var audioConstr = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false
    };
    if (deviceId) audioConstr.deviceId = { exact: deviceId };
    navigator.mediaDevices.getUserMedia({ audio: audioConstr }).then(function (s) {
      stream = s;
      try {
        src = ctx.createMediaStreamSource(stream);
      } catch (e) {
        try { ctx.close(); } catch (e2) {}
        ctx = null;
        setStatus("error");
        return;
      }
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0; // raw transients, no smearing
      src.connect(analyser);
      binHz = ctx.sampleRate / FFT_SIZE;
      binLo = Math.max(1, Math.floor(BAND_LO_HZ / binHz));
      binHi = Math.min(analyser.frequencyBinCount - 1, Math.ceil(BAND_HI_HZ / binHz));
      freqBytes = new Uint8Array(analyser.frequencyBinCount);
      timeBytes = new Uint8Array(analyser.fftSize);
      running = true;
      maxBandE = 0;
      maxTotE = 0;
      lastErr = null;
      pollCount = 0;
      timer = setInterval(poll, POLL_MS);
      calibrate();
    }, function (err) {
      try { if (ctx) ctx.close(); } catch (e) {}
      ctx = null;
      // Chosen mic vanished (unplugged)? Tell the page so it can forget the
      // saved id and fall back to the default input.
      if (deviceId && err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        setStatus("mic-gone");
      } else {
        setStatus("denied");
      }
    });
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    try { if (src) src.disconnect(); } catch (e) {}
    try { if (analyser) analyser.disconnect(); } catch (e) {}
    try { if (ctx) ctx.close(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    ctx = analyser = stream = src = null;
    setStatus("off");
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    triggerCount: function () { return triggers; },
    level: function () { return lastLevel; },
    // for the meter's threshold marker: floor relative to meter scale
    floorLevel: function () { return Math.max(0, Math.min(1, floorAbs / (floorAbs * 1.5))); },
    // Mic-hearing telemetry for the export diagnostics: what the mic has
    // actually heard (peak band energy) vs the trigger floor and baseline.
    telemetry: function () {
      var trackInfo = null;
      try {
        var tr = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
        if (tr) trackInfo = tr.readyState + (tr.muted ? "/muted" : "/unmuted") + (tr.enabled ? "" : "/disabled");
      } catch (e) {}
      return {
        floor: Math.round(floorAbs), base: Math.round(base),
        maxBandE: Math.round(maxBandE), maxTotE: Math.round(maxTotE),
        lastBandE: Math.round(lastBandE), lastErr: lastErr,
        sampleRate: (function () { try { return ctx ? ctx.sampleRate : 0; } catch (e) { return -1; } })(),
        bins: binLo + "-" + binHi,
        ctxState: (function () { try { return ctx ? ctx.state : "none"; } catch (e) { return "?"; } })(),
        polls: pollCount, track: trackInfo
      };
    }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createCrackDetector: createCrackDetector };
}
