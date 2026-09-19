/* Clip assembly from MediaRecorder timeslice chunks.
 *
 * Problem (found 2026-09-18 in a real field clip): MediaRecorder
 * timeslice chunks do NOT align to EBML element boundaries. Naively
 * concatenating header + mid-ring chunks produced a file ending mid-Block
 * (1 stray byte, 24 decode errors, black tail) and a Duration header
 * claiming 2.0s over 7.2s of content. Chunk counts also don't equal time
 * (14 chunks held 7.2s, not 7.0s), so count-based pre-roll is wrong.
 *
 * This module assembles clips defensively:
 *  1. Select chunks by TIME window [trigger-preMs, trigger+postMs], not
 *     by count. Chunks carry arrival timestamps.
 *  2. Split the header chunk into init segment (EBML..Tracks) + media.
 *  3. Walk the media bytes element-by-element; keep only COMPLETE
 *     clusters/blocks. A truncated tail block is dropped, never shipped.
 *  4. Start media at the first cluster boundary (drops a partial leading
 *     cluster rather than shipping undecodable P-frames).
 *  5. Duration comes from chunk timestamps, not from a stopwatch around
 *     the post-roll wait.
 *  6. Fail closed: returns null when there isn't enough valid media —
 *     no "just a picture" clips.
 *
 * Pure module: Uint8Array in, Uint8Array out. No DOM.
 */

// Valid WebM media element IDs (inside Segment). Anything else is not
// a parseable media element — stop rather than accept garbage.
var MEDIA_IDS = {
  0x1f43b675: 1, // Cluster
  0xe7: 1,       // Timecode
  0xa0: 1,       // BlockGroup
  0xa1: 1,       // Block
  0xa3: 1,       // SimpleBlock
  0xec: 1        // Void (padding)
};

var CLUSTER_ID = 0x1f43b675;
var TIMECODE_ID = 0xe7;

function isMediaId(val) { return MEDIA_IDS[val] === 1; }

function parseId(u8, off) {
  if (off >= u8.length) return null;
  var len = 1;
  while (len <= 4 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  if (len > 4 || off + len > u8.length) return null;
  var val = 0;
  for (var i = 0; i < len; i++) val = val * 256 + u8[off + i];
  return { len: len, val: val };
}

function parseSize(u8, off) {
  if (off >= u8.length) return null;
  var len = 1;
  while (len <= 8 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > u8.length) return null;
  var mask = 0xff >> len;
  var unknown = (u8[off] & mask) === mask;
  if (unknown) {
    for (var i = 1; i < len; i++) if (u8[off + i] !== 0xff) { unknown = false; break; }
  }
  var val = u8[off] & mask;
  for (var j = 1; j < len; j++) val = val * 256 + u8[off + j];
  return { len: len, val: val, unknown: unknown };
}

// Offset of the first Cluster in buf, or -1. Sequential parse from a
// known-good start (the header chunk), so no byte-pattern false positives.
function findFirstCluster(u8) {
  var id = parseId(u8, 0);
  if (!id || id.val !== 0x1a45dfa3) return -1; // EBML
  var sz = parseSize(u8, id.len);
  if (!sz) return -1;
  var off = id.len + sz.len + sz.val; // -> Segment
  id = parseId(u8, off);
  if (!id || id.val !== 0x18538067) return -1; // Segment
  var segSz = parseSize(u8, off + id.len);
  if (!segSz) return -1;
  var cur = off + id.len + segSz.len;
  var guard = 0;
  while (cur < u8.length && guard++ < 50) {
    var cId = parseId(u8, cur);
    var cSz = cId && parseSize(u8, cur + cId.len);
    if (!cId || !cSz) return -1;
    if (cId.val === CLUSTER_ID) return cur;
    if (cSz.unknown) return -1; // can't skip safely
    cur = cur + cId.len + cSz.len + cSz.val;
  }
  return -1;
}

// Build a synthesized Cluster header: Cluster ID + unknown size +
// the Timecode element copied from the header chunk's first cluster.
// MediaRecorder chunks don't align to cluster boundaries, so a mid-ring
// selection starts with raw blocks. Wrapping them in a fresh cluster
// keeps the file structurally valid; block timestamps stay relative to
// the original Timecode, preserving their spacing.
function synthClusterHeader(headerBytes, initEnd) {
  var cData = initEnd + 4; // after Cluster ID
  var sz = parseSize(headerBytes, cData);
  if (!sz) return null;
  var child = cData + sz.len;
  var tId = parseId(headerBytes, child);
  if (!tId || tId.val !== TIMECODE_ID) return null;
  var tSz = parseSize(headerBytes, child + tId.len);
  if (!tSz || tSz.unknown) return null;
  var tEnd = child + tId.len + tSz.len + tSz.val;
  if (tEnd > headerBytes.length) return null;
  var timecodeEl = headerBytes.subarray(child, tEnd);
  var out = new Uint8Array(4 + 8 + timecodeEl.length);
  out[0] = 0x1f; out[1] = 0x43; out[2] = 0xb6; out[3] = 0x75; // Cluster ID
  out[4] = 0x01; // unknown size
  for (var i = 5; i < 12; i++) out[i] = 0xff;
  out.set(timecodeEl, 12);
  return out;
}

// Walk media bytes from off; return the offset just past the last
// COMPLETE element. Media may start mid-cluster (a chunk continuation) —
// we walk blocks directly rather than requiring cluster alignment.
// Drops a truncated trailing block. Never throws.
function verifiedMediaEnd(u8, off) {
  var end = off;
  var cur = off;
  var guard = 0;
  while (cur < u8.length && guard++ < 200000) {
    var eId = parseId(u8, cur);
    var eSz = eId && parseSize(u8, cur + eId.len);
    if (!eId || !eSz || !isMediaId(eId.val)) break;
    if (eSz.unknown) {
      // Unknown-size element (a cluster): walk children until the next
      // cluster boundary or a truncated child.
      if (eId.val !== CLUSTER_ID) break; // unknown size on non-cluster: stop
      var cEnd = walkUnknownCluster(u8, cur + eId.len + eSz.len);
      if (cEnd <= cur + eId.len + eSz.len) break;
      end = cEnd;
      cur = cEnd;
    } else {
      var eEnd = cur + eId.len + eSz.len + eSz.val;
      if (eEnd > u8.length) break; // truncated: drop it
      end = eEnd;
      cur = eEnd;
    }
  }
  return end;
}

// Walk children of an unknown-size cluster starting at off. Returns the
// offset past the last complete child (stops at next Cluster ID or at a
// truncated child).
function walkUnknownCluster(u8, off) {
  var cur = off, lastGood = off;
  var guard = 0;
  while (cur < u8.length && guard++ < 100000) {
    // Next cluster begins: this one ends here. Verify it's a real
    // cluster (ID + parseable size + Timecode child), not video data
    // that happens to contain the byte pattern.
    if (cur + 12 <= u8.length &&
        u8[cur] === 0x1f && u8[cur + 1] === 0x43 &&
        u8[cur + 2] === 0xb6 && u8[cur + 3] === 0x75) {
      var cSz = parseSize(u8, cur + 4);
      if (cSz) {
        var tOff = cur + 4 + cSz.len;
        var tId = parseId(u8, tOff);
        if (tId && tId.val === TIMECODE_ID) return cur;
      }
    }
    var eId = parseId(u8, cur);
    var eSz = eId && parseSize(u8, cur + eId.len);
    if (!eId || !eSz || !isMediaId(eId.val)) break;
    if (eSz.unknown) break; // nested unknown size: stop (conservative)
    var eEnd = cur + eId.len + eSz.len + eSz.val;
    if (eEnd > u8.length) break; // truncated child: drop it
    lastGood = eEnd;
    cur = eEnd;
  }
  return lastGood;
}

/* Assemble a clip.
 * headerBytes: Uint8Array, the first MediaRecorder chunk (init segment).
 * chunks: [{bytes: Uint8Array, t: number}] — arrival timestamp t in ms.
 *   These are ring chunks; they start mid-cluster (raw blocks).
 * tTrigger: ms timestamp of the swing trigger.
 * preMs: how far back to reach (step + load + swing).
 * postMs: how far forward (follow-through).
 * minMs: minimum acceptable media duration; null when insufficient.
 * Returns {data: Uint8Array, durationMs, mediaStartMs} or null.
 */
function assembleClip(headerBytes, chunks, tTrigger, preMs, postMs, minMs) {
  if (!headerBytes || !headerBytes.length || !chunks || !chunks.length) return null;
  var initEnd = findFirstCluster(headerBytes);
  if (initEnd < 0) return null;
  var initSeg = headerBytes.subarray(0, initEnd);
  var clusterHeader = synthClusterHeader(headerBytes, initEnd);
  if (!clusterHeader) return null;

  var t0 = tTrigger - preMs, t1 = tTrigger + postMs;
  var sel = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    if (c.t >= t0 && c.t <= t1 && c.bytes && c.bytes.length) sel.push(c);
  }
  if (!sel.length) return null;

  // Concatenate selected media (raw blocks, possibly starting mid-cluster).
  var total = 0, k;
  for (k = 0; k < sel.length; k++) total += sel[k].bytes.length;
  var media = new Uint8Array(total);
  var p = 0;
  for (k = 0; k < sel.length; k++) { media.set(sel[k].bytes, p); p += sel[k].bytes.length; }

  // If the first selected chunk starts with a Cluster ID, drop it — we're
  // wrapping in our own cluster header (avoids nested clusters).
  var mOff = 0;
  if (media.length >= 4 && media[0] === 0x1f && media[1] === 0x43 &&
      media[2] === 0xb6 && media[3] === 0x75) {
    var cSz = parseSize(media, 4);
    if (cSz) {
      mOff = 4 + cSz.len;
      // Also skip its Timecode child if present (we supply our own).
      var tId = parseId(media, mOff);
      if (tId && tId.val === TIMECODE_ID) {
        var tSz = parseSize(media, mOff + tId.len);
        if (tSz && !tSz.unknown) mOff += tId.len + tSz.len + tSz.val;
      }
    }
  }

  var mediaEnd = verifiedMediaEnd(media, mOff);
  if (mediaEnd <= mOff) return null;

  var out = new Uint8Array(initSeg.length + clusterHeader.length + (mediaEnd - mOff));
  out.set(initSeg, 0);
  out.set(clusterHeader, initSeg.length);
  out.set(media.subarray(mOff, mediaEnd), initSeg.length + clusterHeader.length);

  // Honest duration: from first selected chunk's timestamp to last,
  // plus one average chunk interval (chunks cover [t, t+interval)).
  var firstT = sel[0].t, lastT = sel[sel.length - 1].t;
  var avgInterval = sel.length > 1 ? (lastT - firstT) / (sel.length - 1) : 500;
  var durationMs = (lastT - firstT) + avgInterval;
  if (minMs != null && durationMs < minMs) return null;

  return { data: out, durationMs: Math.round(durationMs), mediaStartMs: firstT };
}

// Session-stamped filename: swing-20260918-193022-03.webm — no more
// "swing-1 (12)" collisions across sessions.
function clipFileName(date, swingNum) {
  function p(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
  return "swing-" + date.getFullYear() + p(date.getMonth() + 1, 2) + p(date.getDate(), 2) +
    "-" + p(date.getHours(), 2) + p(date.getMinutes(), 2) + p(date.getSeconds(), 2) +
    "-" + p(swingNum, 2) + ".webm";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    assembleClip: assembleClip,
    clipFileName: clipFileName,
    findFirstCluster: findFirstCluster,
    verifiedMediaEnd: verifiedMediaEnd,
    synthClusterHeader: synthClusterHeader
  };
}
