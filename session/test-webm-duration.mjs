// Regression test for the WebM duration repair.
// Fixture: a real Chrome MediaRecorder init segment captured headless
// (canvas stream, 500 ms timeslices) — the same shape the session's clip
// ring produces. Verifies:
//   1. patchWebmDuration inserts a Duration element into Info.
//   2. The Duration value reads back correctly (ms, float64).
//   3. The rest of the structure survives (Tracks still parses after Info).
//   4. A second patch overwrites in place (idempotent, same length).
//   5. Garbage input fails safe (null -> caller keeps the original blob).
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { patchWebmDuration } = require("./webm-duration.js");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  NOT OK - " + name); }
}

const raw = readFileSync("/tmp/mr_result.txt", "utf8");
const payload = JSON.parse(raw.replace(/^RESULT:/, ""));
const init = new Uint8Array(Buffer.from(payload.initB64, "base64"));
ok(init.length > 100, "fixture init segment loaded (" + init.length + " bytes)");

// --- tiny EBML reader for assertions --------------------------------
function readId(u8, off) {
  let len = 1;
  while (len <= 4 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  let val = 0;
  for (let i = 0; i < len; i++) val = val * 256 + u8[off + i];
  return { len, val };
}
function readSize(u8, off) {
  let len = 1;
  while (len <= 8 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  let val = u8[off] & (0xff >> len);
  for (let i = 1; i < len; i++) val = val * 256 + u8[off + i];
  return { len, val };
}
function findChild(u8, start, end, wantId) {
  // start = offset of first child element (inside a container)
  let cur = start;
  while (cur < end) {
    const id = readId(u8, cur), sz = readSize(u8, cur + id.len);
    if (id.val === wantId) return { off: cur, idLen: id.len, sizeLen: sz.len, size: sz.val, data: cur + id.len + sz.len };
    // don't descend into unknown-size elements here; Info/Tracks are known-size
    cur = cur + id.len + sz.len + sz.val;
  }
  return null;
}
function segmentData(u8) {
  const id = readId(u8, 0), sz = readSize(u8, id.len);
  const segOff = id.len + sz.len + sz.val;
  const segId = readId(u8, segOff), segSz = readSize(u8, segOff + segId.len);
  return segOff + segId.len + segSz.len; // unknown size -> runs to EOF
}

// 1+2: patch and read back the Duration value.
const D = 5012;
const patched = patchWebmDuration(new Uint8Array(init), D);
ok(patched && patched.length === init.length + 11, "patch inserts 11 bytes (got +" + (patched ? patched.length - init.length : "?") + ")");
{
  const segData = segmentData(patched);
  const info = findChild(patched, segData, patched.length, 0x1549a966);
  ok(!!info, "Info element still found after patch");
  const dur = findChild(patched, info.data, info.data + info.size, 0x4489);
  ok(!!dur && dur.size === 8, "Duration element present, 8-byte float");
  const dv = new DataView(patched.buffer, patched.byteOffset + dur.data, 8);
  ok(Math.abs(dv.getFloat64(0) - D) < 1e-9, "Duration reads back as " + D + " ms");
}
// 3: structure after Info is intact — Tracks parses at its shifted offset.
{
  const segData = segmentData(patched);
  const tracks = findChild(patched, segData, patched.length, 0x1654ae6b);
  ok(!!tracks, "Tracks element found after patched Info");
  const entry = findChild(patched, tracks.data, tracks.data + tracks.size, 0xae);
  ok(!!entry, "TrackEntry parses inside Tracks");
}
// 4: idempotent — second patch overwrites in place, length unchanged.
{
  const again = patchWebmDuration(new Uint8Array(patched), 4999);
  const segData = segmentData(again);
  const info = findChild(again, segData, again.length, 0x1549a966);
  const dur = findChild(again, info.data, info.data + info.size, 0x4489);
  const dv = new DataView(again.buffer, again.byteOffset + dur.data, 8);
  ok(again.length === patched.length && Math.abs(dv.getFloat64(0) - 4999) < 1e-9,
     "re-patch overwrites in place (same length, new value)");
}
// 5: fail-safe on garbage.
ok(patchWebmDuration(new Uint8Array([1, 2, 3, 4]), 5000) === null, "garbage input -> null (caller keeps original)");
ok(patchWebmDuration(new Uint8Array(init), NaN) === null, "NaN duration -> null");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
