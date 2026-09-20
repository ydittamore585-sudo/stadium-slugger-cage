/* WebM duration repair.
 *
 * Clips are sliced out of a continuous MediaRecorder ring (for pre-roll),
 * and those slices carry no Duration element — players show no length and
 * can't seek. This splices a Duration element (ID 0x4489) into the
 * Segment's Info element. No dependencies.
 *
 * fixWebmDuration(blob, durationMs) -> Promise<Blob>.
 * Fail-safe: on any parse problem it resolves with the ORIGINAL blob.
 */

function fixWebmDuration(blob, durationMs) {
  return blob.arrayBuffer().then(function (ab) {
    try {
      var fixed = patchWebmDuration(new Uint8Array(ab), durationMs);
      if (!fixed) return blob;
      return new Blob([fixed], { type: blob.type || "video/webm" });
    } catch (e) {
      return blob;
    }
  });
}

// --- EBML plumbing -------------------------------------------------

function ebmlReadId(u8, off) {
  var len = 1;
  while (len <= 4 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  if (len > 4 || off + len > u8.length) return null;
  var val = 0;
  for (var i = 0; i < len; i++) val = val * 256 + u8[off + i];
  return { len: len, val: val };
}

function ebmlReadSize(u8, off) {
  var len = 1;
  while (len <= 8 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > u8.length) return null;
  var val = u8[off] & (0xff >> len);
  for (var j = 1; j < len; j++) val = val * 256 + u8[off + j];
  return { len: len, val: val };
}

// A size VINT with all value-bits set means "unknown size" (streaming).
function ebmlIsUnknownSize(u8, off) {
  var len = 1;
  while (len <= 8 && !(u8[off] & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > u8.length) return false;
  if ((u8[off] & (0xff >> len)) !== (0xff >> len)) return false;
  for (var i = 1; i < len; i++) if (u8[off + i] !== 0xff) return false;
  return true;
}

// --- the patch -----------------------------------------------------

var EBML_ID = 0x1a45dfa3, SEGMENT_ID = 0x18538067;
var INFO_ID = 0x1549a966, DURATION_ID = 0x4489, CLUSTER_ID = 0x1f43b675;

function patchWebmDuration(u8, durationMs) {
  if (!(durationMs > 0) || !isFinite(durationMs)) return null;
  var off = 0;
  var id = ebmlReadId(u8, off);
  if (!id || id.val !== EBML_ID) return null;
  var sz = ebmlReadSize(u8, off + id.len);
  if (!sz) return null;
  off = off + id.len + sz.len + sz.val; // -> Segment
  id = ebmlReadId(u8, off);
  if (!id || id.val !== SEGMENT_ID) return null;
  var segSizeOff = off + id.len;
  if (!ebmlIsUnknownSize(u8, segSizeOff)) return null; // can't safely insert
  var segSz = ebmlReadSize(u8, segSizeOff);
  var cur = segSizeOff + segSz.len;
  while (cur < u8.length) {
    var cId = ebmlReadId(u8, cur);
    var cSz = cId && ebmlReadSize(u8, cur + cId.len);
    if (!cId || !cSz) return null;
    if (cId.val === INFO_ID) {
      return patchInfo(u8, cur, cId.len, cSz.val, cur + cId.len + cSz.len, durationMs);
    }
    if (cId.val === CLUSTER_ID) return null; // no Info before media: bail
    if (ebmlIsUnknownSize(u8, cur + cId.len)) return null;
    cur = cur + cId.len + cSz.len + cSz.val;
  }
  return null;
}

function patchInfo(u8, infoOff, idLen, sizeVal, dataOff, durationMs) {
  var end = dataOff + sizeVal;
  var cur = dataOff;
  while (cur < end) {
    var cId = ebmlReadId(u8, cur);
    var cSz = cId && ebmlReadSize(u8, cur + cId.len);
    if (!cId || !cSz) return null;
    if (cId.val === DURATION_ID) {
      // Overwrite in place — same width, offsets untouched.
      var pos = cur + cId.len + cSz.len;
      if (cSz.val === 8) {
        var dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, durationMs);
        u8.set(new Uint8Array(dv.buffer), pos);
        return u8;
      }
      if (cSz.val === 4) {
        var dv4 = new DataView(new ArrayBuffer(4));
        dv4.setFloat32(0, durationMs);
        u8.set(new Uint8Array(dv4.buffer), pos);
        return u8;
      }
      return null;
    }
    cur = cur + cId.len + cSz.len + cSz.val;
  }
  // No Duration element: append one. 11 bytes =
  // ID (0x44 0x89) + size (0x88 = 8) + float64.
  var newSize = sizeVal + 11;
  if (newSize >= 127) return null; // keep a 1-byte size VINT; Info is tiny
  var out = new Uint8Array(u8.length + 11);
  out.set(u8.subarray(0, infoOff), 0);
  for (var i = 0; i < idLen; i++) out[infoOff + i] = u8[infoOff + i]; // ID as-is
  out[infoOff + idLen] = 0x80 | newSize;
  var wOff = infoOff + idLen + 1;
  out.set(u8.subarray(dataOff, dataOff + sizeVal), wOff);
  var dOff = wOff + sizeVal;
  out[dOff] = 0x44; out[dOff + 1] = 0x89; out[dOff + 2] = 0x88;
  var dw = new DataView(new ArrayBuffer(8));
  dw.setFloat64(0, durationMs);
  out.set(new Uint8Array(dw.buffer), dOff + 3);
  out.set(u8.subarray(dataOff + sizeVal), dOff + 11);
  return out;
}

// Node test hook: `node test-webm-duration.mjs` exercises patchWebmDuration
// against a real Chrome MediaRecorder init segment fixture.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { patchWebmDuration: patchWebmDuration, fixWebmDuration: fixWebmDuration };
}
