/* Unit tests for the ball-annotation ("tap the ball") pure helpers in calib.js.
 * Verifies:
 *  1. addBallPoint appends {t,x,y} without mutating the input array.
 *  2. removeBallPoint drops the right index (and tolerates bad indexes).
 *  3. buildBallTruth produces the exact export shape the detector consumes.
 *  4. ballTruthFileName matches the swing/manual naming convention.
 * Run: node test-ball-truth.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const bt = require("./calib.js");

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

// 1. addBallPoint
var p0 = [{ t: 1.0, x: 100, y: 200 }];
var p1 = bt.addBallPoint(p0, { t: 1.033, x: 110.6, y: 195.2 });
check("add appends", p1.length === 2, "len=" + p1.length);
check("add does not mutate input", p0.length === 1, "len=" + p0.length);
check("add rounds pixels", p1[1].x === 111 && p1[1].y === 195,
  JSON.stringify(p1[1]));
check("add keeps time float", p1[1].t === 1.033, "t=" + p1[1].t);
var pNull = bt.addBallPoint(null, { t: 0, x: 1, y: 2 });
check("add on null base", pNull.length === 1, "len=" + pNull.length);

// 2. removeBallPoint
var pts = [{ t: 1, x: 1, y: 1 }, { t: 2, x: 2, y: 2 }, { t: 3, x: 3, y: 3 }];
var r1 = bt.removeBallPoint(pts, 1);
check("remove middle", r1.length === 2 && r1[0].t === 1 && r1[1].t === 3,
  JSON.stringify(r1.map(function (p) { return p.t; })));
check("remove does not mutate input", pts.length === 3, "len=" + pts.length);
var rBad = bt.removeBallPoint(pts, 9);
check("remove out-of-range keeps all", rBad.length === 3, "len=" + rBad.length);
var rNeg = bt.removeBallPoint(pts, -1);
check("remove negative keeps all", rNeg.length === 3, "len=" + rNeg.length);

// 3. buildBallTruth export shape
var exp = bt.buildBallTruth({
  swingId: 7,
  build: "20260923r",
  videoName: "Swing #7 clip",
  durationSec: 5.002,
  fps: 30,
  points: [{ t: 2.1, x: 640.4, y: 360.6 }, { t: 2.133, x: 655, y: 355 }]
});
check("export type", exp.type === "ball-truth", exp.type);
check("export swingId", exp.swingId === 7, String(exp.swingId));
check("export build", exp.build === "20260923r", exp.build);
check("export videoName", exp.videoName === "Swing #7 clip", exp.videoName);
check("export durationSec", exp.durationSec === 5.002, String(exp.durationSec));
check("export fps", exp.fps === 30, String(exp.fps));
check("export points normalized",
  exp.points.length === 2 &&
  exp.points[0].t === 2.1 && exp.points[0].x === 640 && exp.points[0].y === 361 &&
  Object.keys(exp.points[0]).join(",") === "t,x,y",
  JSON.stringify(exp.points[0]));
var expManual = bt.buildBallTruth({ points: [] });
check("export manual defaults",
  expManual.swingId === null && expManual.build === "dev" &&
  expManual.durationSec === null && expManual.points.length === 0,
  JSON.stringify({ s: expManual.swingId, b: expManual.build }));

// 4. filenames
check("swing filename",
  bt.ballTruthFileName(7, "20260926") === "ball-truth-swing7-20260926.json",
  bt.ballTruthFileName(7, "20260926"));
check("manual filename",
  bt.ballTruthFileName(null, "20260926") === "ball-truth-manual-20260926.json",
  bt.ballTruthFileName(null, "20260926"));
check("undefined swingId is manual",
  bt.ballTruthFileName(undefined, "20260926") === "ball-truth-manual-20260926.json",
  bt.ballTruthFileName(undefined, "20260926"));

if (failures) { console.log(failures + " FAILURES"); process.exit(1); }
console.log("ALL PASS");
