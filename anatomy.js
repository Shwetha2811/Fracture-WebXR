// Anatomical registry: turns the skeleton built by skeleton.js into individually addressable bones
// (unique id, parent, children, anatomical name, transform, mesh, material) and defines the
// region → bone catalogue the user picks from. Adding a bone or region = adding rows here.

// ---------- bone definitions ----------
// match: regex against the part name produced by skeleton.js (scanned or modelled skeleton).
// kind: 'long' bones get a full axial profile fit; others use the same method with lower confidence.
// proximal: how to orient the bone's long axis ('down' = proximal end is the higher one,
//           'lateral' = proximal end is nearer the midline, 'anterior' = proximal end is posterior).
const SIDED = [
  { type: 'clavicle', label: 'Clavicle', match: 'clavicle', kind: 'long', parent: 'sternum', proximal: 'lateral' },
  { type: 'scapula', label: 'Scapula', match: 'scapula', kind: 'flat', parent: 'clavicle' },
  { type: 'humerus', label: 'Humerus', match: 'humerus', kind: 'long', parent: 'scapula' },
  { type: 'ulna', label: 'Ulna', match: 'ulna', kind: 'long', parent: 'humerus' },
  { type: 'radius', label: 'Radius', match: 'radius', kind: 'long', parent: 'humerus' },
  { type: 'hand', label: 'Hand (carpals, metacarpals, phalanges)', short: 'Hand', match: 'hand bones', kind: 'compound', parent: 'radius' },
  { type: 'hip', label: 'Hip bone (os coxae)', short: 'Hip bone', match: 'hip bone', kind: 'flat', parent: 'sacrum' },
  { type: 'femur', label: 'Femur', match: 'femur', kind: 'long', parent: 'hip' },
  { type: 'patella', label: 'Patella', match: 'patella', kind: 'short', parent: 'femur' },
  { type: 'tibia', label: 'Tibia', match: 'tibia', kind: 'long', parent: 'femur' },
  { type: 'fibula', label: 'Fibula', match: 'fibula', kind: 'long', parent: 'tibia' },
  { type: 'foot', label: 'Foot (tarsals, metatarsals, phalanges)', short: 'Foot', match: 'foot bones', kind: 'compound', parent: 'tibia', proximal: 'anterior' },
];
const MIDLINE = [
  { id: 'skull', label: 'Cranium (skull)', short: 'Skull', match: /^cranium/i, kind: 'flat', parent: 'c1' },
  { id: 'mandible', label: 'Mandible', match: /^mandible/i, kind: 'flat', parent: 'skull', proximal: 'anterior' },
  { id: 'sternum', label: 'Sternum', match: /^sternum/i, kind: 'flat', parent: 't1' },
  { id: 'sacrum', label: 'Sacrum', match: /^sacrum/i, kind: 'flat', parent: null },
  { id: 'coccyx', label: 'Coccyx', match: /^coccyx/i, kind: 'short', parent: 'sacrum' },
];
const VERTEBRAE = [
  ...Array.from({ length: 7 }, (_, i) => `C${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `T${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `L${i + 1}`),
];
// Spinal chain runs upward from the sacrum: L5's parent is the sacrum, C1's parent is C2.
VERTEBRAE.forEach((v, i) => {
  MIDLINE.push({
    id: v.toLowerCase(), label: `${v} vertebra`, match: new RegExp(`^${v} `), kind: 'short',
    parent: i === VERTEBRAE.length - 1 ? 'sacrum' : VERTEBRAE[i + 1].toLowerCase(), group: 'spine',
  });
});

function ribDefs() {
  const out = [];
  for (const side of ['left', 'right']) {
    const S = side[0].toUpperCase() + side.slice(1);
    for (let i = 1; i <= 12; i++) {
      out.push({ id: `rib${i}_${side}`, label: `${S} rib ${i}`, match: new RegExp(`^${S} rib ${i} `), kind: 'long', parent: `t${i}`, side, group: 'thorax' });
    }
    out.push({ id: `ribs6_12_${side}`, label: `${S} ribs 6–12`, match: new RegExp(`^${S} ribs 6`), kind: 'compound', parent: 't6', side, group: 'thorax' });
  }
  return out;
}

export const BONE_DEFS = [
  ...MIDLINE,
  ...ribDefs(),
  ...SIDED.flatMap((d) => ['left', 'right'].map((side) => {
    const S = side[0].toUpperCase() + side.slice(1);
    return {
      id: `${d.type}_${side}`, type: d.type, side, kind: d.kind, proximal: d.proximal || 'down',
      label: `${S} ${(d.short || d.label).toLowerCase()}`, fullLabel: `${S} ${d.label.toLowerCase()}`,
      match: new RegExp(`^${S} ${d.match}`, 'i'),
      parent: d.parent === 'sternum' || d.parent === 'sacrum' ? d.parent : `${d.parent}_${side}`,
    };
  })),
];

// ---------- region catalogue (what the user picks first) ----------
// cover: which part of the bone a typical radiograph of that region shows (prior for identification).
const full = [0, 1], prox = [0, 0.55], dist = [0.45, 1];
const both = (type, cover = full) => ['left', 'right'].map((side) => ({ id: `${type}_${side}`, cover }));
export const REGIONS = [
  { id: 'head', label: 'Head', bones: [{ id: 'skull', cover: full }, { id: 'mandible', cover: full }] },
  { id: 'spine', label: 'Spine', bones: [...VERTEBRAE.map((v) => ({ id: v.toLowerCase(), cover: full })), { id: 'sacrum', cover: full }, { id: 'coccyx', cover: full }] },
  { id: 'shoulder', label: 'Shoulder', bones: [...both('clavicle'), ...both('scapula'), ...both('humerus', prox)] },
  { id: 'arm', label: 'Arm', bones: both('humerus') },
  { id: 'elbow', label: 'Elbow', bones: [...both('humerus', dist), ...both('ulna', prox), ...both('radius', prox)] },
  { id: 'forearm', label: 'Forearm', bones: [...both('radius'), ...both('ulna')] },
  { id: 'wrist', label: 'Wrist', bones: [...both('radius', dist), ...both('ulna', dist), ...both('hand', prox)] },
  { id: 'hand', label: 'Hand', bones: both('hand') },
  { id: 'chest', label: 'Chest', bones: [{ id: 'sternum', cover: full }, ...['left', 'right'].flatMap((s) => [1, 2, 3, 4, 5].map((i) => ({ id: `rib${i}_${s}`, cover: full })))] },
  { id: 'pelvis', label: 'Pelvis', bones: [...both('hip'), { id: 'sacrum', cover: full }, { id: 'coccyx', cover: full }] },
  { id: 'hip_joint', label: 'Hip', bones: [...both('hip'), ...both('femur', [0, 0.35]), { id: 'sacrum', cover: full }] },
  { id: 'leg', label: 'Leg', bones: [...both('femur'), ...both('tibia'), ...both('fibula')] },
  { id: 'knee', label: 'Knee', bones: [...both('femur', dist), ...both('tibia', prox), ...both('fibula', prox), ...both('patella')] },
  { id: 'lower_leg', label: 'Lower leg', bones: [...both('tibia'), ...both('fibula')] },
  { id: 'ankle', label: 'Ankle', bones: [...both('tibia', dist), ...both('fibula', dist), ...both('foot', prox)] },
  { id: 'foot', label: 'Foot', bones: both('foot') },
];

// ---------- registry ----------
export class BoneRegistry {
  constructor(skeletonRoot, bones) {
    this.root = skeletonRoot;
    this.byId = new Map();
    this.byObject = new Map();
    const defs = BONE_DEFS.slice();
    for (const obj of bones) {
      const name = obj.userData.name;
      const def = defs.find((d) => d.match.test(name));
      const id = def ? def.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (this.byId.has(id)) { this.#attachExtra(this.byId.get(id), obj); continue; }
      const rec = {
        id, def: def || null, name: def ? def.label : name, anatomicalName: name,
        side: def?.side || (/^left/i.test(name) ? 'left' : /^right/i.test(name) ? 'right' : 'mid'),
        kind: def?.kind || 'short', proximal: def?.proximal || 'down',
        region: obj.userData.region, group: obj.userData.group,
        parent: def?.parent ?? null, children: [],
        object: obj, objects: [obj],
        get mesh() { let m = null; obj.traverse((o) => { if (!m && o.isMesh) m = o; }); return m; },
        get material() { return this.mesh?.material || null; },
        get position() { return obj.position; }, get rotation() { return obj.rotation; }, get scale() { return obj.scale; },
        status: 'generic',
      };
      obj.userData.boneId = id;
      this.byId.set(id, rec);
      this.byObject.set(obj, rec);
    }
    for (const rec of this.byId.values()) {
      if (rec.parent && !this.byId.has(rec.parent)) rec.parent = this.#fallbackParent(rec.parent);
      if (rec.parent) this.byId.get(rec.parent)?.children.push(rec.id);
    }
  }
  #attachExtra(rec, obj) { rec.objects.push(obj); obj.userData.boneId = rec.id; this.byObject.set(obj, rec); }
  #fallbackParent(id) { // e.g. a modelled skeleton without 'hip_left' → climb to the side-less root
    return this.byId.has('sacrum') ? 'sacrum' : null;
  }
  get(id) { return this.byId.get(id) || null; }
  fromObject(o) { while (o && !this.byObject.has(o)) o = o.parent; return o ? this.byObject.get(o) : null; }
  all() { return [...this.byId.values()]; }
  has(id) { return this.byId.has(id); }
  // Region entries that exist in the loaded skeleton, grouped by side for the picker.
  regionBones(regionId) {
    const region = REGIONS.find((r) => r.id === regionId);
    if (!region) return [];
    return region.bones.filter((b) => this.byId.has(b.id)).map((b) => ({ ...b, rec: this.byId.get(b.id) }));
  }
  // Depth-first dump, handy for debugging / the README.
  tree() {
    const lines = [];
    const walk = (id, d) => { const r = this.byId.get(id); lines.push(`${'  '.repeat(d)}${r.id} — ${r.name}`); r.children.forEach((c) => walk(c, d + 1)); };
    for (const r of this.byId.values()) if (!r.parent) walk(r.id, 0);
    return lines.join('\n');
  }
}

// Decode the quantized part files used by the Human Skeleton Atlas (skull.json / ribs.json / body.json).
export async function loadParts(THREE, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const parts = {};
    for (const [name, part] of Object.entries(data.parts)) {
      const q = new Uint16Array(bytes(part.pos)), pos = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) { const k = i % 3; pos[i] = part.min[k] + (q[i] / 65535) * (part.max[k] - part.min[k]); }
      const idx = part.idxBits === 16 ? new Uint16Array(bytes(part.idx)) : new Uint32Array(bytes(part.idx));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.userData = { region: part.region, group: part.group };
      parts[name] = g;
    }
    return parts;
  } catch (err) {
    console.warn(url + ' unavailable, using the modelled version', err);
    return null;
  }
}

// Short plain-language facts shown when a generic bone is selected.
const FACTS = [
  [/^skull/, 'Eight cranial and fourteen facial bones fused at sutures, shown as one piece.'],
  [/^mandible/, 'The only skull bone that moves; it hinges at the temporomandibular joint.'],
  [/^c\d/, 'Cervical vertebra: the smallest and most mobile part of the spine.'],
  [/^t\d/, 'Thoracic vertebra: each anchors a pair of ribs.'],
  [/^l\d/, 'Lumbar vertebra: the largest bodies, carrying most of the upper body\'s weight.'],
  [/^sacrum/, 'Five fused vertebrae locking the spine into the pelvis.'],
  [/^coccyx/, 'Three to five tiny fused vertebrae.'],
  [/^rib/, 'Ribs protect the heart and lungs and move with every breath.'],
  [/^sternum/, 'Manubrium, body and xiphoid process.'],
  [/^clavicle/, 'The only long bone lying horizontally, and one of the most commonly fractured.'],
  [/^scapula/, 'Slides over the back of the rib cage so the arm can reach overhead.'],
  [/^humerus/, 'Ball-shaped head in a shallow socket: the most mobile joint in the body.'],
  [/^ulna/, 'Little-finger side of the forearm; its tip is the point of the elbow.'],
  [/^radius/, 'Thumb side of the forearm; distal radius fractures are very common.'],
  [/^hand/, '27 bones: 8 carpals, 5 metacarpals, 14 phalanges.'],
  [/^hip/, 'Ilium, ischium and pubis fuse into one bone by about age 25.'],
  [/^femur/, 'The longest, strongest bone in the body, roughly a quarter of body height.'],
  [/^patella/, 'The largest sesamoid bone, inside the quadriceps tendon.'],
  [/^tibia/, 'The weight-bearing shinbone.'],
  [/^fibula/, 'Slender, barely weight-bearing; it steadies the ankle.'],
  [/^foot/, '26 bones: 7 tarsals, 5 metatarsals, 14 phalanges.'],
];
export const factFor = (id) => (FACTS.find(([re]) => re.test(id)) || [, ''])[1];
