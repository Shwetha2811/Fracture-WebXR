// Registration of the radiograph onto the anatomical reference skeleton.
//
// The skeleton's bones for the chosen region are projected onto the film plane (see
// reconstruction.js → projectBones). The X-ray is then placed on that projection with a 2D
// similarity transform (scale, rotation, translation, optional mirror) that makes the X-ray's bone
// edges coincide with the skeleton's projected bone edges (robust chamfer distance, coarse grid search
// + coordinate-descent refinement). After this every measurement is made in skeleton coordinates, so
// the X-ray coincides with the skeleton and only what differs (the fractures) is modified.

// Cyclic Jacobi eigen-decomposition of a symmetric n×n matrix (array of rows).
export function eigSym(A, n) {
  const a = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const values = a.map((r, i) => r[i]);
  const order = values.map((v, i) => i).sort((i, j) => values[j] - values[i]);
  return { values: order.map((i) => values[i]), vectors: order.map((i) => V.map((r) => r[i])) };
}

// Two-pass 3-4 chamfer distance transform (distance to the nearest set pixel, in pixels).
export function distanceTransform(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + 1.414); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.414); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.414); if (x > 0) v = Math.min(v, d[i + w - 1] + 1.414); }
    d[i] = v;
  }
  return d;
}

export function boundaryPoints(mask, w, h, maxN = 1500) {
  const pts = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) pts.push(x, y);
  }
  const n = pts.length / 2, step = Math.max(1, n / maxN), out = [];
  for (let k = 0; k < n; k += step) { const i = Math.floor(k); out.push(pts[i * 2], pts[i * 2 + 1]); }
  return new Float32Array(out);
}

function maskPCA(mask, w, h) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cx = sx / n, cy = sy / n, a = sxx / n - cx * cx, b = syy / n - cy * cy, c = sxy / n - cx * cy;
  const ang = 0.5 * Math.atan2(2 * c, a - b);
  const ex = Math.cos(ang), ey = Math.sin(ang);
  let tmin = Infinity, tmax = -Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const t = (x - cx) * ex + (y - cy) * ey; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  return { cx, cy, ang, ex, ey, len: tmax - tmin, n };
}

// Similarity: grid = s·R(θ)·M·p + t  (p = image pixel, M = mirror in x). Both frames have y pointing down.
export const makeFilmTransform = (s, theta, mirror, tx, ty) => {
  const c = Math.cos(theta) * s, sn = Math.sin(theta) * s, m = mirror ? -1 : 1;
  const T = {
    s, theta, mirror, tx, ty,
    fwd: (u, v) => [c * m * u - sn * v + tx, sn * m * u + c * v + ty],
    inv: (gx, gy) => { const x = gx - tx, y = gy - ty; const u = (c * x + sn * y) / (s * s), v = (-sn * x + c * y) / (s * s); return [u * m, v]; },
  };
  return T;
};

// imgMask: segmented bone (w×h). grid: projected skeleton (grid.W×grid.H, grid.union mask).
export function registerFilm(imgMask, w, h, grid, opts = {}) {
  const t0 = performance.now();
  const G = grid, gw = G.W, gh = G.H;
  const tplEdge = new Uint8Array(gw * gh);
  { const b = boundaryPoints(G.union, gw, gh, 1e9); for (let i = 0; i < b.length; i += 2) tplEdge[b[i + 1] * gw + b[i]] = 1; }
  const dtG = distanceTransform(tplEdge, gw, gh);
  const F = opts.fast ? 0.35 : 1; // fast: fewer samples (ranking many candidate poses)
  const imgB = boundaryPoints(imgMask, w, h, Math.round(1400 * F));
  const cache = opts.cache || {}; // the film side is the same for every candidate pose
  if (!cache.dtI) {
    const imgEdge = new Uint8Array(w * h); const b = boundaryPoints(imgMask, w, h, 1e9); for (let i = 0; i < b.length; i += 2) imgEdge[b[i + 1] * w + b[i]] = 1;
    cache.dtI = distanceTransform(imgEdge, w, h);
  }
  const dtI = cache.dtI;
  const tplB = boundaryPoints(G.union, gw, gh, Math.round(1400 * F));
  // interior samples for the area-overlap term (prevents degenerate tiny/huge scales)
  const sampleInterior = (m, W, H, maxN) => { const pts = []; for (let i = 0; i < W * H; i++) if (m[i]) pts.push(i % W, (i / W) | 0); const n = pts.length / 2, st = Math.max(1, n / maxN), out = []; for (let k = 0; k < n; k += st) { const i = Math.floor(k); out.push(pts[i * 2], pts[i * 2 + 1]); } return new Float32Array(out); };
  const imgIn = sampleInterior(imgMask, w, h, Math.round(900 * F)), tplIn = sampleInterior(G.union, gw, gh, Math.round(900 * F));
  // the bone of interest must be in the film (resolves look-alike bones, e.g. femur vs tibia)
  const focusIn = opts.focusMask ? sampleInterior(opts.focusMask, gw, gh, Math.round(500 * F)) : null;
  const CAP = 12; // cells / px: robust truncation so a displaced fragment or an unmodelled bone cannot dominate

  // trimmed mean (lowest 85%) of values in [0, CAP] via a histogram — no sorting or allocation per evaluation
  const HB = 240, hc = new Uint32Array(HB), hs = new Float64Array(HB);
  const hReset = () => { hc.fill(0); hs.fill(0); };
  const hAdd = (v) => { const b = Math.min(HB - 1, (v * (HB - 1) / CAP) | 0); hc[b]++; hs[b] += v; };
  const hTrim = (n, keep = 0.85) => {
    if (!n) return CAP;
    let need = Math.max(1, Math.floor(n * keep)), sum = 0;
    const tot = need;
    for (let b = 0; b < HB && need > 0; b++) { if (!hc[b]) continue; const take = Math.min(need, hc[b]); sum += hs[b] * (take / hc[b]); need -= take; }
    return sum / tot;
  };
  function cost(T) {
    const m = T.mirror ? -1 : 1, c = Math.cos(T.theta) * T.s, sn = Math.sin(T.theta) * T.s, tx = T.tx, ty = T.ty, s2 = T.s * T.s;
    // film → grid: (c·m·u − sn·v + tx, sn·m·u + c·v + ty); grid → film: inverse
    hReset();
    for (let i = 0; i < imgB.length; i += 2) {
      const u = imgB[i], v = imgB[i + 1], xi = Math.round(c * m * u - sn * v + tx), yi = Math.round(sn * m * u + c * v + ty);
      hAdd(xi >= 0 && yi >= 0 && xi < gw && yi < gh ? Math.min(CAP, dtG[yi * gw + xi]) : CAP);
    }
    const eA = hTrim(imgB.length / 2, opts.trimA || 0.85);
    hReset(); let inside = 0;
    for (let i = 0; i < tplB.length; i += 2) {
      const x = tplB[i] - tx, y = tplB[i + 1] - ty, xi = Math.round(m * (c * x + sn * y) / s2), yi = Math.round((-sn * x + c * y) / s2);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue; // outside the film: no evidence either way
      inside++; hAdd(Math.min(CAP, dtI[yi * w + xi] * T.s));
    }
    const frac = inside / (tplB.length / 2), eB = inside ? hTrim(inside) : CAP;
    // overlap: film bone that lands on skeleton bone, and skeleton bone inside the film that lands on film bone
    let pHit = 0, pN = 0, rHit = 0, rN = 0;
    for (let i = 0; i < imgIn.length; i += 2) { const u = imgIn[i], v = imgIn[i + 1], xi = Math.round(c * m * u - sn * v + tx), yi = Math.round(sn * m * u + c * v + ty); pN++; if (xi >= 0 && yi >= 0 && xi < gw && yi < gh && G.union[yi * gw + xi]) pHit++; }
    for (let i = 0; i < tplIn.length; i += 2) { const x = tplIn[i] - tx, y = tplIn[i + 1] - ty, xi = Math.round(m * (c * x + sn * y) / s2), yi = Math.round((-sn * x + c * y) / s2); if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue; rN++; if (imgMask[yi * w + xi]) rHit++; }
    const prec = pN ? pHit / pN : 0, rec = rN ? rHit / rN : 0;
    let eO = CAP * (2 - prec - rec) * 0.5;
    if (focusIn) {
      let fHit = 0; const fN = focusIn.length / 2;
      for (let i = 0; i < focusIn.length; i += 2) { const x = focusIn[i] - tx, y = focusIn[i + 1] - ty, xi = Math.round(m * (c * x + sn * y) / s2), yi = Math.round((-sn * x + c * y) / s2); if (xi >= 0 && yi >= 0 && xi < w && yi < h && imgMask[yi * w + xi]) fHit++; }
      eO += CAP * 0.6 * (1 - Math.min(1, (fHit / fN) / 0.5));
    }
    return { e: 0.35 * eA + 0.3 * eB + 0.35 * eO + (frac < 0.15 ? CAP * (0.15 - frac) * 4 : 0), eA, eB, frac, prec, rec };
  }

  const pi = maskPCA(imgMask, w, h), pg = maskPCA(G.union, gw, gh);
  const cands = [];
  // a trusted starting transform (e.g. from the bone-profile template match) is refined locally
  if (opts.init) cands.push({ T: opts.init, c: cost(opts.init) });
  if (!opts.init)
  for (const mirror of [false, true]) for (const flip of [0, Math.PI]) {
    const angI = mirror ? Math.PI - pi.ang : pi.ang;
    const theta = pg.ang - angI + flip;
    if (opts.near && (mirror !== opts.near.mirror || Math.abs(Math.atan2(Math.sin(theta - opts.near.theta), Math.cos(theta - opts.near.theta))) > Math.PI / 2)) continue;
    for (let ki = 0; ki < 11; ki++) {
      const k = 0.28 * Math.pow(1.16, ki); // film may show only part of the region
      const s = (k * pg.len) / Math.max(1, pi.len);
      for (let f = -0.5; f <= 0.5001; f += 0.05) {
        const gx = pg.cx + pg.ex * f * pg.len, gy = pg.cy + pg.ey * f * pg.len;
        const T0 = makeFilmTransform(s, theta, mirror, 0, 0);
        const [ox, oy] = T0.fwd(pi.cx, pi.cy);
        const T = makeFilmTransform(s, theta, mirror, gx - ox, gy - oy);
        cands.push({ T, c: cost(T) });
      }
    }
  }
  if (opts.init) cands.length = 1;
  else cands.sort((a, b) => a.c.e - b.c.e);
  let best = null;
  const starts = cands.slice(0, opts.refineTop || 4);
  for (const start of starts) {
    let { s, theta, mirror, tx, ty } = start.T, cur = start.c;
    let steps = opts.init && cands.length === 1 ? (opts.initSteps || [0.02, 0.02, 2, 2]) : [0.06, 0.05, 6, 6];
    for (let round = 0; round < 7; round++) {
      let improved = true;
      while (improved) {
        improved = false;
        for (let p = 0; p < 4; p++) for (const sg of [-1, 1]) {
          const q = [s, theta, tx, ty];
          if (p === 0) q[0] = s * Math.exp(sg * steps[0]); else q[p] += sg * steps[p];
          const T = makeFilmTransform(q[0], q[1], mirror, q[2], q[3]);
          const c = cost(T);
          if (c.e < cur.e - 1e-6) { [s, theta, tx, ty] = q; cur = c; improved = true; }
        }
      }
      steps = steps.map((v) => v / 2);
    }
    if (!best || cur.e < best.c.e) best = { T: makeFilmTransform(s, theta, mirror, tx, ty), c: cur };
  }
  // overlap on the part of the skeleton that lies inside the film
  const T = best.T;
  const foot = new Uint8Array(gw * gh), boneG = new Uint8Array(gw * gh);
  let inter = 0, uni = 0;
  if (!opts.fast) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const [u, v] = T.inv(x, y), ui = Math.round(u), vi = Math.round(v);
    if (ui < 0 || vi < 0 || ui >= w || vi >= h) continue;
    const i = y * gw + x; foot[i] = 1;
    boneG[i] = imgMask[vi * w + ui];
    if (boneG[i] && G.union[i]) inter++;
    if (boneG[i] || G.union[i]) uni++;
  }
  return {
    T, foot, boneG, iou: uni ? inter / uni : 0,
    chamferMM: best.c.e * G.cell * 1000, edgeFilmMM: best.c.eA * G.cell * 1000, edgeSkeletonMM: best.c.eB * G.cell * 1000,
    insideFraction: best.c.frac, mmPerPx: T.s * G.cell * 1000, rotationDeg: (T.theta * 180) / Math.PI, mirror: T.mirror,
    ms: performance.now() - t0,
  };
}

// Resample an image-space field into the skeleton grid through the film transform.
export function warpToGrid(field, w, h, grid, T, fill = 0) {
  const out = new Float32Array(grid.W * grid.H).fill(fill);
  for (let y = 0; y < grid.H; y++) for (let x = 0; x < grid.W; x++) {
    const [u, v] = T.inv(x, y);
    const x0 = Math.floor(u), y0 = Math.floor(v);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
    const fx = u - x0, fy = v - y0, i = y0 * w + x0;
    out[y * grid.W + x] = (field[i] * (1 - fx) + field[i + 1] * fx) * (1 - fy) + (field[i + w] * (1 - fx) + field[i + w + 1] * fx) * fy;
  }
  return out;
}

// ---------- per-bone ("articulated") refinement ----------
// A patient's joints are rarely at the reference skeleton's angles (shoulder abduction, elbow flexion, hip
// rotation, wrist deviation…), so one similarity cannot lay a joint film on the skeleton. After the global film
// transform T, every bone of the region that the film shows gets its own small similarity correction C_b that
// lays THAT bone's projected outline on the film's edges. The skeleton itself is never changed: the X-ray is
// warped (smoothly between bones) onto it for display, and film measurements on a bone use C_b⁻¹∘T.
//
// C_b (skeleton grid → where the bone appears on the film, in grid units): x' = c + e^k·R(φ)(x − c) + d
export const applyCorr = (C, x, y) => {
  const cs = Math.cos(C.phi) * Math.exp(C.k), sn = Math.sin(C.phi) * Math.exp(C.k), a = x - C.c[0], b = y - C.c[1];
  return [C.c[0] + cs * a - sn * b + C.d[0], C.c[1] + sn * a + cs * b + C.d[1]];
};
// Film transform for measurements on bone b: film pixel → skeleton grid, i.e. C_b⁻¹ ∘ T (still a similarity).
export function boneTransform(T, C) {
  if (!C || !C.fitted) return T;
  const e = Math.exp(-C.k), cs = Math.cos(-C.phi) * e, sn = Math.sin(-C.phi) * e;
  const inv = (x, y) => { const a = x - C.c[0] - C.d[0], b = y - C.c[1] - C.d[1]; return [C.c[0] + cs * a - sn * b, C.c[1] + sn * a + cs * b]; };
  const [tx, ty] = inv(T.tx, T.ty); // image of the film origin
  return makeFilmTransform(T.s * e, T.theta - C.phi, T.mirror, tx, ty);
}

// edgeImg: film edge map (w×h, 1 = edge). Returns { bones: [{id, fitted, phi, k, d, c, mmBefore, mmAfter}], byId }.
export function refineBones(G, T, edgeImg, w, h, opts = {}) {
  const gw = G.W, gh = G.H, CAP = 10;
  const gEdge = new Uint8Array(gw * gh), foot = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const [u, v] = T.inv(x, y), ui = Math.round(u), vi = Math.round(v);
    if (ui < 0 || vi < 0 || ui >= w || vi >= h) continue;
    foot[y * gw + x] = 1; if (edgeImg[vi * w + ui]) gEdge[y * gw + x] = 1;
  }
  const dt = distanceTransform(gEdge, gw, gh);
  const look = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < gw && yi < gh && foot[yi * gw + xi] ? Math.min(CAP, dt[yi * gw + xi]) : -1; };
  const out = [];
  // Bones that move together at a joint (radius + ulna, tibia + fibula…) are first refined as one rigid unit:
  // thin parallel bones fitted one by one can snap onto each other's edges.
  const init = opts.init ? Object.fromEntries(Object.entries(opts.init).map(([k, v]) => [k, { ...v, c: v.c.slice(), d: v.d.slice() }])) : null;
  const grouped = new Set();
  for (const grp of opts.groups || []) {
    const members = G.bones.filter((b) => grp.includes(b.id) && init?.[b.id]);
    if (!members.length) continue;
    const sets = members.map((b) => ({ C: init[b.id], p: boundaryPoints(b.mask, gw, gh, 400) }));
    let gx0 = 0, gy0 = 0, gn = 0, Lg = 20;
    for (const { C, p } of sets) for (let i = 0; i < p.length; i += 2) { const [x, y] = applyCorr(C, p[i], p[i + 1]); gx0 += x; gy0 += y; gn++; }
    for (const b of members) Lg = Math.max(Lg, b.len2);
    const g = [gx0 / Math.max(1, gn), gy0 / Math.max(1, gn)];
    const cost = (Q) => {
      const vals = [];
      const Qc = { ...Q, c: g };
      for (const { C, p } of sets) for (let i = 0; i < p.length; i += 2) { const [x, y] = applyCorr(C, p[i], p[i + 1]); const [u, v] = applyCorr(Qc, x, y); const val = look(u, v); if (val >= 0) vals.push(val); }
      if (vals.length < gn * 0.25) return CAP * 2;
      vals.sort((a, b2) => a - b2); const m = Math.max(1, Math.floor(vals.length * 0.75)); let sm = 0; for (let i = 0; i < m; i++) sm += vals[i];
      return sm / m + 0.3 * ((Q.phi / 0.4) ** 2 + (Q.k / 0.1) ** 2 + (Math.hypot(...Q.d) / (0.15 * Lg)) ** 2);
    };
    let best = { phi: 0, k: 0, d: [0, 0] }, be = cost(best);
    for (let p0 = -0.2; p0 <= 0.2001; p0 += 0.05) {
      let Q = { phi: p0, k: 0, d: [0, 0] }, e = cost(Q), steps = [0.02, 0.02, 3, 3];
      for (let round = 0; round < 5; round++) {
        let improved = true, guard = 0;
        while (improved && guard++ < 15) {
          improved = false;
          for (let q = 0; q < 4; q++) for (const sg of [-1, 1]) {
            const R2 = { ...Q, d: Q.d.slice() };
            if (q === 0) R2.phi += sg * steps[0]; else if (q === 1) R2.k += sg * steps[1]; else R2.d[q - 2] += sg * steps[q];
            if (Math.abs(R2.phi) > 0.35 || Math.abs(R2.k) > 0.12 || Math.hypot(...R2.d) > 0.25 * Lg) continue;
            const c2 = cost(R2); if (c2 < e - 1e-6) { Q = R2; e = c2; improved = true; }
          }
        }
        steps = steps.map((v) => v / 2);
      }
      if (e < be) { be = e; best = Q; }
    }
    // compose the group correction onto each member: x -> Qg(C_b(x))
    const eg = Math.exp(best.k), cs = Math.cos(best.phi) * eg, sn = Math.sin(best.phi) * eg;
    for (const b of members) {
      const C = init[b.id], a = C.c[0] + C.d[0] - g[0], bb = C.c[1] + C.d[1] - g[1];
      C.d = [g[0] + cs * a - sn * bb + best.d[0] - C.c[0], g[1] + sn * a + cs * bb + best.d[1] - C.c[1]];
      C.phi += best.phi; C.k = (C.k || 0) + best.k; C.fitted = true;
      grouped.add(b.id);
    }
  }
  for (const b of G.bones) {
    const pts = boundaryPoints(b.mask, gw, gh, 450);
    const I0 = init?.[b.id]; // starting pose (the joint angle found by registerArticulated, group-refined)
    let n = 0, cx = 0, cy = 0, inside = 0;
    for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cy += pts[i + 1]; n++; }
    const rec = { id: b.id, fitted: false, phi: 0, k: 0, d: [0, 0], c: I0 ? I0.c.slice() : [cx / Math.max(1, n), cy / Math.max(1, n)] };
    const start = I0?.fitted ? { phi: I0.phi, k: I0.k || 0, d: I0.d.slice() } : { phi: 0, k: 0, d: [0, 0] };
    for (let i = 0; i < pts.length; i += 2) { const [x, y] = applyCorr({ ...rec, ...start }, pts[i], pts[i + 1]), xi = Math.round(x), yi = Math.round(y); if (xi >= 0 && yi >= 0 && xi < gw && yi < gh && foot[yi * gw + xi]) inside++; }
    rec.inside = inside / Math.max(1, n);
    out.push(rec);
    if (I0?.fitted) Object.assign(rec, start, { fitted: true });
    if (n < 30 || rec.inside < 0.3) continue;
    const L = Math.max(20, b.len2), dMax = grouped.has(b.id) ? 0.04 : 0.3, dSig = grouped.has(b.id) ? 0.02 : 0.2; // grouped: only small own adjustments
    const HB = 200, hc = new Uint32Array(HB), hs = new Float64Array(HB);
    const cost = (C) => {
      hc.fill(0); hs.fill(0);
      const ek = Math.exp(C.k), cs = Math.cos(C.phi) * ek, sn = Math.sin(C.phi) * ek, c0 = C.c[0], c1 = C.c[1], d0 = C.d[0], d1 = C.d[1];
      let cnt = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const a = pts[i] - c0, bb = pts[i + 1] - c1, xi = Math.round(c0 + cs * a - sn * bb + d0), yi = Math.round(c1 + sn * a + cs * bb + d1);
        if (xi < 0 || yi < 0 || xi >= gw || yi >= gh || !foot[yi * gw + xi]) continue;
        const v = Math.min(CAP, dt[yi * gw + xi]), k = Math.min(HB - 1, (v * (HB - 1) / CAP) | 0); hc[k]++; hs[k] += v; cnt++;
      }
      if (cnt < n * 0.25) return CAP * 2;
      let need = Math.max(1, Math.floor(cnt * 0.75)), s = 0; const m = need;
      for (let k = 0; k < HB && need > 0; k++) { if (!hc[k]) continue; const take = Math.min(need, hc[k]); s += hs[k] * (take / hc[k]); need -= take; }
      // weak prior towards the global fit: joints move, bones don't jump
      const reg = ((C.phi - start.phi) / 0.6) ** 2 + (C.k / 0.12) ** 2 + (Math.hypot(C.d[0] - start.d[0], C.d[1] - start.d[1]) / (dSig * L)) ** 2;
      return s / m + 0.4 * reg;
    };
    const ident = { ...rec, phi: 0, k: 0, d: [0, 0] }, base = I0?.fitted ? cost({ ...rec }) : cost(ident);
    let best = { ...rec, e: base };
    const span = grouped.has(b.id) ? 0 : I0?.fitted ? 0.15 : 0.6;
    for (let dp = -span; dp <= span + 1e-3; dp += 0.15) {
      let C = { ...rec, phi: start.phi + dp, k: start.k, d: start.d.slice() }, e = cost(C);
      let steps = [0.04, 0.03, 4, 4];
      for (let round = 0; round < 5; round++) {
        let improved = true, guard = 0;
        while (improved && guard++ < 12) {
          improved = false;
          for (let p = 0; p < 4; p++) for (const sg of [-1, 1]) {
            const q = { ...C, d: C.d.slice() };
            if (p === 0) q.phi += sg * steps[0]; else if (p === 1) q.k += sg * steps[1]; else q.d[p - 2] += sg * steps[p];
            if (Math.abs(q.phi - start.phi) > (grouped.has(b.id) ? 0.07 : 0.8) || Math.abs(q.k - start.k) > (grouped.has(b.id) ? 0.04 : 0.18) || Math.hypot(q.d[0] - start.d[0], q.d[1] - start.d[1]) > dMax * L) continue;
            const c = cost(q);
            if (c < e - 1e-6) { C = q; e = c; improved = true; }
          }
        }
        steps = steps.map((v) => v / 2);
      }
      if (e < best.e) best = { ...C, e };
    }
    const raw = (C) => cost(C) - 0.4 * (((C.phi - start.phi) / 0.6) ** 2 + (C.k / 0.12) ** 2 + (Math.hypot(C.d[0] - start.d[0], C.d[1] - start.d[1]) / (dSig * L)) ** 2);
    rec.mmBefore = raw(ident) * G.cell * 1000;
    if (best.e < base * (I0?.fitted ? 1 : 0.92)) { Object.assign(rec, { phi: best.phi, k: best.k, d: best.d, fitted: true }); }
    rec.mmAfter = raw(rec) * G.cell * 1000;
  }
  return { bones: out, byId: Object.fromEntries(out.map((r) => [r.id, r])) };
}

// Displacement field D (grid → grid) blending the per-bone corrections, and the X-ray resampled onto the skeleton
// grid through it: pixel x of the returned canvas shows the film at T⁻¹(x + D(x)).
export function warpFilmToSkeleton(G, T, art, filmCanvas, sigma = 22) {
  const gw = G.W, gh = G.H, n = gw * gh;
  const Dx = new Float32Array(n), Dy = new Float32Array(n), Wt = new Float32Array(n).fill(0.02);
  for (const b of G.bones) {
    const C = art.byId[b.id];
    if (!C?.fitted) { // unfitted bones hold the film in place near them
      const dist = distanceTransform(b.mask, gw, gh);
      for (let i = 0; i < n; i++) { const wgt = Math.exp(-((dist[i] / sigma) ** 2)); Wt[i] += wgt * 0.5; }
      continue;
    }
    const dist = distanceTransform(b.mask, gw, gh);
    for (let i = 0; i < n; i++) {
      const wgt = Math.exp(-((dist[i] / sigma) ** 2)); if (wgt < 1e-3) continue;
      const x = i % gw, y = (i / gw) | 0, [ax, ay] = applyCorr(C, x, y);
      Dx[i] += wgt * (ax - x); Dy[i] += wgt * (ay - y); Wt[i] += wgt;
    }
  }
  for (let i = 0; i < n; i++) { Dx[i] /= Wt[i]; Dy[i] /= Wt[i]; }
  const fw = filmCanvas.width, fh = filmCanvas.height;
  const src = filmCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, fw, fh).data;
  const canvas = document.createElement('canvas'); canvas.width = gw; canvas.height = gh;
  const g = canvas.getContext('2d'), im = g.createImageData(gw, gh), o = im.data;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x, [u, v] = T.inv(x + Dx[i], y + Dy[i]);
    const x0 = Math.floor(u), y0 = Math.floor(v);
    if (x0 < 0 || y0 < 0 || x0 >= fw - 1 || y0 >= fh - 1) continue;
    const fx = u - x0, fy = v - y0;
    for (let k = 0; k < 3; k++) {
      const p = (y0 * fw + x0) * 4 + k;
      o[i * 4 + k] = (src[p] * (1 - fx) + src[p + 4] * fx) * (1 - fy) + (src[p + fw * 4] * (1 - fx) + src[p + fw * 4 + 4] * fx) * fy;
    }
    o[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return { canvas, Dx, Dy };
}

// ---------- articulated registration (joint films) ----------
// The joints of the region (elbow, shoulder, hip, knee, wrist, ankle…) found from the skeleton's parent/child
// bones: children of the same parent move together about their contact with the parent (the joint centre).
export function findArticulations(G, focusId) {
  const ids = new Set(G.bones.map((b) => b.id)), byId = Object.fromEntries(G.bones.map((b) => [b.id, b]));
  const kids = {};
  for (const b of G.bones) { const p = b.rec?.parent; if (p && ids.has(p)) (kids[p] ||= []).push(b.id); }
  const desc = (id) => (kids[id] || []).flatMap((k) => [k, ...desc(k)]);
  const arts = [];
  for (const [parent, ch] of Object.entries(kids)) {
    const group = [...new Set(ch.flatMap((k) => [k, ...desc(k)]))];
    // joint centre: where the moving bones touch the parent (closest 10% of their outline points)
    const dP = distanceTransform(byId[parent].mask, G.W, G.H), cand = [];
    for (const k of ch) { const pts = boundaryPoints(byId[k].mask, G.W, G.H, 1200); for (let i = 0; i < pts.length; i += 2) cand.push([dP[Math.round(pts[i + 1]) * G.W + Math.round(pts[i])], pts[i], pts[i + 1]]); }
    if (!cand.length) continue;
    cand.sort((a, b) => a[0] - b[0]);
    const near = cand.slice(0, Math.max(5, Math.floor(cand.length * 0.1)));
    const pivot = [near.reduce((s, q) => s + q[1], 0) / near.length, near.reduce((s, q) => s + q[2], 0) / near.length];
    // a joint is end-to-end (elbow, knee, hip…), not two bones lying alongside each other (tibia/fibula, sacrum/hip bone)
    const P = byId[parent], pa = [P.B2[0] - P.A2[0], P.B2[1] - P.A2[1]], pl = Math.hypot(...pa) || 1;
    const alongside = ch.some((k) => {
      const C = byId[k], t = (q) => ((q[0] - P.A2[0]) * pa[0] + (q[1] - P.A2[1]) * pa[1]) / pl;
      const a0 = Math.min(t(C.A2), t(C.B2)), a1 = Math.max(t(C.A2), t(C.B2)), ov = Math.min(a1, pl) - Math.max(a0, 0);
      const ca = Math.abs(((C.B2[0] - C.A2[0]) * pa[0] + (C.B2[1] - C.A2[1]) * pa[1]) / (pl * Math.max(1e-6, C.len2)));
      return ov > 0.7 * Math.max(1e-6, C.len2) && ca > Math.cos(15 * Math.PI / 180); // parallel and side by side
    });
    if (alongside) continue;
    if (!ch.some((k) => ['long', 'compound'].includes(byId[k].rec?.kind))) continue; // limb joints (not sacro-iliac / acromio-clavicular)
    const longChild = ch.some((k) => byId[k].rec?.kind === 'long');
    const nearFocus = group.includes(focusId) || parent === focusId;
    arts.push({ parent, group, pivot, rank: (nearFocus ? 2 : 0) + (longChild ? 1 : 0) });
  }
  return arts.sort((a, b) => b.rank - a.rank).slice(0, 2);
}

const rotAbout = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return (x, y) => [p[0] + c * (x - p[0]) - s * (y - p[1]), p[1] + s * (x - p[0]) + c * (y - p[1])]; };
// Per-bone correction (skeleton grid → posed) for joint angles `angles` (one per articulation, nested ones compose).
function poseCorrections(G, arts, angles) {
  const out = {};
  for (const b of G.bones) {
    const pts = boundaryPoints(b.mask, G.W, G.H, 400); let cx = 0, cy = 0; const n = pts.length / 2;
    for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cy += pts[i + 1]; }
    const c = [cx / Math.max(1, n), cy / Math.max(1, n)];
    let phi = 0, p = c.slice();
    arts.forEach((a, j) => { if (a.group.includes(b.id) && angles[j]) { p = rotAbout(a.pivot, angles[j])(...p); phi += angles[j]; } });
    out[b.id] = { id: b.id, fitted: phi !== 0, phi, k: 0, c, d: [p[0] - c[0], p[1] - c[1]], inside: 1 };
  }
  return out;
}
// The region skeleton with its joints at the given angles (grid masks only; the skeleton itself never changes).
function posedGrid(G, corr) {
  const gw = G.W, gh = G.H, union = new Uint8Array(gw * gh), bones = [];
  for (const b of G.bones) {
    const C = corr[b.id];
    let mask = b.mask;
    if (C.fitted) {
      mask = new Uint8Array(gw * gh);
      const cs = Math.cos(-C.phi), sn = Math.sin(-C.phi);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { // inverse map: posed pixel → rest pixel
        const a = x - C.c[0] - C.d[0], bb = y - C.c[1] - C.d[1];
        const u = Math.round(C.c[0] + cs * a - sn * bb), v = Math.round(C.c[1] + sn * a + cs * bb);
        if (u >= 0 && v >= 0 && u < gw && v < gh && b.mask[v * gw + u]) mask[y * gw + x] = 1;
      }
    }
    for (let i = 0; i < gw * gh; i++) if (mask[i]) union[i] = 1;
    bones.push({ ...b, mask });
  }
  return { ...G, union, bones };
}

// Global film transform + joint angles. Returns { reg (registerFilm result on the posed skeleton), init (per-bone
// corrections for refineBones), angles (deg), arts } or null when the region has no joint.
export function registerArticulated(imgMask, w, h, G, focusId, edgeImg = null) {
  const arts = findArticulations(G, focusId);
  if (!arts.length) return null;
  const focusOf = (Gp) => Gp.bones.find((b) => b.id === focusId)?.mask;
  const grid = [-105, -90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90, 105].map((d) => d * Math.PI / 180);
  let angles = arts.map(() => 0), best = null;
  // one full search at the reference pose; every other pose is refined from there (a joint turns, the film doesn't)
  const cache = {};
  const reg0 = registerFilm(imgMask, w, h, G, { focusMask: focusOf(G), fast: true, refineTop: 2, cache });
  // the moving bones' outline inside the film must lie on the film's own edges (a limb that leaves the film
  // must still follow the part that is visible; the global trimmed cost alone would ignore those few edges)
  const dtE = edgeImg ? distanceTransform(edgeImg, w, h) : null;
  const groupCost = (Gp, T) => {
    if (!dtE) return 0;
    const mv = new Set(arts.flatMap((a) => a.group));
    const vals = [];
    for (const b of Gp.bones) {
      if (!mv.has(b.id)) continue;
      const pts = boundaryPoints(b.mask, Gp.W, Gp.H, 500);
      for (let i = 0; i < pts.length; i += 2) {
        const [u, v] = T.inv(pts[i], pts[i + 1]), ui = Math.round(u), vi = Math.round(v);
        if (ui >= 2 && vi >= 2 && ui < w - 2 && vi < h - 2) vals.push(Math.min(12, dtE[vi * w + ui]));
      }
    }
    if (vals.length < 30) return 0;
    vals.sort((p, q) => p - q);
    const m = Math.floor(vals.length * 0.9); let sm = 0; for (let i = 0; i < m; i++) sm += vals[i];
    return (sm / m) * T.s * G.cell * 1000; // mm
  };
  const tryAngles = (ang, fast) => {
    const corr = poseCorrections(G, arts, ang), Gp = posedGrid(G, corr);
    const reg = registerFilm(imgMask, w, h, Gp, { focusMask: focusOf(Gp), near: reg0.chamferMM < 3 ? reg0.T : null, refineTop: fast ? 2 : 3, fast, cache, trimA: 0.97 });
    return { reg, corr, ang: ang.slice(), e: reg.chamferMM + 0.8 * groupCost(Gp, reg.T) };
  };
  for (let j = 0; j < arts.length; j++) { // one joint at a time (coarse), then the best pose refined fully
    let bj = null;
    for (const a of j ? grid.filter((x) => Math.abs(x) <= 0.8) : grid) { const ang = angles.slice(); ang[j] = a; const r = tryAngles(ang, true); if (!bj || r.e < bj.e) bj = r; }
    angles = bj.ang;
  }
  // fine: 2.5° steps around the best (a few degrees are centimetres at the far end of a long bone)
  let centre = angles[0];
  for (const d of [-5, -2.5, 0, 2.5, 5]) { const ang = angles.slice(); ang[0] = centre + d * Math.PI / 180; const r = tryAngles(ang, true); if (!best || r.e < best.e) best = r; }
  centre = best.ang[0]; best = null;
  for (const d of [-1.25, 0, 1.25]) { const ang = angles.slice(); ang[0] = centre + d * Math.PI / 180; const r = tryAngles(ang, false); if (!best || r.e < best.e) best = r; }
  return { reg: best.reg, init: best.corr, angles: best.ang.map((a) => a * 180 / Math.PI), arts };
}
