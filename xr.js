// Shared WebXR plumbing: capability detection with explicit fallbacks, session start/end,
// the stage rig (move / rotate / scale / focus with tweening) and floating spatial panels.
import * as THREE from 'three';
import { setupVR } from './vr.js';
import { setupAR } from './ar.js';

// ---------- capability detection ----------
export async function detectXR() {
  const out = { vr: false, ar: false, secure: window.isSecureContext, api: !!navigator.xr, notes: [] };
  if (!out.secure) out.notes.push('WebXR needs HTTPS (or localhost). Open this page over https:// to enter VR/AR.');
  if (!out.api) { out.notes.push('This browser has no WebXR API. Use the Meta Quest Browser (VR/AR), Chrome on an ARCore Android phone (AR), or a WebXR emulator.'); return out; }
  const ok = async (m) => { try { return await navigator.xr.isSessionSupported(m); } catch { return false; } };
  [out.vr, out.ar] = await Promise.all([ok('immersive-vr'), ok('immersive-ar')]);
  if (!out.vr) out.notes.push('Immersive VR is not available on this device.');
  if (!out.ar) out.notes.push('Immersive AR is not available here (needs Quest 3/3S passthrough, or Chrome on an ARCore phone).');
  return out;
}

// ---------- stage rig ----------
export class StageRig {
  constructor(stage) {
    this.stage = stage;
    this.tween = null;
    this._m = new THREE.Matrix4();
  }
  world() {
    this.stage.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), s = new THREE.Vector3();
    this.stage.matrixWorld.decompose(pos, quat, s);
    return { pos, quat, scale: s.x };
  }
  setWorld(pos, quat, scale) {
    const parent = this.stage.parent;
    parent.updateWorldMatrix(true, false);
    const m = this._m.compose(pos, quat, new THREE.Vector3(scale, scale, scale));
    m.premultiply(parent.matrixWorld.clone().invert());
    m.decompose(this.stage.position, this.stage.quaternion, this.stage.scale);
  }
  tweenTo(target, duration = 0.8) {
    const from = this.world();
    this.tween = { from, to: target, t: 0, duration };
  }
  // world pose that keeps `pivot` (world) fixed while scaling by f
  zoomAbout(f, pivot, limits = [0.05, 12]) {
    const w = this.tween ? this.tween.to : this.world();
    const s = THREE.MathUtils.clamp(w.scale * f, limits[0], limits[1]);
    const k = s / w.scale;
    const pos = pivot.clone().add(w.pos.clone().sub(pivot).multiplyScalar(k));
    this.tween = null;
    this.setWorld(pos, w.quat, s);
  }
  yawAbout(angle, pivot) {
    const w = this.world();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    const pos = pivot.clone().add(w.pos.clone().sub(pivot).applyQuaternion(q));
    this.setWorld(pos, q.multiply(w.quat), w.scale);
  }
  update(dt) {
    if (!this.tween) return;
    const tw = this.tween;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
    const pos = tw.from.pos.clone().lerp(tw.to.pos, e);
    const quat = tw.from.quat.clone().slerp(tw.to.quat, e);
    const s = THREE.MathUtils.lerp(tw.from.scale, tw.to.scale, e);
    this.setWorld(pos, quat, s);
    if (tw.t >= 1) this.tween = null;
  }
}

// ---------- floating panels (canvas textures with ray-pressable buttons) ----------
export class SpatialPanel {
  constructor({ widthPx, heightPx, widthM, draw, name }) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = widthPx; this.canvas.height = heightPx;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const hM = widthM * heightPx / widthPx;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, hM), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, depthWrite: false }));
    this.mesh.renderOrder = 30;
    this.mesh.material.depthTest = true;
    this.mesh.name = name;
    this.mesh.userData.ui = true; this.mesh.userData.panel = this;
    this.buttons = []; this.hover = null; this.drawFn = draw; this.W = widthPx; this.H = heightPx;
    this.flash = null;
  }
  button(x, y, w, h, label, action, active = () => false, opts = {}) { this.buttons.push({ x, y, w, h, label, action, active, ...opts }); }
  at(uv) {
    const px = uv.x * this.W, py = (1 - uv.y) * this.H;
    return this.buttons.find((b) => (b.enabled?.() ?? true) && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) || null;
  }
  press(uv) { const b = this.at(uv); if (b) { this.flash = { b, t: performance.now() }; b.action(); this.redraw(); } return !!b; }
  setHover(b) { if (b !== this.hover) { this.hover = b; this.redraw(); } }
  redraw() {
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, this.W, this.H);
    this.drawFn?.(g, this);
    for (const b of this.buttons) drawButton(g, b, this.hover === b, this.flash?.b === b && performance.now() - this.flash.t < 180);
    this.tex.needsUpdate = true;
  }
}

export const INK = '#e8e4d9', MUTED = '#8e9d9a', ACCENT = '#7fd3de', BONE = '#d6c6a2', RED = '#ff6a5c';
export function drawButton(g, b, hover, flash) {
  const on = b.active(), enabled = b.enabled?.() ?? true;
  g.fillStyle = flash ? '#ffffff' : on ? (b.color || BONE) : hover ? 'rgba(127,211,222,0.25)' : 'rgba(232,228,217,0.08)';
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, Math.min(18, b.h / 3)); g.fill();
  g.strokeStyle = hover ? ACCENT : 'rgba(232,228,217,0.18)'; g.lineWidth = hover ? 4 : 2; g.stroke();
  g.fillStyle = !enabled ? 'rgba(232,228,217,0.3)' : on || flash ? '#15120d' : INK;
  g.font = `${b.weight || 600} ${b.size || 30}px Archivo, system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(typeof b.label === 'function' ? b.label() : b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 16);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
export function panelBackground(g, W, H) {
  g.fillStyle = 'rgba(12,19,20,0.93)'; g.beginPath(); g.roundRect(0, 0, W, H, 30); g.fill();
  g.strokeStyle = 'rgba(127,211,222,0.35)'; g.lineWidth = 3; g.stroke();
}

// Build the three floating panels described in the spec: main panel, toolbar, bone info.
export function buildSpatialUI(ctx) {
  const { actions: A, state: S } = ctx;
  const main = new SpatialPanel({ name: 'panel_main', widthPx: 1024, heightPx: 1240, widthM: 0.46, draw: (g, p) => {
    panelBackground(g, p.W, p.H);
    g.fillStyle = ACCENT; g.font = '600 26px "IBM Plex Mono", monospace'; g.fillText('RESEARCH PROTOTYPE · NOT A DIAGNOSIS', 40, 58);
    g.fillStyle = INK; g.font = '800 64px Archivo, sans-serif'; g.fillText('FRACTOVUE XR', 40, 130);
    g.fillStyle = 'rgba(232,228,217,0.15)'; g.fillRect(40, 160, p.W - 80, 2);
    const r = S.summary();
    const row = (k, v, y, col = INK) => { g.fillStyle = MUTED; g.font = '500 28px "IBM Plex Mono", monospace'; g.fillText(k, 40, y); g.fillStyle = col; g.font = '700 40px Archivo, sans-serif'; g.fillText(v, 330, y, p.W - 370); };
    row('REGION', r.region, 220);
    row('STATUS', r.status, 280, r.patient ? ACCENT : INK);
    row('FRACTURE', r.fracture, 340, r.detected ? RED : INK);
    row('CONFIDENCE', r.confidence, 400);
    g.fillStyle = MUTED; g.font = '400 24px Archivo, sans-serif';
    g.fillText('3D shape is an estimate from one 2D projection.', 40, 452);
    g.fillStyle = MUTED; g.font = '500 22px "IBM Plex Mono", monospace';
    g.fillText('VISUALISATION', 40, 836);
    g.fillText('AFFECTED BONE', 40, 1036);
    g.fillText('L-STICK teleport/turn · R-STICK rotate/zoom · GRIP grab · A focus · B reset · X menu', 40, 1210, p.W - 80);
  } });
  const col = (i) => 40 + i * 482;
  const btn = [
    ['Focus Fracture', A.focusFracture, () => S.focused, () => S.hasFracture()],
    ['Show X-Ray', A.toggleXray, () => S.show('xray'), () => S.hasPatient()],
    ['Show Skeleton', A.toggleSkeleton, () => S.show('skeleton')],
    ['Show Patient Bone', A.togglePatient, () => S.show('patient'), () => S.hasPatient()],
    ['Show Fracture', A.toggleFracture, () => S.show('fracture'), () => S.hasFracture()],
    ['Reset View', A.reset, () => false],
  ];
  btn.forEach(([label, action, active, enabled], i) => main.button(col(i % 2), 490 + Math.floor(i / 2) * 104, 462, 88, label, action, active, { enabled }));
  const modes = ctx.MODES;
  modes.forEach((m, i) => main.button(40 + (i % 4) * 238, 856 + Math.floor(i / 4) * 80, 224, 66, m.label.replace('Observed vs estimated', 'Evidence').replace('Fracture highlight', 'Highlight').replace('X-ray overlay', 'X-ray'),
    () => A.setMode(m.id), () => S.mode() === m.id, { size: 26, color: ACCENT, enabled: () => S.hasPatient() }));
  ['generic', 'patient', 'both'].forEach((d, i) => main.button(40 + i * 318, 1056, 304, 70, d === 'generic' ? 'Generic' : d === 'patient' ? 'Patient' : 'Both',
    () => A.setBoneDisplay(d), () => S.boneDisplay() === d, { size: 28, color: ACCENT, enabled: () => S.hasPatient() }));
  main.button(40, 1140, 944, 40, () => (S.xrMode() === 'immersive-ar' ? 'Exit AR' : 'Exit VR'), A.exitXR, () => false, { size: 24 });

  const tools = [
    ['+ Zoom', A.zoomIn], ['− Zoom', A.zoomOut], ['Reset', A.reset], ['Fit Skeleton', A.fit], ['Focus Fracture', A.focusFracture, () => S.focused, () => S.hasFracture()],
    ['Rotate', A.toggleRotate, () => S.rotating], ['Skeleton', A.toggleSkeleton, () => S.show('skeleton')], ['Patient Bone', A.togglePatient, () => S.show('patient'), () => S.hasPatient()],
    ['Fracture', A.toggleFracture, () => S.show('fracture'), () => S.hasFracture()], ['X-Ray', A.toggleXray, () => S.show('xray'), () => S.hasPatient()],
  ];
  const toolbar = new SpatialPanel({ name: 'panel_toolbar', widthPx: 2000, heightPx: 150, widthM: 0.9, draw: (g, p) => panelBackground(g, p.W, p.H) });
  tools.forEach(([label, action, active = () => false, enabled], i) => toolbar.button(18 + i * 197.5, 22, 186, 106, label, action, active, { size: 30, enabled }));

  const info = new SpatialPanel({ name: 'panel_info', widthPx: 760, heightPx: 400, widthM: 0.26, draw: (g, p) => {
    const b = S.infoTarget();
    panelBackground(g, p.W, p.H);
    if (!b) return;
    g.fillStyle = b.kind === 'fracture' ? RED : ACCENT; g.font = '600 26px "IBM Plex Mono", monospace';
    g.fillText(b.kind === 'fracture' ? 'SELECTED REGION' : 'SELECTED BONE', 34, 56);
    g.fillStyle = INK; g.font = '800 50px Archivo, sans-serif'; g.fillText(b.title, 34, 118, p.W - 68);
    const rows = b.rows.slice(0, 4);
    rows.forEach(([k, v, c], i) => {
      g.fillStyle = MUTED; g.font = '500 26px "IBM Plex Mono", monospace'; g.fillText(k.toUpperCase(), 34, 184 + i * 56);
      g.fillStyle = c || INK; g.font = '600 32px Archivo, sans-serif'; g.fillText(v, 260, 184 + i * 56, p.W - 290);
    });
  } });
  info.mesh.visible = false;
  return { main, toolbar, info, all: [main, toolbar, info] };
}

// ---------- session manager ----------
export class XRManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = null;
    this.session = null;
    this.rig = new StageRig(ctx.viewer.stage);
    this.ui = buildSpatialUI(ctx);
    for (const p of this.ui.all) { ctx.viewer.ui.add(p.mesh); p.redraw(); }
    ctx.viewer.ui.visible = false;
    this.vr = setupVR(ctx, this);
    this.ar = setupAR(ctx, this);
    this.placement = null; // world pose to return to on Reset
    ctx.viewer.onFrame((dt, t, frame) => this.frame(dt, t, frame));
  }
  get presenting() { return this.ctx.viewer.renderer.xr.isPresenting; }

  async start(mode) {
    const { renderer } = this.ctx.viewer;
    if (renderer.xr.isPresenting) { await this.session?.end(); return; }
    const isAR = mode === 'immersive-ar';
    const overlay = document.getElementById('ar-overlay');
    const init = isAR
      ? { optionalFeatures: ['local-floor', 'hit-test', 'anchors', 'plane-detection', 'dom-overlay', 'hand-tracking'], domOverlay: { root: overlay } }
      : { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
    let session;
    try {
      session = await navigator.xr.requestSession(mode, init);
    } catch (err) {
      throw new Error(`Could not start ${isAR ? 'AR' : 'VR'}: ${err.message || err}. ${isAR ? 'AR needs a WebXR-AR device (Quest 3/3S, ARCore phone in Chrome).' : 'Make sure a headset is connected and the page is served over HTTPS.'}`);
    }
    const features = session.enabledFeatures ? [...session.enabledFeatures] : null;
    const has = (f) => (features ? features.includes(f) : true);
    let refType = 'local-floor';
    try { await session.requestReferenceSpace('local-floor'); } catch { refType = 'local'; }
    renderer.xr.setReferenceSpaceType(refType);
    this.mode = mode; this.session = session; this.refType = refType;
    this.features = { hitTest: has('hit-test'), anchors: has('anchors'), planes: has('plane-detection'), domOverlay: !!session.domOverlayState, local: refType === 'local', list: features };
    session.addEventListener('end', () => this.#onEnd());
    await renderer.xr.setSession(session);
    this.#onStart();
    return this.features;
  }

  #onStart() {
    const { viewer, patient, state } = this.ctx;
    const isAR = this.mode === 'immersive-ar';
    viewer.controls.enabled = false;
    viewer.key.castShadow = false;
    viewer.shadowCatcher.visible = false;
    viewer.floor.visible = !isAR;
    viewer.floor.userData.disc.visible = !isAR;
    viewer.scene.background = isAR ? null : new THREE.Color(0x0b1213);
    viewer.scene.fog = isAR ? null : new THREE.Fog(0x0b1213, 6, 16);
    viewer.renderer.xr.setFoveation?.(1);
    this.desktopStage = { pos: viewer.stage.position.clone(), quat: viewer.stage.quaternion.clone(), scale: viewer.stage.scale.x };
    this.needsPlacement = true; this.frames = 0;
    state.focused = false;
    patient.setContextDim(0);
    viewer.ui.visible = !(isAR && this.features.domOverlay);
    if (isAR) this.ar.onStart(); else this.vr.onStart();
    this.ctx.onXRChange?.(this.mode);
  }

  #onEnd() {
    const { viewer, patient, state } = this.ctx;
    const wasAR = this.mode === 'immersive-ar';
    if (wasAR) this.ar.onEnd(); else this.vr.onEnd();
    viewer.anchor.matrixAutoUpdate = true;
    viewer.anchor.position.set(0, 0, 0); viewer.anchor.quaternion.identity(); viewer.anchor.scale.set(1, 1, 1);
    viewer.stage.position.copy(this.desktopStage.pos); viewer.stage.quaternion.copy(this.desktopStage.quat); viewer.stage.scale.setScalar(this.desktopStage.scale);
    viewer.scene.background = null; viewer.scene.fog = null;
    viewer.floor.visible = true; viewer.floor.userData.disc.visible = false;
    viewer.shadowCatcher.visible = true; viewer.key.castShadow = true;
    viewer.controls.enabled = true;
    viewer.ui.visible = false;
    state.focused = false; state.rotating = false;
    patient.setContextDim(0);
    this.rig.tween = null;
    this.mode = null; this.session = null;
    this.ctx.onXRChange?.(null);
  }

  end() { this.session?.end(); }

  headPose() {
    const cam = this.ctx.viewer.renderer.xr.getCamera();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    cam.matrixWorld.decompose(pos, quat, new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    return { pos, quat, fwd, flat, yaw: Math.atan2(-flat.x, -flat.z) };
  }

  // Put panels in front of the user (called on start, after teleport, and on "summon").
  placeUI() {
    const h = this.headPose();
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw);
    const place = (mesh, off, tilt = 0) => {
      mesh.position.copy(h.pos).add(off.clone().applyQuaternion(yawQ));
      mesh.quaternion.copy(yawQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-off.x, -off.z) * 0.8));
      if (tilt) mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
    };
    place(this.ui.main.mesh, new THREE.Vector3(-0.52, -0.12, -0.62));
    place(this.ui.toolbar.mesh, new THREE.Vector3(0, -0.42, -0.62), -0.55);
  }

  // Default placement: skeleton on the floor ~1.4 m ahead, facing the user.
  defaultPlacement(distance = 1.4, scale = 1) {
    const h = this.headPose();
    const floorY = this.refType === 'local' ? h.pos.y - 1.6 : 0;
    const pos = h.pos.clone().add(h.flat.clone().multiplyScalar(distance)); pos.y = floorY;
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw);
    return { pos, quat, scale };
  }

  pivot() { // world point that zoom/rotate keep fixed
    const { patient, state, viewer } = this.ctx;
    const p = new THREE.Vector3();
    if (state.focused && patient.fracturePoint(Math.max(0, state.focusIndex), p)) return p.applyMatrix4(viewer.model.matrixWorld);
    const c = state.selected?.center?.();
    if (c) return c.applyMatrix4(viewer.model.matrixWorld);
    return new THREE.Vector3(0, 0.9, 0).applyMatrix4(viewer.model.matrixWorld);
  }

  zoom(f) { this.rig.zoomAbout(f, this.pivot()); }

  // Bring fracture i ~0.5 m in front of the eyes, enlarged, with the film's viewing direction facing the user.
  focusFracture(i = 0, distance = 0.5, targetLen = 0.5) {
    const { patient, state } = this.ctx;
    const p = patient.fracturePoint(i);
    if (!p) return false;
    const h = this.headPose();
    const len = patient.boneBox(i).getSize(new THREE.Vector3()).length();
    const scale = THREE.MathUtils.clamp(targetLen / len, 0.3, 8);
    const target = h.pos.clone().add(h.flat.clone().multiplyScalar(distance)).add(new THREE.Vector3(0, -0.08, 0));
    const zDir = patient.fractureNormalView(i); // film normal in model space → face the user
    const faceYaw = Math.atan2(zDir.x, zDir.z);
    const yawToUser = Math.atan2(-h.flat.x, -h.flat.z);
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawToUser - faceYaw);
    const pos = target.clone().sub(p.clone().multiplyScalar(scale).applyQuaternion(quat));
    this.rig.tweenTo({ pos, quat, scale }, 0.9);
    state.focused = true;
    patient.setContextDim(0.5);
    patient.setGlow(1.8);
    return true;
  }

  unfocus() {
    const { patient, state } = this.ctx;
    state.focused = false;
    patient.setContextDim(0);
    patient.setGlow(1);
  }

  reset() {
    this.unfocus();
    if (this.placement) this.rig.tweenTo(this.placement, 0.7);
  }

  fit() {
    this.unfocus();
    if (this.mode === 'immersive-ar') { if (this.placement) this.rig.tweenTo(this.placement, 0.7); return; }
    this.rig.tweenTo(this.defaultPlacement(1.4, 1), 0.8);
  }

  refreshUI() { for (const p of this.ui.all) p.redraw(); this.ar.refreshOverlay?.(); }

  frame(dt, t, frame) {
    if (!this.presenting) return;
    this.frames = (this.frames || 0) + 1;
    // wait until the XR camera has a real head pose (it is updated during the first renders)
    if (this.needsPlacement && frame && this.frames > 3) {
      this.needsPlacement = false;
      if (this.mode === 'immersive-vr') {
        this.placement = this.defaultPlacement(1.4, 1);
        this.rig.setWorld(this.placement.pos, this.placement.quat, this.placement.scale);
        this.placeUI();
      } else {
        this.placeUI();
      }
    }
    this.rig.update(dt);
    if (this.ctx.state.rotating && !this.rig.tween) this.rig.yawAbout(dt * 0.45, this.pivot());
    if (this.mode === 'immersive-vr') this.vr.frame(dt, t, frame); else this.ar.frame(dt, t, frame);
  }
}
