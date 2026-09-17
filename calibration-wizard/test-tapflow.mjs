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
  "  window.__hook = { S: S, addRef: addRef, disarmTap: disarmTap, armTap: armTap, buildPresets: buildPresets };\n" + initMarker);
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

// 5. stage tap with nothing armed nudges the user instead of dying silently
S.screen = 2; S.tapping = null;
S.source = "demo"; S.mediaSize = { w: 1280, h: 720 };
const stage = documentStub.getElementById("tapStage");
const hint = documentStub.getElementById("tapHint");
hint.textContent = "";
stage._fire("pointerdown", { preventDefault() {}, clientX: 400, clientY: 300 });
check("unarmed stage tap shows guidance",
  /click a named point/i.test(hint.textContent));

console.log(fail === 0 ? `\n${pass} passed, 0 failed` : `\n${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
