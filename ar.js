// AR mode: place the skeleton on a real surface and inspect it in the room.
//   Phones (Chrome + ARCore): hit-test reticle → tap to place (anchored when 'anchors' is available),
//     then tap = select bone, one-finger drag = rotate (or move), pinch = scale, two-finger twist = rotate,
//     on-screen buttons via the WebXR DOM overlay.
//   Headsets (Quest 3 / 3S passthrough): controller ray → trigger to place; afterwards the VR controller
//     scheme applies (grab, two-hand scale, select, floating panels).
// Every missing feature degrades to a stated fallback instead of failing silently.
import * as THREE from 'three';
import { TouchGestures } from './controls.js';

export function setupAR(ctx, xr) {
  const { viewer } = ctx;
  const { renderer, scene, anchor } = viewer;
  const overlay = document.getElementById('ar-overlay');
  const statusEl = document.getElementById('ar-status');

  const reticle = new THREE.Group();
  reticle.add(new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fd3de })));
  reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.012, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fd3de })));
  const footprint = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.205, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.4 }));
  reticle.add(footprint);
  reticle.matrixAutoUpdate = false; reticle.visible = false;
  scene.add(reticle);
  const planeGroup = new THREE.Group(); scene.add(planeGroup);
  const planeMeshes = new Map();

  const st = { placed: false, hitSource: null, ctrlSources: new Map(), lastHit: null, anchor: null, dragMode: 'rotate', placeScale: 0.4, lifeSize: false, fallbackNoted: false };
  let gestures = null;

  function status(msg) { if (statusEl) statusEl.textContent = msg; ctx.onStatus?.(msg); }

  async function onStart() {
    st.placed = false; st.anchor = null; st.lastHit = null; st.lifeSize = false;
    const session = xr.session, f = xr.features;
    viewer.stage.visible = false;
    anchor.matrixAutoUpdate = false; anchor.matrix.identity();
    overlay.hidden = !f.domOverlay;
    document.body.classList.toggle('ar-dom', !!f.domOverlay);
    st.placeScale = f.domOverlay ? 0.4 : 1;
    if (f.hitTest) {
      try {
        const viewerSpace = await session.requestReferenceSpace('viewer');
        st.hitSource = await session.requestHitTestSource({ space: viewerSpace });
      } catch { st.hitSource = null; }
    }
    session.addEventListener('inputsourceschange', refreshCtrlSources);
    refreshCtrlSources();
    if (!st.hitSource && !xr.features.hitTest) status('Surface detection (hit-test) is not supported here. Tap to place the skeleton 1.2 m in front of you.');
    else status(f.domOverlay ? 'Move your phone slowly to find the floor or a table, then tap to place the skeleton.' : 'Point a controller at the floor or a table and pull the trigger to place the skeleton.');
    if (f.domOverlay && !gestures) gestures = new TouchGestures(overlay, { onTap, onDrag, onPinch });
    refreshOverlay();
  }

  async function refreshCtrlSources() {
    const session = xr.session;
    if (!session || !xr.features.hitTest) return;
    for (const src of session.inputSources) {
      if (src.targetRayMode !== 'tracked-pointer' || st.ctrlSources.has(src)) continue;
      try { st.ctrlSources.set(src, await session.requestHitTestSource({ space: src.targetRaySpace })); } catch { /* ignore */ }
    }
  }

  function onEnd() {
    st.hitSource?.cancel?.(); st.hitSource = null;
    for (const s of st.ctrlSources.values()) s.cancel?.();
    st.ctrlSources.clear();
    st.anchor?.delete?.(); st.anchor = null;
    reticle.visible = false; planeGroup.clear(); planeMeshes.clear();
    viewer.stage.visible = true;
    overlay.hidden = true;
    document.body.classList.remove('ar-dom');
    st.placed = false;
  }

  function facingUserQuat(at) {
    const h = xr.headPose();
    const d = h.pos.clone().sub(at); d.y = 0;
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.x, d.z));
  }

  function placeAt(matrix) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    matrix.decompose(pos, q, new THREE.Vector3());
    // An anchor keeps the model locked to the physical surface as tracking refines.
    // Anchors can only be created inside an XR frame, so creation is deferred to frame().
    st.anchor?.delete?.(); st.anchor = null; st.anchorQ0 = null;
    if (xr.features.anchors) st.pendingAnchor = pos.clone();
    anchor.matrix.makeTranslation(pos.x, pos.y, pos.z);
    anchor.matrixWorldNeedsUpdate = true;
    viewer.stage.position.set(0, 0, 0);
    viewer.stage.quaternion.copy(facingUserQuat(pos));
    viewer.stage.scale.setScalar(st.placeScale);
    viewer.stage.visible = true;
    st.placed = true;
    reticle.visible = false; planeGroup.visible = false;
    anchor.updateMatrixWorld(true);
    xr.placement = xr.rig.world();
    xr.placeUI();
    status(`Placed${st.anchor ? ' and anchored' : ''}. Tap a bone to inspect it · drag to ${st.dragMode} · pinch to scale.`);
    refreshOverlay();
  }

  function fallbackPlace() {
    const h = xr.headPose();
    const pos = h.pos.clone().add(h.flat.clone().multiplyScalar(1.2));
    pos.y = xr.refType === 'local' ? h.pos.y - 1.3 : 0;
    placeAt(new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z), null);
    if (!st.fallbackNoted) { st.fallbackNoted = true; status('Placed without surface detection (not supported on this device); position is approximate.'); }
  }

  function placeFromController(c) {
    const src = c.userData.src, hs = src && st.ctrlSources.get(src);
    const frame = renderer.xr.getFrame(), ref = renderer.xr.getReferenceSpace();
    if (hs && frame) {
      const hits = frame.getHitTestResults(hs);
      if (hits.length) { const p = hits[0].getPose(ref); placeAt(new THREE.Matrix4().fromArray(p.transform.matrix), hits[0]); return; }
    }
    // no hit-test: intersect the controller ray with the floor plane
    const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    const floorY = xr.refType === 'local' ? xr.headPose().pos.y - 1.5 : 0;
    if (d.y < -0.05) { const t = (floorY - o.y) / d.y; const p = o.addScaledVector(d, t); placeAt(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z), null); }
    else fallbackPlace();
  }

  // ----- touch interaction (phone, DOM overlay) -----
  const ndc = new THREE.Vector2();
  function rayFromScreen(x, y) {
    const cam = renderer.xr.getCamera().cameras?.[0] || renderer.xr.getCamera();
    ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam);
    return rc.ray;
  }
  function onTap(x, y) {
    if (!st.placed) {
      if (st.lastHit) placeAt(st.lastHit.matrix, st.lastHit.hit);
      else if (!st.hitSource) fallbackPlace();
      else status('Still looking for a surface: move the phone slowly over the floor or a table.');
      return;
    }
    const r = rayFromScreen(x, y);
    const hit = ctx.picker.fromRay(r.origin, r.direction, 20);
    ctx.select(hit && hit.kind !== 'ui' ? hit : null);
    refreshOverlay();
  }
  function onDrag(dx, dy, x, y) {
    if (!st.placed) return;
    xr.rig.tween = null;
    if (st.dragMode === 'rotate') {
      const w = xr.rig.world();
      xr.rig.yawAbout(dx * 0.01, w.pos);
    } else {
      // move on the placement plane: intersect the touch ray with the horizontal plane through the anchor
      const r = rayFromScreen(x, y);
      const planeY = new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld).y;
      if (Math.abs(r.direction.y) < 1e-3) return;
      const t = (planeY - r.origin.y) / r.direction.y;
      if (t <= 0) return;
      const p = r.origin.clone().addScaledVector(r.direction, t);
      const w = xr.rig.world();
      xr.rig.setWorld(new THREE.Vector3(p.x, w.pos.y, p.z), w.quat, w.scale);
    }
  }
  function onPinch({ scale, rotation }) {
    if (!st.placed) return;
    xr.rig.tween = null;
    const w = xr.rig.world();
    xr.rig.zoomAbout(scale, w.pos, [0.03, 4]);
    xr.rig.yawAbout(-rotation, xr.rig.world().pos);
  }

  // ----- overlay controls -----
  function refreshOverlay() {
    if (overlay.hidden) return;
    const s = ctx.state;
    overlay.querySelectorAll('[data-ar-toggle]').forEach((b) => b.setAttribute('aria-pressed', s.show(b.dataset.arToggle)));
    overlay.querySelector('[data-ar="focus"]').disabled = !s.hasFracture();
    overlay.querySelector('[data-ar="drag"]').textContent = st.dragMode === 'rotate' ? 'Drag: rotate' : 'Drag: move';
    overlay.querySelector('[data-ar="life"]').setAttribute('aria-pressed', st.lifeSize);
    const card = overlay.querySelector('.ar-card');
    const it = s.infoTarget(), sum = s.summary();
    card.innerHTML = it
      ? `<span class="tag ${it.kind === 'fracture' ? 'red' : ''}">${it.kind === 'fracture' ? 'Selected region' : 'Selected bone'}</span><b>${it.title}</b>${it.rows.slice(0, 3).map(([k, v]) => `<span><i>${k}</i> ${v}</span>`).join('')}`
      : `<span class="tag">FractoVue XR</span><b>${sum.region}</b><span><i>Fracture</i> ${sum.fracture}</span><span><i>Confidence</i> ${sum.confidence}</span>`;
  }
  overlay.addEventListener('beforexrselect', (e) => e.preventDefault()); // UI taps must not also select in 3D
  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const A = ctx.actions;
    const k = b.dataset.ar, t = b.dataset.arToggle;
    if (t) A[{ skeleton: 'toggleSkeleton', patient: 'togglePatient', fracture: 'toggleFracture', xray: 'toggleXray' }[t]]();
    else if (k === 'focus') A.focusFracture();
    else if (k === 'zin') A.zoomIn();
    else if (k === 'zout') A.zoomOut();
    else if (k === 'reset') A.reset();
    else if (k === 'replace') { st.placed = false; viewer.stage.visible = false; planeGroup.visible = true; xr.unfocus(); status('Tap a surface to place the skeleton again.'); }
    else if (k === 'drag') st.dragMode = st.dragMode === 'rotate' ? 'move' : 'rotate';
    else if (k === 'life') {
      st.lifeSize = !st.lifeSize;
      const w = xr.rig.world();
      xr.rig.tweenTo({ pos: w.pos, quat: w.quat, scale: st.lifeSize ? 1 : 0.4 }, 0.6);
      xr.placement = { ...xr.placement, scale: st.lifeSize ? 1 : 0.4 };
    } else if (k === 'exit') A.exitXR();
    refreshOverlay();
  });

  // ----- per frame -----
  function frame(dt, t, frame) {
    if (!frame) return;
    const ref = renderer.xr.getReferenceSpace();
    if (st.pendingAnchor && frame.createAnchor) {
      const p = st.pendingAnchor; st.pendingAnchor = null;
      frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z, w: 1 }), ref)
        .then((a) => { st.anchor = a; status('Anchored to the surface. Tap a bone to inspect it · drag to rotate · pinch to scale.'); })
        .catch(() => { st.anchor = null; });
    }
    if (st.anchor && frame.trackedAnchors?.has(st.anchor)) {
      const p = frame.getPose(st.anchor.anchorSpace, ref);
      if (p) {
        const m = new THREE.Matrix4().fromArray(p.transform.matrix);
        const q = new THREE.Quaternion().setFromRotationMatrix(m);
        if (!st.anchorQ0) st.anchorQ0 = q.clone().invert(); // keep the orientation chosen at placement
        anchor.matrix.copy(m).multiply(new THREE.Matrix4().makeRotationFromQuaternion(st.anchorQ0));
        anchor.matrixWorldNeedsUpdate = true;
      }
    }
    if (!st.placed) {
      let pose = null, hit = null;
      if (st.hitSource) { const hits = frame.getHitTestResults(st.hitSource); if (hits.length) { hit = hits[0]; pose = hit.getPose(ref); } }
      for (const [src, hs] of st.ctrlSources) { const hits = frame.getHitTestResults(hs); if (hits.length) { hit = hits[0]; pose = hit.getPose(ref); void src; break; } }
      if (pose) {
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        footprint.scale.setScalar(st.placeScale / 0.4);
        st.lastHit = { matrix: reticle.matrix.clone(), hit };
      } else { reticle.visible = false; st.lastHit = null; }
      if (xr.features.planes && frame.detectedPlanes) drawPlanes(frame, ref);
    }
    xr.vr.frame(dt); // controllers on AR headsets (ignores phone screen input)
  }

  function drawPlanes(frame, ref) {
    const seen = new Set();
    frame.detectedPlanes.forEach((plane) => {
      if (plane.orientation !== 'horizontal') return;
      seen.add(plane);
      const pose = frame.getPose(plane.planeSpace, ref);
      if (!pose) return;
      let m = planeMeshes.get(plane);
      if (!m || m.userData.t !== plane.lastChangedTime) {
        if (m) planeGroup.remove(m);
        const pts = plane.polygon.map((p) => new THREE.Vector3(p.x, 0.002, p.z));
        if (pts.length < 3) return;
        pts.push(pts[0].clone());
        m = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x7fd3de, transparent: true, opacity: 0.55 }));
        m.matrixAutoUpdate = false; m.userData.t = plane.lastChangedTime;
        planeMeshes.set(plane, m); planeGroup.add(m);
      }
      m.matrix.fromArray(pose.transform.matrix);
    });
    for (const [p, m] of planeMeshes) if (!seen.has(p)) { planeGroup.remove(m); planeMeshes.delete(p); }
  }

  // Phones without DOM overlay: screen taps arrive only as XR 'select' events with a screen ray.
  function onScreenSelect(c) {
    if (!st.placed) { if (st.lastHit) placeAt(st.lastHit.matrix); else if (!st.hitSource) fallbackPlace(); return; }
    const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    const hit = ctx.picker.fromRay(o, d, 20);
    ctx.select(hit && hit.kind !== 'ui' ? hit : null);
  }

  return { onStart, onEnd, frame, placeFromController, onScreenSelect, refreshOverlay, get placed() { return st.placed; } };
}
