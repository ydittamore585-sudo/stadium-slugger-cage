#!/usr/bin/env node
/**
 * gopro.mjs — GoPro HERO8 Black WiFi controller for the batting cage.
 *
 * Talks to the camera's HTTP API at http://10.5.5.9 (override with GOPRO_IP).
 * The laptop must be joined to the camera's WiFi network first
 * (camera: swipe down → Preferences → Connections → Camera Info for name/password).
 * Requires Node 18+ (uses global fetch). No dependencies.
 *
 *   node gopro.mjs status   show camera state (raw JSON + best-effort decode)
 *   node gopro.mjs start    start recording  (no touching the tripod = no shake)
 *   node gopro.mjs stop     stop recording
 *   node gopro.mjs cage     EXPERIMENTAL: attempt 1080p + 120fps, then verify
 *   node gopro.mjs probe    dump raw /gp/gpControl/status JSON (for ID mapping)
 *
 * Confidence levels (honest):
 *   SOLID:        mode, shutter start/stop, status endpoint — universal HERO5+.
 *   BEST-EFFORT:  resolution/fps setting IDs — from HERO4/5-era community docs
 *                 (goprowifihack). HERO8 may use different enum values.
 *                 `cage` always reads back and tells you to confirm on screen.
 *   NOT ATTEMPTED: digital lens (Linear) + HyperSmooth — no verified HERO8
 *                 remote codes found. Set on the camera; run `probe` after and
 *                 send the output to Snoop to lock in the codes.
 */

const IP = process.env.GOPRO_IP || '10.5.5.9';
const BASE = `http://${IP}`;
const TIMEOUT_MS = 8000;

async function get(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* some endpoints ack with empty body */ }
    return { ok: res.ok, http: res.status, json, text };
  } catch (err) {
    const why = err.name === 'AbortError'
      ? `timed out reaching ${IP}`
      : `cannot reach ${IP} (${err.message})`;
    throw new Error(`${why} — is this laptop joined to the GoPro's WiFi network?`);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort decodes from HERO4/5-era community docs. NOT verified on HERO8.
// Raw values are always printed alongside; the camera screen is ground truth.
const RESOLUTION_DECODE = {
  1: '4K', 2: '4K SuperView', 4: '2.7K', 5: '2.7K SuperView',
  6: '2.7K 4:3', 7: '1440p', 8: '1080p SuperView', 9: '1080p',
};
const MODE_DECODE = { 0: 'video', 1: 'photo', 2: 'multishot' };

function decodeSettings(settings) {
  const lines = [];
  if (!settings || typeof settings !== 'object') return ['(no settings block in response)'];
  for (const [id, val] of Object.entries(settings)) {
    let note = `raw ${val}`;
    if (id === '2') note = `${val} → ${RESOLUTION_DECODE[val] ?? 'unknown'} (legacy decode, unverified on HERO8)`;
    if (id === '3') note = `${val} → frame rate (no trusted HERO8 decode — check camera screen)`;
    if (id === '4') note = `${val} → lens/FOV (no trusted HERO8 decode — check camera screen)`;
    lines.push(`  setting[${id}]: ${note}`);
  }
  return lines;
}

async function cmdStatus() {
  const r = await get('/gp/gpControl/status');
  if (!r.ok || !r.json) {
    console.error(`status failed (HTTP ${r.http}). Raw: ${r.text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const { status = {}, settings = {} } = r.json;
  console.log('--- decoded (best effort) ---');
  console.log(decodeSettings(settings).join('\n'));
  if (status && typeof status === 'object') {
    const keys = Object.keys(status);
    console.log(`status block: ${keys.length} keys (see raw dump below)`);
  }
  console.log('\n--- raw /gp/gpControl/status ---');
  console.log(JSON.stringify(r.json, null, 2));
}

async function cmdShutter(start) {
  const r = await get(`/gp/gpControl/command/shutter?p=${start ? 1 : 0}`);
  if (r.ok) {
    console.log(start ? 'Recording STARTED.' : 'Recording STOPPED.');
  } else {
    console.error(`shutter failed (HTTP ${r.http}). Raw: ${r.text.slice(0, 200)}`);
    process.exitCode = 1;
  }
}

async function cmdCage() {
  console.log('EXPERIMENTAL preset: 1080p + 120fps attempt.');
  console.log('Each step is read back. The camera screen is the final judge.\n');

  let r = await get('/gp/gpControl/command/mode?p=0');
  console.log(`1. mode → video: ${r.ok ? 'OK' : `FAILED (HTTP ${r.http})`}`);
  await sleep(1000);

  const before = (await get('/gp/gpControl/status')).json?.settings ?? {};

  r = await get('/gp/gpControl/setting/2/9');
  console.log(`2. resolution → 1080p (setting 2=9): ${r.ok ? 'sent' : `FAILED (HTTP ${r.http})`}`);
  await sleep(1000);

  r = await get('/gp/gpControl/setting/3/0');
  console.log(`3. frame rate → 120fps? (setting 3=0): ${r.ok ? 'sent' : `FAILED (HTTP ${r.http})`}`);
  await sleep(1000);

  const after = (await get('/gp/gpControl/status')).json?.settings ?? {};
  console.log(`\nread-back: setting[2] ${before['2'] ?? '?'} → ${after['2'] ?? '?'}, ` +
              `setting[3] ${before['3'] ?? '?'} → ${after['3'] ?? '?'}`);

  console.log('\nNOW CHECK THE CAMERA SCREEN — it must read 1080 | 120.');
  console.log('If it does not, set resolution/fps manually; these are legacy-guess codes.');
  console.log('Then set on the camera: Lens = Linear, HyperSmooth = Off.');
  console.log('(No verified remote codes for lens/stabilization on HERO8 yet.)');
}

async function cmdProbe() {
  const r = await get('/gp/gpControl/status');
  if (!r.ok || !r.json) {
    console.error(`probe failed (HTTP ${r.http}). Raw: ${r.text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(r.json));
  console.error('\n(hint: set the camera to a known state — e.g. Linear + HyperSmooth Off —');
  console.error(' then run probe again and send both outputs to Snoop to map the IDs.)');
}

async function main() {
  const [cmd] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'status': await cmdStatus(); break;
      case 'start': await cmdShutter(true); break;
      case 'stop': await cmdShutter(false); break;
      case 'cage': await cmdCage(); break;
      case 'probe': await cmdProbe(); break;
      default:
        console.log('usage: node gopro.mjs <status|start|stop|cage|probe>');
        console.log('  GOPRO_IP env overrides the default 10.5.5.9');
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
