/**
 * Tap-flow regression test for wizard.js — no browser needed.
 * Stubs the DOM, injects a hook into a copy of wizard.js, and verifies:
 *   1. addRef() DISARMS the tap after each point (the "7 & 8" bug: extra taps
 *      used to silently REPLACE the last point instead of adding a new one).
 *   2. Two consecutive taps, each explicitly armed via its preset, both land.
 *   3. Re-tap of the SAME preset still replaces (correction flow preserved).
 *   4. A tap with no preset armed is a silent no-op (no crash, no phantom ref).
 *   5. Tapping the stage with nothing armed nudges the user (no silent drop).
 *
 * Run: node test-tapflow.mjs
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal DOM stub -------------------------------------------------------
function makeEl(id) {
  const listeners = {};
  const el = {
    id, value: "", textContent: "", innerHTML: "", title: "", className: "",
    hidden: false, disabled: false,
    dataset: { screen: "0" },
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild() {}, removeChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
    click() {},
    _fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev || {})); },
  };
  return el;
}
const els = {};
const documentStub = {
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  createElement: (tag) => makeEl("new:" + tag),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
  exitFullscreen() {}, get fullscreenElement() { return null; },
};
const store = {};
const windowStub = {
  CageCalibration: require("./calibration.js"),
  addEventListener() {},
  scrollTo() {},
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};

// ---- load wizard.js with an injected hook -----------------------------------
let src = fs.readFileSync(path.join(__dirname, "wizard.js"), "utf8");
const initMarker = "  // ------------------------------------------------------------ init";
if (!src.includes(initMarker)) { console.error("FAIL: init marker not found"); process.exit(1); }
src = src.replace(initMarker,
  "  window.__hook = { S: S, addRef: addRef, disarmTap: disarmTap, armTap: armTap, buildPresets: buildPresets, restore: restore,\n" +
  "    mediaTransform: mediaTransform, clientToNatural: clientToNatural, naturalToDisplay: naturalToDisplay,\n" +
  "    zoomAt: zoomAt, resetView: resetView, layoutMedia: layoutMedia };\n" + initMarker);
const sandbox = { window: windowStub, document: documentStub, localStorage: windowStub.localStorage,
                  navigator: {}, alert: () => {} };
sandbox.window.window = sandbox.window;
const vm = require("vm");
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "wizard.js" });
const H = sandbox.window.__hook;
if (!H) { console.error("FAIL: hook not installed"); process.exit(1); }

// ---- assertions --------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  FAIL - " + name); }
}

console.log("tap-flow regression:");
const S = H.S;
S.pack = "garage"; S.refs = [];

// 1. armed tap adds a ref AND disarms afterwards
S.activePreset = "box-l"; S.tapping = "ref";
H.addRef([100, 200]);
check("tap adds ref", S.refs.length === 1 && S.refs[0].id === "box-l");
check("tap disarms afterwards", S.tapping === null);

// 2. second tap, explicitly armed on another preset, ADDS (the "7 & 8" case)
S.activePreset = "box-r"; S.tapping = "ref";
H.addRef([300, 400]);
check("second armed tap adds (no silent replace)", S.refs.length === 2);
check("both presets present",
  S.refs.some((r) => r.id === "box-l") && S.refs.some((r) => r.id === "box-r"));

// 3. re-tap of the SAME preset replaces (correction flow preserved)
S.activePreset = "box-l"; S.tapping = "ref";
H.addRef([150, 250]);
check("re-tap same preset replaces, not duplicates", S.refs.length === 2);
const bl = S.refs.find((r) => r.id === "box-l");
check("re-tap updates coordinates", bl && bl.image[0] === 150 && bl.image[1] === 250);
check("re-tap disarms too", S.tapping === null);

// 4. tap with no preset armed: silent no-op, no crash
S.activePreset = null; S.tapping = "ref";
H.addRef([10, 10]);
check("unarmed tap adds nothing", S.refs.length === 2);

// 5. stage tap (press + release, no drag) with nothing armed nudges the user
S.screen = 2; S.tapping = null;
S.source = "demo"; S.mediaSize = { w: 1280, h: 720 };
const stage = documentStub.getElementById("tapStage");
const hint = documentStub.getElementById("tapHint");
hint.textContent = "";
const pd = { preventDefault() {}, clientX: 400, clientY: 300, target: stage };
stage._fire("pointerdown", pd);
stage._fire("pointerup", pd);
check("unarmed stage tap shows guidance",
  /click a named point/i.test(hint.textContent));

// 5b. a drag is a pan, not a tap: armed tap must NOT fire after dragging
S.activePreset = "box-l"; S.tapping = "ref";
const nRefsBefore = S.refs.length;
const pd2 = { preventDefault() {}, clientX: 100, clientY: 100, target: stage };
stage._fire("pointerdown", pd2);
stage._fire("pointermove", { clientX: 160, clientY: 100, target: stage }); // 60px drag
stage._fire("pointerup", { clientX: 160, clientY: 100, target: stage });
check("drag does not place a tap", S.refs.length === nRefsBefore);
check("drag at zoom 1 does not move view", S.view.z === 1);

// 6. stale refs (preset ids from an older pack geometry) are pruned on restore
S.refs = [];
sandbox.window.localStorage.setItem("cageWizardState.v1", JSON.stringify({
  pack: "garage",
  refs: [
    { id: "g-0", label: "Door edge @ plate (0 ft)", image: [1258, 532], world: [0, 1.524] },
    { id: "g-16", label: "Wall end (16 ft)", image: [609, 363], world: [4.8768, 1.524] },
    { id: "g-26", label: "Door 2 end (26 ft)", image: [475, 331], world: [7.9248, 1.524] },
    { id: "custom-123", label: "Custom (16.4, 0 ft)", image: [1, 1], world: [5, 0] },
  ],
}));
H.restore();
const ids = S.refs.map((r) => r.id);
check("stale g-16 pruned", !ids.includes("g-16"));
check("stale g-26 pruned", !ids.includes("g-26"));
check("valid g-0 kept", ids.includes("g-0"));
check("custom point kept", ids.includes("custom-123"));

// 7. zoom math: cursor-anchored zoom + exact tap round-trip under zoom
S.mediaSize = { w: 1280, h: 720 };
H.resetView();
const beforeZoom = H.clientToNatural(500, 200);
H.zoomAt(500, 200, 2.5);
check("zoom factor applied", Math.abs(S.view.z - 2.5) < 1e-9);
const afterZoom = H.clientToNatural(500, 200);
check("zoom keeps cursor-anchored point fixed",
  Math.abs(beforeZoom[0] - afterZoom[0]) < 1e-6 && Math.abs(beforeZoom[1] - afterZoom[1]) < 1e-6);
let rtOk = true;
[[0, 0], [1280, 720], [640, 360], [100, 700], [1279.4, 0.5]].forEach(function (p) {
  const d = H.naturalToDisplay(p[0], p[1]);
  const n = H.clientToNatural(d[0], d[1]); // stub stage rect has left/top 0
  if (Math.abs(n[0] - p[0]) > 1e-6 || Math.abs(n[1] - p[1]) > 1e-6) rtOk = false;
});
check("tap mapping round-trips exactly under zoom", rtOk);
H.zoomAt(400, 300, 100);
check("zoom clamps at 8x", S.view.z === 8);
H.zoomAt(400, 300, 0.001);
check("zoom out clamps at 1x and recenters", S.view.z === 1 && S.view.cx === null);
// layoutMedia drives the media rect from the same mapping the taps use
H.resetView();
const vid = documentStub.getElementById("liveVideo");
check("media rect matches tap mapping",
  vid.style.width === "800px" && vid.style.left === "0px" &&
  vid.style.height === "450px" && vid.style.top === "75px");
// zoom buttons + double-click
documentStub.getElementById("zoomInBtn")._fire("click", {});
check("zoom-in button", Math.abs(S.view.z - 1.5) < 1e-9);
stage._fire("dblclick", { clientX: 500, clientY: 200, target: stage });
check("double-click resets zoom", S.view.z === 1);
stage._fire("dblclick", { clientX: 500, clientY: 200, target: stage });
check("double-click zooms to 3x", Math.abs(S.view.z - 3) < 1e-9);

// 8. editable garage dimensions drive the door-edge presets
S.garage.door1Ft = 10.25; S.garage.centerFt = 6.5; S.garage.door2Ft = 10.25;
const doors = H.buildPresets().filter((p) => p.id.indexOf("g-") === 0);
check("door edges from dims", doors.map((d) => d.id).join(",") === "g-0,g-10.25,g-16.75,g-27");
check("27 ft edge world x", Math.abs(doors[3].world[0] - 27 * 0.3048) < 1e-9);
check("door edge label", doors[1].label === "Door 1 end (10.25 ft)");
S.garage.door1Ft = 11;
const doorsB = H.buildPresets().filter((p) => p.id.indexOf("g-") === 0);
check("dims edit moves edges", doorsB[1].id === "g-11" && doorsB[3].id === "g-27.75");
S.garage.door1Ft = 10.25; // restore

console.log(fail === 0 ? `\n${pass} passed, 0 failed` : `\n${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
