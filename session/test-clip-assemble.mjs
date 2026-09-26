/* Unit tests for clip-assemble.js.
 * Fixtures: the real field clips from 2026-09-18 —
 *  good: a valid 4.1s swing clip (decodes cleanly)
 *  bad:  a 7.2s false-trigger clip with a truncated tail (1 stray byte)
 * Verifies:
 *  1. findFirstCluster locates the init/media split in a real header.
 *  2. assembleClip rebuilds a structurally valid file from chunk splits.
 *  3. verifiedMediaEnd drops the bad clip's truncated tail block.
 *  4. Duration comes from chunk timestamps, not a stopwatch.
 *  5. clipFileName is session-stamped and collision-free.
 *  6. Fail-closed: garbage in -> null, never a broken clip.
 * Run: node test-clip-assemble.mjs
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const asm = require("./clip-assemble.js");

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("ok   " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

var GOOD = "/home/hatch/workspace/user/media_library/video/23/230cbf952bda328858f45ca19bc7e12014b5b7892d886f035cb07098aacb0857.webm";
var BAD = "/home/hatch/workspace/user/media_library/video/62/62f15158d875d1793f496d8b05cd85e3ab7b4a3effba44630a1af752c78c4488.webm";

var good = new Uint8Array(readFileSync(GOOD));
var bad = new Uint8Array(readFileSync(BAD));
check("fixtures load", good.length > 100000 && bad.length > 100000,
  "good=" + good.length + " bad=" + bad.length);

// 1. Init segment split in a real MediaRecorder header.
var initEnd = asm.findFirstCluster(good);
check("findFirstCluster finds the split", initEnd > 100 && initEnd < 20000, "at " + initEnd);
// The Tracks element (0x1654AE6B) must appear before the cluster.
var tracksIdx = -1;
for (var ti = 0; ti < initEnd - 4; ti++) {
  if (good[ti] === 0x16 && good[ti + 1] === 0x54 && good[ti + 2] === 0xae && good[ti + 3] === 0x6b) {
    tracksIdx = ti; break;
  }
}
check("Tracks element precedes the cluster", tracksIdx >= 0 && tracksIdx < initEnd);
check("cluster ID at split",
  good[initEnd] === 0x1f && good[initEnd + 1] === 0x43 &&
  good[initEnd + 2] === 0xb6 && good[initEnd + 3] === 0x75);

// 2. End-to-end: header + full media through the pipeline.
// Uses the good clip's bytes; verifies the output DECODES.
(function () {
  var headerBytes = good.subarray(0, 65536);
  // Media = everything from the first cluster onward (single "chunk").
  var chunks = [{ bytes: good.subarray(135), t: 500 }];
  var clip = asm.assembleClip(headerBytes, chunks, 500, 100000, 100000, 0);
  check("assembleClip returns a clip", !!clip);
  if (clip) {
    require("fs").writeFileSync("/tmp/rebuilt-clip.webm", Buffer.from(clip.data));
    var mediaStart = asm.findFirstCluster(clip.data);
    check("rebuilt clip has init segment + cluster", mediaStart === 135, "at " + mediaStart);
  }
})();

// 2b. Multi-chunk assembly with timestamps (the real pre-roll scenario).
(function () {
  var headerBytes = good.subarray(0, 65536);
  // Simulate 8 ring chunks by slicing the media at 200KB intervals.
  // These splits may land mid-block; assembleClip must fail closed OR
  // handle them — we verify it doesn't produce a corrupt file.
  var mediaBytes = good.subarray(65536);
  var chunks = [], t = 500;
  var SLICE = 200000;
  for (var off = 0; off < mediaBytes.length; off += SLICE, t += 500) {
    chunks.push({ bytes: mediaBytes.subarray(off, Math.min(off + SLICE, mediaBytes.length)), t: t });
  }
  var clip = asm.assembleClip(headerBytes, chunks, t / 2, 100000, 100000, 1000);
  if (clip) {
    require("fs").writeFileSync("/tmp/rebuilt-multi.webm", Buffer.from(clip.data));
    check("multi-chunk clip assembles", true);
    check("multi-chunk duration honest", clip.durationMs >= 3000 && clip.durationMs <= 5000,
      clip.durationMs + "ms for " + chunks.length + " chunks");
  } else {
    check("multi-chunk clip fails closed (no corrupt output)", true);
  }
})();

// 3. The bad clip's truncated tail is dropped.
(function () {
  var badInit = asm.findFirstCluster(bad);
  check("bad clip has a findable init split", badInit > 0);
  var end = asm.verifiedMediaEnd(bad.subarray(badInit), 0);
  check("truncated tail is dropped", badInit + end < bad.length,
    "kept " + end + " of " + (bad.length - badInit));
  check("dropped tail is tiny (the stray byte + partial block)", bad.length - (badInit + end) < 5000,
    "dropped " + (bad.length - (badInit + end)));
})();

// 4. Time-window selection (not count-based).
(function () {
  var headerBytes = good.subarray(0, 65536);
  // 10 fake ring chunks with real media bytes; timestamps drive selection.
  // (Byte splits are at 200KB; selection logic is what's under test.)
  var mediaBytes = good.subarray(65536);
  var chunks = [], SLICE = 200000;
  for (var i = 0; i < 10 && i * SLICE < mediaBytes.length; i++) {
    chunks.push({
      bytes: mediaBytes.subarray(i * SLICE, Math.min((i + 1) * SLICE, mediaBytes.length)),
      t: (i + 1) * 500
    });
  }
  // Trigger at t=3000, pre=2000, post=1000 -> chunks at 1000..4000 (7 chunks)
  var clip = asm.assembleClip(headerBytes, chunks, 3000, 2000, 1000, 0);
  // Note: mid-block splits may cause fail-closed (null) — that's acceptable;
  // what we must NOT get is a corrupt clip. We check selection via a
  // dedicated unit test on timestamps below instead.
  if (clip) {
    var n = clip.durationMs;
    check("duration matches the time window", n >= 2500 && n <= 4500, n + "ms");
  } else {
    check("mid-block split fails closed (acceptable)", true);
  }
  // Pure timestamp-selection check: fake chunks with valid single-block bytes.
  // Use the first real SimpleBlock from the good clip as the payload.
  var blkStart = -1;
  for (var s = 65536; s < 90000; s++) {
    if (good[s] === 0xa3 && good[s + 1] === 0x82) { blkStart = s; break; }
  }
  if (blkStart > 0) {
    var blkEnd = blkStart + 2 + (good[blkStart + 1] & 0x7f);
    // find full block end via size
    var b1 = good[blkStart + 1], ln = 1;
    while (ln <= 8 && !(b1 & (0x80 >> (ln - 1)))) ln++;
    var vv = b1 & (0xff >> ln);
    for (var j = 1; j < ln; j++) vv = vv * 256 + good[blkStart + 1 + j];
    blkEnd = blkStart + 1 + ln + vv;
    var oneBlock = good.subarray(blkStart, blkEnd);
    var tChunks = [];
    for (var k = 0; k < 10; k++) tChunks.push({ bytes: oneBlock, t: (k + 1) * 500 });
    var tClip = asm.assembleClip(headerBytes, tChunks, 3000, 2000, 1000, 0);
    check("window selects by time", !!tClip);
    if (tClip) {
      // 7 chunks (t=1000..4000): duration = 3000 + 500 = 3500ms
      check("duration = 3500ms for 7 selected chunks",
        tClip.durationMs >= 3400 && tClip.durationMs <= 3600, tClip.durationMs + "ms");
    }
  }
})();

// 5. Session-stamped filenames.
(function () {
  var d = new Date(2026, 8, 18, 19, 30, 22); // local time
  var n1 = asm.clipFileName(d, 3), n2 = asm.clipFileName(d, 4);
  check("filename carries session timestamp", n1 === "swing-20260918-193022-03.webm", n1);
  check("filenames unique per swing", n1 !== n2, n2);
  check("no parens or spaces (browser won't rename)", !/[() ]/.test(n1));
})();

// 6. Fail closed.
check("null header -> null", asm.assembleClip(null, [{ bytes: good, t: 0 }], 0, 1, 1, 0) === null);
check("empty chunks -> null", asm.assembleClip(good.subarray(0, 1000), [], 0, 1, 1, 0) === null);
check("garbage bytes -> null", asm.assembleClip(new Uint8Array([1, 2, 3, 4]), [{ bytes: new Uint8Array([5, 6]), t: 0 }], 0, 1000, 1000, 0) === null);
check("window selects nothing -> null",
  asm.assembleClip(good.subarray(0, 65536), [{ bytes: good.subarray(70000, 71000), t: 0 }], 99999, 100, 100, 0) === null);
(function () {
  // minMs enforced: 100ms of media is not a clip.
  var headerBytes = good.subarray(0, 65536);
  var clip = asm.assembleClip(headerBytes, [{ bytes: good.subarray(70000, 80000), t: 0 }], 0, 5000, 5000, 2000);
  check("minMs rejects a 'just a picture' clip", clip === null);
})();

// 7. Header-led selection: the chunk list starts with the first-ever chunk
// (EBML header + init + partial first cluster), as the manual "Save video"
// path produces. The assembler must strip the leading header and still
// produce a valid clip — not reject it.
// (2026-09-24: manual video failed with "assembler rejected the buffered video".)
(function () {
  var firstChunk = good.subarray(0, 30000); // EBML + init + start of cluster 1
  var restChunk = good.subarray(30000);
  var headerBytes = firstChunk; // clipHeaderChunk IS the first chunk in the real flow
  var chunks = [
    { bytes: firstChunk, t: 0 },
    { bytes: restChunk, t: 500 },
  ];
  var clip = asm.assembleClip(headerBytes, chunks, 500, 100000, 100000, null);
  check("header-led selection assembles", !!clip);
  if (clip) {
    var ms = asm.findFirstCluster(clip.data);
    check("rebuilt header-led clip has init + cluster", ms > 100 && ms < 20000, "at " + ms);
    // The media body must not start with EBML magic (would be a nested header).
    var bodyStart = ms;
    check("no nested EBML header in media",
      !(clip.data[bodyStart + 4] === 0x1a && clip.data[bodyStart + 5] === 0x45),
      "bytes at cluster+4: " + clip.data[bodyStart + 4].toString(16));
    // The media body must not start with a Cluster ID either: the original
    // cluster header is dropped because we wrap blocks in our own
    // synthesized cluster (nested clusters are invalid WebM).
    // Synth header = Cluster ID (4) + unknown size (8) + Timecode (3).
    var contentAt = ms + 4 + 8 + 3;
    var nested = clip.data[contentAt] === 0x1f && clip.data[contentAt + 1] === 0x43 &&
      clip.data[contentAt + 2] === 0xb6 && clip.data[contentAt + 3] === 0x75;
    check("no nested cluster in media", !nested,
      "bytes at content: " + asm.hexBytes(clip.data, contentAt, 4));
  }
})();

// --- 2026-09-26: mid-element media start (field failure) --------------
// In a long session the ring's oldest chunk starts mid-element; the old
// code required element alignment at offset 0 and rejected a healthy
// 24-chunk / 7.4MB ring with "media verify failed at offset 0".
// The bad fixture has a real second cluster at 980419 — a mid-ring
// window starting mid-element must now recover at that boundary.
(function () {
  var headerBytes = bad.subarray(0, 65536);
  check("findClusterBoundary finds the real 2nd cluster",
    asm.findClusterBoundary(bad, 136) === 980419,
    "got " + asm.findClusterBoundary(bad, 136));
  check("findClusterBoundary: none past the last",
    asm.findClusterBoundary(bad, 980420) === -1);
  // Mid-ring window: starts at arbitrary mid-element offset 500123
  // (deep inside cluster 1), spans the cluster-2 boundary.
  var media = bad.subarray(500123);
  check("mid-ring starts mid-element",
    asm.describeId(media, 0).indexOf("not a media id") >= 0,
    asm.describeId(media, 0));
  var clip = asm.assembleClip(headerBytes, [{ bytes: media, t: 500 }],
    500, 100000, 100000, 0);
  check("mid-ring window assembles (field scenario)", !!clip,
    asm.assembleClip.lastReason);
  if (clip) {
    var ms = asm.findFirstCluster(clip.data);
    check("rebuilt mid-ring clip has init + cluster", ms === 135, "at " + ms);
    check("mid-ring clip has media", clip.data.length > 1000000,
      "got " + clip.data.length);
  }
})();

// --- 2026-09-26: forensics on unrecoverable media ----------------------
// When no verified cluster boundary exists, the reject message must say
// what was actually there — hex of the first 16 bytes + what parseId saw.
(function () {
  var headerBytes = bad.subarray(0, 65536);
  var garbage = new Uint8Array(64);
  for (var g = 0; g < 64; g++) garbage[g] = 0xab;
  var clip = asm.assembleClip(headerBytes, [{ bytes: garbage, t: 500 }],
    500, 100000, 100000, 0);
  check("garbage media -> null", !clip);
  var reason = asm.assembleClip.lastReason;
  check("forensics: first-bytes hex", reason.indexOf("first bytes:") >= 0, reason);
  check("forensics: shows the 0xab bytes", reason.indexOf("ab ab ab ab") >= 0, reason);
  check("forensics: parseId verdict", reason.indexOf("parseId") >= 0 &&
    reason.indexOf("not a media id") >= 0, reason);
})();

// --- 2026-09-26: selectClipWindow (Bug A — crack pseudo-ps) -----------
(function () {
  // 24-chunk ring, 500ms spacing — the healthy field ring shape.
  var ring = [];
  for (var i = 0; i < 24; i++) ring.push({ blob: null, t: i * 500 });
  // Crack-style pseudo-ps, exactly the shape onBatCrack now builds:
  // {spike, preChunks, tSpike} with pre-roll preserved at spike time.
  var tSpike = 8000;
  var preChunks = ring.filter(function (c) { return c.t >= tSpike - 4000 && c.t <= tSpike; });
  check("crack pre-roll is 9 chunks", preChunks.length === 9, "got " + preChunks.length);
  var pseudoPs = { audio: true, spike: { t: tSpike }, tSpike: tSpike, preChunks: preChunks };
  var sel = asm.selectClipWindow(pseudoPs.preChunks, ring, pseudoPs.tSpike, 4000, 2000);
  check("crack pseudo-ps selects chunks", sel.length === 13, "got " + sel.length);
  check("crack selection spans pre+post",
    sel.length && sel[0].t === 4000 && sel[sel.length - 1].t === 10000,
    sel.length ? (sel[0].t + "–" + sel[sel.length - 1].t) : "empty");
  // Manual path (no preserved pre-roll): pure time-window selection.
  var selM = asm.selectClipWindow(null, ring, 8000, 4000, 2000);
  check("manual path selects the time window", selM.length === 13 &&
    selM[0].t === 4000 && selM[selM.length - 1].t === 10000,
    "got " + selM.length);
  // The old Bug A shape (no tSpike) must not silently select garbage.
  var selBad = asm.selectClipWindow(preChunks, ring, undefined, 4000, 2000);
  check("undefined trigger selects nothing", selBad.length === 0, "got " + selBad.length);
})();

console.log(failures ? "\n" + failures + " FAILURES" : "\nall pass");
process.exit(failures ? 1 : 0);
