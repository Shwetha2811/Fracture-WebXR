// Skeleton ↔ film geometry and fracture modelling.
//
// The skeleton is the anatomical reference and stays unchanged except where a fracture is found:
//   projectBones       – orthographic projection of the region's bones onto the film plane (per-bone
//                        masks, projected axes, and chord thickness = the anatomy's depth along the beam)
//   buildFracturedBone – the ORIGINAL bone mesh (same scan, same surface) cut along each detected
//                        fracture surface; each fragment is moved by the displacement and angulation
//                        measured on the film. Nothing else about the bone is changed.
//
// Per-vertex attributes of a fractured bone:
//   aFracture  0..1 closeness to a fracture surface     aFragment  0 = proximal, 1.. = distal fragments
//   aRest      position before fragments were moved (for stable per-pixel fracture shading)

import { eigSym } from './registration.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

// Gather a bone's geometry (and its baked surface colours) in model space.
export function extractTemplate(THREE, rec, model) {
  model.updateWorldMatrix(true, true);
  const inv = model.matrixWorld.clone().invert();
  const pos = [], col = [], index = [];
  let base = 0;
  const v = new THREE.Vector3();
  for (const obj of rec.objects) obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, p = g.attributes.position, c = g.attributes.color, M = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(M); pos.push(v.x, v.y, v.z);
      if (c) col.push(c.getX(i), c.getY(i), c.getZ(i)); else col.push(0.8, 0.7, 0.5);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(g.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) index.push(i + base);
    base += p.count;
  });
  const tpl = { rec, pos: new Float32Array(pos), col: new Float32Array(col), index: new Uint32Array(index) };
  tpl.frame = templateFrame(tpl.pos, rec);
  tpl.profiles = {};
  return tpl;
}

// Principal axis frame: a = proximal→distal.
export function templateFrame(pos, rec) {
  const n = pos.length / 3, c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const d = [pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r][k] += d[r] * d[k] / n;
  }
  let a = norm(eigSym(C, 3).vectors[0]);
  const side = rec?.side === 'right' ? -1 : 1, rule = rec?.proximal || 'down';
  if (rule === 'down' && Math.abs(a[1]) > 0.45) { if (a[1] > 0) a = a.map((x) => -x); }
  else if (rule === 'lateral' || (rule === 'down' && Math.abs(a[0]) >= Math.abs(a[2]))) { if (a[0] * side < 0) a = a.map((x) => -x); }
  else if (a[2] < 0) a = a.map((x) => -x);
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = (pos[i * 3] - c[0]) * a[0] + (pos[i * 3 + 1] - c[1]) * a[1] + (pos[i * 3 + 2] - c[2]) * a[2];
    if (t < tmin) tmin = t; if (t > tmax) tmax = t;
  }
  let ml = [1, 0, 0];
  if (Math.abs(dot(ml, a)) > 0.9) ml = [0, 0, 1];
  ml = norm(ml.map((x, k) => x - dot(ml, a) * a[k]));
  return { c, a, ml, ap: cross(a, ml), tmin, tmax, length: tmax - tmin };
}

// Film-plane basis: U = image right, Up = image up, Z = toward the viewer (right-handed).
export function viewBasis(projection, side) {
  const sg = side === 'right' ? -1 : 1;
  return projection === 'LAT'
    ? { U: [0, 0, -sg], Up: [0, 1, 0], Z: [sg, 0, 0] }
    : { U: [1, 0, 0], Up: [0, 1, 0], Z: [0, 0, 1] };
}

// Orthographic projection of the region's bones onto a grid in the film plane (y down, like an image).
export function projectBones(tpls, basis, cell = 0.0006) {
  const { U, Up, Z } = basis;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of tpls) for (let i = 0; i < t.pos.length; i += 3) {
    const p = [t.pos[i], t.pos[i + 1], t.pos[i + 2]];
    const x = dot(p, U), y = dot(p, Up);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const pad = 0.015;
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  cell = Math.max(cell, Math.max(x1 - x0, y1 - y0) / 1100); // keep the grid a sensible size
  const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((y1 - y0) / cell);
  const G = { x0, yTop: y1, cell, W, H, basis, union: new Uint8Array(W * H), thick: new Float32Array(W * H), bones: [] };
  G.toGrid = (p) => [(dot(p, U) - x0) / cell, (y1 - dot(p, Up)) / cell];
  G.toWorld2 = (gx, gy) => [x0 + gx * cell, y1 - gy * cell];
  for (const t of tpls) {
    const mask = new Uint8Array(W * H), thick = new Float32Array(W * H);
    const P = t.pos, I = t.index, zc = dot(t.frame.c, Z), n = P.length / 3;
    const gx = new Float32Array(n), gy = new Float32Array(n), gz = new Float32Array(n);
    for (let i = 0; i < n; i++) { const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; [gx[i], gy[i]] = G.toGrid(p); gz[i] = dot(p, Z) - zc; }
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k], b = I[k + 1], c = I[k + 2];
      const area = (gx[b] - gx[a]) * (gy[c] - gy[a]) - (gx[c] - gx[a]) * (gy[b] - gy[a]);
      if (Math.abs(area) < 1e-9) continue;
      const front = area < 0 ? 1 : -1; // the y-down grid flips the winding
      const bx0 = Math.max(0, Math.floor(Math.min(gx[a], gx[b], gx[c]))), bx1 = Math.min(W - 1, Math.ceil(Math.max(gx[a], gx[b], gx[c])));
      const by0 = Math.max(0, Math.floor(Math.min(gy[a], gy[b], gy[c]))), by1 = Math.min(H - 1, Math.ceil(Math.max(gy[a], gy[b], gy[c])));
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((gx[b] - px) * (gy[c] - py) - (gx[c] - px) * (gy[b] - py)) / area;
        const w1 = ((gx[c] - px) * (gy[a] - py) - (gx[a] - px) * (gy[c] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const i = y * W + x;
        mask[i] = 1;
        thick[i] += front * (w0 * gz[a] + w1 * gz[b] + w2 * gz[c]);
      }
    }
    for (let i = 0; i < W * H; i++) { thick[i] = clamp(Math.abs(thick[i]), 0, 0.08); if (mask[i]) G.union[i] = 1; G.thick[i] += thick[i]; }
    const f = t.frame;
    const A3 = f.a.map((v, k) => f.c[k] + v * f.tmin), B3 = f.a.map((v, k) => f.c[k] + v * f.tmax);
    const A2 = G.toGrid(A3), B2 = G.toGrid(B3);
    G.bones.push({ tpl: t, rec: t.rec, id: t.rec.id, mask, thick, A3, B3, A2, B2, len2: Math.hypot(B2[0] - A2[0], B2[1] - A2[1]), len3: f.length / cell });
  }
  return G;
}

// ---------- template silhouette profile (first-version detector) ----------
const N_BINS = 96;
function interp(arr, s) {
  const n = arr.length, x = clamp(s * n - 0.5, 0, n - 1), i = Math.floor(x), f = x - i;
  return i >= n - 1 ? arr[n - 1] : arr[i] * (1 - f) + arr[i + 1] * f;
}

// Silhouette profile of the skeleton bone as seen in a given projection (exact, by scan-converting triangles).
export function templateProfile(tpl, projection = 'AP') {
  if (tpl.profiles[projection]) return tpl.profiles[projection];
  const { c, a, ml, ap, tmin, length } = tpl.frame;
  const side = tpl.rec?.side === 'right' ? -1 : 1;
  const view = projection === 'LAT' ? [side, 0, 0] : [0, 0, 1];
  let obs = cross(view, a);
  obs = Math.hypot(...obs) < 0.2 ? (projection === 'LAT' ? ap : ml) : norm(obs);
  const depth = cross(a, obs);
  const P = tpl.pos, n = P.length / 3, I = tpl.index;
  const S = new Float32Array(n), O = new Float32Array(n), D = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]];
    S[i] = (dot(q, a) - tmin) / length; O[i] = dot(q, obs); D[i] = dot(q, depth);
  }
  const extent = (V) => {
    const lo = new Float32Array(N_BINS).fill(NaN), hi = new Float32Array(N_BINS).fill(NaN);
    const spans = Array.from({ length: N_BINS }, () => []);
    for (let t = 0; t < I.length; t += 3) {
      const ids = [I[t], I[t + 1], I[t + 2]];
      const ys = ids.map((i) => S[i] * N_BINS - 0.5), xs = ids.map((i) => V[i]);
      const r0 = Math.max(0, Math.ceil(Math.min(...ys))), r1 = Math.min(N_BINS - 1, Math.floor(Math.max(...ys)));
      for (let r = r0; r <= r1; r++) {
        let xmin = Infinity, xmax = -Infinity;
        for (let e = 0; e < 3; e++) {
          const y0 = ys[e], y1 = ys[(e + 1) % 3], x0 = xs[e], x1 = xs[(e + 1) % 3];
          if (r < Math.min(y0, y1) || r > Math.max(y0, y1)) continue;
          if (y1 === y0) { xmin = Math.min(xmin, x0, x1); xmax = Math.max(xmax, x0, x1); } else { const x = x0 + (x1 - x0) * (r - y0) / (y1 - y0); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); }
        }
        if (xmin === Infinity) continue;
        if (!(lo[r] <= xmin)) lo[r] = xmin; if (!(hi[r] >= xmax)) hi[r] = xmax;
        spans[r].push([xmin, xmax]);
      }
    }
    const occ = new Float32Array(N_BINS).fill(1);
    for (let r = 0; r < N_BINS; r++) {
      const sp = spans[r].sort((p, q) => p[0] - q[0]);
      if (!sp.length) continue;
      let cov = 0, [a0, b0] = sp[0];
      for (const [x0, x1] of sp.slice(1)) { if (x0 <= b0) b0 = Math.max(b0, x1); else { cov += b0 - a0; a0 = x0; b0 = x1; } }
      cov += b0 - a0;
      occ[r] = clamp(cov / Math.max(1e-9, hi[r] - lo[r]), 0, 1);
    }
    return [lo, hi, occ];
  };
  const [lo, hi, occ] = extent(O), [dlo, dhi] = extent(D);
  const fill = (arr) => {
    const out = Float32Array.from(arr);
    for (let i = 0; i < N_BINS; i++) if (!Number.isFinite(out[i])) {
      let j = i - 1; while (j >= 0 && !Number.isFinite(arr[j])) j--;
      let k = i + 1; while (k < N_BINS && !Number.isFinite(arr[k])) k++;
      out[i] = j < 0 ? arr[k] : k >= N_BINS ? arr[j] : arr[j] + (arr[k] - arr[j]) * (i - j) / (k - j);
    }
    const sm = Float32Array.from(out);
    for (let i = 1; i < N_BINS - 1; i++) sm[i] = (out[i - 1] + 2 * out[i] + out[i + 1]) / 4;
    return sm;
  };
  const prof = { length, lo: fill(lo), hi: fill(hi), dlo: fill(dlo), dhi: fill(dhi), occ, obs, depth };
  tpl.profiles[projection] = prof;
  return prof;
}

// Turn the first-version detector's image measurements into a fracture plane on the skeleton bone.
// The bone stays in skeleton space; only the image→bone correspondence from the template match is used.
export function fractureModelFromDetection(tpl, fr, M, projection, basis) {
  const prof = templateProfile(tpl, projection);
  const { c, a, tmin, length: L } = tpl.frame;
  const { U, Up } = basis;
  const s = clamp(fr.sTemplate, 0.02, 0.98);
  const t0 = tmin + s * L, slab = L * 0.02, P = tpl.pos;
  let cen = [0, 0, 0], n = 0;
  for (let i = 0; i < P.length; i += 3) {
    const p = [P[i], P[i + 1], P[i + 2]];
    if (Math.abs(dot([p[0] - c[0], p[1] - c[1], p[2] - c[2]], a) - t0) < slab) { cen = cen.map((v, k) => v + p[k]); n++; }
  }
  cen = n ? cen.map((v) => v / n) : a.map((v, k) => c[k] + v * t0);
  const width = Math.max(0.004, interp(prof.hi, s) - interp(prof.lo, s));
  const two = (v) => { const x = dot(v, U), y = dot(v, Up), l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const fs = M.flip ? -1 : 1, sg = M.sign;
  const dW = two(a), e1W = dW.map((v) => v * fs), pW = two(prof.obs).map((v) => v * sg);
  const phi = fr.obliquity || 0;
  const lW = [Math.cos(phi) * pW[0] + Math.sin(phi) * e1W[0], Math.cos(phi) * pW[1] + Math.sin(phi) * e1W[1]];
  let nW = [-lW[1], lW[0]]; if (nW[0] * dW[0] + nW[1] * dW[1] < 0) nW = [-nW[0], -nW[1]];
  const to3 = (w) => [0, 1, 2].map((k) => w[0] * U[k] + w[1] * Up[k]);
  const handed = e1W[0] * pW[1] - e1W[1] * pW[0];
  return {
    s, P3: cen, N3: to3(nW), lineDir3: to3(lW), perp3: to3(pW), width,
    gap: Math.max((fr.gapPx || 0) / M.k, 0.0012), shift: (fr.shiftPx || 0) / M.k,
    angulation: Math.sign(handed || 1) * (fr.angulation || 0) * Math.PI / 180,
  };
}

// ---------- fracture modelling: make the affected area look like a broken bone ----------
// The ORIGINAL skeleton bone is split along a jagged fracture surface (with a crack of the measured width);
// each broken end is closed with a rough fracture face (cortical rim, cancellous interior); small cortical
// chips sit in the gap; distal fragments are displaced as measured. Everything else is untouched.
const tri = (x) => { const f = x / (2 * Math.PI); const u = f - Math.floor(f); return 4 * Math.abs(u - 0.5) - 1; };
const hash3 = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), u = x - xi, v = y - yi, w = z - zi;
  const s = (t) => t * t * (3 - 2 * t), L = (p, q, t) => p + (q - p) * t, c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), s(u)), L(c(0, 1, 0), c(1, 1, 0), s(u)), s(v)), L(L(c(0, 0, 1), c(1, 0, 1), s(u)), L(c(0, 1, 1), c(1, 1, 1), s(u)), s(v)), s(w));
}
const rough = (p, f) => (vnoise(p[0] * f, p[1] * f, p[2] * f) * 0.65 + vnoise(p[0] * f * 2.7 + 5, p[1] * f * 2.7, p[2] * f * 2.7) * 0.35) * 2 - 1;

export function buildFracturedBone(THREE, tpl, fractures, basis) {
  const { U, Up, Z } = basis;
  const frs = fractures.slice().sort((a, b) => a.s - b.s);
  const P3 = Array.from(tpl.pos), COL = Array.from(tpl.col);
  const forced = new Map(), capW = new Map(); // vertex → fragment index / cap weight (for new geometry)
  for (const fr of frs) { fr.amp = fr.width * 0.14; fr.gh = Math.max(fr.gap / 2, 0.0006); }
  // jagged fracture surface: saw-toothed around the bone, irregular along it
  const gOf = (fr, x, y, z) => {
    const q = [x - fr.P3[0], y - fr.P3[1], z - fr.P3[2]];
    const th = Math.atan2(dot(q, Z), dot(q, fr.lineDir3));
    const teeth = 0.5 * tri(5 * th + 0.7) + 0.3 * tri(11 * th + 2.1) + 0.2 * Math.sin(23 * th + 0.4);
    return dot(q, fr.N3) + fr.amp * teeth + fr.width * 0.03 * rough([x, y, z], 900);
  };
  // loose fragments (butterfly / comminution pieces seen on the film): a wedge of the bone between the axial
  // levels the piece spans, on the side of the bone where it lies, as thick as it looks on the film
  const pieces = frs.flatMap((fr) => fr.fragments || []);
  const { c: FC, a: FA, tmin: FT, length: FL } = tpl.frame;
  const NB = 64, binC = Array.from({ length: NB }, () => [0, 0, 0, 0]);
  const binOf = (t) => clamp(Math.floor((t - FT) / FL * NB), 0, NB - 1);
  for (let i = 0; i < tpl.pos.length; i += 3) {
    const p = [tpl.pos[i], tpl.pos[i + 1], tpl.pos[i + 2]], b = binC[binOf(dot([p[0] - FC[0], p[1] - FC[1], p[2] - FC[2]], FA))];
    b[0] += p[0]; b[1] += p[1]; b[2] += p[2]; b[3]++;
  }
  const cenAt = binC.map((b, k) => (b[3] ? [b[0] / b[3], b[1] / b[3], b[2] / b[3]] : FA.map((v, m) => FC[m] + v * (FT + (k + 0.5) / NB * FL))));
  for (const pc of pieces) {
    pc.ext = new Float32Array(NB);
    for (let i = 0; i < tpl.pos.length; i += 3) {
      const p = [tpl.pos[i], tpl.pos[i + 1], tpl.pos[i + 2]], k = binOf(dot([p[0] - FC[0], p[1] - FC[1], p[2] - FC[2]], FA)), q = cenAt[k];
      pc.ext[k] = Math.max(pc.ext[k], dot([p[0] - q[0], p[1] - q[1], p[2] - q[2]], pc.sd3));
    }
  }
  const pieceG = (pc, x, y, z) => {
    const t = dot([x - FC[0], y - FC[1], z - FC[2]], FA), k = binOf(t), q = cenAt[k];
    const across = dot([x - q[0], y - q[1], z - q[2]], pc.sd3) - pc.ext[k] * (1 - 2 * pc.rho);
    return Math.min(t - pc.ta, pc.tb - t, across) + pc.width * 0.04 * rough([x, y, z], 700);
  };
  const cuts = [
    ...pieces.map((pc, k) => ({ kind: 'piece', k, pc, gh: 0.0005, g: (x, y, z) => pieceG(pc, x, y, z) })),
    ...frs.map((fr, fi) => ({ kind: 'frac', fi, fr, gh: fr.gh, g: (x, y, z) => gOf(fr, x, y, z) })),
  ];
  let tris = [];
  for (let k = 0; k < tpl.index.length; k += 3) tris.push([tpl.index[k], tpl.index[k + 1], tpl.index[k + 2]]);
  const cutSets = cuts.map(() => ({ '-1': new Set(), '1': new Set() }));
  let cut = 0;
  cuts.forEach((cu, fi) => {
    const fr = cu;
    const gc = new Map();
    const g = (i) => { if (!gc.has(i)) gc.set(i, cu.g(P3[i * 3], P3[i * 3 + 1], P3[i * 3 + 2])); return gc.get(i); };
    const edgeCache = new Map(); // shared vertices on shared edges → closed cut boundaries
    const newVert = (i, j, target) => {
      const key = `${Math.min(i, j)}_${Math.max(i, j)}_${target > 0 ? 1 : 0}`;
      if (edgeCache.has(key)) return edgeCache.get(key);
      const t = clamp((target - g(i)) / ((g(j) - g(i)) || 1e-12), 0, 1), id = P3.length / 3;
      for (let k = 0; k < 3; k++) { P3.push(P3[i * 3 + k] + (P3[j * 3 + k] - P3[i * 3 + k]) * t); COL.push(COL[i * 3 + k] + (COL[j * 3 + k] - COL[i * 3 + k]) * t); }
      gc.set(id, target); edgeCache.set(key, id); cutSets[fi][target > 0 ? '1' : '-1'].add(id);
      return id;
    };
    const clip = (poly, sgn) => {
      const out = [];
      for (let e = 0; e < poly.length; e++) {
        const i = poly[e], j = poly[(e + 1) % poly.length];
        const ini = sgn * g(i) >= fr.gh, inj = sgn * g(j) >= fr.gh;
        if (ini) out.push(i);
        if (ini !== inj) out.push(newVert(i, j, sgn * fr.gh));
      }
      return out;
    };
    const next = [];
    for (const t of tris) {
      const gs = t.map(g);
      if (gs.every((v) => v >= fr.gh) || gs.every((v) => v <= -fr.gh)) { next.push(t); continue; }
      cut++;
      for (const sgn of [-1, 1]) { const poly = clip(t, sgn); for (let k = 1; k + 1 < poly.length; k++) next.push([poly[0], poly[k], poly[k + 1]]); }
    }
    tris = next;
  });
  const fragOf = (i) => {
    if (forced.has(i)) return forced.get(i);
    const x = P3[i * 3], y = P3[i * 3 + 1], z = P3[i * 3 + 2];
    for (let k = 0; k < pieces.length; k++) if (pieceG(pieces[k], x, y, z) > 0) return 100 + k;
    let f = 0; for (const fr of frs) if (gOf(fr, x, y, z) > 0) f++; return f;
  };
  // rest centroid of every piece (its rotation centre)
  const pieceH = pieces.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < P3.length / 3; i++) { const f = fragOf(i); if (f >= 100) { const h = pieceH[f - 100]; h[0] += P3[i * 3]; h[1] += P3[i * 3 + 1]; h[2] += P3[i * 3 + 2]; h[3]++; } }
  pieces.forEach((pc, k) => { const h = pieceH[k]; pc.H = h[3] ? [h[0] / h[3], h[1] / h[3], h[2] / h[3]] : cenAt[binOf((pc.ta + pc.tb) / 2)]; pc.nVerts = h[3]; });

  // close every broken end with a rough fracture face
  const boundary = new Map(); // directed boundary edges a→b
  { const cnt = new Map(); for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p}_${q}` : `${q}_${p}`; cnt.set(k, (cnt.get(k) || 0) + 1); }
    for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p}_${q}` : `${q}_${p}`; if (cnt.get(k) === 1) boundary.set(p, q); } }
  const capTris = [], chips = [];
  cuts.forEach((cu, fi) => {
    const fr = cu.kind === 'frac' ? cu.fr : { width: cu.pc.width, N3: cu.pc.sd3 };
    for (const side of [-1, 1]) {
      const set = cutSets[fi][String(side)], seen = new Set();
      for (const start of set) {
        if (seen.has(start) || !boundary.has(start)) continue;
        const loop = []; let v = start, guard = 0;
        while (v !== undefined && !seen.has(v) && guard++ < 5000) { seen.add(v); loop.push(v); v = boundary.get(v); }
        if (loop.length < 5 || loop.filter((x) => set.has(x)).length < loop.length * 0.7) continue;
        const frag = fragOf(loop[0]);
        const C = [0, 0, 0]; for (const i of loop) for (let k = 0; k < 3; k++) C[k] += P3[i * 3 + k] / loop.length;
        // face points into the gap (a piece's faces point away from / towards the piece)
        const dir = cu.kind === 'frac' ? (side < 0 ? fr.N3 : fr.N3.map((x) => -x))
          : (() => { const v = norm(C.map((x, m) => (side > 0 ? x - cu.pc.H[m] : cu.pc.H[m] - x))); return Number.isFinite(v[0]) ? v : cu.pc.sd3; })();
        const add = (p, w) => { const id = P3.length / 3; P3.push(...p); COL.push(0.8, 0.7, 0.55); forced.set(id, frag); capW.set(id, w); return id; };
        const K = 3, rings = [loop];
        for (let k = 1; k <= K; k++) {
          const f = 1 - k / (K + 0.8);
          rings.push(loop.map((i) => {
            const p = [0, 1, 2].map((m) => C[m] + (P3[i * 3 + m] - C[m]) * f);
            const r = rough(p, 420) * fr.width * 0.09 * (0.6 + 0.4 * k / K);
            return add(p.map((x, m) => x + dir[m] * r), k === 1 ? 0.55 : 1);
          }));
        }
        const cr = rough(C, 420) * fr.width * 0.08;
        const center = add(C.map((x, m) => x + dir[m] * cr), 1);
        const out = [];
        for (let k = 0; k < K; k++) for (let j = 0; j < loop.length; j++) {
          const a = rings[k][j], b = rings[k][(j + 1) % loop.length], c = rings[k + 1][j], d = rings[k + 1][(j + 1) % loop.length];
          out.push([a, b, d], [a, d, c]);
        }
        for (let j = 0; j < loop.length; j++) out.push([rings[K][j], rings[K][(j + 1) % loop.length], center]);
        // orient to face the gap
        const [a, b, c] = out[out.length - 1].map((i) => [P3[i * 3], P3[i * 3 + 1], P3[i * 3 + 2]]);
        const nrm = cross(b.map((x, m) => x - a[m]), c.map((x, m) => x - a[m]));
        if (dot(nrm, dir) < 0) for (const t of out) t.reverse();
        capTris.push(...out);
        // a few cortical chips around the rim of the proximal break
        if (side < 0 && cu.kind === 'frac') for (let s = 0; s < 5; s++) {
          const i = loop[Math.floor(hash3(fi, s, 3) * loop.length)];
          const p = [P3[i * 3], P3[i * 3 + 1], P3[i * 3 + 2]];
          const out2 = norm(p.map((x, m) => x - C[m]));
          const size = fr.width * (0.07 + 0.08 * hash3(s, fi, 7));
          const pc = p.map((x, m) => x + out2[m] * size * 0.8 + dir[m] * (fr.gh + size * 0.6 * hash3(s, 2, fi)));
          chips.push({ pc, size, seed: fi * 10 + s, frag });
        }
      }
    }
  });
  for (const { pc, size, seed, frag } of chips) { // elongated, irregular octahedral splinters
    const ax1 = norm([hash3(seed, 1, 0) - 0.5, hash3(seed, 2, 0) - 0.5, hash3(seed, 3, 0) - 0.5]);
    const ax2 = norm(cross(ax1, [0.3, 1, 0.2])), ax3 = cross(ax1, ax2);
    const L = size * (1.2 + hash3(seed, 4, 0)), T = size * (0.35 + 0.25 * hash3(seed, 5, 0));
    const pts = [ax1.map((v) => v * L), ax1.map((v) => -v * L * 0.7), ax2.map((v) => v * T), ax2.map((v) => -v * T * 0.8), ax3.map((v) => v * T * 0.6), ax3.map((v) => -v * T * 0.5)];
    const ids = pts.map((d) => { const id = P3.length / 3; P3.push(pc[0] + d[0], pc[1] + d[1], pc[2] + d[2]); COL.push(0.74, 0.64, 0.47); forced.set(id, frag); capW.set(id, 0.15); return id; });
    const f = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]];
    for (const [a, b, c] of f) capTris.push([ids[a], ids[b], ids[c]]);
  }
  tris = tris.concat(capTris);

  const nv = P3.length / 3;
  const rest = new Float32Array(P3), pos = new Float32Array(P3);
  const fragment = new Float32Array(nv), fracture = new Float32Array(nv), cap = new Float32Array(nv);
  let moved = 0;
  for (let i = 0; i < nv; i++) {
    const x = P3[i * 3], y = P3[i * 3 + 1], z = P3[i * 3 + 2];
    const frag = fragOf(i);
    let fw = capW.has(i) ? 1 : 0;
    for (const fr of frs) fw = Math.max(fw, Math.exp(-((gOf(fr, x, y, z) / (0.35 * fr.width + fr.gap)) ** 2)));
    for (const pc of pieces) fw = Math.max(fw, Math.exp(-((pieceG(pc, x, y, z) / (0.3 * pc.width)) ** 2)));
    fragment[i] = frag >= 100 ? 2 : frag; fracture[i] = fw; cap[i] = capW.get(i) || 0;
    if (frag) moved++;
    let v = [x, y, z];
    if (frag >= 100) { // a loose piece: turned about its own centre and moved to where the film shows it (in the film plane)
      const pc = pieces[frag - 100], hx = dot(pc.H, U), hy = dot(pc.H, Up);
      const a = dot(v, U) - hx, b = dot(v, Up) - hy, zz = dot(v, Z), c = Math.cos(pc.rot), s = Math.sin(pc.rot);
      const ra = a * c - b * s + pc.target2[0], rb = a * s + b * c + pc.target2[1];
      v = [0, 1, 2].map((k2) => ra * U[k2] + rb * Up[k2] + zz * Z[k2]);
    }
    for (let k = frag >= 100 ? -1 : frag - 1; k >= 0; k--) {
      const fr = frs[k];
      const px = dot(fr.P3, U), py = dot(fr.P3, Up);
      const a = dot(v, U) - px, b = dot(v, Up) - py, zz = dot(v, Z);
      const c = Math.cos(fr.angulation), s = Math.sin(fr.angulation);
      const ra = a * c - b * s + px + fr.shift * dot(fr.perp3, U), rb = a * s + b * c + py + fr.shift * dot(fr.perp3, Up);
      v = [0, 1, 2].map((k2) => ra * U[k2] + rb * Up[k2] + zz * Z[k2]);
    }
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
  }
  const idx = tris.flat();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(COL), 3));
  geo.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
  geo.setAttribute('aFragment', new THREE.BufferAttribute(fragment, 1));
  geo.setAttribute('aFracture', new THREE.BufferAttribute(fracture, 1));
  geo.setAttribute('aCap', new THREE.BufferAttribute(cap, 1));
  geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  const nPieces = pieces.filter((pc) => pc.nVerts > 0).length;
  return { geometry: geo, info: { vertices: nv, triangles: idx.length / 3, cutTriangles: cut, fragments: frs.length + 1 + nPieces, pieces: nPieces, movedFraction: moved / nv, capTriangles: capTris.length, chips: chips.length } };
}

// Shaded canvas preview of meshes seen through the film (pipeline thumbnail), slightly turned.
export function renderMeshPreview(geos, basis, size = 280, yaw = 0.5) {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const g = cv.getContext('2d'); g.fillStyle = '#060a0b'; g.fillRect(0, 0, size, size);
  const { U, Up, Z } = basis;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const tris = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const geo of geos) {
    const P = geo.attributes.position.array, I = geo.index.array, F = geo.attributes.aFracture.array;
    const V = (i) => { const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]; const x = dot(p, U), y = dot(p, Up), z = dot(p, Z); return [x * cs + z * sn, y, -x * sn + z * cs]; };
    for (let t = 0; t < I.length; t += 3) {
      const a = V(I[t]), b = V(I[t + 1]), c = V(I[t + 2]);
      const nrm = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      const l = Math.hypot(...nrm) || 1;
      tris.push([(a[2] + b[2] + c[2]) / 3, a, b, c, Math.abs(nrm[2] / l) * 0.75 + 0.2, (F[I[t]] + F[I[t + 1]] + F[I[t + 2]]) / 3]);
      for (const p of [a, b, c]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    }
  }
  const sc = (size * 0.88) / Math.max(x1 - x0, y1 - y0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const X = (p) => size / 2 + (p[0] - mx) * sc, Y = (p) => size / 2 - (p[1] - my) * sc;
  tris.sort((p, q) => p[0] - q[0]);
  for (const [, a, b, c, s, f] of tris) {
    const k = Math.min(1, f * 1.3);
    g.fillStyle = `rgb(${((214 * (1 - k) + 255 * k) * s) | 0},${((196 * (1 - k) + 80 * k) * s) | 0},${((160 * (1 - k) + 60 * k) * s) | 0})`;
    g.beginPath(); g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); g.lineTo(X(c), Y(c)); g.closePath(); g.fill();
  }
  return cv;
}

// Place the detected fracture exactly where it appears on the X-ray: the film point and line are carried
// through the film ↔ skeleton registration onto the skeleton bone (same spot, same angle as on the film).
// Returns null when the registration is not trustworthy for this bone, so the caller can fall back.
export function fractureModelFromFilm(tpl, fr, T, G, basis, projection, reg) {
  const bone = G.bones.find((b) => b.id === tpl.rec.id);
  if (!bone || !reg || reg.chamferMM > 6) return null;
  const { U, Up } = basis;
  const prof = templateProfile(tpl, projection);
  const [gx, gy] = T.fwd(fr.point.x, fr.point.y);
  // image vectors → grid (linear part of the similarity) → film-plane world vectors
  const vec = (dx, dy) => { const [ax, ay] = T.fwd(dx, dy), [ox, oy] = T.fwd(0, 0); const x = ax - ox, y = -(ay - oy); const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  // position along the bone: project the film point on the bone's projected axis
  const ax2 = [bone.B2[0] - bone.A2[0], bone.B2[1] - bone.A2[1]], L2 = ax2[0] ** 2 + ax2[1] ** 2;
  const sRaw = ((gx - bone.A2[0]) * ax2[0] + (gy - bone.A2[1]) * ax2[1]) / L2;
  const off = Math.abs((gx - bone.A2[0]) * ax2[1] - (gy - bone.A2[1]) * ax2[0]) / Math.sqrt(L2); // cells from the axis
  const s = clamp(sRaw, 0.02, 0.98);
  const width = Math.max(0.004, interp(prof.hi, s) - interp(prof.lo, s));
  if (sRaw < -0.05 || sRaw > 1.05 || off * G.cell > width * 1.5) return null; // film point is not on this bone
  const { c, a, tmin, length: L } = tpl.frame, t0 = tmin + s * L, P = tpl.pos;
  let cen = [0, 0, 0], n = 0;
  for (let i = 0; i < P.length; i += 3) { const p = [P[i], P[i + 1], P[i + 2]]; if (Math.abs(dot([p[0] - c[0], p[1] - c[1], p[2] - c[2]], a) - t0) < L * 0.02) { cen = cen.map((v, k) => v + p[k]); n++; } }
  cen = n ? cen.map((v) => v / n) : a.map((v, k) => c[k] + v * t0);
  // put the plane through the film point itself (in-plane), keeping the bone's depth
  const [wx, wy] = G.toWorld2(gx, gy), cu = dot(cen, U), cv = dot(cen, Up);
  const P3 = cen.map((v, k) => v + (wx - cu) * U[k] + (wy - cv) * Up[k]);
  const lW = vec(fr.dir.x, fr.dir.y), dW = (() => { const x = dot(a, U), y = dot(a, Up), l = Math.hypot(x, y) || 1; return [x / l, y / l]; })();
  let nW = [-lW[1], lW[0]]; if (nW[0] * dW[0] + nW[1] * dW[1] < 0) nW = [-nW[0], -nW[1]];
  // image bone axis e1 / perpendicular p (as measured by the detector) mapped to the film plane
  const e1W = vec(fr.axis?.ex ?? 0, fr.axis?.ey ?? 1), pW = vec(fr.axis?.px ?? 1, fr.axis?.py ?? 0);
  const to3 = (w) => [0, 1, 2].map((k) => w[0] * U[k] + w[1] * Up[k]);
  const mPerPx = T.s * G.cell, handed = e1W[0] * pW[1] - e1W[1] * pW[0];
  // separate fragments on the film -> pieces carved from this bone where they came from, moved to where they are
  const sOnAxis = (q) => { const [x, y] = T.fwd(q.x, q.y); return ((x - bone.A2[0]) * ax2[0] + (y - bone.A2[1]) * ax2[1]) / L2; };
  const fragments = (fr.fragments || []).map((fg) => {
    const ss = fg.outline.map(sOnAxis);
    let sa = clamp(Math.min(...ss), 0.02, 0.98), sb = clamp(Math.max(...ss), 0.02, 0.98);
    if (sb - sa < 0.02) { const m = (sa + sb) / 2; sa = m - 0.01; sb = m + 0.01; }
    const [tx, ty] = T.fwd(fg.centroid.x, fg.centroid.y), target2 = G.toWorld2(tx, ty);
    const fW = vec(fg.dir.x, fg.dir.y);
    let rot = Math.atan2(dW[0] * fW[1] - dW[1] * fW[0], dW[0] * fW[0] + dW[1] * fW[1]);
    if (rot > Math.PI / 2) rot -= Math.PI; else if (rot < -Math.PI / 2) rot += Math.PI; // a fragment's axis has no direction
    return {
      ta: tmin + sa * L, tb: tmin + sb * L, sRange: [sa, sb], sd3: to3(pW).map((v) => v * fg.side),
      rho: clamp(fg.widPx / Math.max(1, fg.boneWidthPx), 0.2, 0.6), target2, rot: clamp(rot, -0.7, 0.7), width,
    };
  });
  return {
    s, P3, N3: to3(nW), lineDir3: to3(lW), perp3: to3(pW), width,
    gap: Math.max((fr.gapPx || 0) * mPerPx, 0.0012), shift: (fr.shiftPx || 0) * mPerPx,
    angulation: Math.sign(handed || 1) * (fr.angulation || 0) * Math.PI / 180,
    placement: 'film', sFilm: sRaw, fragments,
  };
}
