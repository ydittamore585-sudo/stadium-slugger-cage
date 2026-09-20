/**
 * Minimal MQTT 3.1.1 client over WebSocket — just enough to relay tiny
 * signaling messages between two browsers. QoS 0 only, single topic.
 *
 * No dependencies. Works in browsers and in Node (global WebSocket).
 * Used for WebRTC pairing codes: the broker only ever sees the SDP
 * handshake (LAN IPs at most); the camera media itself stays peer-to-peer
 * on the local network, encrypted with DTLS-SRTP.
 */
(function () {
"use strict";

var WS_SUBPROTOCOL = "mqtt";

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function utf8String(bytes) {
  return new TextDecoder().decode(bytes);
}

function encodeRemainingLength(len) {
  var out = [];
  do {
    var b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return out;
}

function concatBytes(parts) {
  var total = 0, i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total), off = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
  return out;
}

function prefixed(str) {
  var b = utf8Bytes(str);
  var out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function packetWithHeader(fixedHeaderByte, body) {
  var len = encodeRemainingLength(body.length);
  var pkt = new Uint8Array(1 + len.length + body.length);
  pkt[0] = fixedHeaderByte;
  pkt.set(len, 1);
  pkt.set(body, 1 + len.length);
  return pkt;
}

function buildConnect(clientId) {
  var head = concatBytes([prefixed("MQTT"), new Uint8Array([0x04, 0x02, 0x00, 0x3c])]);
  return packetWithHeader(0x10, concatBytes([head, prefixed(clientId)]));
}

function buildSubscribe(packetId, topic) {
  var body = concatBytes([
    new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
    prefixed(topic),
    new Uint8Array([0x00]) // QoS 0
  ]);
  return packetWithHeader(0x82, body);
}

function buildPublish(topic, payloadBytes) {
  return packetWithHeader(0x30, concatBytes([prefixed(topic), payloadBytes]));
}

// Parse one packet at the head of u8. Returns
// {type, topic?, payload?, bytesConsumed} or null when incomplete.
function parsePacket(u8) {
  if (u8.length < 2) return null;
  var type = u8[0] >> 4;
  var mult = 1, len = 0, i = 1, b;
  do {
    if (i >= u8.length) return null;
    b = u8[i++];
    len += (b & 0x7f) * mult;
    mult *= 128;
    if (mult > 128 * 128 * 128) return null; // malformed
  } while (b & 0x80);
  if (u8.length < i + len) return null; // need more bytes
  var body = u8.subarray(i, i + len);
  var pkt = { type: type, bytesConsumed: i + len };
  if (type === 3) { // PUBLISH, QoS 0
    var tlen = (body[0] << 8) | body[1];
    pkt.topic = utf8String(body.subarray(2, 2 + tlen));
    pkt.payload = body.subarray(2 + tlen);
  }
  return pkt;
}

function MqttLink(url, topic, handlers) {
  this.url = url;
  this.topic = topic;
  this.handlers = handlers || {};
  this.clientId = "slugger-" + Math.random().toString(36).slice(2, 10);
  this.ws = null;
  this.buf = new Uint8Array(0);
  this.closed = false;
  this.ready = false;
  this.pingTimer = null;
  this.readyTimer = null;
}

MqttLink.prototype._send = function (pkt) {
  if (this.ws && this.ws.readyState === 1) this.ws.send(pkt);
};

MqttLink.prototype.send = function (obj) {
  obj.cid = this.clientId;
  this._send(buildPublish(this.topic, utf8Bytes(JSON.stringify(obj))));
};

MqttLink.prototype._drain = function () {
  for (;;) {
    var pkt = parsePacket(this.buf);
    if (!pkt) break;
    this.buf = this.buf.subarray(pkt.bytesConsumed);
    this._onPacket(pkt);
    if (this.closed) break;
  }
};

MqttLink.prototype._onWsMessage = function (ev) {
  var self = this;
  var append = function (u8) {
    var next = new Uint8Array(self.buf.length + u8.length);
    next.set(self.buf, 0);
    next.set(u8, self.buf.length);
    self.buf = next;
    self._drain();
  };
  var data = ev.data;
  if (data instanceof ArrayBuffer) append(new Uint8Array(data));
  else if (data && typeof data.arrayBuffer === "function") {
    data.arrayBuffer().then(function (ab) { append(new Uint8Array(ab)); });
  }
  // text frames never occur on the broker path; ignore them
};

MqttLink.prototype._onPacket = function (pkt) {
  var h = this.handlers;
  if (pkt.type === 2) { // CONNACK -> subscribe
    this._send(buildSubscribe(1, this.topic));
  } else if (pkt.type === 9) { // SUBACK -> ready
    if (!this.ready) {
      this.ready = true;
      if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
      this._startPing();
      if (h.onReady) h.onReady();
    }
  } else if (pkt.type === 3) { // PUBLISH
    try {
      var o = JSON.parse(utf8String(pkt.payload));
      if (o && o.cid !== this.clientId && h.onMessage) h.onMessage(o);
    } catch (e) { /* ignore malformed */ }
  }
  // PINGRESP (13): keepalive ok, nothing to do
};

MqttLink.prototype._startPing = function () {
  var self = this;
  this._stopPing();
  this.pingTimer = setInterval(function () {
    self._send(new Uint8Array([0xc0, 0x00])); // PINGREQ
  }, 25000);
};

MqttLink.prototype._stopPing = function () {
  if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
};

MqttLink.prototype.close = function () {
  this.closed = true;
  this._stopPing();
  if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
  try { this._send(new Uint8Array([0xe0, 0x00])); } catch (e) {} // DISCONNECT
  try { if (this.ws) this.ws.close(); } catch (e) {}
  this.ws = null;
};

function connect(url, topic, handlers) {
  handlers = handlers || {};
  var link = new MqttLink(url, topic, handlers);
  var readyTimeoutMs = handlers.readyTimeoutMs || 12000;
  try {
    var ws = new WebSocket(url, WS_SUBPROTOCOL);
    if ("binaryType" in ws) ws.binaryType = "arraybuffer";
    link.ws = ws;
    ws.onopen = function () { link._send(buildConnect(link.clientId)); };
    ws.onmessage = function (ev) { link._onWsMessage(ev); };
    ws.onerror = function () {
      if (!link.ready && !link.closed && handlers.onError) handlers.onError("connection failed");
    };
    ws.onclose = function () {
      link._stopPing();
      if (!link.closed && handlers.onClose) handlers.onClose();
    };
    link.readyTimer = setTimeout(function () {
      if (!link.ready && !link.closed) {
        link.close();
        if (handlers.onError) handlers.onError("pairing service timed out");
      }
    }, readyTimeoutMs);
  } catch (e) {
    if (handlers.onError) handlers.onError("connection failed");
  }
  return link;
}

var api = { connect: connect };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.MqttLink = api;

})();
