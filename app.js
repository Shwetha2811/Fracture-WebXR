// FractoVue XR — application orchestration.
//   complete skeleton → select region (+ bone of interest) → upload X-ray → lay the film onto the
//   skeleton → find every bone in the film → detect every fracture → cut and displace only the
//   fractured bones → highlight fractures → explore on desktop, in VR, or in AR.
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { buildSkeleton } from './skeleton.js';
import { BoneRegistry, REGIONS, loadParts, factFor } from './anatomy.js';
import { createViewer } from './viewer.js';
import { createPicker, attachDesktopPointer } from './controls.js';
import { PatientBoneView, MODES } from './fracture.js';
import { runImagePipeline, loadImage, backendAvailable, runBackendPipeline } from './pipeline.js';
import { extractTemplate, viewBasis, projectBones, buildFracturedBone, renderMeshPreview, templateProfile, fractureModelFromDetection, fractureModelFromFilm } from './reconstruction.js';
import { makeFilmTransform } from './registration.js';
import { makeSyntheticXray } from './sample.js';
import { XRManager, detectXR } from './xr.js';
import { DETECTORS, runDetector } from './mldetect.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

// ---------- scene + skeleton ----------
const viewer = createViewer($('stage'));
const [skull, ribs, body] = await Promise.all(['skull', 'ribs', 'body'].map((n) => loadParts(THREE, `assets/skeleton/${n}.json`)));
const { root, bones, materials } = buildSkeleton(THREE, { MarchingCubes, skull, ribs, body });
viewer.model.add(root);
root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
const registry = new BoneRegistry(root, bones);
$('loading').remove();
window.fractovue = { registry, viewer }; // handy for debugging in the console

// Installed app (Android / Quest): the service worker keeps everything available offline
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable:', err));
}

// generic bone materials (surface grain from the Human Skeleton Atlas)
const boneMat = materials.bone;
boneMat.roughness = 0.62; boneMat.envMapIntensity = 0.5;
const hoverMat = boneMat.clone(); hoverMat.color.set(0xfff6e4); hoverMat.emissive.set(0x2a2214);
const selMat = boneMat.clone(); selMat.color.set(0xa6e4ec); selMat.emissive.set(0x0c3a40);
const regionMat = boneMat.clone(); regionMat.color.set(0xf2e2c0); regionMat.emissive.set(0x1c1a10);
function addGrain(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrainPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGrainPos;
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float grain = gNoise(vGrainPos * 900.0) * 0.6 + gNoise(vGrainPos * 320.0) * 0.4;
diffuseColor.rgb *= 0.84 + 0.22 * grain;`);
  };
  m.customProgramCacheKey = () => 'bone-grain';
}
[boneMat, hoverMat, selMat, regionMat].forEach(addGrain);

const patient = new PatientBoneView({ model: viewer.model, registry, boneMaterial: boneMat });
viewer.onFrame((dt, t) => patient.update(dt, t));

// ---------- state ----------
let xr = null; // XRManager, created once the UI exists
const state = {
  region: null, boneId: null, projection: 'AP', invert: false, detector: 'gated',
  source: null, sourceBlob: null, sourceName: '', roi: null, marks: [], sampleTruth: null,
  result: null, selected: null, focused: false, focusIndex: -1, rotating: false, busy: false,
  engine: { backend: null, useBackend: true },
  hovers: new Map(),
  show: (k) => patient.show[k],
  mode: () => patient.mode,
  boneDisplay: () => patient.boneDisplay,
  hasPatient: () => patient.active,
  hasFracture: () => !!(patient.active && patient.fractureCount),
  xrMode: () => xr?.mode,
  summary() {
    const rec = registry.get(state.boneId);
    const frs = state.result?.fractures || [];
    const regionLabel = state.region ? REGIONS.find((r) => r.id === state.region).label : '';
    const side = rec?.side && rec.side !== 'mid' ? cap(rec.side) + ' ' : '';
    const bonesHit = [...new Set(frs.map((f) => f.bone.rec.name.replace(/^(left|right) /i, '')))];
    return {
      region: regionLabel ? `${side}${regionLabel.toLowerCase()}`.replace(/^./, (c) => c.toUpperCase()) : 'No region selected',
      status: patient.active ? `${frs.length ? `${bonesHit.length} bone${bonesHit.length > 1 ? 's' : ''} modified` : 'No bone modified'}` : rec ? 'Reference skeleton' : '—',
      fracture: !state.result ? '—' : frs.length ? `${frs.length} · ${bonesHit.join(', ')}` : 'None detected',
      confidence: frs.length ? frs.map((f) => `${(f.confidence * 100).toFixed(0)}%`).join(' / ') : state.result ? '—' : '—',
      detected: frs.length > 0, patient: patient.active,
    };
  },
  infoTarget() {
    let hov = null;
    for (const h of state.hovers.values()) if (h) hov = h;
    return describe(hov || state.selected);
  },
};

function describe(hit) {
  if (!hit) return null;
  const frs = state.result?.fractures || [];
  const anchorWorld = () => (hit.point ? hit.point.clone() : viewer.model.localToWorld(centerOf(hit) || new THREE.Vector3(0, 0.9, 0)));
  if (hit.kind === 'fracture' && frs[hit.index]) {
    const f = frs[hit.index];
    return {
      kind: 'fracture', title: `Fracture ${hit.index + 1} of ${frs.length} · ${f.bone.rec.name}`, anchorWorld,
      rows: [['Confidence', `${(f.confidence * 100).toFixed(1)}%`, '#ff6a5c'], ['Location', `${(f.sAxis * 100).toFixed(0)}% from proximal`], ['Pattern', f.pattern.split(' (')[0] + (f.displaced ? ', displaced' : '')],
        ['Displacement', `≈ ${Math.abs(f.shiftMM).toFixed(1)} mm · ${Math.abs(f.angulationDeg).toFixed(1)}°`],
        ...(f.fragments?.length ? [['Loose fragments', `${f.fragments.length} seen on the film, modelled`]] : []), ['Detector', f.source]],
      fact: 'Displacement and angulation are measured in the film plane; out-of-plane components cannot be seen in one projection.',
    };
  }
  const rec = hit.rec;
  if (!rec) return null;
  const mine = frs.filter((f) => f.bone.rec === rec);
  const inFilm = state.result?.bones.find((b) => b.rec === rec);
  return {
    kind: 'bone', title: cap(rec.name), anchorWorld,
    rows: [
      ['Status', mine.length ? `Modified at ${mine.length} fracture${mine.length > 1 ? 's' : ''}` : inFilm?.analyzable ? 'Unchanged (checked, intact)' : 'Unchanged reference bone', mine.length ? '#7fd3de' : null],
      ['Fracture', mine.length ? `${mine.length} detected` : inFilm?.analyzable ? 'None detected' : 'Not assessed', mine.length ? '#ff6a5c' : null],
      ['Confidence', mine.length ? mine.map((f) => `${(f.confidence * 100).toFixed(1)}%`).join(' / ') : '—'],
      ['ID', rec.id],
    ],
    fact: mine.length ? 'Original skeleton bone, cut along each fracture and displaced as measured on the film. The rest of the bone is unchanged.' : factFor(rec.id),
  };
}

// ---------- painting (hover / selection / region) ----------
let regionSet = new Set();
function paint(rec) {
  if (!rec || rec.status === 'replaced') return;
  const hov = [...state.hovers.values()].some((h) => h?.rec === rec && h.kind === 'bone');
  const m = state.selected?.rec === rec && state.selected.kind === 'bone' ? selMat : hov ? hoverMat : regionSet.has(rec) ? regionMat : boneMat;
  for (const o of rec.objects) o.traverse((x) => { if (x.isMesh && x.userData.baseMaterial === boneMat) x.material = m; });
}
const paintAll = () => registry.all().forEach(paint);

function setHover(src, hit) {
  const prev = state.hovers.get(src) || null;
  const same = prev?.rec === hit?.rec && prev?.kind === hit?.kind && prev?.index === hit?.index;
  if (hit) state.hovers.set(src, hit); else state.hovers.delete(src);
  if (same) { if (hit) prev.point = hit.point; return false; }
  paint(prev?.rec); paint(hit?.rec);
  xr?.ui.info.redraw();
  return true;
}

function select(hit) {
  const prev = state.selected;
  state.selected = hit ? { ...hit, center: () => centerOf(hit) } : null;
  paint(prev?.rec); paint(hit?.rec);
  renderInfo();
  xr?.refreshUI();
}
function centerOf(hit) {
  if (hit.kind === 'fracture') return patient.fracturePoint(hit.index);
  if (hit.kind === 'patient') { const it = patient.items.find((x) => x.rec === hit.rec); return it ? it.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()) : null; }
  const b = new THREE.Box3(); for (const o of hit.rec.objects) b.expandByObject(o);
  return viewer.model.worldToLocal(b.getCenter(new THREE.Vector3()));
}

function renderInfo() {
  const d = describe(state.selected);
  $('info').hidden = !d;
  if (!d) return;
  $('info-tag').textContent = d.kind === 'fracture' ? 'Selected fracture' : 'Selected bone';
  $('info-tag').classList.toggle('red', d.kind === 'fracture');
  $('info-name').textContent = d.title;
  $('info-rows').innerHTML = d.rows.map(([k, v, c]) => `<dt>${esc(k)}</dt><dd${c ? ` style="color:${c}"` : ''}>${esc(v)}</dd>`).join('');
  $('info-fact').textContent = d.fact || '';
}

// ---------- picking ----------
const picker = createPicker({ registry, patient });
const tooltip = $('tooltip');
attachDesktopPointer({
  viewer, picker,
  onHover(hit, e) {
    setHover('mouse', hit);
    document.body.classList.toggle('pointing', !!hit);
    if (hit && e) {
      tooltip.textContent = hit.kind === 'fracture' ? `Fracture ${hit.index + 1} · ${hit.rec?.name || ''}` : hit.kind === 'patient' ? `${hit.rec.name} · fractured` : hit.rec.name;
      tooltip.className = `tooltip ${hit.kind === 'fracture' ? 'fracture' : hit.kind === 'patient' ? 'patient' : ''}`;
      tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px'; tooltip.hidden = false;
    } else tooltip.hidden = true;
  },
  onSelect(hit) { select(hit); },
  onFocus(hit) {
    const c0 = centerOf(hit); if (!c0) return;
    const c = viewer.model.localToWorld(c0.clone());
    const off = viewer.camera.position.clone().sub(viewer.controls.target).setLength(hit.kind === 'fracture' ? 0.25 : 0.5);
    viewer.flyTo(c.clone().add(off), c);
  },
});

// ---------- templates (skeleton bones as the anatomical reference) ----------
const templates = new Map();
function getTemplate(id) {
  if (!templates.has(id)) templates.set(id, extractTemplate(THREE, registry.get(id), viewer.model));
  return templates.get(id);
}
function partSource(rec) { // which asset file / part name holds this bone (for the Python backend)
  const n = rec.anatomicalName;
  if (/^cranium|^mandible/i.test(n)) return { file: 'skull.json', part: /^cranium/i.test(n) ? 'cranium' : 'mandible' };
  if (/ rib/i.test(n)) return { file: 'ribs.json', part: n };
  return { file: 'body.json', part: n };
}
// All bones of the chosen region on the side of the bone of interest (these are laid onto the film).
function filmBones() {
  const focus = registry.get(state.boneId);
  const seen = new Set();
  return registry.regionBones(state.region)
    .filter((b) => (focus.side === 'mid' ? true : b.rec.side === focus.side || b.rec.side === 'mid'))
    .map((b) => b.rec).filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// ---------- region & bone pickers ----------
function renderRegions() {
  $('regions').innerHTML = '';
  for (const r of REGIONS) {
    if (!registry.regionBones(r.id).length) continue;
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = r.label; b.setAttribute('aria-pressed', state.region === r.id);
    b.onclick = () => chooseRegion(r.id);
    $('regions').appendChild(b);
  }
}
function chooseRegion(id) {
  state.region = id; detectorNote();
  renderRegions();
  const list = registry.regionBones(id);
  regionSet = new Set(list.map((b) => b.rec));
  paintAll();
  const groups = new Map();
  for (const b of list) {
    const label = b.rec.side === 'left' ? `Left ${REGIONS.find((r) => r.id === id).label.toLowerCase()}` : b.rec.side === 'right' ? `Right ${REGIONS.find((r) => r.id === id).label.toLowerCase()}` : 'Midline';
    if (!groups.has(label)) groups.set(label, []);
    if (!groups.get(label).some((x) => x.rec === b.rec)) groups.get(label).push(b);
  }
  $('bones').innerHTML = [...groups].map(([label, items]) => `<div class="bone-group"><div class="gl">${esc(label)}</div><div class="items">${items.map((b) =>
    `<button class="bone-btn" data-bone="${b.rec.id}" aria-pressed="${state.boneId === b.rec.id}">${esc(shortName(b.rec))}<small>${b.cover[0] > 0 ? 'distal part' : b.cover[1] < 1 ? 'proximal part' : b.rec.kind === 'long' ? 'long bone' : b.rec.kind}</small></button>`).join('')}</div></div>`).join('')
    + '<p class="note">Pick the bone the X-ray shows. Its fracture is found on the film and applied to that skeleton bone; nothing else in the skeleton changes.</p>';
  $('bones').querySelectorAll('[data-bone]').forEach((btn) => { btn.onclick = () => chooseBone(btn.dataset.bone); });
  $('step-region').classList.add('done');
  const box = new THREE.Box3(); for (const b of list) for (const o of b.rec.objects) box.expandByObject(o);
  if (!box.isEmpty() && !xr.presenting) viewer.frameBox(box, 1.5);
}
function shortName(rec) {
  return rec.name.replace(/^(left|right) /i, '').replace(/ \(.*\)$/, '').replace(/^./, (c) => c.toUpperCase());
}
function chooseBone(id) {
  if (state.busy) return;
  const prevSide = registry.get(state.boneId)?.side;
  if (patient.active && registry.get(id).side !== prevSide) clearResult();
  state.boneId = id;
  $('bones').querySelectorAll('[data-bone]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.bone === id));
  const rec = registry.get(id);
  select({ kind: 'bone', rec, point: null });
  $('step-bone').classList.add('done');
  $('sample').disabled = false;
  updateAnalyzeButton();
  const box = new THREE.Box3(); for (const o of rec.objects) box.expandByObject(o);
  if (!xr.presenting) viewer.frameBox(box, 1.3);
  refreshControls();
}
function clearResult() { patient.clear(); state.result = null; state.focused = false; $('step-result').hidden = true; $('step-pipeline').hidden = true; }

// ---------- X-ray input ----------
const previewCanvas = $('preview-canvas');
async function setSource(src, blob, name, truth = null) {
  state.source = await loadImage(src);
  state.sourceBlob = blob; state.sourceName = name; state.roi = null; state.marks = []; state.sampleTruth = truth;
  const im = state.source, w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
  previewCanvas.width = w; previewCanvas.height = h;
  previewCanvas.getContext('2d').drawImage(im, 0, 0);
  $('preview').hidden = false; $('opts').hidden = false;
  drawMarks();
  $('step-xray').classList.add('done');
  updateAnalyzeButton();
}
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setSource(f, f, f.name); });
const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) setSource(f, f, f.name); });

// Synthetic film of the bone of interest with one simulated fracture (as in the first version).
async function makeSample() {
  const focus = registry.get(state.boneId);
  const fractures = { [focus.id]: [{ s: 0.56, obliquityDeg: 24, shift: 0.0045, angulationDeg: 6, gap: 0.002 }] };
  const { canvas, truth } = makeSyntheticXray([getTemplate(focus.id)], { projection: state.projection, fractures });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  await setSource(canvas, blob, `synthetic_${focus.id}_${state.projection}.png`, truth);
}
$('sample').onclick = () => makeSample();
// fracture detector: built-in (first version) locates, your YOLOv8m (HBFMID) decides · your model alone · built-in alone
const ML_ID = 'hbfmid_yolov8m', ML_THR = 0.4; // calibrated: HBFMID val/test + real films (healthy ≤ 0.16, a diagram 0.34, fractures ≥ 0.45)
function detectorNote() {
  const d = DETECTORS[ML_ID], off = state.detector !== 'builtin' && state.region && d.regions && !d.regions.includes(state.region);
  $('det-note').className = off ? 'note warn' : 'note';
  $('det-note').textContent = state.detector === 'builtin' ? `${DETECTORS.builtin.note} It can report fractures on healthy bones.`
    : state.detector === 'gated' ? `Your model decides whether there is a fracture (and its type); the built-in detector places it on the bone. ${d.note}`
    : `Your model decides and its box sets the location. ${d.note}${off ? ' ⚠ This region is outside its training data.' : ''}`;
}
document.querySelectorAll('[data-det]').forEach((b) => {
  b.onclick = () => { state.detector = b.dataset.det; document.querySelectorAll('[data-det]').forEach((x) => x.setAttribute('aria-pressed', x === b)); detectorNote(); };
});
detectorNote();
document.querySelectorAll('[data-proj]').forEach((b) => {
  b.onclick = () => { state.projection = b.dataset.proj; document.querySelectorAll('[data-proj]').forEach((x) => x.setAttribute('aria-pressed', x === b)); };
});
$('invert').onchange = (e) => { state.invert = e.target.checked; };

// crop + manual fracture marks (any number) on the preview
let previewTool = null, dragStart = null;
function setTool(t) {
  previewTool = previewTool === t ? null : t;
  $('crop-btn').setAttribute('aria-pressed', previewTool === 'crop');
  $('mark-btn').setAttribute('aria-pressed', previewTool === 'mark');
  $('preview').className = `preview ${previewTool || ''}`;
  $('preview-mode').hidden = !previewTool;
  $('preview-mode').textContent = previewTool === 'crop' ? 'Drag a box around the bones' : previewTool === 'mark' ? 'Click each fracture' : '';
}
$('crop-btn').onclick = () => setTool('crop');
$('mark-btn').onclick = () => setTool('mark');
$('clear-btn').onclick = () => { state.roi = null; state.marks = []; drawMarks(); };
const rel = (e) => { const r = previewCanvas.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
$('preview').addEventListener('pointerdown', (e) => {
  if (!previewTool) return;
  const p = rel(e);
  if (previewTool === 'mark') { state.marks.push({ u: p.x, v: p.y }); drawMarks(); return; }
  dragStart = p; $('preview').setPointerCapture(e.pointerId);
});
$('preview').addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = rel(e);
  state.roi = { x: Math.min(p.x, dragStart.x), y: Math.min(p.y, dragStart.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) };
  drawMarks();
});
$('preview').addEventListener('pointerup', () => { if (dragStart) { dragStart = null; if (state.roi && (state.roi.w < 0.04 || state.roi.h < 0.04)) state.roi = null; drawMarks(); setTool('crop'); } });
function drawMarks() {
  const roi = $('roi');
  roi.hidden = !state.roi;
  if (state.roi) Object.assign(roi.style, { left: `${state.roi.x * 100}%`, top: `${state.roi.y * 100}%`, width: `${state.roi.w * 100}%`, height: `${state.roi.h * 100}%` });
  $('preview').querySelectorAll('.pin').forEach((p) => p.remove());
  for (const m of state.marks) {
    const pin = document.createElement('div'); pin.className = 'pin';
    Object.assign(pin.style, { left: `${m.u * 100}%`, top: `${m.v * 100}%` });
    $('preview').appendChild(pin);
  }
}
function updateAnalyzeButton() { $('analyze').disabled = !(state.boneId && state.source) || state.busy; }

// ---------- pipeline UI ----------
const STAGES = [
  ['preprocess', 'Preprocessing'], ['segment', 'Bone segmentation'], ['identify', 'Anatomical identification'],
  ['fracture', 'Fracture detection'], ['fracture_seg', 'Fracture segmentation'], ['register', 'Film ↔ skeleton registration'],
  ['depth', 'Depth estimation'], ['pointcloud', 'Point cloud'], ['mesh', 'Fracture modelling'], ['replace', 'Skeleton update'],
];
const stageData = new Map();
function resetStages() {
  stageData.clear();
  $('stages').innerHTML = STAGES.map(([id, title], i) => `<li class="stage" id="st-${id}" data-stage="${id}"><span class="st">${i + 1}</span><div><div class="tt">${title}</div><div class="sm">Waiting</div></div><span class="thumb"></span></li>`).join('');
  $('stages').querySelectorAll('.stage').forEach((li) => li.addEventListener('click', () => openStage(li.dataset.stage)));
}
function stageRunning(id) {
  const li = $(`st-${id}`); if (!li) return;
  li.className = 'stage run'; li.querySelector('.sm').textContent = 'Running…';
}
async function stageDone(id, data) {
  stageData.set(id, data);
  const li = $(`st-${id}`); if (!li) return;
  li.className = `stage ${data.error ? 'err' : data.warn ? 'warn' : 'done'}`;
  li.querySelector('.st').textContent = data.error ? '!' : data.warn ? '!' : '✓';
  li.querySelector('.tt').innerHTML = `${esc(data.title)} <span class="basis ${data.basis}">${data.basis}</span>`;
  li.querySelector('.sm').textContent = data.summary;
  if (data.image) {
    const url = data.image.toDataURL ? data.image.toDataURL('image/png') : data.image.src;
    li.querySelector('.thumb').style.backgroundImage = `url(${url})`;
    data.url = url;
  }
  const next = STAGES[STAGES.findIndex(([s]) => s === id) + 1];
  if (next) stageRunning(next[0]);
  await sleep(120);
}
function openStage(id) {
  const d = stageData.get(id); if (!d) return;
  $('modal-img').innerHTML = d.url ? `<img alt="${esc(d.title)} output" src="${d.url}">` : '';
  $('modal-basis').className = `basis ${d.basis}`; $('modal-basis').textContent = d.basis;
  $('modal-title').textContent = d.title; $('modal-summary').textContent = d.summary;
  $('modal-metrics').innerHTML = (d.metrics || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('stage-modal').showModal();
}

// ---------- analysis ----------
// A film-space fracture annotation expressed in skeleton-grid pixels (for the warped X-ray display).
function markOnGrid(f, Tb) {
  const P = (q) => { const [x, y] = Tb.fwd(q.x, q.y); return { x, y }; };
  const [ax, ay] = Tb.fwd(f.dir?.x ?? 1, f.dir?.y ?? 0), [ox, oy] = Tb.fwd(0, 0), l = Math.hypot(ax - ox, ay - oy) || 1;
  return { point: P(f.point), dir: { x: (ax - ox) / l, y: (ay - oy) / l }, widthPx: (f.widthPx || 20) * Tb.s, zoneImg: f.zoneImg?.map(P),
    fragments: (f.fragments || []).map((g) => ({ ...g, outline: g.outline?.map(P), centroid: P(g.centroid) })) };
}
$('analyze').onclick = () => runAnalysis().catch(onAnalysisError);
function onAnalysisError(err) {
  console.error(err);
  const running = $('stages').querySelector('.stage.run');
  if (running) stageDone(running.dataset.stage, { title: running.querySelector('.tt').textContent, basis: 'observed', summary: err.message, error: true });
  state.busy = false; updateAnalyzeButton();
}

async function runAnalysis() {
  state.busy = true; updateAnalyzeButton();
  clearResult(); patient.setContextDim(0);
  $('step-pipeline').hidden = false;
  resetStages(); stageRunning('preprocess');
  $('step-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const focus = registry.get(state.boneId);
  const recs = filmBones();
  const tpls = recs.map((r) => getTemplate(r.id));
  const basis = viewBasis(state.projection, focus.side);
  const roi = state.roi;
  const marks = state.marks.map((m) => (roi ? { u: (m.u - roi.x) / roi.w, v: (m.v - roi.y) / roi.h } : m)).filter((m) => m.u >= 0 && m.u <= 1 && m.v >= 0 && m.v <= 1);
  const covers = new Map(registry.regionBones(state.region).map((b) => [b.rec.id, b.cover]));
  const candidates = recs.filter((r) => ['long', 'short'].includes(r.kind) || r.id === focus.id)
    .map((r) => ({ id: r.id, name: r.name, cover: covers.get(r.id), profile: templateProfile(getTemplate(r.id), state.projection) }));
  const params = { projection: state.projection, roi, invert: state.invert, basis, tpls, focusId: focus.id, marks, candidates, detector: state.detector };
  if (state.detector !== 'builtin' && !(state.engine.backend && state.engine.useBackend && state.sourceBlob)) {
    // run the learned detector on the original image (it was trained on whole radiographs)
    const d = DETECTORS[ML_ID], note = $('det-note');
    note.textContent = `Running ${d.label}…`;
    try {
      const ml = await runDetector(ML_ID, state.source, { iouThr: 0.7, onProgress: (b) => { note.textContent = `Loading ${d.label}: ${(b / 1e6).toFixed(0)} MB…`; } });
      params.ml = { label: d.short, fractureClasses: d.fractureClasses, healthyClass: d.healthy, thr: ML_THR, boxes: ml.boxes, ms: ml.ms };
      const topF = ml.fractures[0], topH = ml.healthy[0];
      note.textContent = `${d.label}: ${topF ? `${topF.name} ${(topF.score * 100).toFixed(0)}%` : 'no fracture box'}${topH ? ` · Healthy ${(topH.score * 100).toFixed(0)}%` : ''} (${(ml.ms / 1000).toFixed(1)} s).`;
    } catch (err) {
      console.warn(err);
      // never fall back silently to the built-in detector alone: it reports growth plates etc. as fractures
      params.ml = { label: DETECTORS[ML_ID].short, failed: err.message, fractureClasses: [], healthyClass: -1, boxes: [] };
      note.className = 'note warn'; note.textContent = `Your model could not be loaded (${err.message}), so no fracture can be confirmed. Choose "Built-in" to see the built-in detector's own result.`;
    }
  }

  let analysis;
  if (state.engine.backend && state.engine.useBackend && state.sourceBlob) {
    const out = await runBackendPipeline(state.sourceBlob, {
      ...params, bones: recs.map((r) => ({ id: r.id, name: r.name, kind: r.kind, side: r.side, proximal: r.proximal, cover: covers.get(r.id), ...partSource(r) })),
    }, stageDone);
    analysis = fromBackend(out, tpls, basis);
  } else {
    analysis = await runImagePipeline(state.source, params, stageDone);
  }
  // one fracture (first-version detector) on the identified bone, placed on that skeleton bone
  const chosenRec = registry.get(analysis.chosenId);
  const bonesList = recs.map((r) => ({ id: r.id, rec: r, analyzable: r.id === analysis.chosenId, visible: 1, fractures: [] }));
  const chosenEntry = bonesList.find((b) => b.id === analysis.chosenId);
  const det = analysis.fracture;
  if (det?.detected) {
    // place the break where it appears on the film (registered film point); fall back to the template position
    // (film → this bone's skeleton grid, including its own joint correction)
    const tplC = getTemplate(chosenRec.id), detA = { ...det, axis: analysis.axis };
    const Tb = analysis.registration.boneT ? analysis.registration.boneT(chosenRec.id) : analysis.registration.T;
    let model = fractureModelFromFilm(tplC, detA, Tb, analysis.grid, basis, state.projection, analysis.registration);
    // safety net: the film placement must agree with where the detector's profile match puts the break
    if (model && Math.abs(model.s - det.sTemplate) > 0.15) model = null;
    model ||= { ...fractureModelFromDetection(tplC, det, analysis.match, state.projection, basis), placement: 'template' };
    const filmMark = analysis.registration.warpCanvas ? markOnGrid(det, Tb) : null;
    chosenEntry.fractures.push({ ...det, sAxis: model.s, bone: chosenEntry, index: 0, model, placement: model.placement, filmMark });
  }
  analysis.bones = bonesList;
  analysis.fractures = chosenEntry.fractures;
  const frs = analysis.fractures;

  // 9. fracture modelling: cut and displace ONLY the fractured bones
  const modelled = [];
  for (const bo of analysis.bones) {
    if (!bo.fractures.length) continue;
    const mine = frs.filter((f) => f.bone === bo);
    const { geometry, info } = buildFracturedBone(THREE, getTemplate(bo.id), mine.map((f) => f.model), basis);
    modelled.push({ rec: bo.rec, geometry, info, fractures: mine });
  }
  await stageDone('mesh', {
    title: 'Fracture modelling', basis: 'mixed',
    summary: modelled.length
      ? modelled.map((m) => `${m.rec.name}: cut into ${m.info.fragments} fragments${m.info.pieces ? ` (incl. ${m.info.pieces} loose piece${m.info.pieces > 1 ? 's' : ''} from the film)` : ''}`).join(' · ') + ' · the rest of each bone is the original skeleton surface'
      : 'No fracture: the skeleton is left unchanged',
    image: modelled.length ? renderMeshPreview(modelled.map((m) => m.geometry), basis) : null,
    warn: !modelled.length,
    metrics: modelled.flatMap((m) => [
      [m.rec.name, `${m.info.fragments} fragments · ${m.info.cutTriangles} triangles cut · ${(m.info.movedFraction * 100).toFixed(0)}% of vertices displaced`],
      ...m.fractures.map((f) => ['   fracture ' + (f.index + 1), `shift ${f.shiftMM.toFixed(1)} mm · angulation ${f.angulationDeg.toFixed(1)}° (in film plane) · out-of-plane course assumed ⟂ film`]),
    ]).concat([['Geometry', 'original skeleton mesh; only cut + rigid fragment displacement']]),
  });

  // 10. skeleton update
  const reg = analysis.registration, G = analysis.grid;
  const film = reg.warpCanvas // the X-ray warped onto the (unchanged) skeleton: each bone's film image lands on that bone
    ? { canvas: reg.warpCanvas, size: { w: G.W, h: G.H }, T: makeFilmTransform(1, 0, false, 0, 0), grid: G, basis, tpls, warped: true }
    : { canvas: analysis.xrayCanvas, size: analysis.size, T: reg.T, grid: G, basis, tpls };
  patient.setResult({ bones: modelled, fractures: frs, film });
  state.result = { analysis, modelled, fractures: frs, bones: analysis.bones, basis };
  window.fractovue.result = state.result;
  patient.setMode(frs.length ? 'highlight' : 'normal');
  patient.toggle('xray', true); // show the film on the skeleton so the fracture can be compared with the X-ray
  const unchanged = registry.all().length - modelled.length;
  await stageDone('replace', {
    title: 'Skeleton update', basis: 'mixed',
    summary: modelled.length
      ? `${modelled.map((m) => m.rec.name).join(' and ')} modified at ${frs.length} fracture${frs.length > 1 ? 's' : ''}; ${unchanged} other bones unchanged. X-ray laid onto the skeleton.`
      : `No bone modified; ${registry.all().length} bones unchanged. X-ray laid onto the skeleton.`,
    image: null,
    metrics: [['Modified', modelled.map((m) => m.rec.id).join(', ') || '—'], ['Unchanged bones', unchanged], ['Checked and intact', analysis.bones.filter((b) => b.analyzable && !b.fractures.length).map((b) => b.rec.name).join(', ') || '—']],
  });

  state.busy = false; updateAnalyzeButton();
  renderResult();
  select(frs.length ? { kind: 'fracture', index: 0, rec: frs[0].bone.rec, point: null } : { kind: 'bone', rec: focus, point: null });
  refreshControls();
  if (!xr.presenting) viewer.frameBox(patient.regionBox().applyMatrix4(viewer.model.matrixWorld), 1.1, new THREE.Vector3(0.35, 0.12, 1));
  xr.refreshUI();
}

// Backend results carry the same first-version detection + the film transform; geometry is rebuilt here.
function fromBackend(out, tpls, basis) {
  const G = projectBones(tpls, basis);
  const t = out.film.transform, T = makeFilmTransform(t.s, t.theta, t.mirror, t.tx, t.ty);
  const c = document.createElement('canvas'); c.width = out.film.size.w; c.height = out.film.size.h;
  c.getContext('2d').drawImage(state.source, out.film.crop.x, out.film.crop.y, out.film.crop.w, out.film.crop.h, 0, 0, c.width, c.height);
  return { size: out.film.size, crop: out.film.crop, xrayCanvas: c, grid: G, registration: { ...out.film, T }, match: out.match, candidates: out.candidates, consistent: out.consistent, chosenId: out.chosen_id, fracture: out.fracture, axis: out.axis };
}

function renderResult() {
  const r = state.result; if (!r) return;
  const frs = r.fractures, reg = r.analysis.registration;
  const truth = state.sampleTruth || [];
  $('result').innerHTML = `
    <div class="verdict ${frs.length ? 'detected' : ''}">
      <span class="k">${esc(state.summary().region)} · ${state.projection === 'AP' ? 'AP' : 'lateral'} projection</span>
      <span class="v">${frs.length ? `${frs.length} fracture${frs.length > 1 ? 's' : ''} detected` : 'No fracture detected'}</span>
      <span class="conf">${frs.length ? `Confidence ${(frs[0].confidence * 100).toFixed(1)}% (heuristic, uncalibrated)` : `Best candidate ${(r.analysis.fracture.confidence * 100).toFixed(1)}%`}</span>
    </div>
    <ol class="frlist">${frs.map((f, i) => `
      <li><button class="fr" data-fr="${i}">
        <span class="n">${i + 1}</span>
        <span class="b"><b>${esc(cap(f.bone.rec.name))}</b> · ${(f.sAxis * 100).toFixed(0)}% from proximal<br>
        <small>${esc(f.pattern.split(' (')[0])}${f.displaced ? ', displaced' : ''} · ${Math.abs(f.shiftMM).toFixed(1)} mm · ${Math.abs(f.angulationDeg).toFixed(1)}° · ${f.source}</small></span>
        <span class="c">${(f.confidence * 100).toFixed(0)}%<i style="width:${(f.confidence * 100).toFixed(0)}%"></i></span>
      </button></li>`).join('')}</ol>
    <dl class="kv">
      <dt>Identified as</dt><dd>${esc(registry.get(r.analysis.chosenId).name)}${r.analysis.consistent === false ? ` <span style="color:var(--amber)">(${esc(r.analysis.candidates[0].name)} fits better)</span>` : ''}</dd>
      <dt>X-ray coverage</dt><dd>${(r.analysis.match.s0 * 100).toFixed(0)}–${((r.analysis.match.s0 + r.analysis.match.c) * 100).toFixed(0)}% of the bone</dd>
      ${!frs.length ? `<dt>Best candidate</dt><dd>${(r.analysis.fracture.confidence * 100).toFixed(1)}% at ${(r.analysis.fracture.sTemplate * 100).toFixed(0)}%. Mark the fracture on the X-ray to force it.</dd>` : ''}
      ${truth.length ? `<dt>Sample truth</dt><dd>${truth.map((t) => `${esc(registry.get(t.bone).name)} at ${(t.s * 100).toFixed(0)}%`).join(' · ')}</dd>` : ''}
    </dl>
    <p class="note">Confidence is a heuristic score, not a calibrated probability.</p>`;
  $('result').querySelectorAll('[data-fr]').forEach((b) => { b.onclick = () => actions.focusFracture(+b.dataset.fr); });
  $('step-result').hidden = false;
  $('step-pipeline').classList.add('done');
  $('step-result').classList.add('done');
  renderModes();
}
function renderModes() {
  $('modes').innerHTML = MODES.map((m) => `<button data-mode="${m.id}" aria-pressed="${patient.mode === m.id}">${m.label}</button>`).join('');
  $('modes').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => actions.setMode(b.dataset.mode); });
  $('legend').hidden = patient.mode !== 'evidence';
  document.querySelectorAll('[data-display]').forEach((b) => b.setAttribute('aria-pressed', patient.boneDisplay === b.dataset.display));
  document.querySelectorAll('[data-place]').forEach((b) => b.setAttribute('aria-pressed', patient.xrayPlacement === b.dataset.place));
  $('result')?.querySelectorAll('[data-fr]').forEach((b) => b.classList.toggle('on', state.focused && +b.dataset.fr === state.focusIndex));
}
document.querySelectorAll('[data-display]').forEach((b) => { b.onclick = () => actions.setBoneDisplay(b.dataset.display); });
document.querySelectorAll('[data-place]').forEach((b) => { b.onclick = () => { patient.setXrayPlacement(b.dataset.place); if (!patient.show.xray && patient.mode !== 'xray') actions.toggleXray(); renderModes(); }; });

// ---------- actions (shared by desktop toolbar, VR panels, AR overlay) ----------
const actions = {
  zoomIn: () => (xr.presenting ? xr.zoom(1.25) : viewer.zoom(0.7)),
  zoomOut: () => (xr.presenting ? xr.zoom(0.8) : viewer.zoom(1.4)),
  reset() {
    if (xr.presenting) xr.reset();
    else { unfocusDesktop(); viewer.flyTo(viewer.HOME.pos, viewer.HOME.target); }
    refresh();
  },
  fit() {
    if (xr.presenting) xr.fit();
    else { unfocusDesktop(); const b = new THREE.Box3().setFromObject(root); viewer.frameBox(b, 1.05, new THREE.Vector3(0.35, 0.1, 1)); }
    refresh();
  },
  // Focus the given fracture; without an index, step to the next one (after the last: back to the whole view).
  focusFracture(index) {
    const n = patient.fractureCount;
    if (!n) return;
    let i = index;
    if (i === undefined) {
      if (state.focused && state.focusIndex >= n - 1) { actions.reset(); state.focusIndex = -1; return; }
      i = state.focused ? state.focusIndex + 1 : 0;
    }
    state.focusIndex = i;
    if (patient.mode === 'normal' || patient.mode === 'evidence') patient.setMode('highlight');
    if (!patient.show.fracture) patient.toggle('fracture', true);
    if (xr.presenting) xr.focusFracture(i, xr.mode === 'immersive-ar' ? 0.45 : 0.5, xr.mode === 'immersive-ar' ? 0.35 : 0.5);
    else {
      const p = viewer.model.localToWorld(patient.fracturePoint(i));
      const view = new THREE.Vector3().fromArray(state.result.basis.Z).transformDirection(viewer.model.matrixWorld).setY(0).normalize();
      const dir = view.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.4).add(new THREE.Vector3(0, 0.15, 0)).normalize();
      viewer.flyTo(p.clone().add(dir.multiplyScalar(0.22)), p);
      state.focused = true; patient.setContextDim(0.45); patient.setGlow(1.8);
    }
    select({ kind: 'fracture', index: i, rec: patient.fractures[i].bone.rec, point: null });
    refresh();
  },
  toggleRotate() {
    state.rotating = !state.rotating;
    viewer.controls.autoRotate = state.rotating && !xr.presenting;
    refresh();
  },
  toggleSkeleton: () => { patient.toggle('skeleton'); refresh(); },
  togglePatient: () => { patient.toggle('patient'); refresh(); },
  toggleFracture: () => { patient.toggle('fracture'); refresh(); },
  toggleXray: () => { patient.toggle('xray'); refresh(); },
  setMode: (m) => { patient.setMode(m); refresh(); },
  setBoneDisplay: (d) => { patient.setBoneDisplay(d); paintAll(); refresh(); },
  exitXR: () => xr.end(),
};
function unfocusDesktop() { state.focused = false; patient.setContextDim(0); patient.setGlow(1); }

document.querySelectorAll('.tools [data-act]').forEach((b) => { b.onclick = () => actions[b.dataset.act](); });
function refreshControls() {
  document.querySelectorAll('.tools [data-show]').forEach((b) => {
    b.setAttribute('aria-pressed', patient.show[b.dataset.show]);
    if (b.dataset.show !== 'skeleton') b.disabled = !patient.active || ((b.dataset.show === 'fracture' || b.dataset.show === 'patient') && !state.hasFracture());
  });
  const f = document.querySelector('[data-act="focusFracture"]');
  f.disabled = !state.hasFracture(); f.setAttribute('aria-pressed', state.focused);
  f.title = state.hasFracture() && patient.fractureCount > 1 ? `Focus fracture (${state.focused ? state.focusIndex + 1 : 0}/${patient.fractureCount}, click for next)` : 'Focus fracture';
  document.querySelector('[data-act="toggleRotate"]').setAttribute('aria-pressed', state.rotating);
}
function refresh() { refreshControls(); if (state.result) renderModes(); renderInfo(); xr.refreshUI(); }

// ---------- XR ----------
const ctx = { THREE, viewer, registry, patient, picker, state, actions, MODES, select, setHover, onXRChange: null };
xr = new XRManager(ctx);
ctx.onXRChange = (mode) => {
  $('vr-btn').innerHTML = $('vr-btn').innerHTML.replace(/Enter VR|Exit VR/, mode === 'immersive-vr' ? 'Exit VR' : 'Enter VR');
  $('ar-btn').innerHTML = $('ar-btn').innerHTML.replace(/Enter AR|Exit AR/, mode === 'immersive-ar' ? 'Exit AR' : 'Enter AR');
  viewer.controls.autoRotate = state.rotating && !mode;
  for (const k of [...state.hovers.keys()]) if (k !== 'mouse') setHover(k, null);
  refresh();
};
detectXR().then((c) => {
  const vr = $('vr-btn'), ar = $('ar-btn');
  vr.disabled = !c.vr; ar.disabled = !c.ar;
  vr.classList.toggle('ready', c.vr); ar.classList.toggle('ready', c.ar);
  document.body.classList.toggle('has-xr', c.vr || c.ar);
  $('xr-note').textContent = c.vr || c.ar
    ? `${[c.vr && 'VR', c.ar && 'AR'].filter(Boolean).join(' and ')} ready. In VR: left stick teleports, right trigger selects, grips grab, both grips scale, A steps through fractures.`
    : c.notes.join(' ');
});
const startXR = (mode) => xr.start(mode).then((f) => {
  if (f && mode === 'immersive-ar') {
    const miss = [!f.hitTest && 'surface hit-test', !f.anchors && 'anchors', !f.planes && 'plane detection'].filter(Boolean);
    if (miss.length) console.info('AR running without:', miss.join(', '));
  }
}).catch((err) => { $('xr-note').textContent = err.message; });
$('vr-btn').onclick = () => startXR('immersive-vr');
$('ar-btn').onclick = () => startXR('immersive-ar');

// ---------- engine ----------
backendAvailable().then((info) => {
  state.engine.backend = info;
  if (info) {
    $('engine-name').textContent = `Python backend (FastAPI${info.torch ? ' + PyTorch' : ''})`;
    $('engine-toggle').hidden = false;
  }
});
$('use-backend').onchange = (e) => {
  state.engine.useBackend = e.target.checked;
  $('engine-name').textContent = e.target.checked && state.engine.backend ? 'Python backend (FastAPI)' : 'In-browser (classical CV)';
};

// ---------- layout ----------
function layout() {
  const wide = innerWidth > 820;
  viewer.setViewShift(wide ? (384 + 16) / 2 - 40 : 0, wide ? 0 : -innerHeight * 0.16);
}
addEventListener('resize', layout); layout();
$('sheet-handle').onclick = () => $('panel').classList.toggle('collapsed');
$('stage-modal').addEventListener('click', (e) => { if (e.target === $('stage-modal')) $('stage-modal').close(); });

// ---------- demos (also ?demo=forearm / ?demo=femur in the URL) ----------
const DEMOS = { femur: ['leg', 'femur_left'], radius: ['forearm', 'radius_left'] };
async function runDemo(which = 'femur') {
  if (state.busy) return;
  const [region, bone] = DEMOS[which] || DEMOS.femur;
  chooseRegion(region);
  chooseBone(bone);
  state.projection = 'AP';
  document.querySelectorAll('[data-proj]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.proj === 'AP'));
  await makeSample();
  await runAnalysis();
}
document.querySelectorAll('[data-demo]').forEach((b) => { b.onclick = () => runDemo(b.dataset.demo).catch(onAnalysisError); });

renderRegions();
refreshControls();
{ const q = new URLSearchParams(location.search); if (q.has('demo')) runDemo(q.get('demo') || 'femur').catch(onAnalysisError); }
