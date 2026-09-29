// Presentation of the analysed skeleton: fractured bones (the original bones, cut and displaced only
// where the film shows a fracture), fracture markers, the X-ray laid onto the skeleton, generic
// comparison, and the visualisation modes shared by desktop, VR and AR.
import * as THREE from 'three';

export const MODES = [
  { id: 'normal', label: 'Normal' },
  { id: 'highlight', label: 'Fracture highlight' },
  { id: 'transparent', label: 'Transparent' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'xray', label: 'X-ray overlay' },
  { id: 'compare', label: 'Comparison' },
  { id: 'evidence', label: 'Modified vs unchanged' },
];

const FRACTURE_RGB = new THREE.Color(0xff4a3d);
const MAXF = 4;

// Same look as the reference skeleton (baked colours + grain) plus fracture shading and a cancellous
// interior that shows through the broken ends.
function fracturedBoneMaterial(uniforms, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, envMapIntensity: 0.5, side: THREE.DoubleSide, ...extra });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aRest; attribute float aFracture; attribute float aFragment; attribute float aCap;
varying vec3 vRest; varying float vFracture; varying float vFragment; varying vec3 vGrainPos; varying float vCap;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRest = aRest; vFracture = aFracture; vFragment = aFragment; vGrainPos = aRest; vCap = aCap;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform int uMode; uniform float uTime; uniform float uGlow; uniform vec3 uFracColor;
uniform vec3 uFracP[${MAXF}]; uniform vec3 uFracN[${MAXF}]; uniform float uFracBand[${MAXF}]; uniform int uFracCount; uniform float uShowFracture;
varying vec3 vRest; varying float vFracture; varying float vFragment; varying vec3 vGrainPos; varying float vCap;
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float grain = gNoise(vGrainPos * 900.0) * 0.6 + gNoise(vGrainPos * 320.0) * 0.4;
diffuseColor.rgb *= 0.84 + 0.22 * grain;
float fz = smoothstep(0.08, 0.75, vFracture);
float crackDark = 0.0;
for (int i = 0; i < ${MAXF}; i++) {
  if (i >= uFracCount) break;
  vec3 q = vRest - uFracP[i];
  float along = dot(q, uFracN[i]);
  float dd = along / max(uFracBand[i], 1e-5);
  fz = max(fz, exp(-dd * dd));
  // a few thin fissures running away from the break, mostly along the bone, fading with distance
  vec3 t1 = normalize(cross(uFracN[i], abs(uFracN[i].y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(uFracN[i], t1);
  float around = atan(dot(q, t2), dot(q, t1));
  float wob = gNoise(vec3(along * 180.0, around * 3.0, float(i) * 7.0)) - 0.5;
  float line = abs(fract(around * 1.6 + wob * 0.9 + float(i) * 0.37) - 0.5);
  float fiss = 1.0 - smoothstep(0.006, 0.022, line);
  float reach = uFracBand[i] * (1.2 + 1.6 * gNoise(vec3(around * 2.0, 3.0, float(i))));
  crackDark = max(crackDark, fiss * (1.0 - smoothstep(0.0, reach, abs(along))));
}
fz *= uShowFracture;
diffuseColor.rgb *= 1.0 - 0.7 * crackDark * (1.0 - smoothstep(0.2, 0.5, vCap));
// broken end: thin cortical rim, then cancellous (spongy) bone with marrow
float sp = gNoise(vGrainPos * 2600.0) * 0.55 + gNoise(vGrainPos * 700.0) * 0.45;
vec3 canc = mix(vec3(0.44, 0.17, 0.12), vec3(0.9, 0.8, 0.62), smoothstep(0.38, 0.66, sp));
if (vCap > 0.25) diffuseColor.rgb = mix(diffuseColor.rgb, canc, smoothstep(0.3, 0.9, vCap));
if (!gl_FrontFacing) diffuseColor.rgb = canc;
if (uMode == 1) {
  diffuseColor.rgb = mix(diffuseColor.rgb, uFracColor, fz * (gl_FrontFacing ? (vCap > 0.25 ? 0.12 : 0.55) : 0.12));
  diffuseColor.a = mix(diffuseColor.a, 1.0, fz);
} else if (uMode == 2) {
  float g = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
  vec3 unchanged = vec3(g * 0.85);
  vec3 moved = mix(vec3(g), vec3(0.30, 0.82, 0.88), 0.7);
  diffuseColor.rgb = mix(mix(unchanged, moved, step(0.5, vFragment)), vec3(0.96, 0.62, 0.22), fz);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (uMode == 1) totalEmissiveRadiance += uFracColor * fz * (1.0 - 0.6 * smoothstep(0.25, 0.9, vCap)) * (0.35 + 0.25 * sin(uTime * 4.0)) * uGlow;`);
  };
  m.customProgramCacheKey = () => 'fractovue-fractured-' + (extra.wireframe ? 'w' : 's');
  return m;
}

function labelSprite(lines, { accent = '#ff6a5c', width = 640 } = {}) {
  const c = document.createElement('canvas'); c.width = width; c.height = 60 + lines.length * 56;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 20;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,16,17,0.88)'; g.beginPath(); g.roundRect(4, 4, c.width - 8, c.height - 8, 16); g.fill();
  g.fillStyle = accent; g.fillRect(4, 18, 8, c.height - 36);
  lines.forEach((l, i) => {
    g.fillStyle = i === 0 ? accent : '#e8e4d9';
    g.font = i === 0 ? '600 30px "IBM Plex Mono", monospace' : '700 40px Archivo, sans-serif';
    g.fillText(l, 30, 50 + i * 56, c.width - 50);
  });
  sp.userData.aspect = c.width / c.height;
  return sp;
}

export class PatientBoneView {
  constructor({ model, registry, boneMaterial }) {
    this.model = model;
    this.registry = registry;
    this.boneMaterial = boneMaterial;
    this.root = new THREE.Group(); this.root.name = 'fracture_analysis'; model.add(this.root);
    this.compareGroup = new THREE.Group(); this.compareGroup.visible = false; model.add(this.compareGroup);
    this.mode = 'highlight';
    this.show = { skeleton: true, patient: true, fracture: true, xray: false };
    this.boneDisplay = 'patient';
    this.xrayPlacement = 'behind';
    this.ghostMat = new THREE.MeshStandardMaterial({ color: 0x7fb6d6, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.6 });
    this.items = []; this.fractures = []; this.result = null;
    this.glow = 1; this.time = 0;
  }

  get active() { return !!this.result; }
  get rec() { return this.items[0]?.rec || null; }
  get fractureCount() { return this.fractures.length; }

  // result: { bones: [{ rec, geometry, fractures }], fractures: [...], film: { canvas, size, T, grid, basis, tpls } }
  setResult(result) {
    this.clear();
    this.result = result;
    for (const bone of result.bones) {
      const uniforms = {
        uMode: { value: 1 }, uTime: { value: 0 }, uGlow: { value: 1 }, uFracColor: { value: FRACTURE_RGB.clone() }, uShowFracture: { value: 1 },
        uFracP: { value: Array.from({ length: MAXF }, () => new THREE.Vector3()) }, uFracN: { value: Array.from({ length: MAXF }, () => new THREE.Vector3(0, 1, 0)) },
        uFracBand: { value: new Array(MAXF).fill(1) }, uFracCount: { value: Math.min(MAXF, bone.fractures.length) },
      };
      bone.fractures.slice(0, MAXF).forEach((f, i) => {
        uniforms.uFracP.value[i].fromArray(f.model.P3); uniforms.uFracN.value[i].fromArray(f.model.N3);
        uniforms.uFracBand.value[i] = 0.22 * f.model.width + f.model.gap;
      });
      const solid = fracturedBoneMaterial(uniforms), wireM = fracturedBoneMaterial(uniforms, { wireframe: true, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(bone.geometry, solid); mesh.name = `fractured_${bone.rec.id}`;
      mesh.castShadow = mesh.receiveShadow = true; mesh.userData.patient = true; mesh.userData.boneId = bone.rec.id;
      const wire = new THREE.Mesh(bone.geometry, wireM); wire.visible = false; wire.userData.patient = true; wire.userData.boneId = bone.rec.id;
      this.root.add(mesh, wire);
      bone.rec.status = 'replaced';
      this.items.push({ rec: bone.rec, mesh, wire, solid, wireM, uniforms, fractures: bone.fractures });
    }
    // fracture markers
    result.fractures.forEach((f, idx) => {
      const g = new THREE.Group(); g.name = `fracture_${idx + 1}`; g.userData.fracture = true; g.userData.index = idx;
      const r = f.model.width * 0.85, N = new THREE.Vector3().fromArray(f.model.N3);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color: FRACTURE_RGB, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.96, r * 1.06, 64), new THREE.MeshBasicMaterial({ color: 0xff7a6e, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      for (const m of [disc, ring]) { m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), N); m.userData.fracture = true; m.userData.index = idx; m.renderOrder = 6; }
      g.position.fromArray(f.model.P3);
      const out = new THREE.Vector3().fromArray(f.model.lineDir3).normalize();
      if (out.dot(new THREE.Vector3().fromArray(result.film.basis.U)) < 0) out.negate();
      const lbl = labelSprite([`FRACTURE ${idx + 1}`, `${f.bone.rec.name.replace(/^(left|right) /i, '')} · ${(f.confidence * 100).toFixed(0)}%`]);
      const hgt = 0.028; lbl.scale.set(hgt * lbl.userData.aspect, hgt, 1);
      lbl.position.copy(out.clone().multiplyScalar(r * 1.4 + hgt * lbl.userData.aspect * 0.55)).add(new THREE.Vector3(0, hgt * 0.8, 0));
      const lead = new THREE.Line(new THREE.BufferGeometry().setFromPoints([out.clone().multiplyScalar(r * 1.05), lbl.position.clone()]), new THREE.LineBasicMaterial({ color: 0xff7a6e, transparent: true, opacity: 0.8, depthTest: false }));
      lead.renderOrder = 19;
      g.add(disc, ring, lbl, lead);
      g.userData.parts = { disc, ring };
      this.root.add(g);
      this.fractures.push({ ...f, group: g });
    });
    this.#buildXray();
    this.#buildCompare();
    this.apply();
  }

  // The X-ray plane uses the film ↔ skeleton registration, so it coincides with the skeleton.
  #buildXray() {
    const { canvas, size, T, grid, basis, tpls } = this.result.film;
    const { U, Up, Z } = basis;
    let zmin = Infinity, umin = Infinity, umax = -Infinity;
    for (const t of tpls) for (let i = 0; i < t.pos.length; i += 3) {
      const p = [t.pos[i], t.pos[i + 1], t.pos[i + 2]];
      zmin = Math.min(zmin, p[0] * Z[0] + p[1] * Z[1] + p[2] * Z[2]);
      const u = p[0] * U[0] + p[1] * U[1] + p[2] * U[2]; umin = Math.min(umin, u); umax = Math.max(umax, u);
    }
    this.xrayDepth = zmin - 0.012;
    this.xrayBeside = (umax - umin) + 0.05;
    const map = (u, v, z, du = 0) => { const [gx, gy] = T.fwd(u, v); const [x, y] = grid.toWorld2(gx, gy); return new THREE.Vector3(...[0, 1, 2].map((k) => (x + du) * U[k] + y * Up[k] + z * Z[k])); };
    this.placeXray = () => {
      const du = this.xrayPlacement === 'beside' ? this.xrayBeside : 0, z = this.xrayPlacement === 'beside' ? this.xrayDepth + 0.012 : this.xrayDepth;
      const o = map(0, 0, z, du), ex = map(1, 0, z, du).sub(o), ey = map(0, 1, z, du).sub(o);
      const center = o.clone().addScaledVector(ex, size.w / 2).addScaledVector(ey, size.h / 2);
      const nz = new THREE.Vector3().crossVectors(ex, ey.clone().negate()).normalize().multiplyScalar(ex.length());
      this.xray.matrix.makeBasis(ex, ey.clone().negate(), nz).setPosition(center);
      this.xray.matrixWorldNeedsUpdate = true;
    };
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    this.xray = new THREE.Mesh(new THREE.PlaneGeometry(size.w, size.h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }));
    this.xray.name = 'xray_film'; this.xray.matrixAutoUpdate = false; this.xray.renderOrder = -2;
    this.xray.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size.w, size.h)), new THREE.LineBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.6 })));
    this.root.add(this.xray);
    // the fracture as seen on the film: ring + line at its pixel position, linked to the break on the bone
    this.filmMarks = [];
    for (const f0 of this.fractures) {
      const f = f0.filmMark || f0; // grid-space annotation when the X-ray is warped onto the skeleton
      if (!f.point) continue;
      const g = new THREE.Group();
      const lx = f.point.x - size.w / 2, ly = size.h / 2 - f.point.y, r = Math.max(8, (f.widthPx || 20) * 0.9);
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.9, r * 1.05, 48), new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.set(lx, ly, 0.5);
      const d = [f.dir?.x ?? 1, -(f.dir?.y ?? 0)], hl = r * 0.8;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(lx - d[0] * hl, ly - d[1] * hl, 0.6), new THREE.Vector3(lx + d[0] * hl, ly + d[1] * hl, 0.6)]), new THREE.LineBasicMaterial({ color: 0xff5a4f }));
      g.add(ring, line); g.renderOrder = 7;
      if (f.zoneImg) { // bracket the whole fracture zone on the film
        const zp = f.zoneImg.map((q) => new THREE.Vector3(q.x - size.w / 2 + r * 1.4, size.h / 2 - q.y, 0.6));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(zp), new THREE.LineBasicMaterial({ color: 0xffa066 })));
      }
      this.xray.add(g);
      const lead = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xff7a6e, dashSize: 0.006, gapSize: 0.004, transparent: true, opacity: 0.9 }));
      lead.frustumCulled = false;
      this.root.add(lead);
      for (const fg of f.fragments || []) { // fragments seen on the film
        if (!fg.outline?.length) continue;
        const pts = fg.outline.map((q) => new THREE.Vector3(q.x - size.w / 2, size.h / 2 - q.y, 0.7)); pts.push(pts[0].clone());
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffb347 })));
      }
      this.filmMarks.push({ f: f0, local: new THREE.Vector3(lx, ly, 0), lead });
    }
    const placeLeads = () => {
      for (const m of this.filmMarks) {
        const a = m.local.clone().applyMatrix4(this.xray.matrix), b = new THREE.Vector3().fromArray(m.f.model.P3);
        m.lead.geometry.setFromPoints([a, b]); m.lead.computeLineDistances();
      }
    };
    const place0 = this.placeXray;
    this.placeXray = () => { place0(); placeLeads(); };
    this.placeXray();
  }

  #buildCompare() {
    this.compareGroup.clear();
    if (!this.items.length) return;
    const { U } = this.result.film.basis;
    const off = new THREE.Vector3().fromArray(U).multiplyScalar(this.xrayBeside + 0.02);
    const inv = this.model.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    for (const it of this.items) for (const o of it.rec.objects) o.traverse((m) => {
      if (!m.isMesh) return;
      const cm = new THREE.Mesh(m.geometry, this.boneMaterial);
      m.updateWorldMatrix(true, false);
      cm.matrixAutoUpdate = false; cm.matrix.copy(inv.clone().multiply(m.matrixWorld));
      this.compareGroup.add(cm); box.expandByObject(m);
    });
    this.compareGroup.position.copy(off);
    const top = box.getCenter(new THREE.Vector3()); top.y = box.max.y + 0.05; top.applyMatrix4(inv);
    const lg = labelSprite(['REFERENCE', 'Unfractured skeleton bone'], { accent: '#d6c6a2', width: 620 });
    lg.scale.set(0.05 * lg.userData.aspect, 0.05, 1); lg.position.copy(top);
    this.compareGroup.add(lg);
  }

  clear() {
    for (const it of this.items) { it.rec.status = 'generic'; this.#setGenericMaterial(it.rec, null); for (const o of it.rec.objects) o.visible = true; }
    this.root.clear(); this.compareGroup.clear(); this.compareGroup.visible = false;
    this.items = []; this.fractures = []; this.result = null; this.xray = null;
  }

  #setGenericMaterial(rec, mat) { for (const o of rec.objects) o.traverse((m) => { if (m.isMesh) m.material = mat || m.userData.baseMaterial; }); }

  setMode(mode) { this.mode = mode; this.apply(); }
  setBoneDisplay(d) { this.boneDisplay = d; this.apply(); }
  toggle(key, on) { this.show[key] = on ?? !this.show[key]; this.apply(); return this.show[key]; }
  setXrayPlacement(p) { this.xrayPlacement = p; this.placeXray?.(); }

  apply() {
    const s = this.show, mode = this.mode;
    const fractured = new Set(this.items.map((it) => it.rec));
    for (const rec of this.registry.all()) if (!fractured.has(rec)) for (const o of rec.objects) o.visible = s.skeleton;
    if (!this.result) return;
    const showPatient = this.boneDisplay !== 'generic' && s.patient;
    for (const it of this.items) {
      for (const o of it.rec.objects) o.visible = this.boneDisplay !== 'patient';
      this.#setGenericMaterial(it.rec, this.boneDisplay === 'both' ? this.ghostMat : null);
      it.mesh.visible = showPatient;
      it.wire.visible = showPatient && mode === 'wireframe';
      const highlight = s.fracture && mode !== 'normal' && mode !== 'evidence';
      it.uniforms.uMode.value = mode === 'evidence' ? 2 : highlight ? 1 : 0;
      it.uniforms.uShowFracture.value = s.fracture ? 1 : 0;
      const transparent = mode === 'transparent' || mode === 'xray' || mode === 'wireframe';
      Object.assign(it.solid, { transparent, opacity: mode === 'transparent' ? 0.32 : mode === 'xray' ? 0.55 : mode === 'wireframe' ? 0.12 : 1, depthWrite: !transparent });
      it.solid.needsUpdate = true;
    }
    for (const f of this.fractures) f.group.visible = s.fracture && showPatient;
    if (this.xray) this.xray.visible = s.xray || mode === 'xray';
    for (const m of this.filmMarks || []) m.lead.visible = !!(this.xray?.visible && s.fracture && showPatient && this.xrayPlacement === 'behind');
    this.compareGroup.visible = mode === 'compare';
  }

  setContextDim(k) { // fade the unaffected skeleton while inspecting a fracture (it stays visible)
    const m = this.boneMaterial;
    m.transparent = k > 0.001; m.opacity = 1 - 0.55 * k; m.depthWrite = k < 0.5; m.needsUpdate = true;
  }
  setGlow(v) { for (const it of this.items) it.uniforms.uGlow.value = v; }

  update(dt, t) {
    for (const it of this.items) it.uniforms.uTime.value = t / 1000;
    const p = 1 + 0.08 * Math.sin(t / 250);
    for (const f of this.fractures) { f.group.userData.parts.ring.scale.setScalar(p); f.group.userData.parts.disc.material.opacity = 0.05 + 0.06 * (0.5 + 0.5 * Math.sin(t / 250)); }
  }

  fracturePoint(i = 0, target = new THREE.Vector3()) { const f = this.fractures[i]; return f ? target.fromArray(f.model.P3) : null; }
  fractureNormalView(i = 0) { return new THREE.Vector3().fromArray(this.result.film.basis.Z); }
  boneBox(i = 0) {
    const f = this.fractures[i]; const it = f ? this.items.find((x) => x.rec === f.bone.rec) : this.items[0];
    return it ? it.mesh.geometry.boundingBox.clone() : null;
  }
  regionBox() {
    const b = new THREE.Box3();
    for (const t of this.result.film.tpls) for (let i = 0; i < t.pos.length; i += 3) b.expandByPoint(new THREE.Vector3(t.pos[i], t.pos[i + 1], t.pos[i + 2]));
    return b;
  }
  pickables() { return [...this.items.flatMap((it) => [it.mesh]), ...this.fractures.map((f) => f.group.userData.parts.disc)]; }
}
