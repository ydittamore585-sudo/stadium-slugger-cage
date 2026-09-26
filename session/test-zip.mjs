// Structural round-trip test for the dependency-free ZIP writer in
// clip-assemble.js (stored entries only). Builds a zip from known buffers,
// then re-parses it from scratch: local headers, central directory offsets,
// EOCD, CRC32 per entry, and exact data round-trip.
import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
const ca = require("./clip-assemble.js");

var failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("FAIL: " + msg); }
  else console.log("ok: " + msg);
}
function u16(u8, o) { return u8[o] | (u8[o + 1] << 8); }
function u32(u8, o) {
  return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
}
function ascii(u8, o, n) {
  var s = "";
  for (var i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]);
  return s;
}

function main() {
  check(typeof ca.zipCreate === "function", "zipCreate exported");
  check(typeof ca.zipBuild === "function", "zipBuild exported");
  check(typeof ca.crc32Bytes === "function", "crc32Bytes exported");

  // Known-answer CRC32 ("123456789" -> 0xCBF43926).
  var known = new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57]);
  check(ca.crc32Bytes(known) === 0xCBF43926, "crc32 known-answer 0xCBF43926");

  // Test entries: tiny text, empty file, >64KB binary (multi-byte lengths),
  // and a real WebM init segment from fixtures.
  var big = new Uint8Array(70000);
  for (var i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xFF;
  var webmInit = new Uint8Array(readFileSync("./test-fixtures/webm-init-segment.bin"));
  var entries = [
    { name: "swing-20260926-105721-01.webm", data: new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3]) },
    { name: "empty.webm", data: new Uint8Array(0) },
    { name: "big-70k.bin", data: big },
    { name: "webm-init-segment.bin", data: webmInit }
  ];

  var zip = ca.zipCreate(entries);
  check(zip instanceof Uint8Array, "zipCreate returns Uint8Array");
  check(zip.length > 70000, "zip length covers payloads (" + zip.length + " bytes)");

  // Walk local file headers.
  var off = 0, seen = [];
  for (var e = 0; e < entries.length; e++) {
    check(u32(zip, off) === 0x04034B50, "entry " + e + " local header signature at " + off);
    check(u16(zip, off + 8) === 0, "entry " + e + " method = stored");
    var crc = u32(zip, off + 14), compLen = u32(zip, off + 18), uncompLen = u32(zip, off + 22);
    var nameLen = u16(zip, off + 26), extraLen = u16(zip, off + 28);
    check(extraLen === 0, "entry " + e + " no extra field");
    var nm = ascii(zip, off + 30, nameLen);
    check(nm === entries[e].name, "entry " + e + " name round-trips (" + nm + ")");
    check(compLen === entries[e].data.length && uncompLen === entries[e].data.length,
      "entry " + e + " sizes = " + entries[e].data.length);
    var dataOff = off + 30 + nameLen;
    var slice = zip.slice(dataOff, dataOff + compLen);
    check(slice.length === entries[e].data.length &&
      slice.every(function (b, bi) { return b === entries[e].data[bi]; }),
      "entry " + e + " data byte-identical");
    check(ca.crc32Bytes(slice) === crc, "entry " + e + " CRC32 matches header");
    seen.push({ name: nm, localOff: off, crc: crc, len: compLen });
    off = dataOff + compLen;
  }

  // Central directory.
  var cdOff = off;
  for (var c = 0; c < entries.length; c++) {
    check(u32(zip, off) === 0x02014B50, "central entry " + c + " signature at " + off);
    check(u16(zip, off + 10) === 0, "central entry " + c + " method = stored");
    check(u32(zip, off + 16) === seen[c].crc, "central entry " + c + " CRC32 matches local");
    check(u32(zip, off + 20) === seen[c].len, "central entry " + c + " size matches local");
    check(u32(zip, off + 42) === seen[c].localOff,
      "central entry " + c + " local-header offset = " + seen[c].localOff);
    var cnLen = u16(zip, off + 28);
    check(ascii(zip, off + 46, cnLen) === seen[c].name, "central entry " + c + " name matches");
    check(u16(zip, off + 30) === 0 && u16(zip, off + 32) === 0,
      "central entry " + c + " no extra/comment");
    off += 46 + cnLen;
  }
  var cdSize = off - cdOff;

  // End of central directory.
  check(u32(zip, off) === 0x06054B50, "EOCD signature at " + off);
  check(u16(zip, off + 8) === entries.length, "EOCD entry count = " + entries.length);
  check(u16(zip, off + 10) === entries.length, "EOCD total entry count matches");
  check(u32(zip, off + 12) === cdSize, "EOCD central directory size = " + cdSize);
  check(u32(zip, off + 16) === cdOff, "EOCD central directory offset = " + cdOff);
  check(u16(zip, off + 20) === 0, "EOCD no comment");
  check(off + 22 === zip.length, "EOCD ends exactly at end of zip");

  // zipBuild parts path: same bytes, no big concat needed by the caller.
  var b = ca.zipBuild(entries);
  var total = 0, pi;
  for (pi = 0; pi < b.parts.length; pi++) total += b.parts[pi].length;
  check(total === b.byteLength && total === zip.length, "zipBuild parts sum = byteLength = zipCreate length");
  var cat = new Uint8Array(total), p = 0;
  for (pi = 0; pi < b.parts.length; pi++) { cat.set(b.parts[pi], p); p += b.parts[pi].length; }
  check(cat.every(function (by, bi) { return by === zip[bi]; }), "zipBuild parts concatenate to zipCreate output");

  // Empty entry list: valid empty zip.
  var ez = ca.zipCreate([]);
  check(u32(ez, 0) === 0x06054B50 && ez.length === 22, "empty entry list -> 22-byte empty zip");

  if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
  console.log("test-zip: all passed");
}
main();
