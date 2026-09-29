// Learned fracture detectors (optional, selectable next to the built-in first-version detector).
//
// A pretrained YOLOv8 model exported to ONNX runs in the browser with onnxruntime-web (WebAssembly), so it also
// works on a Quest or a phone. The files are split into <15 MB parts and only downloaded when the detector is
// used. Boxes are returned in the ORIGINAL image's pixel coordinates.
//
// hbfmid_yolov8m — the user's own YOLOv8m, trained on the HBFMID "Bon Fracture Detection" dataset (10 classes:
//   nine fracture types + Healthy). Its weights ship as float16 (half the download) and are expanded to float32
//   in the browser before the model is built. Research model, not a diagnostic device.
// wrist_yolov8 — YOLOv8 trained on GRAZPEDWRI-DX (Ju & Cai, Sci Rep 2023, MIT). Paediatric wrists only. Kept for
//   the Python backend; not shipped in the published viewer (size limit).

// onnxruntime-web 1.30.0 (vendor/ort)
// bundled with the app (vendor/ort) so analysis works offline
const ORT_BASE = new URL('./vendor/ort/', import.meta.url).href;

export const DETECTORS = {
  builtin: {
    label: 'Built-in (first version)',
    note: 'Cortical gap + lucent line + contour step against the skeleton bone. Works on any long bone.',
  },
  hbfmid_yolov8m: {
    label: 'Your YOLOv8m (HBFMID)',
    short: 'your model',
    note: 'Your pretrained YOLOv8m (HBFMID, 9 fracture types + Healthy). ~52 MB download on first use.',
    graph: 'models/fracture_detector/web/hbfmid_yolov8m.graph.wasm',
    weights16: ['models/fracture_detector/web/hbfmid_yolov8m.w0.wasm', 'models/fracture_detector/web/hbfmid_yolov8m.w1.wasm', 'models/fracture_detector/web/hbfmid_yolov8m.w2.wasm', 'models/fracture_detector/web/hbfmid_yolov8m.w3.wasm'],
    externalName: 'hbfmid_yolov8m.weights',
    imgsz: 640,
    resize: 'stretch', // the training images were stretched to 640×640
    classes: ['Comminuted', 'Greenstick', 'Healthy', 'Linear', 'Oblique Displaced', 'Oblique', 'Segmental', 'Spiral', 'Transverse Displaced', 'Transverse'],
    healthy: 2,
    fractureClasses: [0, 1, 3, 4, 5, 6, 7, 8, 9],
  },
  wrist_yolov8: {
    label: 'YOLOv8 · wrist (GRAZPEDWRI-DX)',
    short: 'wrist model',
    note: 'Pretrained learned detector (Ju & Cai, Sci Rep 2023). Trained on paediatric wrist films only.',
    parts: ['models/fracture_detector/web/wrist_yolov8.part0.wasm', 'models/fracture_detector/web/wrist_yolov8.part1.wasm', 'models/fracture_detector/web/wrist_yolov8.part2.wasm'],
    imgsz: 640,
    resize: 'letterbox',
    classes: ['boneanomaly', 'bonelesion', 'foreignbody', 'fracture', 'metal', 'periostealreaction', 'pronatorsign', 'softtissue', 'text'],
    healthy: -1,
    fractureClasses: [3],
    regions: ['wrist', 'forearm', 'hand'],
  },
};

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) {
    ortPromise = import(/* @vite-ignore */ `${ORT_BASE}ort.wasm.min.js`).then((m) => {
      const ort = m.default?.InferenceSession ? m.default : m;
      // .js (not .mjs) so any static host serves them as JavaScript
      ort.env.wasm.wasmPaths = { mjs: `${ORT_BASE}ort-wasm-simd-threaded.js`, wasm: `${ORT_BASE}ort-wasm-simd-threaded.wasm` };
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      return ort;
    });
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

async function fetchAll(urls, onBytes) {
  const bufs = []; let got = 0;
  for (const url of urls) {
    const res = await fetch(new URL(url, import.meta.url));
    if (!res.ok) throw new Error(`Model file missing (${url}: HTTP ${res.status})`);
    const b = new Uint8Array(await res.arrayBuffer());
    bufs.push(b); got += b.length; onBytes?.(b.length);
  }
  const all = new Uint8Array(got);
  let o = 0; for (const b of bufs) { all.set(b, o); o += b.length; }
  return all;
}

// IEEE half → float, via a 65,536-entry table
let HALF = null;
function halfToFloat(u16) {
  if (!HALF) {
    HALF = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      HALF[h] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
    }
  }
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = HALF[u16[i]];
  return out;
}

const sessions = new Map();
export async function loadDetector(id, onProgress) {
  const d = DETECTORS[id];
  if (!d?.parts && !d?.graph) return null;
  if (sessions.has(id)) return sessions.get(id);
  const p = (async () => {
    const ort = await loadOrt();
    let got = 0; const tick = (n) => { got += n; onProgress?.(got); };
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    if (d.graph) { // graph + float16 external weights, expanded to float32 here
      const graph = await fetchAll([d.graph], tick), w16 = await fetchAll(d.weights16, tick);
      const w32 = halfToFloat(new Uint16Array(w16.buffer, w16.byteOffset, w16.byteLength / 2));
      opts.externalData = [{ path: d.externalName, data: new Uint8Array(w32.buffer) }];
      return { ort, session: await ort.InferenceSession.create(graph, opts) };
    }
    return { ort, session: await ort.InferenceSession.create(await fetchAll(d.parts, tick), opts) };
  })();
  sessions.set(id, p);
  p.catch(() => sessions.delete(id));
  return p;
}

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter || 1);
};

// source: image / canvas / ImageBitmap. Returns { boxes: [{cls, name, score, box:[x1,y1,x2,y2]}], fractures, healthy, ms }.
export async function runDetector(id, source, { scoreThr = 0.25, iouThr = 0.7, onProgress } = {}) {
  const d = DETECTORS[id];
  const t0 = performance.now();
  const { ort, session } = await loadDetector(id, onProgress);
  const S = d.imgsz, sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  let rx, ry, left = 0, top = 0;
  if (d.resize === 'stretch') { rx = S / sw; ry = S / sh; g.drawImage(source, 0, 0, sw, sh, 0, 0, S, S); }
  else { // Ultralytics letterbox: keep aspect, pad with grey 114, image centred
    const r = Math.min(S / sw, S / sh), nw = Math.round(sw * r), nh = Math.round(sh * r);
    left = Math.round((S - nw) / 2 - 0.1); top = Math.round((S - nh) / 2 - 0.1); rx = ry = r;
    g.fillStyle = 'rgb(114,114,114)'; g.fillRect(0, 0, S, S);
    g.drawImage(source, 0, 0, sw, sh, left, top, nw, nh);
  }
  const px = g.getImageData(0, 0, S, S).data, n = S * S, input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { input[i] = px[i * 4] / 255; input[n + i] = px[i * 4 + 1] / 255; input[2 * n + i] = px[i * 4 + 2] / 255; }
  const out = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) }))[session.outputNames[0]];
  const [, rows, A] = out.dims, o = out.data, nc = rows - 4;
  const cand = [];
  for (let a = 0; a < A; a++) {
    let best = -1, bs = 0;
    for (let k = 0; k < nc; k++) { const v = o[(4 + k) * A + a]; if (v > bs) { bs = v; best = k; } }
    if (bs < scoreThr) continue;
    const cx = o[a], cy = o[A + a], bw = o[2 * A + a], bh = o[3 * A + a];
    const box = [(cx - bw / 2 - left) / rx, (cy - bh / 2 - top) / ry, (cx + bw / 2 - left) / rx, (cy + bh / 2 - top) / ry]
      .map((v, i) => Math.max(0, Math.min(i % 2 ? sh : sw, v)));
    cand.push({ cls: best, name: d.classes[best] || `class ${best}`, score: bs, box });
  }
  cand.sort((p, q) => q.score - p.score);
  const boxes = [];
  for (const b of cand) if (!boxes.some((k) => k.cls === b.cls && iou(k.box, b.box) > iouThr)) boxes.push(b);
  return { detector: id, boxes, fractures: boxes.filter((b) => d.fractureClasses.includes(b.cls)), healthy: boxes.filter((b) => b.cls === d.healthy), ms: performance.now() - t0 };
}
