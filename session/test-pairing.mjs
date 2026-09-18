// Regression tests for the phone <-> laptop WebRTC pairing handshake (cast.js).
// Drives the real cast.js with a stubbed DOM, clock, RTCPeerConnection and
// MQTT link — deterministic, no network, no browser.
//
// Scenarios:
//   0. footer build tag derives from the script's own ?v= cache-buster
//   1. THE REPORTED BUG: a duplicate/late answer arriving when the phone's
//      peer connection is already "stable" must be ignored silently — never
//      "Pairing failed — try again." with no way back
//   2. a failed setRemoteDescription shows "retrying (attempt N)" and the
//      laptop's next republished answer heals the handshake
//   3. three failed attempts mint a fresh offer automatically
//   4. a dead connection rebroadcasts without re-prompting for the camera
//   5. the laptop ignores duplicate offer republishes but re-handshakes
//      when the phone's offer SDP changes (re-pair after a blip)
//   6. 45s with no answer refreshes the offer
//
// Run: node test-pairing.mjs   (exit 1 on any failure)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const castSrc = readFileSync(join(here, "cast.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}
const flush = async (n) => { for (let i = 0; i < (n || 25); i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------
// Stub environment. Fresh per test via loadFresh().
// ---------------------------------------------------------------------------
function makeEnv() {
  const env = {};

  // Controllable clock: cast.js timers only fire when the test advances time.
  env.now = 0;
  let seq = 0;
  const timers = new Map();
  globalThis.setTimeout = (cb, ms) => { const id = ++seq; timers.set(id, { cb, at: env.now + (ms || 0), iv: 0 }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.setInterval = (cb, ms) => { const id = ++seq; timers.set(id, { cb, at: env.now + ms, iv: ms }); return id; };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  env.advance = (ms) => {
    const end = env.now + ms;
    for (;;) {
      let nextId = null, nextAt = Infinity;
      for (const [id, t] of timers) if (t.at <= end && t.at < nextAt) { nextId = id; nextAt = t.at; }
      if (nextId === null) break;
      const t = timers.get(nextId);
      env.now = t.at;
      if (t.iv) t.at = env.now + t.iv; else timers.delete(nextId);
      t.cb();
    }
    env.now = end;
  };

  // DOM.
  const elements = {};
  env.elements = elements;
  function makeEl(id) {
    const handlers = {};
    const el = {
      id, textContent: "", innerHTML: "", value: "", disabled: false, open: false,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      style: {},
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      appendChild() {}, insertBefore() {}, select() {}, focus() {},
      querySelectorAll() { return []; },
      onclick: null, onkeydown: null,
      click() { if (this.onclick) this.onclick(); }
    };
    el._handlers = handlers;
    return el;
  }
  const domListeners = {};
  globalThis.document = {
    currentScript: { src: "https://example.test/cast.js?v=testbuild" },
    getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
    createElement() { return makeEl("anon"); },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (domListeners[t] = domListeners[t] || []).push(fn); }
  };
  env.fireDom = (t) => { (domListeners[t] || []).forEach((fn) => fn()); };

  // Browser/window globals cast.js touches.
  globalThis.window = globalThis;
  globalThis.RTCRtpSender = undefined;
  globalThis.LZString = { compressToBase64: (s) => s, decompressFromBase64: (s) => s };
  globalThis.RTCSessionDescription = class { constructor(d) { this.type = d.type; this.sdp = d.sdp; } };
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  // Camera.
  env.getUserMediaCalls = 0;
  const track = { kind: "video", readyState: "live", muted: false, stop() {}, onmute: null, onunmute: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: { getUserMedia: () => { env.getUserMediaCalls++; return Promise.resolve(stream); } }
    },
    configurable: true, writable: true
  });

  // Fake RTCPeerConnection that mirrors real signaling-state behavior,
  // including the exact "Called in wrong state" rejection from the bug report.
  env.pcCount = 0;
  env.pcs = [];
  globalThis.RTCPeerConnection = class {
    constructor() {
      this.id = ++env.pcCount;
      this.signalingState = "stable";
      this.connectionState = "new";
      this.iceGatheringState = "complete";
      this.iceConnectionState = "new";
      this.localDescription = null;
      this.onconnectionstatechange = null;
      this.ontrack = null;
      this._tracks = [];
      this.setRemoteCalls = 0;
      this.failNextSetRemote = 0; // test hook: reject the next N calls
      env.pcs.push(this);
    }
    addTrack(t) { this._tracks.push(t); }
    getSenders() { return this._tracks.map((t) => ({ track: t, replaceTrack: () => Promise.resolve() })); }
    getReceivers() { return []; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "fake-offer-sdp-pc" + this.id }); }
    createAnswer() { return Promise.resolve({ type: "answer", sdp: "fake-answer-sdp-pc" + this.id }); }
    setLocalDescription(d) {
      this.localDescription = d;
      this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
      return Promise.resolve();
    }
    setRemoteDescription(d) {
      this.setRemoteCalls++;
      if (this.failNextSetRemote > 0) { this.failNextSetRemote--; return Promise.reject(new Error("injected setRemoteDescription failure")); }
      if (d.type === "answer") {
        if (this.signalingState !== "have-local-offer") {
          return Promise.reject(new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to set remote answer sdp: Called in wrong state: " + this.signalingState));
        }
        this.signalingState = "stable";
      } else {
        this.signalingState = "have-remote-offer";
      }
      return Promise.resolve();
    }
    close() { this.connectionState = "closed"; }
    getStats() { return Promise.resolve(new Map()); }
  };

  // Fake MQTT link: the test wires phone <-> laptop by hand.
  env.links = [];
  globalThis.MqttLink = {
    connect(url, topic, handlers) {
      const link = { url, topic, handlers, sent: [], closed: false,
        send(o) { this.sent.push(Object.assign({}, o)); },
        close() { this.closed = true; } };
      env.links.push(link);
      return link;
    }
  };

  // Load the real cast.js into this stub world.
  (0, eval)(castSrc);
  env.fireDom("DOMContentLoaded");
  env.status = () => elements["cast-status"].textContent;
  return env;
}

const phoneGotoPair = async (env) => {
  env.elements["btn-broadcast"]._handlers.click[0]();
  await flush();
  env.elements["cast-pin-input"].value = "404020";
  env.elements["btn-cast-pair"].click();
  await flush();
  // One link: the phone's. Fire onReady so it publishes its offer.
  ok(env.links.length === 1, "phone opened one signaling link");
  env.links[0].handlers.onReady();
  await flush();
  return env.links[0];
};

const lastOffer = (link) => link.sent.filter((m) => m.t === "offer").slice(-1)[0];

// ---------------------------------------------------------------------------
async function testBuildTag() {
  console.log("0. build tag");
  const env = makeEnv();
  ok(env.elements["build-tag"].textContent === "build testbuild", "footer build tag derives from ?v= (got: " + env.elements["build-tag"].textContent + ")");
}

async function testDuplicateAnswerIgnored() {
  console.log("1. duplicate answer after stable is ignored (the reported bug)");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  const offer = lastOffer(link);
  ok(!!offer, "phone published an offer");
  const phonePc = env.pcs[0];

  const answer = { t: "answer", sdp: "laptop-answer-sdp-1" };
  link.handlers.onMessage(answer);
  await flush();
  ok(phonePc.signalingState === "stable", "answer applied, pc stable");
  ok(env.status().indexOf("Broadcasting") >= 0, "status shows broadcasting");

  // The laptop republishes its answer every 2.5s — the duplicate must not
  // throw "Called in wrong state: stable" and must not strand the phone.
  link.handlers.onMessage(answer);
  await flush();
  ok(phonePc.setRemoteCalls === 1, "duplicate answer never reached setRemoteDescription");
  ok(env.status().indexOf("Pairing failed") < 0, "no 'Pairing failed' dead-end");
  ok(env.status().indexOf("Broadcasting") >= 0, "still broadcasting after duplicate");
}

async function testFailedApplyHeals() {
  console.log("2. failed apply retries on the next republished answer");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  const phonePc = env.pcs[0];
  phonePc.failNextSetRemote = 1; // first apply blows up

  const answer = { t: "answer", sdp: "laptop-answer-sdp-1" };
  link.handlers.onMessage(answer);
  await flush();
  ok(env.status().indexOf("retrying (attempt 1)") >= 0, "status shows retry attempt 1 (got: " + env.status() + ")");
  ok(env.status().indexOf("Pairing failed") < 0, "no dead-end on failure");

  link.handlers.onMessage(answer); // laptop's 2.5s republish
  await flush();
  ok(phonePc.signalingState === "stable", "republished answer healed the handshake");
  ok(env.status().indexOf("Broadcasting") >= 0, "broadcasting after heal");
}

async function testThreeFailuresFreshOffer() {
  console.log("3. three failed attempts mint a fresh offer");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  env.pcs[0].failNextSetRemote = 99; // always fail
  const answer = { t: "answer", sdp: "laptop-answer-sdp-1" };
  for (let i = 0; i < 3; i++) { link.handlers.onMessage(answer); await flush(); }
  ok(env.status().indexOf("fresh offer") >= 0, "status announces a fresh offer (got: " + env.status() + ")");
  env.advance(1600);
  await flush();
  ok(env.pcCount === 2, "a new peer connection was created");
  ok(env.links.length === 2, "a new signaling link replaced the old one");
  env.links[1].handlers.onReady();
  await flush();
  ok(!!lastOffer(env.links[1]), "fresh offer published on the new link");
}

async function testConnectionDeathRebroadcasts() {
  console.log("4. dead connection rebroadcasts without re-prompting the camera");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  const phonePc = env.pcs[0];
  link.handlers.onMessage({ t: "answer", sdp: "laptop-answer-sdp-1" });
  await flush();
  ok(env.status().indexOf("Broadcasting") >= 0, "paired first");

  phonePc.connectionState = "failed";
  phonePc.onconnectionstatechange();
  env.advance(3100);
  await flush();
  ok(env.getUserMediaCalls === 1, "camera was NOT re-requested");
  ok(env.pcCount === 2, "new offer cycle started a new peer connection");
  env.links[1].handlers.onReady();
  await flush();
  ok(!!lastOffer(env.links[1]), "rebroadcast offer published after connection death");
}

async function testLaptopDedupeAndRepair() {
  console.log("5. laptop dedupes republishes, re-handshakes on a new offer SDP");
  const env = makeEnv();
  env.elements["btn-watch"]._handlers.click[0]();
  await flush();
  ok(env.links.length === 1, "laptop opened one signaling link");
  const link = env.links[0];
  link.handlers.onReady();
  await flush();

  const offerA = { t: "offer", sdp: "phone-offer-SDP-A" };
  link.handlers.onMessage(offerA);
  await flush();
  link.handlers.onMessage(offerA); // 2.5s republish of the same offer
  await flush();
  ok(env.pcCount === 1, "duplicate offer republish did not start a second handshake");
  const answersAfterA = link.sent.filter((m) => m.t === "answer");
  ok(answersAfterA.length >= 1, "laptop published its answer");

  // Phone re-pairs after a blip with a NEW offer SDP -> laptop must follow.
  link.handlers.onMessage({ t: "offer", sdp: "phone-offer-SDP-B" });
  await flush();
  ok(env.pcCount === 2, "new offer SDP triggered a re-handshake");
  const answersAfterB = link.sent.filter((m) => m.t === "answer");
  ok(answersAfterB.some((a) => a.sdp !== answersAfterA[0].sdp), "laptop published a new answer for the new offer");
}

async function testStallRefreshesOffer() {
  console.log("6. 45s with no answer refreshes the offer");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  const firstOffer = lastOffer(link).sdp;
  env.advance(45000);
  await flush();
  ok(env.status().indexOf("refreshing the offer") >= 0, "status announces the refresh (got: " + env.status() + ")");
  ok(env.pcCount === 2, "stall minted a fresh offer cycle");
  env.links[1].handlers.onReady();
  await flush();
  ok(lastOffer(env.links[1]).sdp !== firstOffer, "the refreshed offer has a new SDP");
}

// 7. THE PATCH-DAY BUG: the laptop refreshes (new build), the mounted phone
//    sits on a dead handshake with answered=true and never republishes.
//    The fresh laptop page says hello with a NEW page sid -> the phone must
//    rebroadcast on its own. A hello with the SAME sid (command channel
//    rejoin, no refresh) or no sid (older laptop build) must NOT rebroadcast.
async function testLaptopRefreshRebroadcasts() {
  console.log("7. phone rebroadcasts when a NEW laptop page says hello after pairing");
  const env = makeEnv();
  const link = await phoneGotoPair(env);
  link.handlers.onMessage({ t: "answer", sdp: "laptop-answer-sdp-1", sid: "laptop-session-A" });
  await flush();
  ok(env.status().indexOf("Broadcasting") >= 0, "paired with laptop session A");

  link.handlers.onMessage({ t: "hello", sid: "laptop-session-B" }); // laptop refreshed
  await flush();
  ok(env.status().indexOf("rebroadcasting") >= 0, "phone noticed the laptop restarted (got: " + env.status() + ")");
  env.advance(600);
  await flush();
  ok(env.pcCount === 2, "fresh offer cycle started a new peer connection");
  ok(env.getUserMediaCalls === 1, "camera was NOT re-requested");
  env.links[1].handlers.onReady();
  await flush();
  ok(!!lastOffer(env.links[1]), "rebroadcast offer published for the new laptop page");

  const env2 = makeEnv();
  const link2 = await phoneGotoPair(env2);
  link2.handlers.onMessage({ t: "answer", sdp: "laptop-answer-sdp-1", sid: "laptop-session-A" });
  await flush();
  link2.handlers.onMessage({ t: "hello", sid: "laptop-session-A" }); // same page, channel rejoin
  await flush();
  env2.advance(600);
  await flush();
  ok(env2.pcCount === 1, "same-sid hello did not rebroadcast");

  const env3 = makeEnv();
  const link3 = await phoneGotoPair(env3);
  link3.handlers.onMessage({ t: "answer", sdp: "laptop-answer-sdp-1", sid: "laptop-session-A" });
  await flush();
  link3.handlers.onMessage({ t: "hello" }); // older laptop build, no sid
  await flush();
  env3.advance(600);
  await flush();
  ok(env3.pcCount === 1, "sid-less hello did not rebroadcast");
}

// 8. The laptop's hello and its answer both carry the page session id, and
//    it's the same id in both — that's what lets the phone match them.
async function testLaptopHelloAndAnswerCarrySid() {
  console.log("8. laptop hello + answer carry the page session id");
  const env = makeEnv();
  env.elements["btn-watch"]._handlers.click[0]();
  await flush();
  const link = env.links[0];
  link.handlers.onReady();
  await flush();
  const hello = link.sent.find((m) => m.t === "hello");
  ok(!!hello && typeof hello.sid === "string" && hello.sid.length > 0, "hello carries a page sid");
  link.handlers.onMessage({ t: "offer", sdp: "phone-offer-SDP-A" });
  await flush();
  const answers = link.sent.filter((m) => m.t === "answer");
  ok(answers.length >= 1 && answers[0].sid === hello.sid, "answer carries the same page sid");
}

// ---------------------------------------------------------------------------
await testBuildTag();
await testDuplicateAnswerIgnored();
await testFailedApplyHeals();
await testThreeFailuresFreshOffer();
await testConnectionDeathRebroadcasts();
await testLaptopDedupeAndRepair();
await testStallRefreshesOffer();
await testLaptopRefreshRebroadcasts();
await testLaptopHelloAndAnswerCarrySid();

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
