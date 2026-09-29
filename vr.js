// VR interaction (Meta Quest 2 / 3 / 3S and other WebXR headsets). Controllers are also
// used for AR on headsets (Quest passthrough), where the left hand places instead of teleports.
//
//   LEFT  controller: trigger or stick-forward = teleport arc · stick left/right = snap turn
//                     X = bring menu to me · Y = X-ray on/off · grip = grab
//   RIGHT controller: trigger = select bone / fracture / press UI · grip = grab & rotate model
//                     stick ← → = rotate model · stick ↑ ↓ = zoom · A = focus fracture · B = reset
//   BOTH grips       : two-handed scale + rotate + move
//   Hand tracking    : pinch = trigger on the same hand
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export function setupVR(ctx, xr) {
  const { viewer, picker } = ctx;
  const { renderer, scene } = viewer;
  const tmpM = new THREE.Matrix4();
  const factory = (() => { try { return new XRControllerModelFactory(); } catch { return null; } })();

  // teleport visuals
  const arcGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, () => new THREE.Vector3()));
  const arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.9 }));
  arc.visible = false; arc.frustumCulled = false; scene.add(arc);
  const target = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.85 }));
  target.visible = false; scene.add(target);

  // user rig for teleport / snap turn (applied through an offset reference space)
  let rigM = new THREE.Matrix4(), baseRef = null;

  const controllers = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.75 }));
    ray.scale.z = 4; c.add(ray);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0x7fd3de }));
    dot.visible = false; scene.add(dot);
    c.userData = { i, ray, dot, src: null, hand: 'none', hover: null, uiHover: null, teleporting: false, grab: null, prevButtons: [], stickLatch: false, selectGrab: false };
    c.addEventListener('connected', (e) => {
      c.userData.src = e.data; c.userData.hand = e.data.handedness || 'none';
      ray.visible = e.data.targetRayMode === 'tracked-pointer';
    });
    c.addEventListener('disconnected', () => { release(c); c.userData.src = null; dot.visible = false; ctx.setHover(c, null); });
    c.addEventListener('selectstart', () => onSelectStart(c));
    c.addEventListener('selectend', () => onSelectEnd(c));
    c.addEventListener('squeezestart', () => grab(c));
    c.addEventListener('squeezeend', () => release(c));
    scene.add(c);
    const grip = renderer.xr.getControllerGrip(i);
    if (factory) grip.add(factory.createControllerModel(grip));
    scene.add(grip);
    return c;
  });
  const other = (c) => controllers.find((o) => o !== c);
  const isAR = () => xr.mode === 'immersive-ar';
  const isLeft = (c) => c.userData.hand === 'left';

  function aim(c, raycaster) {
    tmpM.identity().extractRotation(c.matrixWorld);
    const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).applyMatrix4(tmpM).normalize();
    if (raycaster) raycaster.set(o, d);
    return { o, d };
  }
  function buzz(c, v, ms) { try { c.userData.src?.gamepad?.hapticActuators?.[0]?.pulse?.(v, ms); } catch { /* none */ } }

  const uiRay = new THREE.Raycaster();
  function uiHit(c) {
    if (!viewer.ui.visible) return null;
    aim(c, uiRay);
    const meshes = xr.ui.all.map((p) => p.mesh).filter((m) => m.visible);
    const h = uiRay.intersectObjects(meshes, false)[0];
    return h ? { panel: h.object.userData.panel, uv: h.uv, distance: h.distance, point: h.point } : null;
  }

  function onSelectStart(c) {
    if (c.userData.src?.targetRayMode === 'screen') { // phone taps: DOM-overlay gestures handle them, else ar.js
      if (isAR() && !xr.features?.domOverlay) xr.ar.onScreenSelect(c);
      return;
    }
    const u = uiHit(c);
    if (u) { if (u.panel.press(u.uv)) { buzz(c, 0.5, 30); xr.refreshUI(); } return; }
    if (isAR() && !xr.ar.placed) { xr.ar.placeFromController(c); return; }
    if (isLeft(c) && !isAR()) { c.userData.teleporting = true; return; }
    const { o, d } = aim(c);
    const hit = picker.fromRay(o, d, 20);
    if (hit && hit.kind !== 'ui') { ctx.select(hit); buzz(c, 0.6, 40); return; }
    // empty space: pinch/trigger-drag moves the model (useful with hand tracking)
    c.userData.selectGrab = true; grab(c);
  }
  function onSelectEnd(c) {
    if (c.userData.teleporting) { c.userData.teleporting = false; if (target.visible) teleportTo(target.position); arc.visible = target.visible = false; }
    if (c.userData.selectGrab) { c.userData.selectGrab = false; release(c); }
  }

  // ----- grab: one hand moves+rotates, two hands scale+rotate+move -----
  let two = null;
  function grab(c) {
    xr.rig.tween = null;
    const o = other(c);
    if (o.userData.grab) {
      const a = c.getWorldPosition(new THREE.Vector3()), b = o.getWorldPosition(new THREE.Vector3());
      two = { mid0: a.clone().add(b).multiplyScalar(0.5), v0: b.clone().sub(a), world0: xr.rig.world() };
      c.userData.grab = { two: true };
      return;
    }
    c.updateWorldMatrix(true, false);
    const w = xr.rig.world();
    const S = new THREE.Matrix4().compose(w.pos, w.quat, new THREE.Vector3(w.scale, w.scale, w.scale));
    c.userData.grab = { rel: c.matrixWorld.clone().invert().multiply(S) };
    buzz(c, 0.3, 20);
  }
  function release(c) {
    if (!c.userData.grab) return;
    c.userData.grab = null;
    two = null;
    const o = other(c);
    if (o.userData.grab) { o.userData.grab = null; grab(o); } // continue one-handed with the other hand
  }
  function updateGrab() {
    const [a, b] = controllers;
    if (two && a.userData.grab && b.userData.grab) {
      const pa = a.getWorldPosition(new THREE.Vector3()), pb = b.getWorldPosition(new THREE.Vector3());
      const mid = pa.clone().add(pb).multiplyScalar(0.5), v = pb.clone().sub(pa);
      const k = v.length() / Math.max(0.02, two.v0.length());
      const yaw = Math.atan2(v.x, v.z) - Math.atan2(two.v0.x, two.v0.z);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const w0 = two.world0;
      const scale = THREE.MathUtils.clamp(w0.scale * k, 0.05, 12);
      const pos = mid.clone().add(w0.pos.clone().sub(two.mid0).applyQuaternion(q).multiplyScalar(scale / w0.scale));
      xr.rig.setWorld(pos, q.multiply(w0.quat.clone()), scale);
      return;
    }
    for (const c of controllers) {
      const g = c.userData.grab;
      if (!g || g.two) continue;
      c.updateWorldMatrix(true, false);
      const M = c.matrixWorld.clone().multiply(g.rel);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), s = new THREE.Vector3();
      M.decompose(pos, quat, s);
      xr.rig.setWorld(pos, quat, s.x);
    }
  }

  // ----- teleport & snap turn through an offset reference space -----
  function applyRig(prevM) {
    if (!baseRef) baseRef = renderer.xr.getReferenceSpace();
    const inv = rigM.clone().invert();
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    inv.decompose(p, q, new THREE.Vector3());
    renderer.xr.setReferenceSpace(baseRef.getOffsetReferenceSpace(new XRRigidTransform({ x: p.x, y: p.y, z: p.z, w: 1 }, { x: q.x, y: q.y, z: q.z, w: q.w })));
    // floating UI travels with the user
    const delta = rigM.clone().multiply(prevM.clone().invert());
    viewer.ui.children.forEach((m) => m.applyMatrix4(delta));
  }
  function teleportTo(point) {
    const h = xr.headPose().pos;
    const prev = rigM.clone();
    rigM = new THREE.Matrix4().makeTranslation(point.x - h.x, 0, point.z - h.z).multiply(rigM);
    applyRig(prev);
  }
  function snapTurn(angle) {
    const h = xr.headPose().pos;
    const prev = rigM.clone();
    rigM = new THREE.Matrix4().makeTranslation(h.x, 0, h.z)
      .multiply(new THREE.Matrix4().makeRotationY(angle))
      .multiply(new THREE.Matrix4().makeTranslation(-h.x, 0, -h.z))
      .multiply(rigM);
    applyRig(prev);
  }
  function updateArc(c) {
    const { o, d } = aim(c);
    const g = -9.8, v = d.clone().multiplyScalar(7), pts = arcGeo.attributes.position;
    let hit = null, last = o.clone();
    for (let i = 0; i < 40; i++) {
      const t = i * 0.04;
      const p = new THREE.Vector3(o.x + v.x * t, o.y + v.y * t + 0.5 * g * t * t, o.z + v.z * t);
      if (!hit && p.y <= 0) { const k = last.y / Math.max(1e-6, last.y - p.y); hit = last.clone().lerp(p, k); }
      const q = hit || p;
      pts.setXYZ(i, q.x, q.y, q.z);
      last = p;
    }
    pts.needsUpdate = true;
    arc.visible = true;
    target.visible = !!hit && hit.distanceTo(o) < 15;
    if (hit) target.position.copy(hit).setY(0.005);
    arc.material.color.set(target.visible ? 0x7fd3de : 0xff6a5c);
  }

  // ----- per-frame: hover, thumbsticks, buttons -----
  function frame(dt) {
    updateGrab();
    let anyTeleport = false;
    for (const c of controllers) {
      const { ray, dot, src } = c.userData;
      if (!src || src.targetRayMode === 'screen') continue;
      const gp = src.gamepad;
      if (c.userData.teleporting) { updateArc(c); anyTeleport = true; }
      // hover (UI first, then anatomy)
      const u = uiHit(c);
      let len = 4;
      if (u) { len = u.distance; u.panel.setHover(u.panel.at(u.uv)); if (c.userData.uiHover && c.userData.uiHover !== u.panel) c.userData.uiHover.setHover(null); c.userData.uiHover = u.panel; ctx.setHover(c, null); }
      else {
        if (c.userData.uiHover) { c.userData.uiHover.setHover(null); c.userData.uiHover = null; }
        if (!c.userData.grab && !c.userData.teleporting) {
          const { o, d } = aim(c);
          const hit = picker.fromRay(o, d, 20);
          if (hit) len = hit.distance;
          if (ctx.setHover(c, hit) && hit) buzz(c, 0.12, 10);
        }
      }
      ray.scale.z = len;
      dot.visible = len < 4;
      if (dot.visible) { const { o, d } = aim(c); dot.position.copy(o).addScaledVector(d, len); }
      if (!gp) continue;
      // thumbsticks (xr-standard: axes[2], axes[3])
      const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
      const dz = (v) => (Math.abs(v) > 0.18 ? v : 0);
      if (isLeft(c) && !isAR()) {
        if (ax[1] < -0.6 && !c.userData.teleporting) { c.userData.teleporting = true; c.userData.stickTeleport = true; }
        if (c.userData.stickTeleport && ax[1] > -0.25) { c.userData.stickTeleport = false; c.userData.teleporting = false; if (target.visible) teleportTo(target.position); arc.visible = target.visible = false; }
        if (Math.abs(ax[0]) > 0.7 && !c.userData.stickLatch) { c.userData.stickLatch = true; snapTurn(ax[0] > 0 ? -Math.PI / 6 : Math.PI / 6); }
        if (Math.abs(ax[0]) < 0.3) c.userData.stickLatch = false;
      } else if (!c.userData.grab) {
        if (dz(ax[0])) { xr.rig.tween = null; xr.rig.yawAbout(-dz(ax[0]) * dt * 1.6, xr.pivot()); }
        if (dz(ax[1])) { xr.rig.tween = null; xr.zoom(1 - dz(ax[1]) * dt * 1.2); }
      }
      // face buttons (edge-triggered): 4 = A/X, 5 = B/Y
      const prev = c.userData.prevButtons;
      const pressed = (i) => gp.buttons[i]?.pressed && !prev[i];
      if (isLeft(c)) { if (pressed(4)) xr.placeUI(); if (pressed(5)) ctx.actions.toggleXray(); }
      else { if (pressed(4)) ctx.actions.focusFracture(); if (pressed(5)) ctx.actions.reset(); }
      c.userData.prevButtons = gp.buttons.map((b) => b.pressed);
    }
    if (!anyTeleport) { arc.visible = false; target.visible = false; }
    updateInfoPanel();
  }

  // floating bone information next to the hovered / selected bone, facing the user
  function updateInfoPanel() {
    const info = xr.ui.info, it = ctx.state.infoTarget();
    if (!viewer.ui.visible || !it || !it.anchorWorld) { info.mesh.visible = false; return; }
    const h = xr.headPose();
    const p = it.anchorWorld();
    const toHead = h.pos.clone().sub(p).normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toHead).normalize();
    const want = p.clone().addScaledVector(side, 0.2).addScaledVector(toHead, 0.12).add(new THREE.Vector3(0, 0.08, 0));
    info.mesh.position.lerp(want, info.mesh.visible ? 0.25 : 1);
    info.mesh.lookAt(h.pos);
    info.mesh.visible = true;
  }

  return {
    controllers,
    onStart() { rigM = new THREE.Matrix4(); baseRef = null; },
    onEnd() { for (const c of controllers) { c.userData.grab = null; c.userData.teleporting = false; ctx.setHover(c, null); } two = null; arc.visible = target.visible = false; },
    frame,
    updateGrab, updateInfoPanel, frameShared: frame,
  };
}
