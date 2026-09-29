// Input: ray picking (mouse / touch / XR rays share it), desktop pointer wiring,
// and a small touch-gesture recogniser (tap · drag · pinch · two-finger rotate) used by AR.
import * as THREE from 'three';

// Resolve a raycast into something meaningful: the fracture marker, the patient bone, or a generic bone.
export function createPicker({ registry, patient, extra = () => [] }) {
  const raycaster = new THREE.Raycaster();
  function targets() {
    const list = [];
    for (const rec of registry.all()) for (const o of rec.objects) if (o.visible) list.push(o);
    if (patient.active && patient.root.visible) list.push(...patient.pickables().filter((o) => o.visible || o === patient.markerDisc));
    return list.concat(extra());
  }
  function resolve(hits) {
    for (const h of hits) {
      let o = h.object, visible = true;
      for (let p = o; p; p = p.parent) if (!p.visible) { visible = false; break; }
      if (!visible) continue;
      if (o.userData.fracture) { const i = o.userData.index || 0; return { kind: 'fracture', index: i, rec: patient.fractures[i]?.bone.rec, point: h.point, distance: h.distance }; }
      if (o.userData.patient) return { kind: 'patient', rec: registry.get(o.userData.boneId), point: h.point, distance: h.distance };
      if (o.userData.ui) return { kind: 'ui', object: o, uv: h.uv, point: h.point, distance: h.distance };
      const rec = registry.fromObject(o);
      if (rec) return { kind: 'bone', rec, point: h.point, distance: h.distance };
    }
    return null;
  }
  return {
    raycaster,
    fromRay(origin, dir, far = 20) {
      raycaster.set(origin, dir); raycaster.far = far;
      return resolve(raycaster.intersectObjects(targets(), true));
    },
    fromCamera(ndc, camera) {
      raycaster.setFromCamera(ndc, camera); raycaster.far = 100;
      return resolve(raycaster.intersectObjects(targets(), true));
    },
  };
}

export function attachDesktopPointer({ viewer, picker, onHover, onSelect, onFocus }) {
  const el = viewer.renderer.domElement, ndc = new THREE.Vector2();
  let down = null, queued = null;
  const at = (x, y) => {
    const r = el.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    return picker.fromCamera(ndc, viewer.camera);
  };
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && !viewer.renderer.xr.isPresenting) onSelect(at(e.clientX, e.clientY), e);
    down = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) { onHover(null, e); return; }
    queued = e;
  });
  el.addEventListener('pointerleave', (e) => { queued = null; onHover(null, e); });
  el.addEventListener('dblclick', (e) => { const hit = at(e.clientX, e.clientY); if (hit) onFocus(hit); });
  viewer.onFrame(() => {
    if (!queued || viewer.renderer.xr.isPresenting) return;
    const e = queued; queued = null;
    onHover(at(e.clientX, e.clientY), e);
  });
  return { at };
}

// Touch gestures on a DOM element (used over the AR camera view via WebXR DOM overlay).
export class TouchGestures {
  constructor(el, h) {
    this.el = el; this.h = h; this.pts = new Map(); this.start = null; this.moved = false;
    const opts = { passive: false };
    el.addEventListener('pointerdown', (e) => this.#down(e), opts);
    el.addEventListener('pointermove', (e) => this.#move(e), opts);
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, (e) => this.#up(e), opts);
  }
  #snapshot() {
    const p = [...this.pts.values()];
    if (p.length < 2) return { n: p.length, x: p[0]?.x, y: p[0]?.y };
    const [a, b] = p;
    return { n: 2, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  #down(e) {
    if (e.target.closest?.('button, input, label, select, .no-gesture')) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.last = this.#snapshot();
    if (this.pts.size === 1) { this.start = { x: e.clientX, y: e.clientY, t: performance.now() }; this.moved = false; }
    else this.moved = true;
    e.preventDefault();
  }
  #move(e) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = this.#snapshot(), l = this.last;
    if (s.n === 1 && l?.n === 1) {
      if (Math.hypot(s.x - this.start.x, s.y - this.start.y) > 8) this.moved = true;
      if (this.moved) this.h.onDrag?.(s.x - l.x, s.y - l.y, s.x, s.y);
    } else if (s.n === 2 && l?.n === 2) {
      let da = s.ang - l.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      this.h.onPinch?.({ scale: s.d / Math.max(1, l.d), rotation: da, x: s.x, y: s.y, dx: s.x - l.x, dy: s.y - l.y });
    }
    this.last = s;
    e.preventDefault();
  }
  #up(e) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    if (this.pts.size === 0) {
      if (!this.moved && this.start && performance.now() - this.start.t < 450) this.h.onTap?.(e.clientX, e.clientY);
      this.h.onEnd?.();
      this.start = null;
    }
    this.last = this.#snapshot();
  }
}
