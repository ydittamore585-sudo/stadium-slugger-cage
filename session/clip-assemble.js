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
 *  4. Start media at the first verifiable offset: the offset itself when
 *     it begins valid elements; otherwise the first VERIFIED cluster
 *     boundary ahead (Cluster ID + parseable size + Timecode child),
 *     dropping the partial leading bytes; otherwise the first run of
 *     2+ consecutive valid elements (single-cluster windows).
 *  5. Duration comes from chunk timestamps, not from a stopwatch around
 *     the post-roll wait.
 *  6. Fail closed: returns null when there isn't enough valid media —
 *     no "just a picture" clips.
 *  7. Timestamp rebase (2026-09-26): concatenated chunks hold multiple
 *     original clusters, each with its own Timecode. Every block
 *     timestamp is rewritten to one continuous timeline starting at 0
 *     and ALL original cluster headers/Timecodes are stripped — the
 *     file carries a single synthesized cluster. Without this, later
 *     clusters' timestamps jump ~100 s ahead and the player freezes on
 *     a still frame after ~3 s.
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
// a Timecode=0 element. Media block timestamps are rebased to a single
// continuous timeline starting at 0 (see rebaseMediaTimestamps), so the
// cluster Timecode MUST be 0 — copying the header chunk's original
// Timecode here would offset the whole timeline.
// (2026-09-26: the old code copied the header chunk's Timecode while
// later embedded clusters kept their own Timecode bases — a ~100 s
// discontinuity that played as 3 s of video then a still frame.)
function synthClusterHeader() {
  var out = new Uint8Array(4 + 8 + 3);
  out[0] = 0x1f; out[1] = 0x43; out[2] = 0xb6; out[3] = 0x75; // Cluster ID
  out[4] = 0x01; // unknown size
  for (var i = 5; i < 12; i++) out[i] = 0xff;
  out[12] = 0xe7; out[13] = 0x81; out[14] = 0x00; // Timecode = 0
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

// Scan forward from `from` for the first VERIFIED cluster boundary:
// Cluster ID + parseable size + Timecode child. This is the same
// verification discipline walkUnknownCluster uses for cluster
// continuation — a bare 4-byte ID pattern in video data is not enough.
// (2026-09-26: in a long session the ring's oldest chunk starts
// mid-element; verifiedMediaEnd requires element alignment at offset 0
// and found nothing parseable in a healthy 7.4 MB ring. Start media at
// the first verified cluster instead, dropping the leading partial
// bytes.)
// Returns the offset, or -1 when no verified cluster exists.
function findClusterBoundary(u8, from) {
  for (var cur = from; cur + 12 <= u8.length; cur++) {
    if (u8[cur] === 0x1f && u8[cur + 1] === 0x43 &&
        u8[cur + 2] === 0xb6 && u8[cur + 3] === 0x75) {
      var cSz = parseSize(u8, cur + 4);
      if (!cSz) continue;
      var tOff = cur + 4 + cSz.len;
      var tId = parseId(u8, tOff);
      if (tId && tId.val === TIMECODE_ID) return cur;
    }
  }
  return -1;
}

// Read the Timecode value (ms) of the verified cluster at cb. cb must be
// a verified cluster boundary (ID + parseable size + Timecode child, as
// findClusterBoundary returns). Returns the Timecode, or null when the
// child isn't a well-formed Timecode element.
function readClusterTimecode(u8, cb) {
  var cSz = parseSize(u8, cb + 4);
  if (!cSz) return null;
  var off = cb + 4 + cSz.len;
  var tId = parseId(u8, off);
  if (!tId || tId.val !== TIMECODE_ID) return null;
  var tSz = parseSize(u8, off + tId.len);
  if (!tSz || tSz.unknown || tSz.val > 8) return null;
  var tEnd = off + tId.len + tSz.len + tSz.val;
  if (tEnd > u8.length) return null;
  var tc = 0;
  for (var j = 0; j < tSz.val; j++) tc = tc * 256 + u8[off + tId.len + tSz.len + j];
  return tc;
}

// Advance past a verified cluster's header (ID + size) and its Timecode
// child, so the media body is raw blocks. cb must come from
// findClusterBoundary. The caller wraps the blocks in its own
// synthesized cluster header (timecode supplied separately).
function skipClusterHeader(u8, cb) {
  var cSz = parseSize(u8, cb + 4);
  var off = cb + 4 + (cSz ? cSz.len : 0);
  var tId = parseId(u8, off);
  if (tId && tId.val === TIMECODE_ID) {
    var tSz = parseSize(u8, off + tId.len);
    if (tSz && !tSz.unknown) off += tId.len + tSz.len + tSz.val;
  }
  return off;
}

function readInt16BE(u8, off) {
  var v = (u8[off] << 8) | u8[off + 1];
  return (v & 0x8000) ? v - 0x10000 : v;
}

function writeInt16BE(u8, off, v) {
  u8[off] = (v >> 8) & 0xff;
  u8[off + 1] = v & 0xff;
}

// Rebase every block timestamp in [mOff, mediaEnd) onto ONE continuous
// timeline and return ONLY the media block bytes — every original Cluster
// ID/size/Timecode byte is stripped. The caller wraps the result in a
// single synthesized cluster (Timecode 0).
//
// Why (2026-09-26, real field bug — "plays 3 s then a still frame"):
// concatenated ring chunks contain MULTIPLE original MediaRecorder
// clusters, each with its own Timecode. Wrapping them under one header
// while later clusters kept their original Timecode bases produced a
// ~100 s timestamp discontinuity: the player rendered the first blocks
// then held a still frame waiting for timestamps that never arrived.
//
// Walk: the region is element-aligned (verifiedMediaEnd), so parseId at
// each step sees true elements — no byte-pattern false positives. The
// leading raw blocks (before the first embedded cluster) belong to the
// cluster that was open when the selection started:
//   - leadTimecode != null: mOff was a verified boundary whose Timecode
//     was read before its header was dropped — exact base.
//   - else: estimated from the cluster cadence, U_0 - (U_1 - U_0); with
//     fewer than 2 clusters there is only one time base, so no collision
//     is possible and the original relative timestamps are kept.
// Each block's absolute time = clusterTimecode + relTs; the emitted
// timestamp is abs - minAbs, so the timeline starts at 0 with no
// negatives. A monotonic clamp keeps timestamps non-decreasing even if
// the cadence estimate is slightly off.
// Returns a Uint8Array, or null (fail closed) when there are no blocks
// or a rebased timestamp would overflow the int16 block-timestamp field.
function rebaseMediaTimestamps(u8, mOff, mediaEnd, leadTimecode) {
  rebaseMediaTimestamps.lastReason = "";
  // Pass 1: original cluster Timecodes, in walk order.
  var clusters = [];
  var cur = mOff, guard = 0;
  while (cur < mediaEnd && guard++ < 200000) {
    var id = parseId(u8, cur);
    if (!id) break;
    if (id.val === CLUSTER_ID) {
      var tc = readClusterTimecode(u8, cur);
      if (tc == null) break;
      clusters.push({ off: cur, timecode: tc });
      var after = skipClusterHeader(u8, cur);
      if (after <= cur) break; // no progress: stop, don't spin
      cur = after;
    } else {
      var sz = parseSize(u8, cur + id.len);
      if (!sz || sz.unknown) break;
      var eEnd = cur + id.len + sz.len + sz.val;
      if (eEnd <= cur || eEnd > mediaEnd) break;
      cur = eEnd;
    }
  }
  // Time base for the leading raw blocks (see above).
  var seg0Base;
  if (leadTimecode != null) seg0Base = leadTimecode;
  else if (clusters.length >= 2 && clusters[1].timecode > clusters[0].timecode)
    seg0Base = clusters[0].timecode - (clusters[1].timecode - clusters[0].timecode);
  else seg0Base = clusters.length ? clusters[0].timecode : 0;

  // Pass 2: collect blocks with their absolute times. Cluster headers and
  // Timecode children are dropped; Void padding passes through untouched.
  var blocks = []; // {off, len, tsOff (-1 = no timestamp), abs}
  cur = mOff; guard = 0;
  var curTc = seg0Base, totalBytes = 0;
  while (cur < mediaEnd && guard++ < 200000) {
    var bId = parseId(u8, cur);
    if (!bId) break;
    if (bId.val === CLUSTER_ID) {
      var ctc = readClusterTimecode(u8, cur);
      if (ctc == null) break;
      curTc = ctc;
      cur = skipClusterHeader(u8, cur);
      continue;
    }
    var bSz = parseSize(u8, cur + bId.len);
    if (!bSz || bSz.unknown) break;
    var bEnd = cur + bId.len + bSz.len + bSz.val;
    if (bEnd <= cur || bEnd > mediaEnd) break;
    if (bId.val === 0xa3 || bId.val === 0xa1) {
      // SimpleBlock / Block: timestamp is int16 BE right after the
      // 1-byte track number.
      var pay = cur + bId.len + bSz.len;
      if (bSz.val >= 4) {
        blocks.push({ off: cur, len: bEnd - cur, tsOff: pay + 1,
          abs: curTc + readInt16BE(u8, pay + 1) });
        totalBytes += bEnd - cur;
      }
    } else if (bId.val === 0xa0) {
      // BlockGroup: patch the child Block's timestamp.
      var gEnd = bEnd, gc = cur + bId.len + bSz.len, gGuard = 0;
      var tsOff = -1, rel = 0;
      while (gc < gEnd && gGuard++ < 20) {
        var cId = parseId(u8, gc);
        var cSz = cId && parseSize(u8, gc + cId.len);
        if (!cId || !cSz || cSz.unknown) break;
        var cEnd = gc + cId.len + cSz.len + cSz.val;
        if (cEnd > gEnd) break;
        if (cId.val === 0xa1 && cSz.val >= 4) {
          tsOff = gc + cId.len + cSz.len + 1;
          rel = readInt16BE(u8, tsOff);
          break;
        }
        gc = cEnd;
      }
      if (tsOff >= 0) {
        blocks.push({ off: cur, len: bEnd - cur, tsOff: tsOff,
          abs: curTc + rel });
        totalBytes += bEnd - cur;
      }
      // A BlockGroup without a patchable Block can't be rebased: drop it.
    } else if (bId.val === 0xec) {
      blocks.push({ off: cur, len: bEnd - cur, tsOff: -1, abs: 0 });
      totalBytes += bEnd - cur;
    }
    // Anything else at top level (a stray Timecode, unknown ids):
    // dropped — it can't be placed on the timeline.
    cur = bEnd;
  }
  var timed = blocks.filter(function (b) { return b.tsOff >= 0; });
  if (!timed.length) {
    rebaseMediaTimestamps.lastReason = "no timestamped blocks in [" +
      mOff + "," + mediaEnd + ")";
    return null;
  }
  var minAbs = timed[0].abs;
  for (var i = 1; i < timed.length; i++) if (timed[i].abs < minAbs) minAbs = timed[i].abs;
  var out = new Uint8Array(totalBytes);
  var p = 0, prev = -1;
  for (var k = 0; k < blocks.length; k++) {
    var b = blocks[k], ts = -1;
    if (b.tsOff >= 0) {
      ts = b.abs - minAbs;
      if (ts < prev) ts = prev; // monotonic clamp (estimate safety)
      if (ts > 32000) {
        rebaseMediaTimestamps.lastReason = "rebased timestamp " + ts +
          "ms exceeds the int16 block-timestamp range";
        return null;
      }
      prev = ts;
    }
    out.set(u8.subarray(b.off, b.off + b.len), p);
    if (b.tsOff >= 0) writeInt16BE(out, p + (b.tsOff - b.off), ts);
    p += b.len;
  }
  return out;
}
rebaseMediaTimestamps.lastReason = "";

// Fallback when no cluster boundary exists ahead (e.g. a window inside a
// single-cluster recording): the first offset beginning 2+ consecutive
// valid media elements. Two consecutive valid elements is strong
// structural verification — a single byte-pattern match in video data
// is not enough. Cluster IDs are excluded (tier 1's job).
// Returns the offset, or -1.
function findElementRun(u8, from) {
  for (var cur = from; cur < u8.length; cur++) {
    var id = parseId(u8, cur);
    if (!id || !isMediaId(id.val) || id.val === CLUSTER_ID) continue;
    var sz = parseSize(u8, cur + id.len);
    if (!sz || sz.unknown) continue;
    var eEnd = cur + id.len + sz.len + sz.val;
    if (eEnd <= cur + id.len + sz.len || eEnd > u8.length) continue;
    var id2 = parseId(u8, eEnd);
    if (!id2 || !isMediaId(id2.val) || id2.val === CLUSTER_ID) continue;
    var sz2 = parseSize(u8, eEnd + id2.len);
    if (!sz2 || sz2.unknown) continue;
    var eEnd2 = eEnd + id2.len + sz2.len + sz2.val;
    if (eEnd2 > u8.length) continue;
    return cur;
  }
  return -1;
}

// First n bytes at off as lowercase hex, space-separated — for reject
// forensics, so the next field run says what was actually there instead
// of us guessing.
function hexBytes(u8, off, n) {
  var parts = [];
  for (var i = 0; i < n && off + i < u8.length; i++) {
    var h = u8[off + i].toString(16);
    parts.push(h.length < 2 ? "0" + h : h);
  }
  return parts.join(" ");
}

// What parseId sees at off, in words — distinguishes "truncated input"
// from "misaligned video data" from "unknown element id".
function describeId(u8, off) {
  var id = parseId(u8, off);
  if (!id) return "parseId=null (fewer than 4 bytes or no length marker)";
  return "parseId len=" + id.len + " val=0x" + id.val.toString(16) +
    (isMediaId(id.val) ? " (known media id)" : " (not a media id)");
}

/* Pure chunk-selection for swing clips (extracted from captureSwingClip
 * so it can be unit-tested — 2026-09-26: a crack trigger built a
 * pseudo-pending-spike with no tSpike, and the inline selection silently
 * produced zero chunks from a healthy ring).
 * preservedPre: ring chunks preserved at spike time (or null/empty).
 * ring: the live clip ring, entries {bytes, t}.
 * Returns the selected entries in order. Never throws.
 */
function selectClipWindow(preservedPre, ring, tTrigger, preMs, postMs) {
  var sel = [];
  if (typeof tTrigger !== "number" || !isFinite(tTrigger)) return sel;
  var t1 = tTrigger + postMs;
  var i;
  if (preservedPre && preservedPre.length) {
    for (i = 0; i < preservedPre.length; i++) sel.push(preservedPre[i]);
    for (i = 0; i < ring.length; i++) {
      var pc = ring[i];
      if (pc.t > tTrigger && pc.t <= t1) sel.push(pc);
    }
  } else {
    var t0 = tTrigger - preMs;
    for (i = 0; i < ring.length; i++) {
      var c = ring[i];
      if (c.t >= t0 && c.t <= t1) sel.push(c);
    }
  }
  return sel;
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
  assembleClip.lastReason = "";
  function reject(why) { assembleClip.lastReason = why; return null; }
  if (!headerBytes || !headerBytes.length || !chunks || !chunks.length)
    return reject("empty input (header " + (headerBytes && headerBytes.length) +
      "b, " + (chunks && chunks.length) + " chunks)");
  var initEnd = findFirstCluster(headerBytes);
  if (initEnd < 0) return reject("no cluster in header chunk");
  var initSeg = headerBytes.subarray(0, initEnd);
  var clusterHeader = synthClusterHeader();

  var t0 = tTrigger - preMs, t1 = tTrigger + postMs;
  var sel = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    if (c.t >= t0 && c.t <= t1 && c.bytes && c.bytes.length) sel.push(c);
  }
  if (!sel.length) return reject("no chunks in window [" + Math.round(t0) + "," +
    Math.round(t1) + "] of " + chunks.length + " (t " +
    Math.round(chunks[0].t) + "–" + Math.round(chunks[chunks.length-1].t) + ")");

  // Concatenate selected media (raw blocks, possibly starting mid-cluster).
  var total = 0, k;
  for (k = 0; k < sel.length; k++) total += sel[k].bytes.length;
  var media = new Uint8Array(total);
  var p = 0;
  for (k = 0; k < sel.length; k++) { media.set(sel[k].bytes, p); p += sel[k].bytes.length; }

  // If the selection includes the first-ever chunk, it starts with the EBML
  // header + init segment — skip to its first Cluster. (The init segment is
  // already prepended above; leaving the header in the media body produces
  // a structurally invalid file.)
  // (2026-09-24: manual "Save video" dumps the whole ring including chunk 0,
  // which the assembler rejected because the media began with EBML magic.)
  var mOff = 0;
  if (media.length >= 4 && media[0] === 0x1a && media[1] === 0x45 &&
      media[2] === 0xdf && media[3] === 0xa3) {
    var fc = findFirstCluster(media);
    if (fc > 0) mOff = fc;
  }
  // If the media starts with a verified cluster boundary (aligned chunk,
  // or the header chunk's own cluster after the EBML split), read its
  // Timecode BEFORE dropping the header + Timecode child — the leading
  // blocks belong to this cluster and their timestamps are relative to
  // it. We wrap the raw blocks in our own synthesized cluster header,
  // and nested clusters are invalid WebM.
  // (2026-09-26: the old code dropped this header without reading the
  // Timecode, then wrapped the blocks under Timecode 0 while later
  // embedded clusters kept their original Timecode bases — a ~100 s
  // discontinuity that played as 3 s of video then a still frame.)
  var leadTimecode = null;
  if (findClusterBoundary(media, mOff) === mOff) {
    leadTimecode = readClusterTimecode(media, mOff);
    mOff = skipClusterHeader(media, mOff);
  }
  // Start media at the first verifiable offset.
  // Timeslice chunks don't align to EBML elements: a mid-ring selection
  // usually starts mid-element, where parseId sees garbage and a walk
  // from offset 0 finds nothing parseable. (2026-09-26: the old code
  // required element alignment at offset 0 and rejected a healthy
  // 24-chunk / 7.4MB ring with "media verify failed at offset 0".)
  //   1. mOff itself, when it begins valid elements (aligned chunk —
  //      the pre-fix behavior, kept so valid media never regresses);
  //   2. otherwise the first VERIFIED cluster boundary ahead (Cluster ID
  //      + parseable size + Timecode child), dropping the partial
  //      leading bytes;
  //   3. otherwise the first 2+ consecutive valid elements (windows
  //      inside a single-cluster recording have no boundary to find).
  var mediaEnd = verifiedMediaEnd(media, mOff);
  if (mediaEnd <= mOff) {
    var cb = findClusterBoundary(media, mOff);
    if (cb >= 0) {
      // Skip the cluster header + its Timecode child — we wrap the raw
      // blocks in our own synthesized cluster header (avoids nested
      // clusters). The bytes before cb are dropped, so the media now
      // starts AT this cluster: its Timecode is the exact base for the
      // leading blocks' relative timestamps.
      leadTimecode = readClusterTimecode(media, cb);
      mOff = skipClusterHeader(media, cb);
    } else {
      var er = findElementRun(media, mOff);
      if (er < 0) return reject("no verified media start in " + media.length +
        "b of media (" + sel.length + " chunks selected); first bytes: " +
        hexBytes(media, mOff, 16) + "; " + describeId(media, mOff));
      mOff = er;
    }
    mediaEnd = verifiedMediaEnd(media, mOff);
  }
  if (mediaEnd <= mOff) return reject("media verify failed at offset " + mOff +
    " of " + media.length + "b (" + sel.length + " chunks selected); first bytes: " +
    hexBytes(media, mOff, 16) + "; " + describeId(media, mOff));

  // Rebase every block timestamp onto one continuous timeline starting
  // at 0 and strip ALL original cluster headers/Timecodes. Without this,
  // each original cluster's blocks keep timestamps relative to their own
  // Timecode while sharing one synthesized header — a timestamp
  // discontinuity the player renders as a still frame.
  var rebased = rebaseMediaTimestamps(media, mOff, mediaEnd, leadTimecode);
  if (!rebased) return reject("timestamp rebase failed: " +
    rebaseMediaTimestamps.lastReason);

  var out = new Uint8Array(initSeg.length + clusterHeader.length + rebased.length);
  out.set(initSeg, 0);
  out.set(clusterHeader, initSeg.length);
  out.set(rebased, initSeg.length + clusterHeader.length);

  // Honest duration: from first selected chunk's timestamp to last,
  // plus one average chunk interval (chunks cover [t, t+interval)).
  var firstT = sel[0].t, lastT = sel[sel.length - 1].t;
  var avgInterval = sel.length > 1 ? (lastT - firstT) / (sel.length - 1) : 500;
  var durationMs = (lastT - firstT) + avgInterval;
  if (minMs != null && durationMs < minMs)
    return reject("duration " + Math.round(durationMs) + "ms < min " + minMs + "ms");

  return { data: out, durationMs: Math.round(durationMs), mediaStartMs: firstT };
}
assembleClip.lastReason = "";

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
    findClusterBoundary: findClusterBoundary,
    skipClusterHeader: skipClusterHeader,
    findElementRun: findElementRun,
    selectClipWindow: selectClipWindow,
    rebaseMediaTimestamps: rebaseMediaTimestamps,
    readClusterTimecode: readClusterTimecode,
    hexBytes: hexBytes,
    describeId: describeId,
    synthClusterHeader: synthClusterHeader
  };
}
