// yolo-watch.js — YOLO ball/batter watcher for the Cage Edition session app.
//
// NOT YET WIRED INTO index.html. This is the scaffold for the watcher rework:
// it becomes the detector's eyes once a cage-trained model exists and the
// current build has been validated in the field.
//
// Scheduling (the BP-cadence design):
//   IDLE   — 3 fps. Cheap state reads: pitch incoming? batter set? ball teed?
//   ACTION — 12 fps burst while a pitch is in flight / swing window is open.
//            Motion interpolation fills between YOLO frames; the existing
//            24-frame motion path carries ball flight once acquired.
//   WebGPU execution provider first, WASM fallback.
//
// Model: YOLO11n fine-tuned on cage data, 640px, INT8 (see ../yolo/).
// Classes: 0=ball, 1=batter, 2=bat.
"use strict";

const YoloWatch = (() => {
  const SIZE = 640;
  const IDLE_FPS = 3;
  const ACTION_FPS = 12;
  const CONF_T = 0.35;
  const IOU_T = 0.45;

  const CLS = { BALL: 0, BATTER: 1, BAT: 2 };

  let session = null;      // ort.InferenceSession
  let mode = "IDLE";
  let lastRun = 0;
  let onDetect = null;     // callback(detections, timestamp)

  async function init(modelUrl, opts = {}) {
    // ort is expected from the onnxruntime-web CDN bundle loaded before this script
    if (typeof ort === "undefined") throw new Error("onnxruntime-web not loaded");
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["webgpu", "wasm"],
    });
    onDetect = opts.onDetect || null;
    return true;
  }

  function setMode(m) {
    if (m === "IDLE" || m === "ACTION") mode = m;
  }

  function due(now) {
    const interval = 1000 / (mode === "ACTION" ? ACTION_FPS : IDLE_FPS);
    return now - lastRun >= interval;
  }

  // canvas -> letterboxed 640x640 Float32Array CHW, normalized
  function preprocess(canvas) {
    const off = document.createElement("canvas");
    off.width = SIZE; off.height = SIZE;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    const scale = Math.min(SIZE / canvas.width, SIZE / canvas.height);
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(canvas, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
    const img = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const chw = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      chw[i] = img[i * 4] / 255;
      chw[SIZE * SIZE + i] = img[i * 4 + 1] / 255;
      chw[2 * SIZE * SIZE + i] = img[i * 4 + 2] / 255;
    }
    return { tensor: new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]), scale, dx: (SIZE - w) / 2, dy: (SIZE - h) / 2 };
  }

  function nms(boxes) {
    boxes.sort((a, b) => b.conf - a.conf);
    const keep = [];
    for (const b of boxes) {
      let ok = true;
      for (const k of keep) {
        const x1 = Math.max(b.x1, k.x1), y1 = Math.max(b.y1, k.y1);
        const x2 = Math.min(b.x2, k.x2), y2 = Math.min(b.y2, k.y2);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const u = (b.x2 - b.x1) * (b.y2 - b.y1) + (k.x2 - k.x1) * (k.y2 - k.y1) - inter;
        if (u > 0 && inter / u >= IOU_T) { ok = false; break; }
      }
      if (ok) keep.push(b);
    }
    return keep;
  }

  // Run once on a video frame canvas. Returns detections in source-pixel coords.
  // Callers should gate with due() for the idle/action schedule.
  async function detect(canvas) {
    if (!session) return [];
    const now = performance.now();
    const { tensor, scale, dx, dy } = preprocess(canvas);
    const out = await session.run({ images: tensor });
    const data = out.output0.data; // [1, 4+nc, 8400]
    const nc = out.output0.dims[1] - 4;
    const dets = [];
    for (let i = 0; i < 8400; i++) {
      let best = 0, cls = -1;
      for (let c = 0; c < nc; c++) {
        const v = data[(4 + c) * 8400 + i];
        if (v > best) { best = v; cls = c; }
      }
      if (best < CONF_T) continue;
      const cx = data[i], cy = data[8400 + i], w = data[2 * 8400 + i], h = data[3 * 8400 + i];
      // back to source-pixel coords through the letterbox
      dets.push({
        cls, conf: best,
        x1: (cx - w / 2 - dx) / scale, y1: (cy - h / 2 - dy) / scale,
        x2: (cx + w / 2 - dx) / scale, y2: (cy + h / 2 - dy) / scale,
      });
    }
    lastRun = now;
    const kept = nms(dets);
    if (onDetect) onDetect(kept, now);
    return kept;
  }

  // Convenience: highest-confidence ball, if any
  function ballOf(dets) {
    let b = null;
    for (const d of dets) if (d.cls === CLS.BALL && (!b || d.conf > b.conf)) b = d;
    return b;
  }

  return { init, detect, due, setMode, ballOf, CLS, get mode() { return mode; } };
})();

if (typeof module !== "undefined") module.exports = YoloWatch;
