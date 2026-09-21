/* live-ball-track.js — streaming ball tracker for the live cage feed.
 *
 * Ports the v2 hypothesis tracker to a per-frame API:
 *   - incoming pitch is tracked only until contact/occlusion
 *   - a sharp heading turn at speed TERMINATES the pitch chain (no greedy
 *     extension through contact); the blob that caused the turn starts a
 *     new chain
 *   - a post-contact search opens around the contact neighborhood: a new
 *     fast chain on a sharply different heading => batted ball
 *   - a slow/similar-heading chain in the window RESUMES the pitch (gap)
 *   - swing check is anchored to the pitch endpoint (no fixed batter ROI)
 *
 * Pure module: no DOM, no side effects. Feed push(gray, tMs) with a
 * W*H grayscale frame; events arrive via opts.onEvent.
 *
 * Events:
 *   {type:'pitch', state:'start'|'resume'|'end', f, x0,y0, x1,y1}
 *   {type:'contact', f, x, y, dang, spd}
 *   {type:'batted', state:'start'|'update'|'end', f, pts}
 *   {type:'verdict', verdict:'hit'|'swing-no-contact'|'take',
 *      pitchF0, pitchF1, contactF, swingRatio}
 */
"use strict";

function createBallTracker(o) {
  o = o || {};
  var W = o.W || 480, H = o.H || 270;
  var DIFF_THR = o.diffThr != null ? o.diffThr : 26;
  var BLOB_MIN = 3, BLOB_MAX = 250;
  var LINK_MIN_D = 4, LINK_MAX_D = 100;
  var LINK_SLOPE = 1.5, LINK_SLOPE_C = 16;
  var TURN_SPLIT_DEG = o.turnDeg != null ? o.turnDeg : 40;
  var TURN_SPLIT_MINV = 12;
  var TRIM_MIN_V = 4;
  var PITCH_MIN_V = 4, PITCH_MAX_V = 30; // px/frame at 480x270; 44px/frame
  // chains are noise/flicker, not a pitch (fastest measured real: ~10)
  var CONTACT_DIST = 90, CONTACT_GAP = 5, CONTACT_DANG = 50;
  var BATTED_MIN_V = 10;
  var BATTED_MIN_TRAVEL = 20;  // batted ball must actually go somewhere
  var BATTED_MAX_TURN = 50;    // heading consistency across the departure
  var COAST_MAX = 2;           // missed frames tolerated before a chain dies
  var PITCH_LATCH = o.pitchLatch != null ? o.pitchLatch : 3.0;
  var SWING_WIN = 10, SWING_RATIO = 3.0;
  var PRUNE_AFTER = 45; // frames to keep dead chains for drawing/selection

  var onEvent = o.onEvent || function () {};

  var prev = null, f = -1;
  var chains = [], nextId = 1;
  var pitch = null;       // {chain, sc, f0}
  var contactWin = null;  // {f1,x,y,vx,vy,until}
  var batted = null;      // {chain, ptsAll:[...]}
  var reappear = null;    // {a2,a1,a0,sx,ice,until}
  var energy = [];        // {f,left,right} ring
  var extSwingAt = -1e18; // ms timestamp from notifySwing()
  var lastT = 0;
  var noPitchUntil = -1e9;
  var debug = !!o.debug;
  var candLog = []; // {f, id, sc, len, x0, dx, v, r2x, r2y, consist, sizeF, meanN}

  // ---------- math helpers ----------
  function segSpeed(a, b) {
    var dt = (b.f - a.f) || 1;
    return Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }
  function linfit(xs, ys) {
    var n = xs.length, i, mx = 0, my = 0;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0;
    for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var s = sxx ? sxy / sxx : 0, ic = my - s * mx, ssr = 0, sst = 0;
    for (i = 0; i < n; i++) { ssr += Math.pow(ys[i] - (s * xs[i] + ic), 2); sst += Math.pow(ys[i] - my, 2); }
    return { r2: sst ? Math.max(0, 1 - ssr / sst) : 0, slope: s, ice: ic };
  }
  function trimSlow(pts) {
    var a = 0, b = pts.length - 1;
    while (b - a >= 2 && segSpeed(pts[a], pts[a + 1]) < TRIM_MIN_V) a++;
    while (b - a >= 2 && segSpeed(pts[b - 1], pts[b]) < TRIM_MIN_V) b--;
    return pts.slice(a, b + 1);
  }
  function segStats(pts) {
    var t = [], x = [], y = [], i;
    for (i = 0; i < pts.length; i++) { t.push(pts[i].f); x.push(pts[i].x); y.push(pts[i].y); }
    var fx = linfit(t, x), fy = linfit(t, y);
    var dt = (t[t.length - 1] - t[0]) || 1;
    var v = Math.hypot(x[x.length - 1] - x[0], y[y.length - 1] - y[0]) / dt;
    var vs = [], sv = 0;
    for (i = 1; i < pts.length; i++) vs.push(segSpeed(pts[i - 1], pts[i]));
    var mv = 0;
    for (i = 0; i < vs.length; i++) mv += vs[i];
    mv /= (vs.length || 1);
    for (i = 0; i < vs.length; i++) sv += Math.pow(vs[i] - mv, 2);
    sv = Math.sqrt(sv / (vs.length || 1));
    var mn = 0;
    for (i = 0; i < pts.length; i++) mn += pts[i].n;
    mn /= pts.length;
    return { f0: t[0], f1: t[t.length - 1], len: pts.length, x0: x[0],
      dx: x[x.length - 1] - x[0], dy: y[y.length - 1] - y[0], v: v,
      r2x: fx.r2, r2y: fy.r2, mv: mv, sv: sv, meanN: mn };
  }
  function scorePitch(st) {
    if (st.len < 4 || st.dx >= 0 || st.v < PITCH_MIN_V || st.v > PITCH_MAX_V) return 0;
    // The pitch comes from the pitcher's side and traverses the frame.
    // (Side-on cage geometry: pitcher right, batter left — fixed for the product.)
    if (st.x0 < W * 0.35 || st.dx > -30) return 0;
    // A pitch in flight has nearly constant horizontal velocity, so x-vs-time
    // must be very linear. The pitcher's accelerating hand fails this even
    // when it matches on speed and smoothness. (y is NOT scored for linearity:
    // gravity makes vertical motion quadratic, and a linear y-fit penalizes
    // real pitches.)
    if (st.r2x < 0.92) return 0;
    var consist = 1 / (1 + st.sv / (st.mv || 1));
    var sizeF = 1 / (1 + Math.max(0, st.meanN - 80) / 80);
    return st.len * st.r2x * consist * sizeF;
  }
  function angDeg(ax, ay, bx, by) {
    var d = ax * bx + ay * by, m = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (!m) return 0;
    return Math.acos(Math.max(-1, Math.min(1, d / m))) * 180 / Math.PI;
  }
  function endVel(pts, k) {
    k = k || 3;
    var n = pts.length, a = pts[Math.max(0, n - 1 - k)], b = pts[n - 1];
    var dt = (b.f - a.f) || 1;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  function startVel(pts, k) {
    k = k || 2;
    var a = pts[0], b = pts[Math.min(pts.length - 1, k)];
    var dt = (b.f - a.f) || 1;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  function predict(c) {
    var n = c.pts.length, k = Math.min(3, n);
    var a = c.pts[n - k], b = c.pts[n - 1], dt = (b.f - a.f) || 1;
    return { x: b.x + (b.x - a.x) / dt, y: b.y + (b.y - a.y) / dt };
  }

  // ---------- blobs ----------
  function findBlobs(cur) {
    var seen = new Uint8Array(W * H), out = [], i, p;
    for (i = 0; i < W * H; i++) {
      var dv = cur[i] - prev[i];
      if (dv < 0) dv = -dv;
      if (dv < DIFF_THR || seen[i]) continue;
      var q = [i]; seen[i] = 1;
      var sx = 0, sy = 0, n = 0;
      while (q.length && n < 3000) {
        p = q.pop(); n++;
        var x = p % W, y = (p / W) | 0; sx += x; sy += y;
        var qpush = function (pp, condv) {
          if (condv && !seen[pp]) {
            var d2 = cur[pp] - prev[pp]; if (d2 < 0) d2 = -d2;
            if (d2 >= DIFF_THR) { seen[pp] = 1; q.push(pp); }
          }
        };
        qpush(p - 1, x > 0); qpush(p + 1, x < W - 1);
        qpush(p - W, y > 0); qpush(p + W, y < H - 1);
      }
      if (n >= BLOB_MIN && n <= BLOB_MAX) out.push({ x: sx / n, y: sy / n, n: n });
    }
    return out;
  }

  function stepEnergy(cur) {
    var sl = 0, sr = 0, cl = 0, cr = 0, y, x, p, d;
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) {
      p = y * W + x; d = cur[p] - prev[p]; if (d < 0) d = -d;
      if (x < W / 2) { sl += d; cl++; } else { sr += d; cr++; }
    }
    energy.push({ f: f, left: sl / cl, right: sr / cr });
    if (energy.length > 90) energy.shift();
  }

  function endChain(c, why) {
    if (c.dead) return;
    c.dead = true; c.deadF = f; c.why = why;
    if (pitch && pitch.chain === c) {
      var last = c.pts[c.pts.length - 1], v = endVel(c.pts);
      contactWin = { f1: last.f, x: last.x, y: last.y, vx: v.x, vy: v.y,
        until: last.f + CONTACT_GAP, pitchF0: pitch.f0,
        contactF: null, decideBy: 0, dang: 0 };
      onEvent({ type: "pitch", state: "end", f: last.f, x0: c.pts[0].x, y0: c.pts[0].y, x1: last.x, y1: last.y });
    }
    if (batted && batted.chain === c) {
      var bpts = battedPts();
      onEvent({ type: "batted", state: "end", f: f, pts: bpts });
      // Evaluate the departure NOW: a batted ball that leaves the frame in
      // 3-4 frames never reaches the old 6-point confirmation, and waiting
      // for reappearance lets jitter chains pollute the hypothesis.
      if (contactWin && contactWin.contactF && battedConfirmed()) {
        batted = null;
        confirmHit();
        return;
      }
      armReappear();
      if (contactWin) contactWin.battedDiedF = f;
      batted = null;
    }
  }

  function armReappear() {
    // ballistic prediction of the batted ball for up to 40 frames, so a
    // reappearance after a visibility gap can rejoin the hypothesis
    var pts = battedPts(), t = [], x = [], y = [], i;
    for (i = 0; i < pts.length; i++) { t.push(pts[i].f); x.push(pts[i].x); y.push(pts[i].y); }
    if (t.length < 4) return;
    var fx = linfit(t, x);
    var n = t.length, sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
    for (i = 0; i < n; i++) {
      var ti = t[i], ti2 = ti * ti;
      sx += ti; sx2 += ti2; sx3 += ti2 * ti; sx4 += ti2 * ti2;
      sy += y[i]; sxy += ti * y[i]; sx2y += ti2 * y[i];
    }
    var det = function (m) {
      return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    };
    var A = [[sx2, sx, n], [sx3, sx2, sx], [sx4, sx3, sx2]], B = [sy, sxy, sx2y];
    var d0 = det(A);
    if (Math.abs(d0) < 1e-9) return;
    var rep = function (cc) { var M = A.map(function (r) { return r.slice(); }); for (var k = 0; k < 3; k++) M[k][cc] = B[k]; return M; };
    reappear = { a2: det(rep(0)) / d0, a1: det(rep(1)) / d0, a0: det(rep(2)) / d0,
      sx: fx.slope, ice: fx.ice, until: t[t.length - 1] + 40, ptsAll: pts.slice() };
  }

  function tryReappear(c) {
    if (!reappear || f > reappear.until) { reappear = null; return false; }
    var p0 = c.pts[0];
    var px = reappear.sx * p0.f + reappear.ice;
    var py = reappear.a2 * p0.f * p0.f + reappear.a1 * p0.f + reappear.a0;
    if (Math.hypot(p0.x - px, p0.y - py) > 50) return false;
    var vv = startVel(c.pts);
    var pv = { x: reappear.sx, y: 2 * reappear.a2 * p0.f + reappear.a1 };
    if (angDeg(vv.x, vv.y, pv.x, pv.y) > 45) return false;
    // drop prefix points at/after the new chain's start (no double count)
    var cut = c.pts[0].f, pre = [];
    for (var i = 0; i < reappear.ptsAll.length; i++)
      if (reappear.ptsAll[i].f < cut) pre.push(reappear.ptsAll[i]);
    batted = { chain: c, prefix: pre };
    c.used = true;
    onEvent({ type: "batted", state: "start", f: p0.f, reappeared: true, pts: battedPts() });
    reappear = null;
    return true;
  }

  function anchoredSwing(pitchEndF, pitchEndX) {
    var left = pitchEndX < W / 2;
    var vals = [], i, e;
    for (i = 0; i < energy.length; i++) {
      e = energy[i];
      if (e.f >= pitchEndF - SWING_WIN && e.f <= pitchEndF + SWING_WIN)
        vals.push(left ? e.left : e.right);
    }
    if (!vals.length) return { swing: false, ratio: 0 };
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var base = sorted[Math.floor(sorted.length / 2)] || 1;
    var peak = 0;
    for (i = 0; i < vals.length; i++) if (vals[i] > peak) peak = vals[i];
    return { swing: peak > base * SWING_RATIO, ratio: peak / base, peak: peak, base: base };
  }

  function battedPts() {
    if (!batted) return [];
    return batted.prefix.concat(batted.chain.pts);
  }

  function meanSpeed(pts) {
    if (pts.length < 2) return 0;
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += segSpeed(pts[i - 1], pts[i]);
    return s / (pts.length - 1);
  }

  // Departure gate: does this batted hypothesis look like a real struck ball?
  // Fast, travels a real distance, holds its heading, steady on at least one
  // axis. Rejects jitter/noise chains that happen to be quick.
  function battedDeparted(pts) {
    var seen = {}, up = [], i, k;
    for (i = 0; i < pts.length; i++)
      if (!pts[i].coast) seen[pts[i].f] = pts[i]; // real detections only
    for (k in seen) up.push(seen[k]);
    up.sort(function (a, b) { return a.f - b.f; });
    // Judge the DEPARTURE — the first few frames off the bat. Later flight
    // (apex, descent, bounce, roll) is slower and curvier and must not
    // dilute the departure evidence.
    up = up.slice(0, 4);
    if (up.length < 3) return false;
    // A batted ball is at full speed from the instant of contact — it never
    // accelerates from a slow first step. A slow start means the chain is
    // the bat's motion blur, not the ball.
    var s0 = Math.hypot(up[1].x - up[0].x, up[1].y - up[0].y) / ((up[1].f - up[0].f) || 1);
    if (s0 < 8) return false;
    if (meanSpeed(up) <= BATTED_MIN_V) return false;
    var a = up[0], b = up[up.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < BATTED_MIN_TRAVEL) return false;
    var v0 = startVel(up, 2), v1 = endVel(up, 3);
    if (Math.hypot(v0.x, v0.y) < 6 || Math.hypot(v1.x, v1.y) < 6) return false;
    if (angDeg(v0.x, v0.y, v1.x, v1.y) > BATTED_MAX_TURN) return false;
    var t = [], xs = [], ys = [];
    for (i = 0; i < up.length; i++) { t.push(up[i].f); xs.push(up[i].x); ys.push(up[i].y); }
    var r2x = linfit(t, xs).r2, r2y = linfit(t, ys).r2;
    return Math.max(r2x, r2y) > 0.6;
  }

  function reprovSustained(pts) {
    // A reprovisioned batted ball confirms by persisting: it must still be
    // a live, moving object several frames after re-emerging — and it must
    // actually GO somewhere (a dead ball jittering in the dirt doesn't count).
    var seen = {}, up = [], i, k;
    for (i = 0; i < pts.length; i++)
      if (!pts[i].coast) seen[pts[i].f] = pts[i];
    for (k in seen) up.push(seen[k]);
    up.sort(function (a, b) { return a.f - b.f; });
    if (up.length < 8) return false;
    if (meanSpeed(up) < 6) return false;
    var a = up[0], b = up[up.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 25) return false;
    return true;
  }

  function battedConfirmed() {
    // centralized: the live batted hypothesis has proven itself
    var bp = battedPts();
    if (batted.isReprov) return reprovSustained(bp);
    return battedDeparted(bp);
  }

  function resolveVerdict(pitchF0, pitchF1) {
    var sw = anchoredSwing(pitchF1, contactWin ? contactWin.x : W / 2);
    // external swing detector (e.g. the session's prominence detector) counts
    // if it fired any time since the pitch started
    var extSwing = pitch && extSwingAt >= pitch.t0 - 500;
    var verdict = (sw.swing || extSwing) ? "swing-no-contact" : "take";
    onEvent({ type: "verdict", verdict: verdict, pitchF0: pitchF0, pitchF1: pitchF1,
      contactF: null, swingRatio: sw.ratio });
    pitch = null; contactWin = null;
    noPitchUntil = f + 45; // 1.5s cooldown before the next pitch can latch
  }

  function confirmHit() {
    var pts = battedPts();
    onEvent({ type: "verdict", verdict: "hit",
      pitchF0: contactWin.pitchF0, pitchF1: contactWin.f1,
      contactF: contactWin.contactF, dang: contactWin.dang, spd: meanSpeed(pts) });
    pitch = null; contactWin = null;
    noPitchUntil = f + 45;
  }

  function updateHypotheses() {
    var i, c, st, sc;
    // prune ancient dead chains
    chains = chains.filter(function (cc) { return !cc.dead || f - cc.deadF < PRUNE_AFTER; });

    // pitch selection
    if (!pitch && f > noPitchUntil) {
      var best = null;
      for (i = 0; i < chains.length; i++) {
        c = chains[i];
        if (c.used) continue;
        // coast points are linear predictions — they would inflate the
        // linearity scores, so pitch candidacy uses real detections only
        var real = c.pts.filter(function (p) { return !p.coast; });
        if (real.length < 4) continue;
        var tr = trimSlow(real);
        if (tr.length < 4) continue;
        st = segStats(tr); sc = scorePitch(st);
        if (debug && sc > 0 && !c.candLogged) {
          c.candLogged = true;
          candLog.push({ f: f, id: c.id, sc: +sc.toFixed(2), len: st.len,
            x0: Math.round(st.x0), dx: Math.round(st.dx), v: +st.v.toFixed(1),
            r2x: +st.r2x.toFixed(2), r2y: +(st.r2y || 0).toFixed(2),
            consist: +(1 / (1 + st.sv / (st.mv || 1))).toFixed(2),
            meanN: Math.round(st.meanN) });
        }
        if (sc > PITCH_LATCH && !c.dead && (!best || sc > best.sc)) best = { chain: c, sc: sc, st: st };
      }
      if (best) {
        pitch = { chain: best.chain, sc: best.sc, f0: best.st.f0, t0: lastT };
        best.chain.used = true;
        var p0 = best.chain.pts[0];
        onEvent({ type: "pitch", state: "start", f: p0.f, x0: p0.x, y0: p0.y,
          x1: best.chain.pts[best.chain.pts.length - 1].x,
          y1: best.chain.pts[best.chain.pts.length - 1].y });
      }
    }

    // contact window: classify new chains born near the pitch end
    if (contactWin && !contactWin.contactF && f > contactWin.until) {
      resolveVerdict(pitch ? pitch.f0 : contactWin.f1, contactWin.f1);
    }
    if (contactWin) {
      // a provisional contact awaits confirmation: the batted ball must prove
      // itself with sustained fast flight (a 3-frame bat flash doesn't count)
      if (contactWin.contactF) {
        if (batted) {
          // A reprovisioned chain already passed a strict scan (near the
          // contact point, fast, sharp direction change). It confirms by
          // persisting as a coherent moving object — the departure itself
          // is often messy in the bat's motion blur.
          if (battedConfirmed()) { confirmHit(); }
          else if (f > contactWin.decideBy) {
            batted = null;
            resolveVerdict(contactWin.pitchF0, contactWin.f1);
          }
        } else if (f <= contactWin.decideBy) {
          // First batted candidate died (often lost in the bat's motion blur
          // at contact). A fresh fast chain near the contact point within the
          // window gets a second chance as the batted ball.
          for (i = 0; i < chains.length; i++) {
            c = chains[i];
            if (c.used || c.dead || c.pts.length < 3) continue;
            var r0 = c.pts[0].f;
            // The replacement must be born AFTER the first candidate died —
            // a chain that coexisted with it is the bat/clutter, not the ball.
            var diedF = contactWin.battedDiedF || contactWin.contactF;
            if (r0 <= diedF || r0 > contactWin.until) continue;
            // ...and near the CONTACT POINT (not just the pitch end): the
            // ball re-emerges where it was lost, within a few fast frames.
            var rd = Math.hypot(c.pts[0].x - contactWin.cx, c.pts[0].y - contactWin.cy);
            if (rd > 60) continue;
            var rvv = startVel(c.pts), rspd = Math.hypot(rvv.x, rvv.y);
            var rdang = angDeg(contactWin.vx, contactWin.vy, rvv.x, rvv.y);
            if (rspd >= BATTED_MIN_V && rdang >= CONTACT_DANG) {
              c.used = true;
              batted = { chain: c, prefix: [], isReprov: true };
              onEvent({ type: "batted", state: "start", f: r0,
                pts: battedPts(), reprov: true });
              break;
            }
          }
        } else {
          // batted candidate died before confirming — fall back
          resolveVerdict(contactWin.pitchF0, contactWin.f1);
        }
      } else if (!contactWin.contactF) {
        for (i = 0; i < chains.length; i++) {
          c = chains[i];
          if (c.used || c.pts.length < 3) continue;
          var b0 = c.pts[0].f;
          if (b0 < contactWin.f1 - 1 || b0 > contactWin.until) continue;
          var d = Math.hypot(c.pts[0].x - contactWin.x, c.pts[0].y - contactWin.y);
          if (d > CONTACT_DIST) continue;
          var vv = startVel(c.pts), spd = Math.hypot(vv.x, vv.y);
          var dang = angDeg(contactWin.vx, contactWin.vy, vv.x, vv.y);
          if (spd >= BATTED_MIN_V && dang >= CONTACT_DANG) {
            // PROVISIONAL contact — verdict waits for confirmation
            c.used = true;
            batted = { chain: c, prefix: [] };
            contactWin.contactF = b0; contactWin.decideBy = b0 + 15;
            contactWin.dang = dang;
            contactWin.cx = c.pts[0].x; contactWin.cy = c.pts[0].y;
            onEvent({ type: "contact", f: b0, x: c.pts[0].x, y: c.pts[0].y,
              dang: dang, spd: spd, provisional: true });
            onEvent({ type: "batted", state: "start", f: b0, pts: battedPts() });
            break;
          } else if (dang < 30 && spd > 3 && d < 40 && b0 <= contactWin.f1 + 2 && pitch) {
            // same pitch continuing through a 1-2 frame gap — resume it
            c.used = true;
            pitch.chain = c; pitch.f0 = Math.min(pitch.f0, c.pts[0].f);
            onEvent({ type: "pitch", state: "resume", f: b0, x0: c.pts[0].x, y0: c.pts[0].y, x1: c.pts[0].x, y1: c.pts[0].y });
            contactWin = null;
            break;
          }
          // otherwise: unrelated slow/odd chain (dribble, roll, noise) — leave it
        }
      }
    }

    // reappearance: a new chain matching the predicted batted ball
    if (reappear && !batted) {
      for (i = 0; i < chains.length; i++) {
        c = chains[i];
        if (c.used || c.pts.length < 3) continue;
        if (tryReappear(c)) break;
      }
      if (reappear && f > reappear.until) reappear = null;
    }
  }

  // ---------- public API ----------
  function push(gray, tMs) {
    if (!prev) prev = new Uint8Array(W * H);
    if (!gray || gray.length !== W * H) return;
    f++;
    lastT = tMs;
    if (f === 0) { prev.set(gray); return; } // seed; blobs start at frame 1
    var blobs = findBlobs(gray);
    stepEnergy(gray);
    var claimed = {}, i, k;
    for (i = 0; i < chains.length; i++) {
      var c = chains[i];
      if (c.dead) continue;
      var last = c.pts[c.pts.length - 1];
      var bi = -1, bd = 1e9, bl = null;
      for (k = 0; k < blobs.length; k++) {
        if (claimed[k]) continue;
        var o = blobs[k];
        var dx = o.x - last.x, dy = o.y - last.y, d = Math.hypot(dx, dy);
        if (d < LINK_MIN_D || d > LINK_MAX_D) continue;
        if (Math.abs(dy) > Math.abs(dx) * LINK_SLOPE + LINK_SLOPE_C) continue;
        if (d < bd) { bd = d; bi = k; bl = o; }
      }
      if (bi >= 0) {
        var turn = 0, inV = 0;
        if (c.pts.length >= 2) {
          var p2 = c.pts[c.pts.length - 2];
          var h1 = Math.atan2(last.y - p2.y, last.x - p2.x);
          var h2 = Math.atan2(bl.y - last.y, bl.x - last.x);
          turn = Math.abs(h2 - h1) * 180 / Math.PI;
          if (turn > 180) turn = 360 - turn;
          inV = Math.hypot(last.x - p2.x, last.y - p2.y); // per-frame incoming speed
        }
        var candV = Math.hypot(bl.x - last.x, bl.y - last.y);
        // Terminate on a sharp turn when the outgoing motion is fast
        // (batted ball) OR much slower than the incoming (ball died).
        var died = inV > 6 && candV > 0.5 && inV / candV > 3;
        if (turn > TURN_SPLIT_DEG && (candV > TURN_SPLIT_MINV || died)) {
          endChain(c, "turn"); // blob stays unclaimed -> starts a new chain
        } else {
          c.pts.push({ f: f, x: bl.x, y: bl.y, n: bl.n });
          claimed[bi] = 1; c.missed = 0;
        }
      } else {
        // second chance: prediction gate on the same frame
        var pr = predict(c), bj = -1, bdd = 45, bo = null;
        for (k = 0; k < blobs.length; k++) {
          if (claimed[k]) continue;
          var o2 = blobs[k];
          var dd = Math.hypot(o2.x - pr.x, o2.y - pr.y);
          if (dd < bdd) { bdd = dd; bj = k; bo = o2; }
        }
        if (bj >= 0) {
          c.pts.push({ f: f, x: bo.x, y: bo.y, n: bo.n, coast: true });
          claimed[bj] = 1; c.missed = 0;
        } else {
          c.missed = (c.missed || 0) + 1;
          if (c.missed <= COAST_MAX) {
            // coast on prediction: a fast ball often drops a frame to blur
            var pr2 = predict(c);
            c.pts.push({ f: f, x: pr2.x, y: pr2.y, n: 0, coast: true });
          } else {
            endChain(c, "lost");
          }
        }
      }
    }
    for (k = 0; k < blobs.length; k++) {
      if (claimed[k]) continue;
      chains.push({ id: nextId++, pts: [{ f: f, x: blobs[k].x, y: blobs[k].y, n: blobs[k].n }],
        dead: false, missed: 0, used: false });
    }
    updateHypotheses();
    prev.set(gray);
  }

  function notifySwing(tMs) { extSwingAt = tMs; }

  function state() {
    return {
      f: f, W: W, H: H,
      pitch: pitch ? { f0: pitch.f0, pts: pitch.chain.pts } : null,
      batted: batted ? { pts: battedPts() } : null,
      inContactWindow: !!(contactWin && !contactWin.contactF),
      contactF: contactWin ? contactWin.contactF : null,
      chains: debug ? chains.filter(function (c) { return !c.dead || f - c.deadF < 12; })
        .map(function (c) { return { id: c.id, dead: c.dead, pts: c.pts }; }) : undefined,
      candLog: debug ? candLog : undefined,
    };
  }

  function reset() {
    prev = null; f = -1; chains = []; pitch = null;
    contactWin = null; batted = null; reappear = null; energy = [];
    extSwingAt = -1e18; lastT = 0; noPitchUntil = -1e9; candLog = []; nextId = 1;
  }

  return { push: push, notifySwing: notifySwing, state: state, reset: reset };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createBallTracker: createBallTracker };
}
if (typeof window !== "undefined") {
  window.BallTrack = {
    createBallTracker: createBallTracker,
    createLiveTracker: createBallTracker, // alias
  };
}
