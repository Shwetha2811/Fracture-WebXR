// Renderer, scene, lighting and the transform hierarchy shared by desktop, VR and AR:
//   scene
//    ├─ anchor  (identity on desktop/VR; follows the WebXR anchor / hit pose in AR)
//    │   └─ stage  (user placement: move / rotate / scale)
//    │       ├─ model (skeleton root + patient bone + fracture marker + X-ray plane)
//    │       └─ contact shadow
//    ├─ floor grid (VR / desktop)
//    ├─ ui (floating spatial panels)
//    └─ controllers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);
  const HOME = { pos: new THREE.Vector3(1.15, 1.25, 3.1), target: new THREE.Vector3(0, 0.9, 0) };
  camera.position.copy(HOME.pos);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const hemi = new THREE.HemisphereLight(0xf2efe8, 0x2a2420, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e2, 2.1);
  key.position.set(1.6, 3.4, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 2.1, bottom: -0.3, near: 0.5, far: 8 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfd6e0, 0.8);
  rim.position.set(-2.5, 1.8, -2);
  scene.add(rim);

  const anchor = new THREE.Group(); anchor.name = 'anchor'; scene.add(anchor);
  const stage = new THREE.Group(); stage.name = 'stage'; anchor.add(stage);
  const model = new THREE.Group(); model.name = 'model'; stage.add(model);
  key.target = stage;

  // contact shadow: cheap radial blob that works in VR/AR without shadow maps
  const blobTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002; blob.renderOrder = -1;
  stage.add(blob);
  const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(1.2, 48), new THREE.ShadowMaterial({ opacity: 0.32 }));
  shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = 0.001; shadowCatcher.receiveShadow = true;
  stage.add(shadowCatcher);

  const floor = new THREE.Group();
  const grid = new THREE.PolarGridHelper(2.4, 16, 8, 96, 0x2f4446, 0x1f2d2e);
  grid.material.transparent = true; grid.material.opacity = 0.55;
  floor.add(grid);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ color: 0x0d1516, roughness: 1 }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = -0.002; disc.visible = false; disc.name = 'floor';
  floor.add(disc);
  floor.userData.disc = disc;
  scene.add(floor);

  const ui = new THREE.Group(); ui.name = 'ui'; scene.add(ui);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.08;
  controls.maxDistance = 9;
  controls.autoRotateSpeed = 1.4;
  controls.update();

  let camTween = null;
  const flyTo = (pos, target) => { camTween = { pos: pos.clone(), target: target.clone() }; };
  controls.addEventListener('start', () => { camTween = null; });
  function zoom(f) {
    const off = camera.position.clone().sub(controls.target);
    const d = THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance);
    flyTo(controls.target.clone().add(off.setLength(d)), controls.target);
  }
  function frameBox(box, distanceScale = 1.6, dir) {
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.5;
    const d = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * distanceScale * 0.62 + 0.05;
    const off = (dir ? dir.clone() : camera.position.clone().sub(controls.target)).normalize().multiplyScalar(Math.max(d, 0.12));
    flyTo(c.clone().add(off), c);
  }

  const frameCbs = [];
  const onFrame = (cb) => frameCbs.push(cb);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop((t, frame) => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (!renderer.xr.isPresenting) {
      if (camTween) {
        const k = 1 - Math.pow(0.0008, dt);
        camera.position.lerp(camTween.pos, k);
        controls.target.lerp(camTween.target, k);
        if (camera.position.distanceTo(camTween.pos) < 0.001) camTween = null;
      }
      controls.update();
    }
    for (const cb of frameCbs) cb(dt, t, frame);
    renderer.render(scene, camera);
  });

  // Horizontal / vertical projection shift so content centres in the space not covered by panels.
  let shift = { x: 0, y: 0 };
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (renderer.xr.isPresenting) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.fov = w < 600 ? 50 : 40;
    if (shift.x || shift.y) camera.setViewOffset(w, h, -shift.x, -shift.y, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  const setViewShift = (x, y = 0) => { shift = { x, y }; resize(); };

  return { THREE, renderer, scene, camera, controls, anchor, stage, model, floor, ui, key, hemi, blob, shadowCatcher, HOME, flyTo, zoom, frameBox, onFrame, setViewShift, isFlying: () => !!camTween };
}
