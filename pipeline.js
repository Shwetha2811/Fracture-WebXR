// X-ray analysis pipeline (in-browser engine). Mirrors backend/ stage by stage:
//   preprocessing → bone segmentation → anatomical identification → fracture detection →
//   fracture segmentation → depth estimation → point cloud
// Film ↔ skeleton registration lives in registration.js, skeleton projection and fracture modelling in reconstruction.js.
//
// Everything here is classical, deterministic image analysis. It is a research prototype:
// a single radiograph is a 2D projection, so any depth produced below is ESTIMATED, not measured.

import { projectBones } from './reconstruction.js';
import { registerFilm, warpToGrid, makeFilmTransform, distanceTransform, refineBones, warpFilmToSkeleton, boneTransform, applyCorr, boundaryPoints, registerArticulated } from './registration.js';

// ---------- small image helpers ----------
const img = (w, h, data = new Float32Array(w * h)) => ({ w, h, data });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}
function median(arr) { return arr.length ? percentile(arr, 0.5) : NaN; }

export async function loadImage(src) {
  if (src instanceof HTMLCanvasElement) return src;
  // decode to a canvas (works in background tabs, where <img>.decode() can stall)
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

// Crop (normalized roi) + downscale to the analysis resolution; returns colour canvas + grey image.
function rasterize(source, roi, maxSide, invert) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const r = roi || { x: 0, y: 0, w: 1, h: 1 };
  const cx = Math.round(r.x * sw), cy = Math.round(r.y * sh), cw = Math.max(8, Math.round(r.w * sw)), ch = Math.max(8, Math.round(r.h * sh));
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const w = Math.max(8, Math.round(cw * s)), h = Math.max(8, Math.round(ch * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, cx, cy, cw, ch, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const out = img(w, h);
  for (let i = 0; i < w * h; i++) {
    const l = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    out.data[i] = invert ? 1 - l : l;
  }
  return { canvas, grey: out, scale: s, crop: { x: cx, y: cy, w: cw, h: ch }, source: { w: sw, h: sh } };
}

function gaussian(src, sigma) {
  const { w, h } = src, r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = img(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * src.data[y * w + clamp(x + i, 0, w - 1)];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * tmp[clamp(y + i, 0, h - 1) * w + x];
    out.data[y * w + x] = a;
  }
  return out;
}

function normalize(src, lo = 0.01, hi = 0.995) {
  const a = percentile(src.data, lo), b = percentile(src.data, hi);
  const out = img(src.w, src.h);
  for (let i = 0; i < src.data.length; i++) out.data[i] = clamp((src.data[i] - a) / Math.max(1e-6, b - a), 0, 1);
  return out;
}

// Contrast-limited adaptive histogram equalization (tiles × tiles, bilinear between tile maps).
function clahe(src, tiles = 8, clip = 2.5, bins = 128) {
  const { w, h } = src, tw = w / tiles, th = h / tiles;
  const maps = [];
  for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
    const hist = new Float32Array(bins);
    const x0 = Math.floor(tx * tw), x1 = Math.floor((tx + 1) * tw), y0 = Math.floor(ty * th), y1 = Math.floor((ty + 1) * th);
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[Math.min(bins - 1, Math.floor(src.data[y * w + x] * bins))]++; n++; }
    const limit = Math.max(1, (clip * n) / bins);
    let excess = 0;
    for (let b = 0; b < bins; b++) if (hist[b] > limit) { excess += hist[b] - limit; hist[b] = limit; }
    for (let b = 0; b < bins; b++) hist[b] += excess / bins;
    const cdf = new Float32Array(bins);
    let acc = 0;
    for (let b = 0; b < bins; b++) { acc += hist[b]; cdf[b] = acc / Math.max(1, n); }
    maps.push(cdf);
  }
  const out = img(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src.data[y * w + x], b = Math.min(bins - 1, Math.floor(v * bins));
    const fx = clamp(x / tw - 0.5, 0, tiles - 1), fy = clamp(y / th - 0.5, 0, tiles - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(tiles - 1, x0 + 1), y1 = Math.min(tiles - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const m = (tx, ty) => maps[ty * tiles + tx][b];
    out.data[y * w + x] = (m(x0, y0) * (1 - ax) + m(x1, y0) * ax) * (1 - ay) + (m(x0, y1) * (1 - ax) + m(x1, y1) * ax) * ay;
  }
  return out;
}

function otsu(data) {
  const bins = 256, hist = new Float64Array(bins);
  for (const v of data) hist[Math.min(bins - 1, Math.floor(v * bins))]++;
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 0.5;
  for (let t = 0; t < bins; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = (t + 0.5) / bins; }
  }
  return thr;
}

function boxMean(src, r) {
  const { w, h } = src, I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src.data[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = img(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    out.data[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

// Binary morphology with a square structuring element (separable running max/min).
function morph(mask, w, h, r, dilate) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pass = (src, dst, horizontal) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) for (let i = 0; i < len; i++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r && v === (dilate ? 0 : 1); k++) {
        const j = i + k;
        const s = j < 0 || j >= len ? 0 : horizontal ? src[l * w + j] : src[j * w + l];
        if (dilate ? s : !s) v = dilate ? 1 : 0;
      }
      if (horizontal) dst[l * w + i] = v; else dst[i * w + l] = v;
    }
  };
  pass(mask, tmp, true); pass(tmp, out, false);
  return out;
}
const close = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);
const open = (m, w, h, r) => morph(morph(m, w, h, r, false), w, h, r, true);

function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (!seen[i] && !mask[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

function components(mask, w, h) {
  const lab = new Int32Array(w * h).fill(-1), comps = [], stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const c = { id: comps.length, area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, pixels: [] };
    lab[s] = c.id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      c.area++; c.sx += x; c.sy += y; c.sxx += x * x; c.syy += y * y; c.sxy += x * y; c.pixels.push(i);
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && mask[j] && lab[j] < 0) { lab[j] = c.id; stack.push(j); }
    }
    comps.push(c);
  }
  for (const c of comps) Object.assign(c, pca2(c));
  return comps;
}

function pca2(c) {
  const mx = c.sx / c.area, my = c.sy / c.area;
  const cxx = c.sxx / c.area - mx * mx, cyy = c.syy / c.area - my * my, cxy = c.sxy / c.area - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let ex = cxy, ey = l1 - cxx;
  if (Math.hypot(ex, ey) < 1e-9) { ex = cxx >= cyy ? 1 : 0; ey = cxx >= cyy ? 0 : 1; }
  const n = Math.hypot(ex, ey);
  ex /= n; ey /= n;
  if (ey < 0 || (Math.abs(ey) < 1e-6 && ex < 0)) { ex = -ex; ey = -ey; } // canonical: axis points down the image
  return { cx: mx, cy: my, ex, ey, l1, l2, elong: Math.sqrt(l1 / Math.max(1e-6, l2)) };
}

// ---------- canvas rendering of stage outputs ----------
function greyCanvas(im, tint) {
  const c = document.createElement('canvas'); c.width = im.w; c.height = im.h;
  const g = c.getContext('2d'), d = g.createImageData(im.w, im.h);
  for (let i = 0; i < im.w * im.h; i++) {
    const v = clamp(im.data[i], 0, 1) * 255;
    d.data[i * 4] = v * (tint?.[0] ?? 1); d.data[i * 4 + 1] = v * (tint?.[1] ?? 1); d.data[i * 4 + 2] = v * (tint?.[2] ?? 1); d.data[i * 4 + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  return c;
}
function overlayCanvas(base, layers) { // layers: [{mask, rgb, alpha}]
  const c = greyCanvas(base, [0.85, 0.9, 0.9]);
  const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height);
  for (const { mask, rgb, alpha } of layers) {
    for (let i = 0; i < mask.length; i++) if (mask[i]) for (let k = 0; k < 3; k++) d.data[i * 4 + k] = d.data[i * 4 + k] * (1 - alpha) + rgb[k] * alpha;
  }
  g.putImageData(d, 0, 0);
  return c;
}
function outline(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) out[i] = 1;
  }
  return out;
}
// Perceptual colour ramp (dark teal → cyan → bone → white) for depth maps.
function ramp(t) {
  const stops = [[0, [8, 28, 34]], [0.35, [26, 110, 122]], [0.65, [127, 211, 222]], [0.85, [214, 198, 162]], [1, [255, 250, 240]]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) { const k = (t - a) / (b - a); return ca.map((v, j) => v + (cb[j] - v) * k); }
  }
  return stops[stops.length - 1][1];
}

// ---------- template matching (first-version detector) ----------
const N_SLICES = 96;
function interp(arr, s) {
  const n = arr.length, x = clamp(s * n - 0.5, 0, n - 1), i = Math.floor(x), f = x - i;
  return i >= n - 1 ? arr[n - 1] : arr[i] * (1 - f) + arr[i + 1] * f;
}
function fillNaN(arr) {
  const out = Float32Array.from(arr), n = out.length;
  const valid = []; for (let i = 0; i < n; i++) if (Number.isFinite(out[i])) valid.push(i);
  if (!valid.length) return out;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(out[i])) continue;
    let a = -1, b = -1;
    for (const v of valid) { if (v < i) a = v; if (v > i) { b = v; break; } }
    out[i] = a < 0 ? arr[b] : b < 0 ? arr[a] : arr[a] + (arr[b] - arr[a]) * (i - a) / (b - a);
  }
  return out;
}

// Search coverage [s0, s0 + c], axis flip and mirror sign so the template silhouette best explains the X-ray.
export function matchProfile(P, T, cover, opts = {}) {
  const N = P.lo.length, LP = P.length;
  const valid = []; for (let i = 0; i < N; i++) if (Number.isFinite(P.lo[i]) && P.cov[i] > 0.5) valid.push(i);
  if (valid.length < 8) return null;
  const evalParams = (c, s0, flip, sign) => {
    const k = LP / (c * T.length);
    const lo = new Float32Array(N), hi = new Float32Array(N);
    const xs = [], ds = [];
    for (const i of valid) {
      const sP = (i + 0.5) / N, u = flip ? 1 - sP : sP, sT = s0 + u * c;
      const a = interp(T.lo, sT) * k, b = interp(T.hi, sT) * k;
      lo[i] = sign > 0 ? a : -b; hi[i] = sign > 0 ? b : -a;
      xs.push(sP); ds.push((P.lo[i] + P.hi[i]) / 2 - (lo[i] + hi[i]) / 2);
    }
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = 0; j < xs.length; j++) { sx += xs[j]; sy += ds[j]; sxx += xs[j] ** 2; sxy += xs[j] * ds[j]; }
    const n = xs.length, den = n * sxx - sx * sx;
    const b1 = Math.abs(den) > 1e-9 ? (n * sxy - sx * sy) / den : 0, b0 = (sy - b1 * sx) / n;
    const errs = [];
    for (const i of valid) { const d = b0 + b1 * (i + 0.5) / N; errs.push((Math.abs(P.lo[i] - lo[i] - d) + Math.abs(P.hi[i] - hi[i] - d)) / (2 * LP)); }
    errs.sort((x, y) => x - y);
    const keep = errs.slice(0, Math.max(4, Math.floor(errs.length * 0.8)));
    let err = keep.reduce((s, e) => s + e, 0) / keep.length;
    if (cover) err += 0.012 * (Math.abs(s0 - cover[0]) + Math.abs(s0 + c - cover[1]));
    err += 0.003 * (1 - c);
    return { err, c, s0, flip, sign, k, trend: [b0, b1] };
  };
  let best = null;
  const consider = (r) => { if (!best || r.err < best.err) best = r; };
  // opts.range: coverage known geometrically (joint films) — search only near it
  const inRange = (c, s0) => !opts.range || (Math.abs(c - opts.range.c) <= 0.05 && Math.abs(s0 - opts.range.s0) <= 0.05);
  const cs = opts.range ? [opts.range.c - 0.04, opts.range.c - 0.02, opts.range.c, opts.range.c + 0.02, opts.range.c + 0.04].filter((c) => c >= 0.3 && c <= 1) : [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  for (const c of cs) for (let s0 = 0; s0 <= 1 - c + 1e-6; s0 += opts.range ? 0.01 : 0.025)
    if (inRange(c, s0)) for (const flip of opts.flip === undefined ? [false, true] : [opts.flip]) for (const sign of [1, -1]) consider(evalParams(c, s0, flip, sign));
  if (!best) return null;
  const coarse = best;
  for (let c = coarse.c - 0.06; c <= coarse.c + 0.06; c += 0.01) {
    if (c < 0.3 || c > 1) continue;
    for (let s0 = coarse.s0 - 0.03; s0 <= coarse.s0 + 0.03; s0 += 0.005) {
      if (s0 < 0 || s0 + c > 1 + 1e-6 || !inRange(c, s0)) continue;
      consider(evalParams(c, s0, coarse.flip, coarse.sign));
    }
  }
  best.score = clamp(1 - best.err / 0.06, 0, 1);
  return best;
}

// ---------- the pipeline ----------
// params: { roi, invert, projection, basis, tpls (region bones of the side), candidates [{id, name, cover, profile}],
//           focusId, marks: [{u, v}] }
export async function runImagePipeline(source, params, report) {
  const stages = {};
  const done = async (id, data) => { stages[id] = data; await report?.(id, data); };

  // 1. Preprocessing
  const r = rasterize(source, params.roi, params.maxSide || 560, params.invert);
  const { w, h } = r.grey;
  const norm = normalize(r.grey);
  const den = gaussian(norm, 1.1);
  const enh = clahe(den, 8, 2.2);
  await done('preprocess', {
    title: 'Preprocessing', basis: 'observed',
    summary: `${r.source.w}×${r.source.h} → ${w}×${h} px · percentile normalisation · Gaussian denoise · CLAHE`,
    image: greyCanvas(enh),
    metrics: [['Analysis size', `${w}×${h}`], ['Crop', params.roi ? 'user ROI' : 'full image'], ['Inverted', params.invert ? 'yes' : 'no']],
  });

  // 2. Bone segmentation (first version): Otsu body/air + max-edge-contrast bone threshold, main bone + collinear fragments
  const t1 = otsu(den.data);
  const gx = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, d = den.data;
    const sx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
    const sy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
    gx[i] = Math.hypot(sx, sy);
  }
  let thr = t1, bestEdge = -1;
  for (let t = Math.min(0.9, t1 + 0.04); t < 0.95; t += 0.02) {
    let sum = 0, cnt = 0, area = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x, a = den.data[i] > t;
      if (a) area++;
      if (a !== (den.data[i + 1] > t) || a !== (den.data[i + w] > t)) { sum += gx[i]; cnt++; }
    }
    if (area < w * h * 0.004 || cnt < 40) continue;
    if (sum / cnt > bestEdge) { bestEdge = sum / cnt; thr = t; }
  }
  const local = boxMean(den, Math.round(Math.max(w, h) / 14));
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = den.data[i] > thr && den.data[i] > local.data[i] * 0.92 ? 1 : 0;
  mask = open(mask, w, h, 1);
  mask = close(mask, w, h, 3);
  mask = fillHoles(mask, w, h);
  const compsAll = components(mask, w, h).filter((c) => c.area > w * h * 0.002).sort((a, b) => b.area - a.area);
  if (!compsAll.length) throw new Error('No bone-like structure found. Try cropping to the bone, or tick “Image is inverted”.');
  const allBone = new Uint8Array(w * h);
  for (const c of compsAll) for (const i of c.pixels) allBone[i] = 1;
  // film edges: bone outlines + the strongest intensity edges near bone (used to lay each skeleton bone on the film)
  const filmEdges = (all) => {
    const e = new Uint8Array(w * h), near = morph(all, w, h, 8, true), vals = [];
    for (let i = 0; i < w * h; i++) if (near[i]) vals.push(gx[i]);
    const gthr = percentile(vals, 0.85);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (near[i] && gx[i] > gthr) e[i] = 1;
      if (all[i] && (!all[i - 1] || !all[i + 1] || !all[i - w] || !all[i + w])) e[i] = 1;
    }
    return e;
  };
  // Joint / multi-bone films: bones touch (elbow, hip, shoulder, knee…) and merge into one blob. Lay the region's
  // skeleton on the film first — every bone at the patient's own joint angle — and keep only the footprint of the
  // bone of interest, so the (unchanged) first-version detector sees that bone alone.
  const G = projectBones(params.tpls, params.basis);
  const focusBone = G.bones.find((b) => b.id === params.focusId);
  let isolate = null, isoDiag = null;
  if (params.tpls.length > 1 && focusBone) {
    const edgesR = filmEdges(allBone);
    const artic = registerArticulated(allBone, w, h, G, params.focusId); // joint angle(s) of the region first
    const reg0 = artic ? artic.reg : registerFilm(allBone, w, h, G, { focusMask: focusBone.mask });
    const art0 = refineBones(G, reg0.T, edgesR, w, h, { init: artic?.init });
    // a joint only counts if its moving bones are actually on the film (a femur film in the Leg region has no knee)
    const visible = (group, parentId) => {
      let n = 0, on = 0;
      const P = G.bones.find((b) => b.id === parentId), Tp = boneTransform(reg0.T, art0.byId[parentId]);
      for (const b of G.bones) {
        if (!group.includes(b.id)) continue;
        const Tb0 = boneTransform(reg0.T, art0.byId[b.id]);
        for (let i = 0, k = 0; i < G.W * G.H; i++) {
          if (!b.mask[i] || (k++ % 9)) continue;
          const [u, v] = Tb0.inv(i % G.W, (i / G.W) | 0), ui = Math.round(u), vi = Math.round(v);
          if (ui < 0 || vi < 0 || ui >= w || vi >= h) continue;
          const [px2, py2] = Tp.fwd(ui, vi);
          let nearParent = false; // on or next to the parent bone: no evidence either way
          if (P) for (let dy = -6; dy <= 6 && !nearParent; dy += 2) for (let dx = -6; dx <= 6; dx += 2) { const x = Math.round(px2) + dx, y = Math.round(py2) + dy; if (x >= 0 && y >= 0 && x < G.W && y < G.H && P.mask[y * G.W + x]) { nearParent = true; break; } }
          if (nearParent) continue;
          n++; if (regHit(ui, vi)) on++;
        }
      }
      return n > 30 ? on / n : 0;
    };
    const regHit = (u, v) => { const i = v * w + u; return allBone[i] || (den.data[i] > (t1 + thr) / 2 && den.data[i] > local.data[i] * 1.02); }; // faint / thin bone counts too
    art0.joints = artic ? artic.arts.map((a, j) => ({ parent: a.parent, group: a.group, deg: artic.angles[j], visible: visible(a.group, a.parent) })).filter((j) => j.visible > 0.5) : [];
    const Tf = boneTransform(reg0.T, art0.byId[params.focusId]);
    // footprints on the film: the bone of interest (its own silhouette + a small margin) and every other bone
    const onFilm = (b, T1, r) => {
      const m = r ? morph(b.mask, G.W, G.H, r, true) : b.mask, out = new Uint8Array(w * h);
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
        const [gX, gY] = T1.fwd(u, v), xi = Math.round(gX), yi = Math.round(gY);
        if (xi >= 0 && yi >= 0 && xi < G.W && yi < G.H && m[yi * G.W + xi]) out[v * w + u] = 1;
      }
      return out;
    };
    const others = new Uint8Array(w * h), othersWide = new Uint8Array(w * h);
    for (const b of G.bones) if (b.id !== params.focusId) {
      const Tb0 = boneTransform(reg0.T, art0.byId[b.id]), o = onFilm(b, Tb0, 3), o2 = onFilm(b, Tb0, 12);
      for (let i = 0; i < w * h; i++) { if (o[i]) others[i] = 1; if (o2[i]) othersWide[i] = 1; }
    }
    // the margin keeps the bone's true edge; where it reaches onto another bone it is dropped (overlaps stay)
    // margin (~3.5 mm) keeps the bone's true edge and small displacements; pixels of other bones stay out
    const footOf = (T1) => { const core = onFilm(focusBone, T1, 0), margin = onFilm(focusBone, T1, 6), f = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (core[i] || (margin[i] && !others[i])) f[i] = 1; return f; };
    const foot = footOf(Tf);
    let n = 0, hit = 0;
    for (let i = 0; i < w * h; i++) if (foot[i]) { n++; if (allBone[i]) hit++; }
    isoDiag = { mm: reg0.chamferMM, hit, n, frac: hit / Math.max(1, n), joints: art0.joints };
    isoDiag.reg0 = reg0; isoDiag.art0 = art0;
    // isolate only when the bone is really merged with a neighbour on the film (its blob reaches well outside its footprint)
    const main0 = compsAll.slice(0, 6).sort((a, b) => b.area * Math.sqrt(b.elong) - a.area * Math.sqrt(a.elong))[0];
    let inF = 0; for (const i of main0.pixels) if (foot[i]) inF++;
    isoDiag.mainInside = inF / main0.area;
    if (reg0.chamferMM < 6 && n > w * h * 0.004 && isoDiag.mainInside < 0.8) isolate = { foot, others, othersWide, footOf, onFilm, focusBone, Tf, reg0, art0, n, hit };
  }
  if (isolate) {
    // the bone's own threshold: Otsu on its footprint and the soft tissue around it
    const buildMask = (foot) => {
      const ringF = morph(foot, w, h, 8, true), vals = [];
      for (let i = 0; i < w * h; i++) if (ringF[i]) vals.push(den.data[i]);
      isolate.thr = Math.max(t1, otsu(Float32Array.from(vals)));
      const mL = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mL[i] = foot[i] && (mask[i] || den.data[i] > isolate.thr) ? 1 : 0;
      return fillHoles(close(open(mL, w, h, 1), w, h, 2), w, h);
    };
    isolate.mask = buildMask(isolate.foot);
    // the joint fit is approximate; lay the bone of interest alone on what was isolated and rebuild its footprint
    // from that (a few degrees off at the joint would clip the far end of a long bone)
    const Gfoc = { ...G, union: focusBone.mask, bones: [focusBone] };
    for (let it = 0; it < 2; it++) {
      const rf = registerFilm(isolate.mask, w, h, Gfoc, { init: isolate.Tf, initSteps: [0.03, 0.04, 4, 4] });
      if (!(rf.chamferMM < 4)) break;
      isolate.Tf = rf.T; isolate.foot = isolate.footOf(rf.T); isolate.mask = buildMask(isolate.foot);
    }
    isolate.near = isolate.onFilm(isolate.focusBone, isolate.Tf, 3); // right next to the bone of interest
  }
  const comps = isolate
    ? components(isolate.mask, w, h).filter((c) => c.area > w * h * 0.001).sort((a, b) => b.area - a.area)
    : compsAll;
  if (!comps.length) throw new Error('No bone-like structure found. Try cropping to the bone, or tick “Image is inverted”.');
  const main = comps.slice(0, 6).sort((a, b) => b.area * Math.sqrt(b.elong) - a.area * Math.sqrt(a.elong))[0];
  const keep = [main];
  const halfLen = 2 * Math.sqrt(main.l1);
  for (const c of comps) {
    if (c === main || c.area < main.area * 0.08) continue;
    if (isolate) { keep.push(c); continue; } // inside the bone's own footprint every sizeable piece is that bone
    const dx = c.cx - main.cx, dy = c.cy - main.cy;
    const along = dx * main.ex + dy * main.ey, across = Math.abs(-dx * main.ey + dy * main.ex);
    const angle = Math.acos(Math.min(1, Math.abs(c.ex * main.ex + c.ey * main.ey)));
    if (across < halfLen * 0.25 && Math.abs(along) < halfLen * 2.2 && angle < 0.6) keep.push(c);
  }
  let bone = new Uint8Array(w * h);
  for (const c of keep) for (const i of c.pixels) bone[i] = 1;
  // Hysteresis: extend the bone into connected, moderately bright pixels, so fainter spongy bone at the
  // ends (condyles, metaphyses) is kept and the film's true extent along the bone is known.
  {
    const tLow = thr - 0.4 * (thr - t1), maxSteps = Math.round(Math.max(w, h) * 0.2);
    // only past the two ends of the bone along its axis — the shaft outline is left exactly as segmented
    const st0 = { area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    for (const c of keep) for (const k of Object.keys(st0)) st0[k] += c[k];
    const a0 = pca2(st0);
    let t0min = Infinity, t0max = -Infinity;
    for (let i = 0; i < w * h; i++) if (bone[i]) { const t = (i % w - a0.cx) * a0.ex + (((i / w) | 0) - a0.cy) * a0.ey; if (t < t0min) t0min = t; if (t > t0max) t0max = t; }
    const beyondEnds = (j) => { const t = (j % w - a0.cx) * a0.ex + (((j / w) | 0) - a0.cy) * a0.ey; return t < t0min - 0.5 || t > t0max + 0.5; };
    // soft-tissue level next to each end: growth must stay clearly brighter than it, so it follows
    // faint bone (condyles, metaphyses) but never floods into the surrounding soft tissue
    const d4 = morph(bone, w, h, 4, true), d10 = morph(bone, w, h, 10, true);
    const ring = [[], []];
    for (let i = 0; i < w * h; i++) if (d10[i] && !d4[i] && !allBone[i]) { // soft tissue only, not a neighbouring bone
      const t = (i % w - a0.cx) * a0.ex + (((i / w) | 0) - a0.cy) * a0.ey;
      if (t < t0min + 25) ring[0].push(den.data[i]); else if (t > t0max - 25) ring[1].push(den.data[i]);
    }
    const q75 = (a) => { if (!a.length) return t1; a.sort((p, q) => p - q); return a[(a.length * 0.75) | 0]; };
    const tissue = ring.map(q75), tEnd = tissue.map((v) => Math.max(tLow, v + 0.4 * (thr - v)));
    const tOf = (j) => (j % w - a0.cx) * a0.ex + (((j / w) | 0) - a0.cy) * a0.ey;
    let front = [];
    for (let i = 0; i < w * h; i++) if (bone[i]) { const t = (i % w - a0.cx) * a0.ex + (((i / w) | 0) - a0.cy) * a0.ey; if (isolate || t < t0min + 3 || t > t0max - 3) front.push(i); }
    for (let step = 0; step < maxSteps && front.length; step++) {
      const next = [];
      for (const i of front) {
        const x = i % w, y = (i / w) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (j < 0 || bone[j]) continue;
          if (den.data[j] > tLow && den.data[j] > local.data[j] * 0.85 && (isolate ? isolate.foot[j] : beyondEnds(j)) && den.data[j] > tEnd[tOf(j) < 0 ? 0 : 1]) { bone[j] = 1; next.push(j); }
        }
      }
      front = next;
    }
    bone = fillHoles(close(bone, w, h, 2), w, h);
  }
  // A bone that runs off the film ends there, cut straight across: the (oblique) cut at the film border is not a fracture.
  let cutAtBorder = 0;
  {
    const st = { area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    for (let i = 0; i < w * h; i++) if (bone[i]) { const x = i % w, y = (i / w) | 0; st.area++; st.sx += x; st.sy += y; st.sxx += x * x; st.syy += y * y; st.sxy += x * y; }
    if (st.area) {
      const a1 = pca2(st), tOf = (i) => (i % w - a1.cx) * a1.ex + (((i / w) | 0) - a1.cy) * a1.ey;
      let tmn = Infinity, tmx = -Infinity;
      for (let i = 0; i < w * h; i++) if (bone[i]) { const t = tOf(i); tmn = Math.min(tmn, t); tmx = Math.max(tmx, t); }
      const Lb = tmx - tmn, B = 2;
      let lo = -Infinity, hi = Infinity; // bone touching the border within the last 20% of either end
      for (let i = 0; i < w * h; i++) {
        if (!bone[i]) continue;
        const x = i % w, y = (i / w) | 0;
        if (x > B && y > B && x < w - 1 - B && y < h - 1 - B) continue;
        const t = tOf(i);
        if (t < tmn + 0.2 * Lb) lo = Math.max(lo, t); else if (t > tmx - 0.2 * Lb) hi = Math.min(hi, t);
      }
      const pad = 0.02 * Lb;
      if (lo > -Infinity || hi < Infinity) for (let i = 0; i < w * h; i++) if (bone[i]) { const t = tOf(i); if (t < lo + pad || t > hi - pad) { bone[i] = 0; cutAtBorder++; } }
    }
  }
  const merged = { area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
  for (let i = 0; i < w * h; i++) if (bone[i]) { const x = i % w, y = (i / w) | 0; merged.area++; merged.sx += x; merged.sy += y; merged.sxx += x * x; merged.syy += y * y; merged.sxy += x * y; }
  const ax = pca2(merged);
  await done('segment', {
    title: 'Bone segmentation', basis: 'observed',
    summary: `Max-edge-contrast threshold ${thr.toFixed(2)} (body/air Otsu ${t1.toFixed(2)}) · ${keep.length} fragment${keep.length > 1 ? 's' : ''} kept on the main axis${isolate ? ` · ${focusBone.rec.name} isolated from the other bones at the joint` : ''}`,
    image: overlayCanvas(enh, [...(isolate ? [{ mask: outline(isolate.foot, w, h), rgb: [240, 190, 90], alpha: 0.9 }] : []), { mask: bone, rgb: [127, 211, 222], alpha: 0.35 }, { mask: outline(bone, w, h), rgb: [127, 211, 222], alpha: 1 }]),
    metrics: [['Bone pixels', merged.area.toLocaleString()], ['Fragments', keep.length], ['Elongation', ax.elong.toFixed(1)],
      ['Film border', cutAtBorder ? 'bone runs off the film: its visible part ends at the border (not a fracture)' : 'bone ends inside the film'],
      ['Joint isolation', isolate ? `${focusBone.rec.name}: footprint from the region skeleton laid on the film (per-bone fit)` : params.tpls.length > 1 ? 'not needed / not reliable — whole film used' : 'single bone']],
  });

  // 3. Profile along the principal axis + anatomical identification against the skeleton bones
  const ex = ax.ex, ey = ax.ey, px = ey, py = -ex;
  let tmin = Infinity, tmax = -Infinity, rmax = 0;
  for (let i = 0; i < w * h; i++) if (bone[i]) {
    const x = i % w - ax.cx, y = ((i / w) | 0) - ax.cy;
    const t = x * ex + y * ey, o = x * px + y * py;
    if (t < tmin) tmin = t; if (t > tmax) tmax = t; if (Math.abs(o) > rmax) rmax = Math.abs(o);
  }
  const L = tmax - tmin, R = rmax + 3;
  const at = (m, x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h ? m[yi * w + xi] : 0; };
  const hull = fillHoles(close(bone, w, h, 7), w, h);
  const blurred = gaussian(enh, 3.5);
  const lucent = img(w, h);
  for (let i = 0; i < w * h; i++) lucent.data[i] = hull[i] ? Math.max(0, blurred.data[i] - enh.data[i]) : 0;
  const P = { length: L, lo: new Float32Array(N_SLICES), hi: new Float32Array(N_SLICES), cov: new Float32Array(N_SLICES), luc: new Float32Array(N_SLICES), inten: new Float32Array(N_SLICES) };
  for (let s = 0; s < N_SLICES; s++) {
    const t = tmin + (s + 0.5) * L / N_SLICES;
    let lo = NaN, hi = NaN, cnt = 0, hlo = NaN, hhi = NaN, isum = 0, icnt = 0;
    const lucs = [];
    for (let o = -R; o <= R; o += 0.5) {
      const x = ax.cx + ex * t + px * o, y = ax.cy + ey * t + py * o;
      if (at(bone, x, y)) { if (Number.isNaN(lo)) lo = o; hi = o; cnt++; isum += enh.data[Math.round(y) * w + Math.round(x)]; icnt++; }
      if (at(hull, x, y)) { if (Number.isNaN(hlo)) hlo = o; hhi = o; lucs.push(lucent.data[Math.round(y) * w + Math.round(x)]); }
    }
    P.lo[s] = lo; P.hi[s] = hi;
    const hw = Number.isNaN(hhi) ? 0 : hhi - hlo;
    P.cov[s] = hw > 0 ? Math.min(1, (cnt * 0.5) / hw) : 0;
    lucs.sort((a, b) => b - a);
    const top = lucs.slice(0, Math.max(1, Math.floor(lucs.length * 0.3)));
    P.luc[s] = top.reduce((a, b) => a + b, 0) / top.length;
    P.inten[s] = icnt ? isum / icnt : NaN;
    if (Number.isNaN(lo)) { P.lo[s] = hlo; P.hi[s] = hhi; P.cov[s] = Number.isNaN(hlo) ? 0 : P.cov[s]; }
  }
  const loF = fillNaN(P.lo), hiF = fillNaN(P.hi);
  const widths = []; for (let s = 0; s < N_SLICES; s++) if (Number.isFinite(P.lo[s])) widths.push(P.hi[s] - P.lo[s]);
  const medW = median(widths) || 1;

  // When the region's skeleton has been laid on the film joint by joint (joint films), the bone of interest's
  // direction and the part of it the film shows are known geometrically: they fix the profile match's direction
  // (a butterfly or comminution can make the wide end look like the narrow one) and give its coverage.
  let geo = null;
  if (isoDiag && (isolate || isoDiag.joints.length) && isoDiag.mm < 3) {
    const Tf = isolate ? isolate.Tf : boneTransform(isoDiag.reg0.T, isoDiag.art0.byId[params.focusId]); // refined isolation fit if any
    const fb = G.bones.find((b) => b.id === params.focusId), ab = [fb.B2[0] - fb.A2[0], fb.B2[1] - fb.A2[1]], l2 = ab[0] ** 2 + ab[1] ** 2;
    const sAt = (t) => { const [x, y] = Tf.fwd(ax.cx + ex * t, ax.cy + ey * t); return ((x - fb.A2[0]) * ab[0] + (y - fb.A2[1]) * ab[1]) / l2; };
    const sA = sAt(tmin), sB = sAt(tmin + L);
    if (Math.abs(sB - sA) > 0.2) geo = { flip: sB < sA, cover: [clamp(Math.min(sA, sB), 0, 1), clamp(Math.max(sA, sB), 0, 1)] };
  }
  const candidates = [];
  for (const cand of params.candidates) {
    const m = geo && cand.id === params.focusId
      ? (matchProfile(P, cand.profile, geo.cover, { flip: geo.flip, range: { s0: geo.cover[0], c: geo.cover[1] - geo.cover[0] } }) || matchProfile(P, cand.profile, geo.cover, { flip: geo.flip }))
      : matchProfile(P, cand.profile, cand.cover);
    if (m) candidates.push({ id: cand.id, name: cand.name, match: m, profile: cand.profile });
  }
  candidates.sort((a, b) => a.match.err - b.match.err);
  const chosen = candidates.find((c) => c.id === params.focusId) || candidates[0];
  if (!chosen) throw new Error('Could not fit the bone template to this image.');
  const M = chosen.match, Tsel = chosen.profile, best = candidates[0];
  const consistent = best.id === chosen.id || best.match.score - M.score < 0.08;
  {
    const c = greyCanvas(enh, [0.85, 0.9, 0.9]), g = c.getContext('2d');
    g.lineWidth = 2; g.strokeStyle = 'rgba(214,198,162,0.95)';
    for (const side of ['lo', 'hi']) {
      g.beginPath();
      for (let s = 0; s < N_SLICES; s++) {
        const t = tmin + (s + 0.5) * L / N_SLICES, d = M.trend[0] + M.trend[1] * (s + 0.5) / N_SLICES;
        const sP = (s + 0.5) / N_SLICES, u = M.flip ? 1 - sP : sP, sT = M.s0 + u * M.c;
        const a = interp(Tsel[M.sign > 0 ? side : side === 'lo' ? 'hi' : 'lo'], sT) * M.k * M.sign + d;
        const x = ax.cx + ex * t + px * a, y = ax.cy + ey * t + py * a;
        s ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.strokeStyle = '#7fd3de'; g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(ax.cx + ex * tmin, ax.cy + ey * tmin); g.lineTo(ax.cx + ex * tmax, ax.cy + ey * tmax); g.stroke();
    g.setLineDash([]);
    const prox = M.flip ? tmax : tmin;
    g.fillStyle = '#7fd3de'; g.beginPath(); g.arc(ax.cx + ex * prox, ax.cy + ey * prox, 5, 0, 7); g.fill();
    g.font = '600 13px system-ui'; g.fillText('proximal', ax.cx + ex * prox + 8, ax.cy + ey * prox + 4);
    await done('identify', {
      title: 'Anatomical identification', basis: 'mixed',
      summary: `${chosen.name}: template fit ${(M.score * 100).toFixed(0)}% · shows ${(M.s0 * 100).toFixed(0)}–${((M.s0 + M.c) * 100).toFixed(0)}% of the bone${consistent ? '' : ` · ⚠ ${best.name} fits better`}`,
      image: c, warn: !consistent,
      metrics: [
        ['Best template match', `${best.name} (${(best.match.score * 100).toFixed(0)}%)`],
        ...candidates.slice(0, 4).map((q) => [`  ${q.name}`, `${(q.match.score * 100).toFixed(0)}%`]),
        ['Coverage', `${(M.s0 * 100).toFixed(0)}–${((M.s0 + M.c) * 100).toFixed(0)}% of length`],
        ['Proximal end', M.flip ? 'bottom of image' : 'top of image'],
        ['Side (L/R)', 'from your selection — not inferable from one projection'],
      ],
    });
  }

  // 4. Fracture detection (first version): cortical gap + radiolucent line + contour step vs the template
  const lo2 = new Float32Array(N_SLICES), hi2 = new Float32Array(N_SLICES);
  for (let s = 0; s < N_SLICES; s++) {
    const d = M.trend[0] + M.trend[1] * (s + 0.5) / N_SLICES;
    const sP = (s + 0.5) / N_SLICES, u = M.flip ? 1 - sP : sP, sT = M.s0 + u * M.c;
    const a = interp(Tsel.lo, sT) * M.k, b = interp(Tsel.hi, sT) * M.k;
    lo2[s] = (M.sign > 0 ? a : -b) + d; hi2[s] = (M.sign > 0 ? b : -a) + d;
  }
  const lucMed = new Float32Array(N_SLICES);
  for (let s = 0; s < N_SLICES; s++) {
    const win = []; for (let j = Math.max(0, s - 8); j <= Math.min(N_SLICES - 1, s + 8); j++) { if (Number.isFinite(P.luc[j])) win.push(P.luc[j]); }
    lucMed[s] = median(win);
  }
  const boneI = median(Array.from(P.inten).filter(Number.isFinite)) || 0.5;
  const sig = { gap: new Float32Array(N_SLICES), luc: new Float32Array(N_SLICES), step: new Float32Array(N_SLICES), score: new Float32Array(N_SLICES) };
  const e0 = Math.round(N_SLICES * 0.05), e1s = Math.round(N_SLICES * 0.1);
  for (let s = 0; s < N_SLICES; s++) {
    const sT = M.s0 + (M.flip ? 1 - (s + 0.5) / N_SLICES : (s + 0.5) / N_SLICES) * M.c;
    const occT = Tsel.occ ? interp(Tsel.occ, sT) : 1;
    sig.gap[s] = Number.isFinite(P.lo[s]) ? Math.max(0, occT - P.cov[s]) : 1;
    sig.luc[s] = Number.isFinite(P.luc[s]) ? Math.max(0, P.luc[s] - (Number.isFinite(lucMed[s]) ? lucMed[s] : 0)) / Math.max(0.05, boneI) : 0; // no bone in this slice: no lucency
    if (s >= 2 && s < N_SLICES - 2) {
      const rl = (j) => loF[j] - lo2[j], rh = (j) => hiF[j] - hi2[j];
      sig.step[s] = Math.max(Math.abs(rl(s + 2) - rl(s - 2)), Math.abs(rh(s + 2) - rh(s - 2))) / medW;
    }
    const inner = s >= e0 && s < N_SLICES - e0, innerStep = s >= e1s && s < N_SLICES - e1s;
    if (!inner) { sig.gap[s] = 0; sig.luc[s] = 0; }
    if (!innerStep) sig.step[s] = 0;
    sig.score[s] = inner ? 0.4 * Math.min(2, sig.gap[s] / 0.5) + 0.4 * Math.min(2, sig.luc[s] / 0.12) + (innerStep ? 0.2 * Math.min(2, sig.step[s] / 0.25) : 0) : 0;
  }
  const sm = sig.score.map((v, s) => (sig.score[Math.max(0, s - 1)] + 2 * v + sig.score[Math.min(N_SLICES - 1, s + 1)]) / 4);
  let iF = 0;
  for (let s = 0; s < N_SLICES; s++) if (sm[s] > sm[iF]) iF = s;
  let manual = false;
  const mark = (params.marks || [])[0];
  if (mark) {
    const mx = mark.u * w - ax.cx, my = mark.v * h - ax.cy;
    iF = clamp(Math.floor(((mx * ex + my * ey) - tmin) / L * N_SLICES), 0, N_SLICES - 1);
    manual = true;
  }
  const near = (arr) => Math.max(...[-2, -1, 0, 1, 2].map((d) => arr[clamp(iF + d, 0, N_SLICES - 1)]));
  const pGap = sigmoid((near(sig.gap) - 0.32) / 0.07), pLuc = sigmoid((near(sig.luc) - 0.07) / 0.022), pStep = sigmoid((near(sig.step) - 0.2) / 0.04);
  let confidence = clamp(1 - (1 - pGap) * (1 - pLuc) * (1 - 0.6 * pStep), 0.02, 0.985);
  if (manual) confidence = Math.max(confidence, 0.5);
  let detected = confidence >= 0.5;
  const builtinConfidence = confidence;

  // Learned detector (optional, chosen by the user):
  //   gated    — the built-in detector finds WHERE the break is; the model decides WHETHER there is one (and its type).
  //              If the model sees only healthy bone / no fracture, nothing is reported.
  //   learned  — the model decides and its best fracture box on this bone sets the location.
  //   combined — either detector can report the fracture; the model's box sets the location.
  const mode = params.detector || 'builtin';
  const toA = (x, y) => [(x - r.crop.x) * r.scale, (y - r.crop.y) * r.scale];
  const mlBoxes = (params.ml?.boxes || []).map((b) => { const [x1, y1] = toA(b.box[0], b.box[1]), [x2, y2] = toA(b.box[2], b.box[3]); return { ...b, a: [x1, y1, x2, y2] }; });
  let mlBox = null, useBoxLoc = false, mlDecision = null;
  if (mode !== 'builtin' && !manual) {
    const onBone = (b) => {
      let hit = 0, n = 0;
      for (let y = Math.max(0, Math.floor(b.a[1])); y <= Math.min(h - 1, Math.ceil(b.a[3])); y += 2)
        for (let x = Math.max(0, Math.floor(b.a[0])); x <= Math.min(w - 1, Math.ceil(b.a[2])); x += 2) { n++; if (hull[y * w + x]) hit++; }
      return n ? hit / n : 0;
    };
    const onB = mlBoxes.filter((b) => onBone(b) > 0.05), isF = (b) => params.ml.fractureClasses.includes(b.cls);
    mlBox = onB.filter(isF).sort((p, q) => q.score - p.score)[0] || null;
    const fS = mlBox ? mlBox.score : 0, hS = Math.max(0, ...onB.filter((b) => b.cls === params.ml.healthyClass).map((b) => b.score));
    const modelYes = !params.ml.failed && !!mlBox && fS >= (params.ml.thr ?? 0.3) && fS >= hS;
    mlDecision = { fracture: modelYes, fractureScore: fS, healthyScore: hS, type: modelYes ? mlBox.name : null, failed: params.ml.failed || null };
    if (!modelYes) mlBox = null;
    useBoxLoc = !!mlBox && (mode !== 'gated' || !detected); // gated: the built-in location stays when it found the break
    if (useBoxLoc) {
      const cx = (mlBox.a[0] + mlBox.a[2]) / 2, cy = (mlBox.a[1] + mlBox.a[3]) / 2;
      iF = clamp(Math.floor((((cx - ax.cx) * ex + (cy - ax.cy) * ey) - tmin) / L * N_SLICES), 0, N_SLICES - 1);
    }
    if (mode === 'learned' || mode === 'gated') { detected = modelYes; confidence = modelYes ? fS : Math.max(0.02, fS); }
    else if (mlBox) { detected = true; confidence = Math.max(confidence, fS); }
  }

  // Localisation (after detection — the detection decision above is unchanged). Where exactly is the break?
  // Real films (comminuted fractures, butterfly fragments, fainter metaphyses) need break-specific evidence:
  //   outline steps · a SHORT gap with bone on both sides (a long uncovered stretch is segmentation loss) ·
  //   extra width from displaced / butterfly fragments (film wider than the bone, not narrower) · lucent lines.
  // The fracture zone is the contiguous run of that evidence; the break is placed at its weighted centre.
  let zone = [iF, iF];
  const wres = Array.from({ length: N_SLICES }, (_, i) => ((hiF[i] - loF[i]) - (hi2[i] - lo2[i])) / medW);
  const locEv = new Float32Array(N_SLICES);
  for (let s = e0; s < N_SLICES - e0; s++) {
    const side = (a, b) => { let m = 0; for (let j = Math.max(0, a); j <= Math.min(N_SLICES - 1, b); j++) m = Math.max(m, P.cov[j]); return m; };
    let run = 0; for (let j = s - 6; j <= s + 6; j++) if (j >= 0 && j < N_SLICES && P.cov[j] < 0.5) run++;
    const gapB = run > 7 ? 0 : sig.gap[s] * Math.min(side(s - 9, s - 3), side(s + 3, s + 9));
    locEv[s] = 0.35 * Math.min(2, sig.step[s] / 0.25) + 0.3 * Math.min(2, gapB / 0.4)
      + 0.25 * Math.min(2, Math.max(0, wres[s] - 0.15) / 0.3) + 0.3 * Math.min(2, sig.luc[s] / 0.12);
  }
  const locSm = locEv.map((v, s) => (locEv[Math.max(0, s - 1)] + 2 * v + locEv[Math.min(N_SLICES - 1, s + 1)]) / 4);
  let iL = 0; for (let s = 0; s < N_SLICES; s++) if (locSm[s] > locSm[iL]) iL = s;
  if (useBoxLoc) { // the learned box spans the fracture zone
    const sl = [[0, 1], [2, 1], [0, 3], [2, 3]].map(([i, j]) => clamp(Math.floor((((mlBox.a[i] - ax.cx) * ex + (mlBox.a[j] - ax.cy) * ey) - tmin) / L * N_SLICES), 0, N_SLICES - 1));
    zone = [Math.min(...sl), Math.max(...sl)];
  } else if (detected && !manual && locSm[iL] > 0.25) {
    const thrZ = locSm[iL] * 0.3;
    let a = iL, b = iL, miss = 0;
    for (let s = iL - 1; s >= e0 && miss <= 3; s--) { if (locSm[s] >= thrZ) { a = s; miss = 0; } else miss++; }
    miss = 0;
    for (let s = iL + 1; s < N_SLICES - e0 && miss <= 3; s++) { if (locSm[s] >= thrZ) { b = s; miss = 0; } else miss++; }
    zone = [a, b];
    let ws = 0, wsum = 0; for (let s = a; s <= b; s++) { ws += s * locSm[s]; wsum += locSm[s]; }
    iF = clamp(Math.round(ws / Math.max(1e-9, wsum)), 0, N_SLICES - 1);
  }
  const sOfSlice = (s) => M.s0 + (M.flip ? 1 - (s + 0.5) / N_SLICES : (s + 0.5) / N_SLICES) * M.c;

  const tF = tmin + (iF + 0.5) * L / N_SLICES, midF = (loF[iF] + hiF[iF]) / 2;
  const F = { x: ax.cx + ex * tF + px * midF, y: ax.cy + ey * tF + py * midF };
  const slice = L / N_SLICES;
  let lx = px, ly = py, obliq = 0;
  {
    const wF0 = Math.max(4, hiF[iF] - loF[iF]);
    const val = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
      const i = yi * w + xi;
      return hull[i] ? lucent.data[i] + (bone[i] ? 0 : 0.12) : 0;
    };
    let bestV = -1, bestPhi = 0, bestShift = 0;
    for (let deg = -60; deg <= 60; deg += 3) {
      const phi = deg * Math.PI / 180, dx = Math.cos(phi) * px + Math.sin(phi) * ex, dy = Math.cos(phi) * py + Math.sin(phi) * ey;
      for (let sh = -slice * 3; sh <= slice * 3; sh += 1) {
        let sum = 0, n = 0;
        for (let u = -0.4 * wF0; u <= 0.4 * wF0; u += 0.5) { sum += val(F.x + ex * sh + dx * u, F.y + ey * sh + dy * u); n++; }
        if (sum / n > bestV) { bestV = sum / n; bestPhi = phi; bestShift = sh; }
      }
    }
    obliq = bestPhi;
    lx = Math.cos(bestPhi) * px + Math.sin(bestPhi) * ex; ly = Math.cos(bestPhi) * py + Math.sin(bestPhi) * ey;
    F.x += ex * bestShift; F.y += ey * bestShift;
  }
  const fitSide = (a, b) => {
    const xs = [], ys = [];
    for (let s = Math.max(0, a); s <= Math.min(N_SLICES - 1, b); s++) if (Number.isFinite(P.lo[s]) && P.cov[s] > 0.6) { xs.push(s); ys.push((P.lo[s] + P.hi[s]) / 2); }
    if (xs.length < 4) return null;
    const n = xs.length, sx = xs.reduce((p, v) => p + v, 0), sy = ys.reduce((p, v) => p + v, 0);
    const sxx = xs.reduce((p, v) => p + v * v, 0), sxy = xs.reduce((p, v, j) => p + v * ys[j], 0);
    const m = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
    return { m, b: (sy - m * sx) / n };
  };
  // fit the intact bone on either side of the whole fracture zone (not through comminution / butterfly fragments)
  const wide = zone[1] - zone[0] > 8; // comminuted: a short break keeps the close fit
  const za = wide ? Math.min(zone[0], iF) : iF, zb = wide ? Math.max(zone[1], iF) : iF;
  const A = fitSide(za - 18, za - 4), B = fitSide(zb + 4, zb + 18);
  let shiftPx = 0, angulation = 0;
  if (A && B) { shiftPx = (B.m * iF + B.b) - (A.m * iF + A.b); angulation = (Math.atan(B.m / slice) - Math.atan(A.m / slice)) * 180 / Math.PI; }
  let gapSlices = 0;
  for (let s = iF - 4; s <= iF + 4; s++) { const j = clamp(s, 0, N_SLICES - 1); if (sig.gap[j] > 0.3 || sig.luc[j] > Math.max(0.05, near(sig.luc) * 0.5)) gapSlices++; }
  const gapPx = detected ? Math.max(1.5, gapSlices * slice * 0.35) : 0;
  const obliqDeg = Math.abs(obliq * 180 / Math.PI);
  const displaced = Math.abs(shiftPx) > 0.12 * medW || Math.abs(angulation) > 5;
  const pattern = obliqDeg < 15 ? 'transverse' : obliqDeg < 45 ? 'oblique' : 'long oblique / spiral (not separable in one view)';
  const sFrac = (iF + 0.5) / N_SLICES, sFracT = M.s0 + (M.flip ? 1 - sFrac : sFrac) * M.c;
  const fracture = {
    detected, manual, confidence, builtinConfidence, source: manual ? 'user-marked' : useBoxLoc ? params.ml.label : mlBox ? `built-in location · ${params.ml.label}` : 'classical', type: mlDecision?.type || null, sliceIndex: iF, s: sFrac, sTemplate: sFracT, sAxis: sFracT,
    point: F, dir: { x: lx, y: ly }, obliquity: obliq, obliquityDeg: obliqDeg, pattern, displaced,
    shiftPx, angulation, angulationDeg: angulation, gapPx, widthPx: hiF[iF] - loF[iF],
    evidence: { gap: near(sig.gap), lucency: near(sig.luc), step: near(sig.step) },
    shiftMM: (shiftPx / M.k) * 1000,
    zone: [Math.min(sOfSlice(zone[0]), sOfSlice(zone[1])), Math.max(sOfSlice(zone[0]), sOfSlice(zone[1]))],
    zoneImg: [zone[0], zone[1]].map((s) => { const t = tmin + (s + 0.5) * L / N_SLICES; return { x: ax.cx + ex * t + px * midF, y: ax.cy + ey * t + py * midF }; }),
    ml: mode === 'builtin' ? null : { detector: params.ml?.label, mode, decision: mlDecision, boxes: mlBoxes.map(({ a, cls, name, score }) => ({ a, cls, name, score })), used: mlBox ? { a: mlBox.a, score: mlBox.score } : null },
    fragments: [],
  };
  // Fragments seen on the film: bone in the fracture zone that belongs to NEITHER main fragment — i.e. lies outside
  // both the proximal and the distal fragment's outline (the skeleton bone's outline carried along each fragment's
  // own measured course). Butterfly and comminution pieces show up here.
  if (detected) {
    // each main fragment's outline = the skeleton outline with its two edges fitted to the film's intact cortex
    const rfit = (a, b, edge) => {
      const xs = [], ys = [];
      for (let s = Math.max(0, a); s <= Math.min(N_SLICES - 1, b); s++) if (Number.isFinite(P.lo[s]) && P.cov[s] > 0.6) { xs.push(s); ys.push(edge === 'lo' ? P.lo[s] - lo2[s] : P.hi[s] - hi2[s]); }
      if (xs.length < 4) return null;
      const n = xs.length, sx = xs.reduce((q, v) => q + v, 0), sy = ys.reduce((q, v) => q + v, 0);
      const sxx = xs.reduce((q, v) => q + v * v, 0), sxy = xs.reduce((q, v, j) => q + v * ys[j], 0);
      const m = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
      return { m, b: (sy - m * sx) / n };
    };
    const RA = { lo: rfit(za - 18, za - 4, 'lo'), hi: rfit(za - 18, za - 4, 'hi') }, RB = { lo: rfit(zb + 4, zb + 18, 'lo'), hi: rfit(zb + 4, zb + 18, 'hi') };
    const off = (f, s) => (f ? f.m * s + f.b : 0);
    const s0 = Math.max(0, za - 12), s1 = Math.min(N_SLICES - 1, zb + 12), marg = (isolate ? 0.18 : 0.1) * medW; // isolated: allow for the footprint's fit
    const cand = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!((bone[i] || allBone[i] || mask[i]) && (!isolate || isolate.near[i] || !isolate.othersWide[i]))) continue; // not (near) another bone
      const x = i % w - ax.cx, y = ((i / w) | 0) - ax.cy, t = x * ex + y * ey, o = x * px + y * py;
      if (Math.abs(o) > 2.5 * medW) continue; // near this bone only
      const sI = Math.floor((t - tmin) / L * N_SLICES);
      if (sI < s0 || sI > s1) continue;
      const inA = sI <= zb + 3 && o >= lo2[sI] + off(RA.lo, sI) - marg && o <= hi2[sI] + off(RA.hi, sI) + marg;
      const inB = sI >= za - 3 && o >= lo2[sI] + off(RB.lo, sI) - marg && o <= hi2[sI] + off(RB.hi, sI) + marg;
      if (!inA && !inB) cand[i] = 1;
    }
    const comps = components(open(cand, w, h, 1), w, h)
      .filter((c) => c.area >= Math.max(40, 0.15 * medW * medW) && 4 * Math.sqrt(Math.max(0, c.l2)) >= 0.12 * medW)
      .sort((a, b) => b.area - a.area).slice(0, 3);
    const hull2 = (pix) => { // convex hull (monotone chain) of the fragment's pixels
      const pts = pix.map((i) => [i % w, (i / w) | 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const q of pts) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
      for (let k = pts.length - 1; k >= 0; k--) { const q = pts[k]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
      return lo.slice(0, -1).concat(up.slice(0, -1)).map(([x, y]) => ({ x, y }));
    };
    for (const c of comps) {
      let tA = Infinity, tB = -Infinity, oS = 0;
      for (const i of c.pixels) { const x = i % w - ax.cx, y = ((i / w) | 0) - ax.cy, t = x * ex + y * ey; tA = Math.min(tA, t); tB = Math.max(tB, t); oS += x * px + y * py; }
      const sm = clamp(Math.floor(((tA + tB) / 2 - tmin) / L * N_SLICES), 0, N_SLICES - 1);
      const R = sm <= iF ? RA : RB, side = oS / c.area >= (lo2[sm] + off(R.lo, sm) + hi2[sm] + off(R.hi, sm)) / 2 ? 1 : -1;
      const sa = sOfSlice(clamp(Math.floor((tA - tmin) / L * N_SLICES), 0, N_SLICES - 1)), sb = sOfSlice(clamp(Math.floor((tB - tmin) / L * N_SLICES), 0, N_SLICES - 1));
      fracture.fragments.push({
        centroid: { x: c.cx, y: c.cy }, dir: { x: c.ex, y: c.ey }, areaPx: c.area,
        lenPx: 4 * Math.sqrt(c.l1), widPx: 4 * Math.sqrt(Math.max(0, c.l2)), boneWidthPx: medW,
        sRange: [Math.min(sa, sb), Math.max(sa, sb)], side, outline: hull2(c.pixels),
      });
    }
  }
  {
    const c = greyCanvas(enh, [0.85, 0.9, 0.9]), g = c.getContext('2d');
    const gw = Math.min(150, w * 0.3);
    g.fillStyle = 'rgba(8,14,15,0.72)'; g.fillRect(w - gw - 8, 8, gw, h - 16);
    const plot = (arr, col, scale) => {
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
      for (let s = 0; s < N_SLICES; s++) { const x = w - gw - 8 + Math.min(1, arr[s] / scale) * (gw - 8) + 4, y = 12 + (s / (N_SLICES - 1)) * (h - 24); s ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    };
    plot(sig.gap, '#7fd3de', 1); plot(sig.luc, '#f0a35e', 0.3); plot(sig.step, '#c9a4ff', 0.6);
    const yF = 12 + (iF / (N_SLICES - 1)) * (h - 24);
    g.strokeStyle = '#ff5a4f'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(w - gw - 8, yF); g.lineTo(w - 8, yF); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#9fb0ad'; g.font = '10px monospace';
    g.fillText('gap', w - gw - 2, h - 26); g.fillStyle = '#f0a35e'; g.fillText('lucency', w - gw + 26, h - 26); g.fillStyle = '#c9a4ff'; g.fillText('step', w - gw + 82, h - 26);
    const half = (hiF[iF] - loF[iF]) * 0.75;
    g.strokeStyle = detected ? '#ff5a4f' : 'rgba(255,90,79,0.5)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(F.x - lx * half, F.y - ly * half); g.lineTo(F.x + lx * half, F.y + ly * half); g.stroke();
    g.strokeRect(F.x - half - 6, F.y - half * 0.6, half * 2 + 12, half * 1.2);
    for (const b of mlBoxes) { // learned detector boxes (fracture = red, other findings = grey)
      const isF = params.ml.fractureClasses.includes(b.cls);
      g.strokeStyle = b === mlBox ? '#ff2d1f' : isF ? 'rgba(255,120,100,0.8)' : 'rgba(200,210,210,0.55)'; g.lineWidth = b === mlBox ? 2.5 : 1.2;
      g.setLineDash(isF ? [] : [3, 3]); g.strokeRect(b.a[0], b.a[1], b.a[2] - b.a[0], b.a[3] - b.a[1]); g.setLineDash([]);
      g.fillStyle = g.strokeStyle; g.font = '10px monospace'; g.fillText(`${b.name} ${(b.score * 100).toFixed(0)}%`, b.a[0] + 2, Math.max(10, b.a[1] - 3));
    }
    await done('fracture', {
      title: 'Fracture detection', basis: 'observed', warn: !detected,
      summary: detected
        ? `${manual ? 'User-marked' : useBoxLoc ? `${params.ml.label} box` : 'Detected'} at ${(sFracT * 100).toFixed(0)}% of bone length · ${mlDecision?.type ? `${mlDecision.type} (${params.ml.label})` : pattern}${!mlDecision?.type && displaced ? ', displaced' : ''} · confidence ${(confidence * 100).toFixed(1)}%`
        : mode === 'gated' || mode === 'learned'
          ? mlDecision?.failed ? `No fracture confirmed: ${params.ml?.label} could not be loaded (${mlDecision.failed}). Choose "Built-in" to see the built-in detector's own result.` : `No fracture: ${params.ml?.label} sees ${mlDecision?.healthyScore > mlDecision?.fractureScore ? `healthy bone (${(mlDecision.healthyScore * 100).toFixed(0)}%)` : `no fracture above ${((params.ml?.thr ?? 0.3) * 100).toFixed(0)}% (best ${(mlDecision?.fractureScore * 100 || 0).toFixed(0)}%)`}${builtinConfidence >= 0.5 && mode === 'gated' ? ` — the built-in detector alone would have reported ${(builtinConfidence * 100).toFixed(0)}%` : ''}. You can mark a fracture manually on the X-ray.`
          : `No fracture above threshold (best candidate ${(confidence * 100).toFixed(1)}%). You can mark it manually on the X-ray.`,
      image: c,
      metrics: [
        ['Confidence (heuristic, uncalibrated)', `${(confidence * 100).toFixed(1)}%`],
        ...(mode !== 'builtin' ? [['Detector', `${params.ml?.label} (${mode === 'learned' ? 'decides and locates' : mode === 'gated' ? 'decides; built-in locates' : 'combined with built-in'})`],
          ...(mlDecision ? [['Model decision', `${mlDecision.fracture ? `fracture — ${mlDecision.type}` : 'no fracture'} (fracture ${(mlDecision.fractureScore * 100).toFixed(0)}%, healthy ${(mlDecision.healthyScore * 100).toFixed(0)}%)`]] : []), ['Learned boxes', mlBoxes.map((b) => `${b.name} ${(b.score * 100).toFixed(0)}%`).join(', ') || 'none'], ['Built-in detector', `${(builtinConfidence * 100).toFixed(1)}%`]] : []),
        ['Location', `${(sFracT * 100).toFixed(0)}% from proximal end`],
        ['Pattern (in this projection)', pattern],
        ['Obliquity', `${obliqDeg.toFixed(0)}°`],
        ['Lateral shift', `${shiftPx.toFixed(1)} px (${(shiftPx / medW * 100).toFixed(0)}% of width)`],
        ['Angulation (in-plane)', `${angulation.toFixed(1)}°`],
        ['Evidence', `gap ${fracture.evidence.gap.toFixed(2)} · lucency ${fracture.evidence.lucency.toFixed(2)} · step ${fracture.evidence.step.toFixed(2)}`],
      ],
    });
  }

  // 5. Fracture segmentation
  const fmask = new Uint8Array(w * h);
  if (detected) {
    const nx = -ly, ny = lx;
    const band = Math.max(3, gapPx / 2 + 3);
    const lthr = percentile(Array.from(lucent.data).filter((v, i) => hull[i]), 0.8);
    for (let i = 0; i < w * h; i++) {
      if (!hull[i]) continue;
      const x = i % w - F.x, y = ((i / w) | 0) - F.y;
      const d = Math.abs(x * nx + y * ny), along = Math.abs(x * lx + y * ly);
      if (d < band * 1.6 && along < fracture.widthPx * 0.8 && (lucent.data[i] > lthr || !bone[i] || d < band * 0.5)) fmask[i] = 1;
    }
  }
  let farea = 0; for (const v of fmask) farea += v;
  await done('fracture_seg', {
    title: 'Fracture segmentation', basis: 'observed', warn: !detected,
    summary: detected ? `${farea.toLocaleString()} px fracture zone around the detected line${fracture.fragments.length ? ` · ${fracture.fragments.length} separate fragment${fracture.fragments.length > 1 ? 's' : ''} on the film` : ''}` : 'Skipped: no fracture above threshold',
    image: (() => {
      const c = overlayCanvas(enh, [{ mask: outline(bone, w, h), rgb: [127, 211, 222], alpha: 0.9 }, { mask: fmask, rgb: [255, 90, 79], alpha: 0.65 }]), g = c.getContext('2d');
      g.strokeStyle = '#ffb347'; g.lineWidth = 2;
      for (const fg of fracture.fragments) { g.beginPath(); fg.outline.forEach((q, k) => (k ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath(); g.stroke(); }
      return c;
    })(),
    metrics: [['Fracture pixels', farea.toLocaleString()], ['Gap width (est.)', `${gapPx.toFixed(1)} px`],
      ['Separate fragments', fracture.fragments.length ? fracture.fragments.map((f) => `${(f.lenPx).toFixed(0)}×${f.widPx.toFixed(0)} px at ${(f.sRange[0] * 100).toFixed(0)}–${(f.sRange[1] * 100).toFixed(0)}%`).join(' · ') : 'none seen']],
  });

  // 6. Film ↔ skeleton registration (places the X-ray on the skeleton; detection does not depend on it)
  const focusBoneC = G.bones.find((b) => b.id === chosen.id);
  // Seed from the template match: it already knows which part of which bone the film shows, so the
  // X-ray, its fracture and the skeleton bone line up (the free search is only a fallback).
  const matchTransform = (Gx) => {
    const tpl = params.tpls.find((t) => t.rec.id === chosen.id);
    if (!tpl) return null;
    const { c: C, a: A, tmin: tm, length: LT } = tpl.frame, obs = Tsel.obs;
    const toGrid = (u, o) => {
      const d = M.trend[0] + M.trend[1] * u, sT = M.s0 + (M.flip ? 1 - u : u) * M.c, oT = (o - d) / (M.sign * M.k);
      return Gx.toGrid([0, 1, 2].map((k) => C[k] + A[k] * (tm + sT * LT) + obs[k] * oT));
    };
    const imgPt = (u, o) => [ax.cx + ex * (tmin + u * L) + px * o, ax.cy + ey * (tmin + u * L) + py * o];
    const P = [imgPt(0, 0), imgPt(1, 0), imgPt(0.5, 40)], Q = [toGrid(0, 0), toGrid(1, 0), toGrid(0.5, 40)];
    let best = null;
    for (const mirror of [false, true]) {
      const m = mirror ? -1 : 1, a1 = [m * P[0][0], P[0][1]], a2 = [m * P[1][0], P[1][1]];
      const dp = [a2[0] - a1[0], a2[1] - a1[1]], dq = [Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]], den = dp[0] ** 2 + dp[1] ** 2;
      const zr = (dq[0] * dp[0] + dq[1] * dp[1]) / den, zi = (dq[1] * dp[0] - dq[0] * dp[1]) / den;
      const tx = Q[0][0] - (zr * a1[0] - zi * a1[1]), ty = Q[0][1] - (zi * a1[0] + zr * a1[1]);
      const T0 = makeFilmTransform(Math.hypot(zr, zi), Math.atan2(zi, zr), mirror, tx, ty);
      const [qx, qy] = T0.fwd(P[2][0], P[2][1]), err = Math.hypot(qx - Q[2][0], qy - Q[2][1]);
      if (!best || err < best.err) best = { T: T0, err };
    }
    return best.T;
  };
  const Tmatch = matchTransform(G);
  const jointFit = isoDiag && (isolate || isoDiag.joints.length) ? isoDiag : null; // a joint was found / the bone had to be isolated
  const jointGood = jointFit && jointFit.mm < 3 && chosen.id === params.focusId; // the joint fit already lays the film on the skeleton
  let reg = jointGood ? isoDiag.reg0 : registerFilm(allBone, w, h, G, { focusMask: focusBoneC?.mask, init: M.score >= 0.4 ? Tmatch : null });
  let T = reg.T;
  // Per-bone refinement: every bone the film shows is laid on the film's own edges (joints at the patient's angles)
  let art = jointGood ? isoDiag.art0 : refineBones(G, T, filmEdges(allBone), w, h);
  if (jointFit && jointFit.reg0.chamferMM + 0.3 < reg.chamferMM) { reg = jointFit.reg0; T = reg.T; art = jointFit.art0; } // the joint fit was better
  // Placement of the break: the bone of interest alone (a rigid bone needs no joints) — its skeleton silhouette laid
  // on exactly the bone the detector measured, seeded from the profile match. Expressed in the region grid.
  {
    const tplF = params.tpls.find((t) => t.rec.id === chosen.id);
    const Gf = projectBones([tplF], params.basis), TmF = M.score >= 0.4 ? matchTransform(Gf) : null;
    const regF = registerFilm(bone, w, h, Gf, { init: TmF, initSteps: [0.04, 0.03, 4, 4] });
    const kf = Gf.cell / G.cell, ox = (Gf.x0 - G.x0) / G.cell, oy = (G.yTop - Gf.yTop) / G.cell, Tf0 = regF.T;
    const TfG = makeFilmTransform(Tf0.s * kf, Tf0.theta, Tf0.mirror, Tf0.tx * kf + ox, Tf0.ty * kf + oy);
    // keep whichever transform lays this bone's outline better on the film (edges + the measured bone): the
    // single-bone fit, or the region fit with its joint correction
    const fb = G.bones.find((b) => b.id === chosen.id), dtF = distanceTransform(filmEdges(allBone), w, h);
    const bpts = boundaryPoints(fb.mask, G.W, G.H, 800), ipts = [];
    for (let i = 0, n = 0; i < G.W * G.H; i++) if (fb.mask[i] && (n++ % 7 === 0)) ipts.push(i % G.W, (i / G.W) | 0);
    const score = (Tc) => {
      const v = []; let inside = 0, hit = 0, cnt = 0;
      for (let i = 0; i < bpts.length; i += 2) { const [u, q] = Tc.inv(bpts[i], bpts[i + 1]), ui = Math.round(u), vi = Math.round(q); if (ui >= 0 && vi >= 0 && ui < w && vi < h) v.push(Math.min(12, dtF[vi * w + ui])); }
      for (let i = 0; i < ipts.length; i += 2) { const [u, q] = Tc.inv(ipts[i], ipts[i + 1]), ui = Math.round(u), vi = Math.round(q); if (ui >= 0 && vi >= 0 && ui < w && vi < h) { inside++; if (bone[vi * w + ui]) hit++; } cnt++; }
      if (v.length < 20) return 99;
      v.sort((a, b) => a - b); const m = Math.floor(v.length * 0.8); let sm = 0; for (let i = 0; i < m; i++) sm += v[i];
      // consistency with the detector's own measurement: where along the bone the profile match puts the break
      let agree = 0;
      if (fracture.detected) {
        const [gx0, gy0] = Tc.fwd(fracture.point.x, fracture.point.y), ab = [fb.B2[0] - fb.A2[0], fb.B2[1] - fb.A2[1]];
        const sC = ((gx0 - fb.A2[0]) * ab[0] + (gy0 - fb.A2[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2);
        agree = Math.abs(sC - fracture.sTemplate) > 0.12 ? 10 : 0;
      }
      return sm / m + 6 * (1 - hit / Math.max(1, inside)) + (inside < cnt * 0.3 ? 6 : 0) + agree;
    };
    const Tregion = boneTransform(T, art.byId[chosen.id]), sR = score(Tregion);
    let TP = TfG, sF = regF.chamferMM < 4 ? score(TfG) : 99;
    if (isolate && chosen.id === params.focusId) { const sI = score(isolate.Tf); if (sI < sF) { TP = isolate.Tf; sF = sI; } } // the isolation fit
    reg.placement = { T: TP, chamferMM: sF <= sR ? Math.min(regF.chamferMM, 3.9) : 99, iou: regF.iou, scoreBone: sF, scoreRegion: sR, used: sF <= sR ? 'bone' : 'region' };
    if (sF <= sR && TP.mirror === T.mirror) { // the X-ray display uses the same transform for this bone, so film and model coincide
      const rec0 = art.byId[chosen.id], c0 = rec0.c, [u0, v0] = TP.inv(c0[0], c0[1]), [px0, py0] = T.fwd(u0, v0);
      Object.assign(rec0, { fitted: true, phi: T.theta - TP.theta, k: Math.log(T.s / TP.s), d: [px0 - c0[0], py0 - c0[1]], placement: true });
    }
  }
  const warp = warpFilmToSkeleton(G, T, art, r.canvas);
  reg.bones = art; reg.warpCanvas = warp.canvas;
  reg.boneT = (id) => (id === chosen.id && reg.placement.chamferMM < 4 ? reg.placement.T : boneTransform(T, art.byId[id]));
  const gridAtPixel = (u, v) => { const [a, b] = T.fwd(u, v); const xi = Math.round(a), yi = Math.round(b); return xi >= 0 && yi >= 0 && xi < G.W && yi < G.H ? yi * G.W + xi : -1; };
  {
    const c = greyCanvas(enh, [0.8, 0.84, 0.84]), g = c.getContext('2d'), d = g.getImageData(0, 0, w, h);
    const edge = new Uint8Array(G.W * G.H);
    for (let y = 1; y < G.H - 1; y++) for (let x = 1; x < G.W - 1; x++) { const i = y * G.W + x; if (G.union[i] && (!G.union[i - 1] || !G.union[i + 1] || !G.union[i - G.W] || !G.union[i + G.W])) edge[i] = 1; }
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) { const gi = gridAtPixel(u, v); if (gi >= 0 && (edge[gi] || edge[gi + 1])) { const k = (v * w + u) * 4; d.data[k] = 120; d.data[k + 1] = 110; d.data[k + 2] = 90; } }
    g.putImageData(d, 0, 0);
    // each bone's outline after its own correction (what the display warp lays onto the skeleton)
    g.fillStyle = 'rgb(236,214,160)';
    for (const b of G.bones) {
      const C = art.byId[b.id], pts = boundaryPoints(b.mask, G.W, G.H, 2500);
      for (let i = 0; i < pts.length; i += 2) { const [a, bb] = C?.fitted ? applyCorr(C, pts[i], pts[i + 1]) : [pts[i], pts[i + 1]]; const [u, v] = T.inv(a, bb); g.fillRect(u - 0.6, v - 0.6, 1.3, 1.3); }
    }
    const fittedB = art.bones.filter((b) => b.fitted);
    await done('register', {
      title: 'Film ↔ skeleton registration', basis: 'mixed',
      summary: `X-ray laid onto the skeleton: global fit ${reg.chamferMM.toFixed(1)} mm · ${reg.mmPerPx.toFixed(2)} mm/px · ${fittedB.length} bone${fittedB.length === 1 ? '' : 's'} refined at the joints`,
      image: c, warn: reg.chamferMM > 6,
      metrics: [['Mean edge distance (global)', `${reg.chamferMM.toFixed(2)} mm`], ['Scale', `${reg.mmPerPx.toFixed(3)} mm/px`], ['Rotation', `${reg.rotationDeg.toFixed(1)}°${reg.mirror ? ' · mirrored' : ''}`],
        ...art.bones.filter((b) => b.inside >= 0.3).map((b) => [`  ${G.bones.find((x) => x.id === b.id).rec.name}`, b.fitted ? `${(b.phi * 180 / Math.PI).toFixed(1)}° · ×${Math.exp(b.k).toFixed(2)} · ${Math.hypot(...b.d) * G.cell * 1000 | 0} mm → edges ${b.mmBefore.toFixed(1)} → ${b.mmAfter.toFixed(1)} mm` : `kept (edges ${b.mmBefore?.toFixed(1) ?? '—'} mm)`]),
        ...(art.joints?.length ? art.joints.map((j) => [`  Joint ${G.bones.find((x) => x.id === j.parent)?.rec.name ?? j.parent} → ${j.group.map((g) => G.bones.find((x) => x.id === g)?.rec.name ?? g).join(' + ')}`, `${j.deg.toFixed(0)}° from the reference skeleton`]) : []),
        ['Used for', 'X-ray warped onto the unchanged skeleton; fracture placement on its bone; depth']],
    });
  }

  // 7–8. Depth from the registered skeleton + point cloud
  const depth = new Float32Array(w * h); let dmax = 0;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) { const gi = gridAtPixel(u, v); if (gi < 0) continue; const t = G.thick[gi] / (T.s * G.cell); depth[v * w + u] = t; if (t > dmax) dmax = t; }
  {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), d = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const col = depth[i] > 0 ? ramp(depth[i] / Math.max(1, dmax)) : [6, 10, 11]; d.data[i * 4] = col[0]; d.data[i * 4 + 1] = col[1]; d.data[i * 4 + 2] = col[2]; d.data[i * 4 + 3] = 255; }
    g.putImageData(d, 0, 0);
    await done('depth', { title: 'Depth estimation', basis: 'estimated', summary: 'Thickness along the beam from the registered skeleton (anatomical reference). A single X-ray does not measure depth.', image: c, metrics: [['Max thickness', `${(dmax * T.s * G.cell * 1000).toFixed(1)} mm`]] });
  }
  const pts = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const dd = depth[y * w + x]; if (dd > 0) pts.push(x, -y, dd / 2, x, -y, -dd / 2); }
  await done('pointcloud', { title: 'Point cloud', basis: 'estimated', summary: `${(pts.length / 6 * 2).toLocaleString()} points on the front/back surfaces of the registered anatomy`, image: null, metrics: [['Points', (pts.length / 3).toLocaleString()]] });

  return {
    size: { w, h }, crop: r.crop, xrayCanvas: r.canvas, grid: G, registration: reg,
    match: M, candidates, consistent, chosenId: chosen.id, fracture, joint: isoDiag ? { mm: isoDiag.mm, frac: isoDiag.frac, mainInside: isoDiag.mainInside, joints: isoDiag.joints, used: !!isolate } : null, axis: { cx: ax.cx, cy: ax.cy, ex, ey, px, py, tmin, L },
    signals: { gap: Array.from(sig.gap), luc: Array.from(sig.luc), step: Array.from(sig.step), sm: Array.from(sm), loc: Array.from(locSm), width: Array.from({ length: N_SLICES }, (_, i) => ((hiF[i] - loF[i]) - (hi2[i] - lo2[i])) / medW), cov: Array.from(P.cov) },
  };
}

// ---------- backend engine (FastAPI) ----------
export async function backendAvailable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1200);
    const r = await fetch('api/health', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function runBackendPipeline(file, params, report) {
  const fd = new FormData();
  fd.append('xray', file);
  fd.append('params', JSON.stringify({
    projection: params.projection, roi: params.roi, invert: params.invert, focus_id: params.focusId,
    marks: params.marks, bones: params.bones, detector: params.detector,
  }));
  const res = await fetch('api/analyze', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  const out = await res.json();
  for (const st of out.stages) {
    let im = null;
    if (st.image) { im = new Image(); im.src = st.image; await im.decode().catch(() => {}); }
    await report?.(st.id, { ...st, image: im });
  }
  return out;
}
