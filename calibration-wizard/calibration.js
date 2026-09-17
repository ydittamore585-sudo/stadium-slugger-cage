/**
 * Stadium Slugger — Cage Edition: calibration math core.
 *
 * Zero dependencies, no DOM access. Runs in a phone browser AND in node
 * (for the math self-test). This module implements the image<->ground
 * mapping that turns a FIXED cage camera into a measuring device:
 *
 *   image pixels (u,v)  <-->  cage/world meters (x,y) on the ground plane
 *
 * World frame (matches the existing Stadium Slugger simulator convention):
 *   origin (0,0,0) = center of home plate at ground level
 *   +x = toward the pitcher / outfield, meters
 *   +y = lateral, + toward right field, meters
 *   +z = up, meters
 *
 * Method: planar homography via normalized Direct Linear Transform (Hartley).
 * The cage floor is a known plane; tapping >= 4 reference points whose world
 * coordinates are known (home plate corners, cage posts, marked distances)
 * determines the 3x3 homography H with H * [u,v,1]^T ~ [x,y,1]^T.
 *
 * Honesty rules enforced here:
 *  - < 4 points, or a degenerate (near-collinear) configuration, or a
 *    failed numeric solve  ->  { ok:false, reason }  (fail-closed; no H)
 *  - reprojection error above threshold  ->  solve succeeds but the caller
 *    must treat the result as low-confidence / unverified.
 *  - This module NEVER labels anything "calibrated". Verification is a
 *    separate, explicit step (see buildProfile) whose pass/fail the wizard
 *    records in the profile. Downstream tracking must read profile.verified
 *    and label every number "uncalibrated estimate" unless verified === true.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(); // node
  } else {
    root.CageCalibration = factory(); // browser
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROFILE_FORMAT = "stadium-slugger/cage-calibration";
  var PROFILE_VERSION = 1;

  // ---------------------------------------------------------------- matrices

  function matMul3(a, b) {
    var c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++) {
        var s = 0;
        for (var k = 0; k < 3; k++) s += a[i][k] * b[k][j];
        c[i][j] = s;
      }
    return c;
  }

  function invert3(m) {
    // Adjugate / determinant. Returns null when singular.
    var a = m[0][0], b = m[0][1], c = m[0][2];
    var d = m[1][0], e = m[1][1], f = m[1][2];
    var g = m[2][0], h = m[2][1], i = m[2][2];
    var A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    var inv = [
      [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
    return inv;
  }

  function applyH(H, u, v) {
    var w = H[2][0] * u + H[2][1] * v + H[2][2];
    if (!isFinite(w) || Math.abs(w) < 1e-12) return null;
    return [
      (H[0][0] * u + H[0][1] * v + H[0][2]) / w,
      (H[1][0] * u + H[1][1] * v + H[1][2]) / w,
    ];
  }

  function normalizeH(H) {
    var s = H[2][2];
    if (!isFinite(s) || Math.abs(s) < 1e-12) return null;
    return H.map(function (row) { return row.map(function (x) { return x / s; }); });
  }

  // ------------------------------------------- symmetric eigensolver (Jacobi)

  // Cyclic Jacobi eigenvalue decomposition for a real symmetric n x n matrix.
  // Returns { values:[...], vectors:[[col0],[col1],...] } (columns = eigenvectors).
  // Only used on the 9x9 normal-equations matrix from DLT; n is tiny.
  function jacobiEigen(A) {
    var n = A.length;
    var a = A.map(function (row) { return row.slice(); });
    var v = [];
    for (var i = 0; i < n; i++) {
      v.push([]);
      for (var j = 0; j < n; j++) v[i].push(i === j ? 1 : 0);
    }
    for (var sweep = 0; sweep < 60; sweep++) {
      var off = 0;
      for (var p = 0; p < n; p++)
        for (var q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-20) break;
      for (var p2 = 0; p2 < n; p2++) {
        for (var q2 = p2 + 1; q2 < n; q2++) {
          var apq = a[p2][q2];
          if (Math.abs(apq) < 1e-15) continue;
          var app = a[p2][p2], aqq = a[q2][q2];
          var tau = (aqq - app) / (2 * apq);
          var t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
          var c = 1 / Math.sqrt(1 + t * t);
          var s = t * c;
          for (var k = 0; k < n; k++) {
            var akp = a[k][p2], akq = a[k][q2];
            a[k][p2] = c * akp - s * akq;
            a[k][q2] = s * akp + c * akq;
          }
          for (var k2 = 0; k2 < n; k2++) {
            var apk = a[p2][k2], aqk = a[q2][k2];
            a[p2][k2] = c * apk - s * aqk;
            a[q2][k2] = s * apk + c * aqk;
          }
          for (var k3 = 0; k3 < n; k3++) {
            var vkp = v[k3][p2], vkq = v[k3][q2];
            v[k3][p2] = c * vkp - s * vkq;
            v[k3][q2] = s * vkp + c * vkq;
          }
        }
      }
    }
    var values = [];
    for (var d = 0; d < n; d++) values.push(a[d][d]);
    var vectors = [];
    for (var col = 0; col < n; col++) {
      var vec = [];
      for (var row = 0; row < n; row++) vec.push(v[row][col]);
      vectors.push(vec);
    }
    return { values: values, vectors: vectors };
  }

  // ------------------------------------------------------------ DLT solve

  function normalizePoints(pts) {
    // Hartley normalization: centroid -> origin, mean distance -> sqrt(2).
    var n = pts.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    var meanD = 0;
    for (i = 0; i < n; i++)
      meanD += Math.hypot(pts[i][0] - cx, pts[i][1] - cy);
    meanD /= n;
    if (!isFinite(meanD) || meanD < 1e-12) return null;
    var s = Math.SQRT2 / meanD;
    var T = [[s, 0, -s * cx], [0, s, -s * cy], [0, 0, 1]];
    var out = pts.map(function (p) { return [s * (p[0] - cx), s * (p[1] - cy)]; });
    return { T: T, pts: out };
  }

  /**
   * Solve the image->ground homography from point correspondences.
   * @param {Array} refs - [{ image:[u,v], world:[x,y] }, ...], world in meters.
   * @returns { ok:true, H, Hinv, perPoint:[{reprojPx, reprojM}], meanPx, maxPx, meanM, maxM }
   *          or { ok:false, reason } — fail-closed, never a bogus matrix.
   */
  function solveHomography(refs) {
    if (!refs || refs.length < 4) {
      return { ok: false, reason: "Insufficient evidence: need at least 4 reference points, have " + (refs ? refs.length : 0) + "." };
    }
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (!r || !isFinite(r.image[0]) || !isFinite(r.image[1]) ||
          !isFinite(r.world[0]) || !isFinite(r.world[1])) {
        return { ok: false, reason: "Insufficient evidence: reference point " + (i + 1) + " has non-finite coordinates." };
      }
    }

    var imgPts = refs.map(function (r) { return r.image; });
    var wldPts = refs.map(function (r) { return r.world; });

    // Degeneracy guard: points must span 2D in BOTH planes (reject collinear sets).
    function spread(pts) {
      var n = pts.length, mx = 0, my = 0, j;
      for (j = 0; j < n; j++) { mx += pts[j][0]; my += pts[j][1]; }
      mx /= n; my /= n;
      var sx = 0, sy = 0;
      for (j = 0; j < n; j++) { sx += Math.pow(pts[j][0] - mx, 2); sy += Math.pow(pts[j][1] - my, 2); }
      return [Math.sqrt(sx / n), Math.sqrt(sy / n)];
    }
    var spImg = spread(imgPts), spWld = spread(wldPts);
    if (spImg[0] < 1e-9 || spImg[1] < 1e-9)
      return { ok: false, reason: "Insufficient evidence: reference points are degenerate (near-collinear) in the image." };
    if (spWld[0] < 1e-9 || spWld[1] < 1e-9)
      return { ok: false, reason: "Insufficient evidence: reference points are degenerate (near-collinear) in world coordinates." };

    var ni = normalizePoints(imgPts), nw = normalizePoints(wldPts);
    if (!ni || !nw)
      return { ok: false, reason: "Insufficient evidence: point normalization failed (coincident points?)." };

    var n = refs.length;
    var A = [];
    // H maps image (u,v) -> world (x,y): constraint q x H p = 0 with
    // p = (u,v,1) source, q = (x,y,1) target. Rows (Hartley-Zisserman Alg 4.1):
    //   [0,0,0, -u,-v,-1,  y*u,  y*v,  y]
    //   [u,v,1,  0, 0, 0, -x*u, -x*v, -x]
    for (var k = 0; k < n; k++) {
      var u = ni.pts[k][0], v = ni.pts[k][1];
      var x = nw.pts[k][0], y = nw.pts[k][1];
      A.push([0, 0, 0, -u, -v, -1, y * u, y * v, y]);
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v, -x]);
    }
    // Normal equations M = A^T A (9x9 symmetric); solution = eigenvector of smallest eigenvalue.
    var M = [];
    for (var p = 0; p < 9; p++) {
      M.push([]);
      for (var q = 0; q < 9; q++) {
        var s = 0;
        for (var r2 = 0; r2 < A.length; r2++) s += A[r2][p] * A[r2][q];
        M[p].push(s);
      }
    }
    var eig = jacobiEigen(M);
    var minIdx = 0;
    for (var e = 1; e < 9; e++) if (eig.values[e] < eig.values[minIdx]) minIdx = e;
    var h = eig.vectors[minIdx];
    var Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];

    // Denormalize: H = T_wld^-1 * Hn * T_img.
    // (We solved q' ~ Hn * p' in normalized coords, with q' = T_wld*q, p' = T_img*p,
    //  so q ~ T_wld^-1 * Hn * T_img * p.)
    var TwldInv = invert3(nw.T);
    if (!TwldInv) return { ok: false, reason: "Insufficient evidence: numeric failure inverting world normalization." };
    var H = normalizeH(matMul3(TwldInv, matMul3(Hn, ni.T)));
    if (!H) return { ok: false, reason: "Insufficient evidence: solved homography is degenerate." };
    var Hinv = invert3(H);
    if (!Hinv) return { ok: false, reason: "Insufficient evidence: solved homography is singular." };

    // Reprojection diagnostics, both directions.
    var perPoint = [], meanPx = 0, maxPx = 0, meanM = 0, maxM = 0;
    for (var j2 = 0; j2 < n; j2++) {
      var wEst = applyH(H, imgPts[j2][0], imgPts[j2][1]);
      var iEst = applyH(Hinv, wldPts[j2][0], wldPts[j2][1]);
      if (!wEst || !iEst)
        return { ok: false, reason: "Insufficient evidence: homography maps a reference point to infinity." };
      var eM = Math.hypot(wEst[0] - wldPts[j2][0], wEst[1] - wldPts[j2][1]);
      var ePx = Math.hypot(iEst[0] - imgPts[j2][0], iEst[1] - imgPts[j2][1]);
      perPoint.push({ reprojPx: ePx, reprojM: eM });
      meanPx += ePx; meanM += eM;
      if (ePx > maxPx) maxPx = ePx;
      if (eM > maxM) maxM = eM;
    }
    meanPx /= n; meanM /= n;

    return {
      ok: true, H: H, Hinv: Hinv, perPoint: perPoint,
      meanPx: meanPx, maxPx: maxPx, meanM: meanM, maxM: maxM,
      numPoints: n,
    };
  }

  // ------------------------------------------------------- height (z) scale

  /**
   * Vertical pixels-per-meter at a known ground location, from a marker of
   * known height photographed at a known ground position.
   *
   * This is a LOCAL, approximate scale (documented): it treats the camera as
   * locally affine near the sample. Valid for ball heights small relative to
   * camera distance — true in a cage. It is the ONLY height input the wizard
   * measures; without it, height-dependent numbers stay "uncalibrated estimate".
   *
   * @param {Array} H - image->ground homography (for the expected ground pixel)
   * @param {number} markerHeightM - known physical height of the marker, meters (>0)
   * @param {Array} groundImage - tapped pixel of the marker BASE [u,v]
   * @param {Array} topImage - tapped pixel of the marker TOP [u,v]
   * @returns { ok:true, pxPerM, groundWorld:[x,y], groundImageExpected:[u,v], baseTapErrPx }
   *          or { ok:false, reason }
   */
  function solveHeightScale(H, markerHeightM, groundImage, topImage) {
    if (!H) return { ok: false, reason: "Insufficient evidence: no homography (solve the ground plane first)." };
    if (!isFinite(markerHeightM) || markerHeightM <= 0 || markerHeightM > 3)
      return { ok: false, reason: "Insufficient evidence: marker height must be a positive number of meters (<= 3 m)." };
    var gw = applyH(H, groundImage[0], groundImage[1]);
    if (!gw) return { ok: false, reason: "Insufficient evidence: marker base pixel maps to infinity." };
    var Hinv = invert3(H);
    if (!Hinv) return { ok: false, reason: "Insufficient evidence: homography not invertible." };
    var gExp = applyH(Hinv, gw[0], gw[1]); // where the tapped base SHOULD appear
    var baseTapErrPx = Math.hypot(gExp[0] - groundImage[0], gExp[1] - groundImage[1]);
    var dyPx = Math.hypot(topImage[0] - groundImage[0], topImage[1] - groundImage[1]);
    if (dyPx < 2) return { ok: false, reason: "Insufficient evidence: marker top and base taps are nearly the same pixel — re-tap with a taller marker or closer view." };
    return {
      ok: true,
      pxPerM: dyPx / markerHeightM,
      groundWorld: gw,
      groundImageExpected: gExp,
      baseTapErrPx: baseTapErrPx,
      markerHeightM: markerHeightM,
    };
  }

  /**
   * Estimate ball height from a height-scale sample. Documented approximation:
   * z ≈ (pixel distance from the ball's ground projection, measured along the
   * image-vertical toward the marker top) / pxPerM. The wizard UI taps the
   * ball and the ground point directly below it; tracking code in step 2 will
   * do this automatically from the ball mask + homography.
   */
  function estimateHeight(ballImage, groundBelowImage, pxPerM) {
    if (!isFinite(pxPerM) || pxPerM <= 0) return null;
    var dPx = Math.hypot(ballImage[0] - groundBelowImage[0], ballImage[1] - groundBelowImage[1]);
    return dPx / pxPerM;
  }

  // ------------------------------------------------------------- profile I/O

  function buildProfile(input) {
    // input: { cage, camera, solveResult, heightSamples:[...], verification:{...}, appVersion, notes }
    var errors = [];
    if (!input.cage || !isFinite(input.cage.lengthM) || input.cage.lengthM <= 0)
      errors.push("cage.lengthM must be positive meters.");
    if (!input.cage || !isFinite(input.cage.widthM) || input.cage.widthM <= 0)
      errors.push("cage.widthM must be positive meters.");
    if (!input.solveResult || !input.solveResult.ok)
      errors.push("a successful homography solve is required.");
    if (!input.camera || !isFinite(input.camera.heightM) || input.camera.heightM <= 0)
      errors.push("camera.heightM must be positive meters.");

    var heightStatus = "missing";
    var heightSamples = [];
    if (input.heightSamples && input.heightSamples.length > 0) {
      var good = input.heightSamples.filter(function (s) { return s && s.ok; });
      if (good.length > 0) {
        heightStatus = "measured";
        heightSamples = good.map(function (s) {
          return {
            pxPerM: s.pxPerM,
            groundWorldM: s.groundWorld,
            markerHeightM: s.markerHeightM,
            baseTapErrPx: s.baseTapErrPx,
          };
        });
      }
    }

    var ver = input.verification || null;
    var verificationPassed = !!(ver && ver.passed === true && isFinite(ver.errorM));

    var groundPlane = "unverified";
    if (input.solveResult && input.solveResult.ok && verificationPassed) {
      groundPlane = "verified";
    }
    var verified = verificationPassed && groundPlane === "verified";

    var confidence = "low";
    if (verified) {
      var meanPx = input.solveResult.meanPx;
      var n = input.solveResult.numPoints;
      if (meanPx <= 2 && n >= 6 && ver.errorM <= 0.10) confidence = "high";
      else if (meanPx <= 4) confidence = "medium";
    }

    var profile = {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: input.appVersion || "cage-wizard-prototype",
      cage: {
        lengthM: input.cage.lengthM,
        widthM: input.cage.widthM,
        heightM: input.cage.heightM || null,
        notes: input.cage.notes || "",
      },
      camera: {
        heightM: input.camera.heightM,
        distanceBehindPlateM: input.camera.distanceBehindPlateM != null ? input.camera.distanceBehindPlateM : null,
        sideOffsetM: input.camera.sideOffsetM != null ? input.camera.sideOffsetM : null,
        imageWidth: input.camera.imageWidth || null,
        imageHeight: input.camera.imageHeight || null,
        notes: input.camera.notes || "",
      },
      worldFrame: {
        origin: "center of home plate at ground level",
        xAxis: "+x toward the pitcher/outfield (meters)",
        yAxis: "+y lateral, toward right field (meters)",
        zAxis: "+z up (meters)",
        units: "meters",
      },
      homography: input.solveResult && input.solveResult.ok ? {
        imageToGround: input.solveResult.H,
        groundToImage: input.solveResult.Hinv,
        numPoints: input.solveResult.numPoints,
        reprojectionErrorPx: { mean: input.solveResult.meanPx, max: input.solveResult.maxPx },
        reprojectionErrorM: { mean: input.solveResult.meanM, max: input.solveResult.maxM },
        perPointReprojPx: input.solveResult.perPoint.map(function (p) { return p.reprojPx; }),
      } : null,
      referencePoints: (input.referencePoints || []).map(function (r) {
        return { id: r.id || "", label: r.label || "", imagePx: r.image, worldM: r.world };
      }),
      heightScale: {
        status: heightStatus, // "measured" | "assumed" | "missing"
        samples: heightSamples,
      },
      verification: ver ? {
        method: ver.method || "known-position-tap",
        knownWorldM: ver.knownWorldM,
        measuredWorldM: ver.measuredWorldM,
        errorM: ver.errorM,
        thresholdM: ver.thresholdM,
        passed: verificationPassed,
      } : null,
      capabilities: {
        // What downstream tracking is ALLOWED to treat as calibrated.
        groundPlane: groundPlane,       // "verified" | "unverified"
        height: heightStatus,            // "measured" | "assumed" | "missing"
      },
      verified: verified,
      confidence: confidence,            // "high" | "medium" | "low"
      label: verified ? "calibrated" : "uncalibrated estimate",
      notes: input.notes || "",
    };

    return { profile: profile, errors: errors, valid: errors.length === 0 };
  }

  /**
   * Validate a profile object (e.g. loaded from disk). Fail-closed: returns
   * { ok:false, errors:[...] } for anything malformed or self-contradictory.
   */
  function validateProfile(p) {
    var errors = [];
    if (!p || typeof p !== "object") return { ok: false, errors: ["not an object"] };
    if (p.format !== PROFILE_FORMAT) errors.push("format must be " + PROFILE_FORMAT);
    if (p.version !== PROFILE_VERSION) errors.push("version must be " + PROFILE_VERSION);
    var H = p.homography && p.homography.imageToGround;
    if (!H || H.length !== 3 || H.some(function (r) { return !r || r.length !== 3 || r.some(function (x) { return !isFinite(x); }); }))
      errors.push("homography.imageToGround must be a finite 3x3 matrix.");
    else if (!invert3(H)) errors.push("homography.imageToGround is singular.");
    if (p.verified === true) {
      if (!p.verification || p.verification.passed !== true)
        errors.push("verified=true requires verification.passed=true.");
      if (!p.capabilities || p.capabilities.groundPlane !== "verified")
        errors.push("verified=true requires capabilities.groundPlane='verified'.");
      if (p.label !== "calibrated")
        errors.push("verified=true requires label='calibrated'.");
    } else {
      if (p.label !== "uncalibrated estimate")
        errors.push("verified=false requires label='uncalibrated estimate'.");
    }
    if (p.capabilities && ["measured", "assumed", "missing"].indexOf(p.capabilities.height) < 0)
      errors.push("capabilities.height must be measured|assumed|missing.");
    return { ok: errors.length === 0, errors: errors };
  }

  // ------------------------------------------------------- tracking-stage API

  /**
   * The step-2 tracking stage consumes the profile through these helpers —
   * it must NOT reach into profile.homography directly (keeps the fail-closed
   * contract in one place).
   */
  function imageToGround(profile, u, v) {
    var chk = validateProfile(profile);
    if (!chk.ok) return { ok: false, reason: "Insufficient evidence: calibration profile invalid (" + chk.errors[0] + ")" };
    if (profile.capabilities.groundPlane !== "verified")
      return { ok: false, reason: "Insufficient evidence: ground plane is not verified — position is an uncalibrated estimate." };
    var pt = applyH(profile.homography.imageToGround, u, v);
    if (!pt) return { ok: false, reason: "Insufficient evidence: pixel maps outside the calibrated plane." };
    return { ok: true, xM: pt[0], yM: pt[1], calibrated: true };
  }

  function groundToImage(profile, xM, yM) {
    var chk = validateProfile(profile);
    if (!chk.ok) return { ok: false, reason: "Insufficient evidence: calibration profile invalid." };
    var pt = applyH(profile.homography.groundToImage, xM, yM);
    if (!pt) return { ok: false, reason: "pixel maps to infinity." };
    return { ok: true, u: pt[0], v: pt[1] };
  }

  return {
    PROFILE_FORMAT: PROFILE_FORMAT,
    PROFILE_VERSION: PROFILE_VERSION,
    solveHomography: solveHomography,
    solveHeightScale: solveHeightScale,
    estimateHeight: estimateHeight,
    buildProfile: buildProfile,
    validateProfile: validateProfile,
    imageToGround: imageToGround,
    groundToImage: groundToImage,
    applyH: applyH,
    invert3: invert3,
  };
});
