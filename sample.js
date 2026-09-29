// Synthetic radiograph of one or more generic bones (e.g. radius + ulna), each with any number of
// simulated fractures. Used for demos and for testing the pipeline without patient data.
// Method: orthographic ray casting through the skeleton meshes (signed chord accumulation), a hollowed
// inner copy for the medullary canal, a soft-tissue envelope and film noise.
import { viewBasis } from './reconstruction.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

// tpls: templates in the film; fractures: { boneId: [{ s, obliquityDeg, shift (m), angulationDeg, gap (m),
//   butterfly?: { len (fraction of bone), side (±1), rho (0..1 of the width), move: [outward, along] (m), rotDeg } }] }
// pose: { boneId: degrees } turns that bone in the film plane about its proximal end (a joint at another angle
//   than the reference skeleton's), to test registration of joint films. { deg, about: boneId } turns it about
//   another bone's proximal end; { deg, aboutDistal: boneId } about another bone's distal end (the joint centre:
//   forearm about the end of the humerus, lower leg about the end of the femur).
export function makeSyntheticXray(tpls, opts = {}) {
  const projection = opts.projection || 'AP';
  const side = tpls.find((t) => t.rec.side !== 'mid')?.rec.side || 'left';
  const { U, Up, Z } = viewBasis(projection, side);
  const fractures = opts.fractures || {};
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of tpls) for (let i = 0; i < t.pos.length; i += 3) {
    const p = [t.pos[i], t.pos[i + 1], t.pos[i + 2]];
    x0 = Math.min(x0, dot(p, U)); x1 = Math.max(x1, dot(p, U)); y0 = Math.min(y0, dot(p, Up)); y1 = Math.max(y1, dot(p, Up));
  }
  const spanX = x1 - x0, spanY = y1 - y0;
  const H = opts.height || 620;
  const W = Math.round(clamp(H * Math.max(0.5, (spanX + 0.35 * Math.min(spanY, spanX * 3 + 0.05)) / (spanY * 1.15)), 300, 900));
  const scale = Math.min((H * 0.86) / spanY, (W * 0.78) / spanX);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const toPx = (x, y) => [W / 2 + (x - mx) * scale, H / 2 - (y - my) * scale];
  const boneT = new Float32Array(W * H), cover = new Uint8Array(W * H);
  // proximal-end centre of every bone (pose pivots; a pose may turn a bone about another bone's end, e.g. the forearm)
  const ends = {};
  for (const t of tpls) {
    const { c, a, tmin, length: L } = t.frame, P = t.pos; const acc = [[0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < P.length; i += 3) {
      const p = [P[i], P[i + 1], P[i + 2]], s = (dot([p[0] - c[0], p[1] - c[1], p[2] - c[2]], a) - tmin) / L;
      const k = s < 1 / 32 ? 0 : s > 31 / 32 ? 1 : -1; if (k < 0) continue;
      acc[k][0] += dot(p, U); acc[k][1] += dot(p, Up); acc[k][2]++;
    }
    ends[t.rec.id] = acc.map((q) => (q[2] ? [q[0] / q[2], q[1] / q[2]] : [0, 0])); // [proximal, distal] end centres
  }
  const lines = [], truthEnds = {};

  for (const t of tpls) {
    const { c, a, tmin, length: L } = t.frame;
    const P = t.pos, n = P.length / 3, I = t.index;
    const NB = 48, cen = Array.from({ length: NB }, () => [0, 0, 0, 0]), sOf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = (dot([P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]], a) - tmin) / L; sOf[i] = s;
      const b = cen[clamp(Math.floor(s * NB), 0, NB - 1)];
      b[0] += P[i * 3]; b[1] += P[i * 3 + 1]; b[2] += P[i * 3 + 2]; b[3]++;
    }
    for (const b of cen) if (b[3]) { b[0] /= b[3]; b[1] /= b[3]; b[2] /= b[3]; }
    const rad = new Float32Array(NB), rc = new Float32Array(NB);
    for (let i = 0; i < n; i++) {
      const k = clamp(Math.floor(sOf[i] * NB), 0, NB - 1), b = cen[k];
      rad[k] += Math.hypot(P[i * 3] - b[0], P[i * 3 + 1] - b[1], P[i * 3 + 2] - b[2]); rc[k]++;
    }
    const zc = dot(c, Z);
    const pv = (opts.pose || {})[t.rec.id], pd = ((typeof pv === 'object' ? pv.deg : pv) || 0) * Math.PI / 180, pc = Math.cos(pd), ps = Math.sin(pd);
    const piv = typeof pv === 'object' && pv.aboutDistal && ends[pv.aboutDistal] ? ends[pv.aboutDistal][1]
      : typeof pv === 'object' && pv.about && ends[pv.about] ? ends[pv.about][0] : ends[t.rec.id][0];
    const pose = (x, y) => [piv[0] + (x - piv[0]) * pc - (y - piv[1]) * ps, piv[1] + (x - piv[0]) * ps + (y - piv[1]) * pc];
    const poseV = (v) => [v[0] * pc - v[1] * ps, v[0] * ps + v[1] * pc];
    { const f = t.frame, A3 = f.a.map((v, k) => f.c[k] + v * f.tmin), B3 = f.a.map((v, k) => f.c[k] + v * f.tmax);
      truthEnds[t.rec.id] = [A3, B3].map((p) => toPx(...pose(dot(p, U), dot(p, Up)))); } // true film position of the bone's axis ends
    const V = (i, inner) => {
      let p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
      if (inner) { const b = cen[clamp(Math.floor(sOf[i] * NB), 0, NB - 1)]; p = p.map((v, k) => b[k] + (v - b[k]) * 0.58); }
      return [...pose(dot(p, U), dot(p, Up)), dot(p, Z) - zc];
    };
    // fractures of this bone, proximal → distal, as lines in the film plane
    const frs = (fractures[t.rec.id] || []).slice().sort((p, q) => p.s - q.s).map((f) => {
      const b = cen[clamp(Math.floor(f.s * NB), 0, NB - 1)];
      let ax = [dot(a, U), dot(a, Up)]; const al = Math.hypot(...ax); ax = [ax[0] / al, ax[1] / al];
      const ob = (f.obliquityDeg || 0) * Math.PI / 180;
      const k = clamp(Math.floor(f.s * NB), 0, NB - 1);
      return { ...f, halfWidth: f.halfWidth || (rc[k] ? (rad[k] / rc[k]) * 0.9 : 0.01), Pf: pose(dot(b, U), dot(b, Up)), nrm: poseV([ax[0] * Math.cos(ob) - ax[1] * Math.sin(ob), ax[0] * Math.sin(ob) + ax[1] * Math.cos(ob)]), perp: poseV([ax[1], -ax[0]]), ang: (f.angulationDeg || 0) * Math.PI / 180 };
    });
    const fragOf = (x, y) => frs.reduce((k, f) => k + ((x - f.Pf[0]) * f.nrm[0] + (y - f.Pf[1]) * f.nrm[1] > 0 ? 1 : 0), 0);
    const move = (x, y, frag) => {
      for (let k = frag - 1; k >= 0; k--) {
        const f = frs[k], dx = x - f.Pf[0], dy = y - f.Pf[1], ca = Math.cos(f.ang), sa = Math.sin(f.ang);
        x = f.Pf[0] + dx * ca - dy * sa + f.perp[0] * (f.shift || 0);
        y = f.Pf[1] + dx * sa + dy * ca + f.perp[1] * (f.shift || 0);
      }
      return [x, y];
    };
    const outer = new Float32Array(W * H), inner = new Float32Array(W * H), innerW = new Float32Array(W * H);
    for (const [buf, isInner] of [[outer, false], [inner, true]]) {
      for (let k = 0; k < I.length; k += 3) {
        const ids = [I[k], I[k + 1], I[k + 2]];
        let pts = ids.map((i) => V(i, isInner));
        if (frs.length) {
          const fr = fragOf((pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3);
          if (fr) pts = pts.map(([x, y, z]) => [...move(x, y, fr), z]);
        }
        const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], e2 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1]];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (Math.abs(nz) < 1e-14) continue;
        const front = nz > 0 ? 1 : -1;
        const S = pts.map(([x, y]) => toPx(x, y));
        const bx0 = Math.max(0, Math.floor(Math.min(S[0][0], S[1][0], S[2][0]))), bx1 = Math.min(W - 1, Math.ceil(Math.max(S[0][0], S[1][0], S[2][0])));
        const by0 = Math.max(0, Math.floor(Math.min(S[0][1], S[1][1], S[2][1]))), by1 = Math.min(H - 1, Math.ceil(Math.max(S[0][1], S[1][1], S[2][1])));
        const area = (S[1][0] - S[0][0]) * (S[2][1] - S[0][1]) - (S[2][0] - S[0][0]) * (S[1][1] - S[0][1]);
        if (Math.abs(area) < 1e-9) continue;
        const wIn = smooth(0.14, 0.26, sOf[ids[0]]) * (1 - smooth(0.74, 0.86, sOf[ids[0]])) * 0.85 + 0.15;
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((S[1][0] - px) * (S[2][1] - py) - (S[2][0] - px) * (S[1][1] - py)) / area;
          const w1 = ((S[2][0] - px) * (S[0][1] - py) - (S[0][0] - px) * (S[2][1] - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          buf[y * W + x] += front * (w0 * pts[0][2] + w1 * pts[1][2] + w2 * pts[2][2]);
          if (isInner) innerW[y * W + x] = Math.max(innerW[y * W + x], wIn);
        }
      }
    }
    let tb = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const to = clamp(outer[i], 0, 0.06), ti = clamp(inner[i], 0, 0.06);
      tb[i] = Math.max(0, to - 0.82 * innerW[i] * ti);
    }
    for (const f of frs.filter((q) => q.butterfly)) { // butterfly: a wedge of cortex on one side, displaced
      const B = f.butterfly, sd = B.side || 1, k = clamp(Math.floor(f.s * NB), 0, NB - 1), hw = rc[k] ? rad[k] / rc[k] : 0.01;
      const ax = [-f.perp[1], f.perp[0]], halfL = (B.len * L) / 2, lim = hw * (1 - 2 * (B.rho ?? 0.35));
      const ctr = [f.Pf[0] + f.perp[0] * sd * (lim + hw) / 2, f.Pf[1] + f.perp[1] * sd * (lim + hw) / 2];
      const inWedge = (x, y) => { const dx = x - f.Pf[0], dy = y - f.Pf[1]; return Math.abs(dx * ax[0] + dy * ax[1]) < halfL && (dx * f.perp[0] + dy * f.perp[1]) * sd > lim; };
      const ca = Math.cos((B.rotDeg || 0) * Math.PI / 180), sa = Math.sin((B.rotDeg || 0) * Math.PI / 180);
      const out = Float32Array.from(tb);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const wx = (x - W / 2) / scale + mx, wy = -(y - H / 2) / scale + my; if (inWedge(wx, wy)) out[y * W + x] = 0; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { // inverse map: where did this pixel of the moved piece come from?
        const mv = [f.perp[0] * sd * B.move[0] + ax[0] * B.move[1], f.perp[1] * sd * B.move[0] + ax[1] * B.move[1]]; // outward, along the bone
        const wx = (x - W / 2) / scale + mx - mv[0] - ctr[0], wy = -(y - H / 2) / scale + my - mv[1] - ctr[1];
        const sx = ctr[0] + ca * wx + sa * wy, sy = ctr[1] - sa * wx + ca * wy;
        if (!inWedge(sx, sy)) continue;
        const [px, py] = toPx(sx, sy), xi = Math.round(px), yi = Math.round(py);
        if (xi >= 0 && yi >= 0 && xi < W && yi < H) out[y * W + x] = Math.max(out[y * W + x], tb[yi * W + xi]);
      }
      tb = out;
    }
    for (let i = 0; i < W * H; i++) { boneT[i] += tb[i]; if (tb[i] > 0.002) cover[i] = 1; }
    for (const f of frs) lines.push({ ...f, bone: t.rec.id });
  }

  const rnd = mulberry32(opts.seed || 7);
  const img = new Float32Array(W * H);
  const cxw = (x0 + x1) / 2, R = Math.max(spanX * 0.62, 0.035);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const wx = (x - W / 2) / scale + mx, wy = -(y - H / 2) / scale + my;
    const along = (wy - my) / (spanY / 2), Rr = R * (1 - 0.12 * along * along);
    const tissue = Math.abs(wx - cxw) < Rr ? Math.sqrt(1 - ((wx - cxw) / Rr) ** 2) : 0;
    img[i] = 0.06 + 0.9 * (1 - Math.exp(-(72 * boneT[i] + 0.6 * tissue))) + (rnd() - 0.5) * 0.035;
  }
  // radiolucent fracture lines (only across the fractured bone)
  for (const f of lines) {
    const [pfx, pfy] = toPx(...f.Pf);
    const nx = f.nrm[0], ny = -f.nrm[1];
    const gapPx = Math.max(1.2, (f.gap || 0.0015) * scale), halfLen = (f.halfWidth || 0.016) * scale;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!cover[i]) continue;
      const d = (x - pfx) * nx + (y - pfy) * ny;
      if (Math.abs(d) > gapPx * 4) continue;
      if (Math.abs((x - pfx) * ny - (y - pfy) * nx) > halfLen) continue;
      const k = Math.exp(-((d / gapPx) ** 2));
      img[i] = img[i] * (1 - 0.62 * k) + 0.12 * k;
    }
  }
  const blur = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, cnt = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const wgt = dx || dy ? 1 : 2; s += img[clamp(y + dy, 0, H - 1) * W + clamp(x + dx, 0, W - 1)] * wgt; cnt += wgt;
    }
    blur[y * W + x] = s / cnt;
  }
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), d = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { const v = clamp(Math.pow(blur[i], 1.15), 0, 1) * 255; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; }
  g.putImageData(d, 0, 0);
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold 28px Arial';
  g.fillText(side === 'right' ? 'R' : 'L', projection === 'AP' && side !== 'right' ? W - 40 : 16, 40);
  g.font = '12px monospace'; g.fillStyle = 'rgba(255,255,255,0.55)';
  const nfx = lines.length;
  g.fillText(`SYNTHETIC ${projection} · ${tpls.map((t) => t.rec.name.toUpperCase()).join(' + ')}${nfx ? ` · ${nfx} SIMULATED FRACTURE${nfx > 1 ? 'S' : ''}` : ''}`, 12, H - 12, W - 24);
  return { canvas: cv, truthEnds, truth: lines.map(({ bone, s, obliquityDeg, shift, angulationDeg }) => ({ bone, s, obliquityDeg, shift, angulationDeg })) };
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
