#!/usr/bin/env node
/**
 * bridge.mjs — GoPro HERO8 ↔ Stadium Slugger Cage Edition bridge.
 *
 * The phone's browser cannot reach the GoPro directly (the camera hosts its
 * own WiFi network and the phone can only join one WiFi at a time). This
 * server runs on the LAPTOP, which joins the GoPro's WiFi, and does two jobs:
 *
 *   1. Serves the Cage Edition session app itself, so the phone can load it
 *      from the laptop over the camera's WiFi (no internet needed after load).
 *   2. Exposes a tiny JSON API the app uses for GoPro start/stop/status.
 *
 * Requires Node 18+ (global fetch). No dependencies.
 *
 *   GOPRO_IP=10.5.5.9  node bridge.mjs        # defaults: camera 10.5.5.9, port 8090
 *   PORT=8090           node bridge.mjs
 *
 * API (all JSON):
 *   GET  /api/health         { ok, bridge:'gopro-bridge', version, goproIp }
 *   GET  /api/gopro/status   { ok, cameraReachable, bridgeRecording, raw? }
 *   POST /api/gopro/start    start recording  -> { ok, recording:true }
 *   POST /api/gopro/stop     stop recording   -> { ok, recording:false }
 *
 * Honesty notes:
 *  - `bridgeRecording` is tracked by THIS bridge (start/stop pressed through
 *    it). The camera's raw /gp/gpControl/status is passed through as `raw`
 *    for inspection, but its "am I recording" flag is not decoded — the
 *    camera screen stays ground truth.
 *  - One controller at a time: if the Quik app on the phone is also
 *    connected, don't fight it for the shutter.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);                    // stadium-slugger-cage/
const GOPRO_IP = process.env.GOPRO_IP || '10.5.5.9';
const PORT = parseInt(process.env.PORT || '8090', 10);
const VERSION = '20260919c';
const CAM_TIMEOUT_MS = 5000;

// Static roots exposed by the bridge. The session app lives at /session/,
// and it pulls ../calibration-wizard/calibration.js, so both trees are served.
const STATIC_ROOTS = {
  '/session/': join(REPO, 'session'),
  '/calibration-wizard/': join(REPO, 'calibration-wizard'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

let bridgeRecording = false; // set only by start/stop THROUGH this bridge

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

async function camGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CAM_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${GOPRO_IP}${path}`, { signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ack with empty body */ }
    return { ok: res.ok, http: res.status, json, text };
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? `camera timed out at ${GOPRO_IP}`
      : `cannot reach camera at ${GOPRO_IP} (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function noCache(res) {
  res.setHeader('cache-control', 'no-store');
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') {
    res.writeHead(302, { location: '/session/' });
    res.end();
    return;
  }
  let root = null;
  let rel = null;
  for (const [prefix, dir] of Object.entries(STATIC_ROOTS)) {
    if (urlPath.startsWith(prefix)) { root = dir; rel = urlPath.slice(prefix.length); break; }
  }
  if (!root) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const abs = normalize(join(root, rel));
  // Containment: never serve outside the mapped root.
  if (!abs.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store', // cage LAN: always fresh, never a stale build
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];
  noCache(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, bridge: 'gopro-bridge', version: VERSION, goproIp: GOPRO_IP });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/gopro/status') {
    try {
      const r = await camGet('/gp/gpControl/status');
      log('status -> camera', r.ok ? 'reachable' : `HTTP ${r.http}`);
      sendJson(res, 200, {
        ok: true,
        cameraReachable: r.ok,
        bridgeRecording,
        raw: r.json,
      });
    } catch (err) {
      log('status ->', err.message);
      sendJson(res, 200, { ok: true, cameraReachable: false, bridgeRecording, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && (urlPath === '/api/gopro/start' || urlPath === '/api/gopro/stop')) {
    const start = urlPath.endsWith('/start');
    try {
      const r = await camGet(`/gp/gpControl/command/shutter?p=${start ? 1 : 0}`);
      if (r.ok) {
        bridgeRecording = start;
        log(`shutter ${start ? 'START' : 'STOP'} -> ok`);
        sendJson(res, 200, { ok: true, recording: bridgeRecording });
      } else {
        log(`shutter -> HTTP ${r.http}`);
        sendJson(res, 502, { ok: false, error: `camera answered HTTP ${r.http}` });
      }
    } catch (err) {
      log(`shutter -> ${err.message}`);
      sendJson(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'unknown api route' });
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) handleApi(req, res).catch((e) => {
    log('api error:', e.message);
    sendJson(res, 500, { ok: false, error: 'bridge error: ' + e.message });
  });
  else serveStatic(req, res).catch((e) => {
    log('static error:', e.message);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('bridge error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
    }
  }
  console.log('');
  console.log(`GoPro bridge ${VERSION} — camera at ${GOPRO_IP}, API on :${PORT}`);
  console.log('Open ONE of these on the phone (phone must join the GoPro WiFi too):');
  for (const a of addrs) console.log(`  http://${a}:${PORT}/`);
  console.log('');
  console.log('Laptop must be on the GoPro WiFi network first.');
  console.log('One controller at a time — close Quik or leave its shutter alone.');
  console.log('');
});
