// Procedural human skeleton (adult, ~1.75 m, anatomical position).
// Units are metres; feet rest on y = 0, the figure faces +z, the body's left is +x.
// Every bone is a THREE.Group with userData { bone: true, name, region, group }.

export function buildSkeleton(THREE, opts = {}) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const UP = V(0, 1, 0);

  const mat = opts.boneMaterial || new THREE.MeshStandardMaterial({ color: 0xd6c6a2, roughness: 0.6, metalness: 0 });
  mat.name = mat.name || 'Bone';
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b221c, roughness: 0.95, metalness: 0 });
  dark.name = 'Cavity';
  const tooth = new THREE.MeshStandardMaterial({ color: 0xb29d70, roughness: 0.5, metalness: 0 });
  tooth.name = 'Enamel';
  const cartMat = new THREE.MeshStandardMaterial({ color: 0xb9a888, roughness: 0.4, metalness: 0 });
  cartMat.name = 'Cartilage';
  const discMat = new THREE.MeshStandardMaterial({ color: 0x4f555e, roughness: 0.7, metalness: 0 });
  discMat.name = 'Intervertebral disc';

  const root = new THREE.Group();
  root.name = 'Human_Skeleton';
  const bones = [];

  const sphereGeo = new THREE.SphereGeometry(1, 20, 14);

  function addBone(name, region, group, parts) {
    const g = new THREE.Group();
    g.name = name.replace(/[^\w]+/g, '_');
    g.userData = { bone: true, name, region, group };
    for (const p of parts.flat()) g.add(p);
    root.add(g);
    bones.push(g);
    return g;
  }

  function orient(mesh, a, b) {
    const dir = b.clone().sub(a);
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
    return mesh;
  }

  // Lathe along a→b: slim, slightly oval shaft that flares gradually (metaphysis) into rounded ends (epiphyses).
  function longBone(a, b, rA, rS, rB, seg = 16, bow = 0) {
    const len = a.distanceTo(b);
    const wA = Math.min(0.35, Math.max(0.14, (2.6 * rA) / len));
    const wB = Math.min(0.35, Math.max(0.14, (2.6 * rB) / len));
    const cA = Math.min(0.3, rA / len);
    const cB = Math.min(0.3, rB / len);
    const pts = [];
    const N = 32;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const waist = 1 - 0.06 * Math.sin(Math.PI * t);
      let r = rS * waist + (rA - rS) * Math.exp(-((t / wA) ** 2)) + (rB - rS) * Math.exp(-(((1 - t) / wB) ** 2));
      if (t < cA) { const u = 1 - t / cA; r *= Math.sqrt(Math.max(0, 1 - u * u)); }
      if (1 - t < cB) { const u = 1 - (1 - t) / cB; r *= Math.sqrt(Math.max(0, 1 - u * u)); }
      pts.push(new THREE.Vector2(Math.max(r, 0.0002), t * len));
    }
    const geo = new THREE.LatheGeometry(pts, seg);
    geo.scale(1, 1, 0.86);
    if (bow) { // gentle forward curve of the shaft (femur, tibia)
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + bow * Math.sin(Math.PI * p.getY(i) / len));
      geo.computeVertexNormals();
    }
    return orient(new THREE.Mesh(geo, mat), a, b);
  }

  // Flat band swept along a curve (ribs): wide across, thin through, tapering at both ends.
  function band(points, width, thick, centre, m = mat) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const N = 56, M = 10, pos = [], idx = [];
    const out = new THREE.Vector3(), W = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const u = i / N, P = curve.getPointAt(u), T = curve.getTangentAt(u);
      out.set(P.x - centre.x, 0, P.z - centre.z).normalize();
      out.addScaledVector(T, -out.dot(T)).normalize();
      W.crossVectors(T, out).normalize();
      const f = 0.55 + 0.45 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.6);
      for (let j = 0; j < M; j++) {
        const a = (j / M) * Math.PI * 2;
        const q = P.clone().addScaledVector(W, Math.cos(a) * width * 0.5 * f).addScaledVector(out, Math.sin(a) * thick * 0.5 * (0.8 + 0.2 * f));
        pos.push(q.x, q.y, q.z);
      }
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), c = a + M, d = b + M;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const s = thick * 0.55;
    return [new THREE.Mesh(geo, m), ellipsoid(points[0], s * 1.3, s * 1.3, s * 1.3, m), ellipsoid(points[points.length - 1], width * 0.28, width * 0.28, s, m)];
  }

  function ellipsoid(p, sx, sy, sz, m = mat, rot) {
    const mesh = new THREE.Mesh(m === mat ? sphereGeo.clone() : sphereGeo, m);
    mesh.position.copy(p);
    mesh.scale.set(sx, sy, sz);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    return mesh;
  }

  function tube(points, r, closed = false) {
    const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
    const parts = [new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 10), r, 8, closed), mat)];
    if (!closed) {
      parts.push(ellipsoid(points[0], r, r, r));
      parts.push(ellipsoid(points[points.length - 1], r, r, r));
    }
    return parts;
  }

  function rotateAbout(list, p, axis, ang) {
    const M = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, ang))
      .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    for (const b of list) for (const m of b.children) m.applyMatrix4(M);
  }

  const sides = [
    { sx: 1, label: 'Left' },
    { sx: -1, label: 'Right' },
  ];

  // ---------- Scanned body: every bone comes from scans already placed in skeleton space ----------
  if (opts.body) {
    const scanned = (g) => { const m = new THREE.Mesh(g, mat); m.userData.cavity = true; return m; };
    if (opts.skull?.cranium && opts.skull?.mandible) {
      addBone('Cranium (skull)', 'skull', 'Skull', [scanned(opts.skull.cranium)]);
      addBone('Mandible (jaw)', 'skull', 'Skull', [scanned(opts.skull.mandible)]);
    }
    for (const [name, g] of Object.entries(opts.ribs || {})) addBone(name, 'thorax', 'Rib cage', [scanned(g)]);
    for (const [name, g] of Object.entries(opts.body)) addBone(name, g.userData.region, g.userData.group, [scanned(g)]);
  } else {
  // ---------- Skull: sculpted signed-distance surfaces, polygonised with marching cubes ----------
    const MC = opts.MarchingCubes;
    if (!MC) throw new Error('buildSkeleton needs opts.MarchingCubes for the skull');
    const O = V(0, 1.655, -0.005); // skull origin in world space (local +z = face)

    const sdE = (px, py, pz, cx, cy, cz, rx, ry, rz) => {
      const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
      const k0 = Math.sqrt(x * x + y * y + z * z);
      const k1 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
      return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
    };
    const sdC = (px, py, pz, ax, ay, az, bx, by, bz, r) => {
      const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
      const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
      return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
    };
    const sdRB = (px, py, pz, cx, cy, cz, hx, hy, hz, r) => {
      const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy, qz = Math.abs(pz - cz) - hz;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
    };
    const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
    const cut = (a, b, k) => -smin(-a, b, k); // smoothly subtract shape b from a

    function cranium(x, y, z) {
      const ax = Math.abs(x);
      const egg = 1 - 0.05 * Math.max(0, Math.min(1, (y - 0.02) / 0.07));               // narrower toward the crown
      let d = sdE(x / egg, y, z, 0, 0.012, -0.014, 0.069, 0.068, 0.095) * egg;         // parietal vault
      d = smin(d, sdE(x, y, z, 0, -0.004, -0.07, 0.054, 0.052, 0.042), 0.02);           // occipital
      d = smin(d, sdE(x / egg, y, z, 0, 0.02, 0.03, 0.058, 0.055, 0.052) * egg, 0.02);  // frontal
      d = smin(d, sdE(x, y, z, 0, -0.052, 0.054, 0.037, 0.034, 0.035), 0.018);           // maxilla
      d = smin(d, sdE(x, y, z, 0, -0.079, 0.052, 0.029, 0.011, 0.029), 0.01);
      d = smin(d, sdE(x, y, z, 0, -0.022, 0.056, 0.048, 0.028, 0.034), 0.014);          // facial mass around the orbits
      d = smin(d, sdE(ax, y, z, 0.046, -0.02, 0.058, 0.008, 0.021, 0.018), 0.01);         // lateral orbital wall            // alveolar arch
      d = smin(d, sdC(ax, y, z, 0, -0.005, 0.089, 0.042, -0.003, 0.079, 0.0048), 0.012);   // brow ridge
      d = smin(d, sdC(ax, y, z, 0.045, -0.006, 0.078, 0.048, -0.04, 0.071, 0.0048), 0.012); // lateral orbital rim
      d = smin(d, sdC(ax, y, z, 0.014, -0.042, 0.089, 0.046, -0.04, 0.074, 0.003), 0.01); // lower orbital rim
      d = smin(d, sdE(ax, y, z, 0.046, -0.047, 0.058, 0.011, 0.011, 0.013), 0.01);      // zygomatic
      d = smin(d, sdE(ax, y, z, 0.053, -0.058, -0.022, 0.009, 0.015, 0.01), 0.01);       // mastoid
      d = smin(d, sdC(x, y, z, 0, -0.02, 0.095, 0, -0.035, 0.104, 0.0048), 0.006);       // nasal bones
      d = smin(d, sdE(x, y, z, 0, -0.028, -0.108, 0.012, 0.006, 0.006), 0.008);         // external occipital protuberance
      d = cut(d, sdE(ax, y, z, 0.081, -0.022, 0.014, 0.0145, 0.028, 0.028), 0.012);        // temporal fossa (shallow)
      d = smin(d, sdC(ax, y, z, 0.052, -0.046, 0.05, 0.062, -0.043, 0.0, 0.0045), 0.006);  // zygomatic arch (bridges the fossa)
      d = smin(d, sdC(ax, y, z, 0.062, -0.043, 0.0, 0.061, -0.038, -0.013, 0.0045), 0.006); // arch root in front of the ear
      d = cut(d, sdE(x, y, z, 0, -0.064, -0.03, 0.015, 0.014, 0.019), 0.004);            // foramen magnum
      d = smin(d, sdE(ax, y, z, 0.014, -0.061, -0.02, 0.006, 0.004, 0.01), 0.003);        // occipital condyles
      { const ox = ax - 0.032, oy = y + 0.022, ca = Math.cos(0.08), sa = Math.sin(0.08);
        const rx = ox * ca + oy * sa, ry = -ox * sa + oy * ca;
        const tp = 0.3 + 0.7 * Math.max(0, Math.min(1, (z - 0.046) / 0.042));           // cone narrows toward the back
        d = cut(d, sdRB(rx / tp, ry / tp, z, 0, 0, 0.088, 0.0102, 0.0098, 0.04, 0.0115) * tp, 0.003); } // orbit
      d = cut(d, smin(sdE(x, y, z, 0, -0.049, 0.1, 0.009, 0.02, 0.022), sdE(x, y, z, 0, -0.062, 0.1, 0.0132, 0.0095, 0.022), 0.006), 0.003); // nasal aperture (pear)
      d = cut(d, sdE(ax, y, z, 0.028, -0.062, 0.104, 0.011, 0.011, 0.012), 0.008);       // canine fossa
      d = cut(d, sdE(ax, y, z, 0.07, -0.042, -0.004, 0.012, 0.0055, 0.0055), 0.003);     // ear canal
      return d;
    }
    // Wavy suture lines (coronal, sagittal, lambdoid, squamous) returned as 0..1 darkness.
    function sutures(x, y, z) {
      const wig = (t, a) => Math.sin(t * 520) * 0.0016 * a + Math.sin(t * 1330 + 1.3) * 0.0008 * a;
      const line = (dist) => Math.exp(-((dist / 0.0011) ** 2));
      let k = 0;
      if (y > -0.02) k = Math.max(k, line(Math.abs(z - (0.028 - 0.12 * (y - 0.05) ** 2 * 4) - wig(x + y, 1))));        // coronal
      if (y > 0.035 && z < 0.028 && z > -0.075) k = Math.max(k, line(Math.abs(x - wig(z, 1.3))));                      // sagittal
      if (z < -0.03) k = Math.max(k, line(Math.abs(z + 0.068 + 0.45 * (y - 0.06) - 0.06 * x * x * 40 - wig(x, 1.2)))); // lambdoid
      if (Math.abs(x) > 0.05 && y < 0.02 && y > -0.045) k = Math.max(k, line(Math.abs(y - 0.012 + 12 * (z - 0.0) ** 2 - wig(z, 0.6)))); // squamous
      return k;
    }
    function mandible(x, y, z) {
      const ax = Math.abs(x);
      const Y = (y + 0.115) / 2.4 - 0.115;       // tall, thin body
      const Z = (z - 0.006) / 2.7 + 0.006;       // broad ramus
      let d = sdC(ax, Y, z, 0, -0.113, 0.078, 0.022, -0.113, 0.066, 0.0056);
      d = smin(d, sdC(ax, Y, z, 0.022, -0.113, 0.066, 0.036, -0.112, 0.03, 0.0052), 0.008);
      d = smin(d, sdC(ax, Y, z, 0.036, -0.112, 0.03, 0.043, -0.11, 0.0, 0.0052), 0.008);
      d = smin(d, sdC(ax, y, Z, 0.044, -0.108, 0.004, 0.054, -0.052, 0.004, 0.0042), 0.008); // ramus
      d = smin(d, sdE(ax, y, z, 0.055, -0.048, 0.0, 0.009, 0.005, 0.006), 0.005);        // condyle
      d = smin(d, sdC(ax, y, z, 0.049, -0.072, 0.016, 0.048, -0.054, 0.022, 0.0035), 0.006); // coronoid
      d = cut(d, sdE(ax, y, z, 0.052, -0.05, 0.012, 0.012, 0.008, 0.006), 0.004);        // mandibular notch
      d = smin(d, sdE(x, y, z, 0, -0.124, 0.078, 0.015, 0.008, 0.0065), 0.006);          // chin
      d = smin(d, sdE(ax, y, z, 0.013, -0.127, 0.075, 0.007, 0.005, 0.005), 0.005);        // mental tubercles
      return d;
    }

    function sdfMesh(sdf, min, max, res, origin = O) {
      const c = min.clone().add(max).multiplyScalar(0.5);
      const H = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) * 0.54;
      const mc = new MC(res, mat, false, false, 150000);
      mc.isolation = 0;
      const half = res / 2, f = mc.field;
      for (let k = 0; k < res; k++) for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        f[i + j * res + k * res * res] = -sdf(c.x + ((i - half) / half) * H, c.y + ((j - half) / half) * H, c.z + ((k - half) / half) * H);
      }
      mc.update();
      const n = mc.count, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), e = 0.0004;
      for (let v = 0; v < n; v++) {
        const x = c.x + mc.positionArray[v * 3] * H, y = c.y + mc.positionArray[v * 3 + 1] * H, z = c.z + mc.positionArray[v * 3 + 2] * H;
        pos.set([x, y, z], v * 3);
        const g = V(sdf(x + e, y, z) - sdf(x - e, y, z), sdf(x, y + e, z) - sdf(x, y - e, z), sdf(x, y, z + e) - sdf(x, y, z - e)).normalize();
        nor.set([g.x, g.y, g.z], v * 3);
      }
      // make triangle winding agree with the outward normals
      const a = V(...pos.subarray(0, 3)), b = V(...pos.subarray(3, 6)), c3 = V(...pos.subarray(6, 9));
      if (b.clone().sub(a).cross(c3.clone().sub(a)).dot(V(...nor.subarray(0, 3))) < 0) {
        for (let t = 0; t < n; t += 3) for (const arr of [pos, nor]) {
          const tmp = arr.slice(t * 3 + 3, t * 3 + 6);
          arr.copyWithin(t * 3 + 3, t * 3 + 6, t * 3 + 9);
          arr.set(tmp, t * 3 + 6);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(origin);
      m.userData.sdf = sdf;
      return m;
    }

    // Permanent dentition along a parabolic arch: incisors, canine, premolars, molars (width, height, depth).
    const TEETH = [
      [0.0085, 0.0105, 0.0065], [0.0066, 0.0095, 0.006], [0.0076, 0.012, 0.0075], [0.007, 0.0088, 0.009],
      [0.0068, 0.0085, 0.009], [0.0102, 0.0078, 0.0105], [0.0092, 0.0074, 0.01], [0.0085, 0.007, 0.0095],
    ];
    function arch(yc, zf, k, s, down) {
      const out = [];
      for (const sx of [1, -1]) {
        let x = 0, arc = 0;
        const walk = (to) => { while (arc < to) { x += 0.0002 / Math.hypot(1, 2 * k * x); arc += 0.0002; } };
        for (const [w0, h0, dp0] of TEETH) {
          const w = w0 * s, h = h0 * s, dp = dp0 * s;
          const start = arc;
          walk(start + w / 2);
          const t = ellipsoid(V(O.x + sx * x, O.y + yc + (down ? -h : h) * 0.36, O.z + zf - k * x * x), w * 0.49, h * 0.46, dp / 2.4, tooth);
          t.rotation.y = Math.atan(2 * k * sx * x);
          out.push(t);
          walk(start + w);
        }
      }
      return out;
    }

    if (opts.skull?.cranium && opts.skull?.mandible) {
      // Scanned skull (NIH 3D Visible Human), already placed in skeleton space by skull.glb
      const scanned = (g) => { const m = new THREE.Mesh(g, mat); m.userData.cavity = true; return m; };
      addBone('Cranium (skull)', 'skull', 'Skull', [scanned(opts.skull.cranium)]);
      addBone('Mandible (jaw)', 'skull', 'Skull', [scanned(opts.skull.mandible)]);
    } else {
    addBone('Cranium (skull)', 'skull', 'Skull', [
      Object.assign(sdfMesh(cranium, V(-0.09, -0.1, -0.125), V(0.09, 0.112, 0.118), 160), { userData: { sdf: cranium, sutures } }),
      ellipsoid(V(O.x + 0.0315, O.y - 0.021, O.z + 0.06), 0.0155, 0.015, 0.014, dark), // back of the orbit
      ellipsoid(V(O.x - 0.0315, O.y - 0.021, O.z + 0.06), 0.0155, 0.015, 0.014, dark),
      ellipsoid(V(O.x, O.y - 0.096, O.z + 0.058), 0.024, 0.006, 0.018, dark),
      ellipsoid(V(O.x, O.y - 0.052, O.z + 0.078), 0.01, 0.017, 0.006, dark),
      ...arch(-0.089, 0.089, 44, 1, true),
    ]);
    addBone('Mandible (jaw)', 'skull', 'Skull', [
      sdfMesh(mandible, V(-0.068, -0.14, -0.018), V(0.068, -0.035, 0.1), 80),
      ...arch(-0.1015, 0.084, 50, 0.92, false),
      ellipsoid(V(O.x + 0.022, O.y - 0.115, O.z + 0.0752), 0.0019, 0.0017, 0.0012, dark), // mental foramina
      ellipsoid(V(O.x - 0.022, O.y - 0.115, O.z + 0.0752), 0.0019, 0.0017, 0.0012, dark),
    ]);
    }

  // ---------- Spine ----------
  const curveKeys = [[1.54, -0.015], [1.47, 0.0], [1.4, -0.03], [1.26, -0.065], [1.12, -0.05], [1.02, -0.02], [0.95, -0.04]];
  function spineZ(y) {
    for (let i = 0; i < curveKeys.length - 1; i++) {
      const [y0, z0] = curveKeys[i], [y1, z1] = curveKeys[i + 1];
      if (y <= y0 && y >= y1) {
        const t = (y0 - y) / (y0 - y1), s = t * t * (3 - 2 * t);
        return z0 + (z1 - z0) * s;
      }
    }
    return y > curveKeys[0][0] ? curveKeys[0][1] : curveKeys[curveKeys.length - 1][1];
  }

  function vertebra(name, y, r, h, spLen, spDrop, trLen, group, gap) {
    const z = spineZ(y);
    const prof = [[0, -h / 2], [r * 0.9, -h / 2], [r * 1.02, -h * 0.42], [r * 0.9, 0], [r * 1.0, h * 0.42], [r * 0.88, h / 2], [0, h / 2]]
      .map(([a, b]) => new THREE.Vector2(a, b));
    const bodyGeo = new THREE.LatheGeometry(prof, 20);
    bodyGeo.scale(1, 1, 0.8);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.set(0, y, z);
    const extra = [];
    if (gap > 0) {
      const dg = new THREE.CylinderGeometry(r * 0.96, r * 0.98, gap * 0.9, 20);
      dg.scale(1, 1, 0.8);
      const disc = new THREE.Mesh(dg, discMat);
      disc.position.set(0, y - h / 2 - gap / 2, spineZ(y - h / 2 - gap / 2));
      extra.push(disc);
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(r * 0.62, r * 0.2, 8, 20), mat);
    arch.position.set(0, y, z - r * 1.45);
    arch.rotation.x = Math.PI / 2;
    const back = z - r * 2.05;
    const parts = [
      body, arch, ...extra,
      longBone(V(0, y, back), V(0, y - spDrop, back - spLen), r * 0.28, r * 0.16, r * 0.22, 8),
      longBone(V(r * 0.5, y, z - r * 1.3), V(r * 0.6 + trLen, y + 0.002, z - r * 1.6), r * 0.22, r * 0.15, r * 0.22, 8),
      longBone(V(-r * 0.5, y, z - r * 1.3), V(-(r * 0.6 + trLen), y + 0.002, z - r * 1.6), r * 0.22, r * 0.15, r * 0.22, 8),
    ];
    addBone(name, 'spine', group, parts);
    return { y, z, r };
  }

  const thoracic = [];
  for (let i = 0; i < 7; i++) vertebra(`C${i + 1} cervical vertebra`, 1.535 - i * 0.019, 0.011 + i * 0.0006, 0.011, 0.016 + i * 0.002, 0.004, 0.011, 'Cervical spine', i === 0 ? 0 : 0.008);
  for (let i = 0; i < 12; i++) thoracic.push(vertebra(`T${i + 1} thoracic vertebra`, 1.395 - i * 0.025, 0.0135 + i * 0.0005, 0.017, 0.03, 0.016, 0.02, 'Thoracic spine', 0.008));
  for (let i = 0; i < 5; i++) vertebra(`L${i + 1} lumbar vertebra`, 1.085 - i * 0.032, 0.021 + i * 0.001, 0.023, 0.03, 0.004, 0.038 - i * 0.002, 'Lumbar spine', i === 4 ? 0.01 : 0.009);

  {
    // Sacrum: a tilted, tapering, front-concave wedge with four pairs of sacral foramina.
    const C = V(0, 0.905, -0.068), ca = Math.cos(0.45), sa = Math.sin(0.45);
    const sacrum = (x, y, z) => {
      const u = y - C.y, w = z - C.z;
      const yy = u * ca + w * sa;
      const zz = -u * sa + w * ca + 3 * yy * yy;
      const t = Math.max(0, Math.min(1, (yy + 0.055) / 0.11));
      let d = sdRB(x, yy, zz, 0, 0, 0, 0.047 * (0.5 + 0.5 * t), 0.052, 0.011, 0.004);
      d = smin(d, sdE(x, yy, zz, 0, 0.05, 0.004, 0.022, 0.01, 0.015), 0.008);   // S1 body / promontory
      d = smin(d, sdC(x, yy, zz, 0, 0.045, -0.013, 0, -0.035, -0.013, 0.003), 0.004); // median crest
      for (let i = 0; i < 4; i++) {
        const fy = 0.03 - i * 0.021, fx = 0.02 - i * 0.002;
        d = cut(d, sdE(Math.abs(x), yy, zz, fx, fy, 0, 0.0045, 0.0045, 0.03), 0.002);
      }
      return d;
    };
    addBone('Sacrum', 'pelvis', 'Pelvis', [sdfMesh(sacrum, V(-0.065, 0.83, -0.125), V(0.065, 0.985, -0.01), 88, V(0, 0, 0))]);
    addBone('Coccyx (tailbone)', 'pelvis', 'Pelvis', [longBone(V(0, 0.855, -0.094), V(0, 0.822, -0.08), 0.008, 0.005, 0.003, 8)]);
  }

  // ---------- Thorax ----------
  const scannedRibs = !!opts.ribs && Object.keys(opts.ribs).length > 0;
  const sternumTop = scannedRibs ? V(0, 1.35, 0.04) : V(0, 1.357, 0.078), sternumBot = scannedRibs ? V(0, 1.1, 0.114) : V(0, 1.105, 0.108);
  const sternumZ = (y) => sternumTop.z + ((sternumTop.y - y) / (sternumTop.y - sternumBot.y)) * (sternumBot.z - sternumTop.z);
  {
    const body = longBone(sternumTop, sternumBot, 0.024, 0.016, 0.012, 16);
    body.scale.set(1, 1, 0.35);
    const xiph = longBone(sternumBot, V(0, 1.075, sternumBot.z - 0.004), 0.008, 0.005, 0.003, 8);
    const manubrium = ellipsoid(V(0, 1.332, sternumZ(1.332) + 0.003), 0.026, 0.024, 0.0075, mat, [scannedRibs ? -0.29 : -0.12, 0, 0]);
    addBone('Sternum (breastbone)', 'thorax', 'Rib cage', [body, xiph, manubrium]);
  }

  if (scannedRibs) {
    for (const [name, g] of Object.entries(opts.ribs)) {
      const m = new THREE.Mesh(g, mat); m.userData.cavity = true;
      addBone(name, 'thorax', 'Rib cage', [m]);
    }
  }
  const ribW = [0.55, 0.72, 0.83, 0.9, 0.96, 1, 1, 1, 0.98, 0.94, 0.86, 0.76];
  for (let i = 0; i < (scannedRibs ? 0 : 12); i++) {
    const { y, z, r } = thoracic[i];
    const w = ribW[i];
    const drop = 0.055 + i * 0.012;
    const kind = i < 7 ? 'true rib' : i < 10 ? 'false rib' : 'floating rib';
    for (const { sx, label } of sides) {
      const ys = 1.345 - i * 0.034;                      // where a true rib's cartilage meets the sternum
      const zf = i < 7 ? sternumZ(ys) : 0.1;
      const pts = [
        V(sx * r * 0.9, y, z - r * 1.2),
        V(sx * (0.03 + 0.045 * w), y - 0.006, z - r * 1.2 - 0.018),
        V(sx * (0.03 + 0.1 * w), y - 0.3 * drop, z + 0.02),
        V(sx * (0.03 + 0.108 * w), y - 0.6 * drop, (z + zf) / 2 + 0.03 * w),
      ];
      let cart = null;
      if (i < 7) {
        const end = V(sx * (0.03 + 0.07 * w), y - drop, zf - 0.02);
        pts.push(end);
        cart = [end, V(sx * (0.02 + 0.03 * w), (y - drop + ys) / 2, zf - 0.005), V(sx * 0.017, ys, zf)];
      } else if (i < 10) {
        const k = i - 7, end = V(sx * (0.036 + 0.085 * w), y - drop, 0.07);
        pts.push(end);
        const top = V(sx * (0.02 + k * 0.006), 1.112 - k * 0.01, sternumZ(1.105) - 0.004 - k * 0.004);
        cart = [end, V(sx * (0.03 + 0.05 * w - k * 0.004), (end.y + top.y) / 2 - 0.005, 0.087), top];
      } else {
        pts.pop();
        pts.push(V(sx * (0.03 + 0.102 * w), y - 0.55 * drop, z + 0.07));
      }
      addBone(`${label} rib ${i + 1} (${kind})`, 'thorax', 'Rib cage', [
        band(pts, i === 0 ? 0.0135 : 0.0125 - i * 0.00025, 0.0045, V(0, 0, 0.02)),
        cart ? band(cart, 0.0095, 0.004, V(0, 0, 0.02), cartMat) : [],
      ]);
    }
  }

  // ---------- Shoulder girdle, arms and hands ----------
  const fingerNames = ['index', 'middle', 'ring', 'little'];
  const carpalNames = ['Scaphoid', 'Lunate', 'Triquetrum', 'Pisiform', 'Trapezium', 'Trapezoid', 'Capitate', 'Hamate'];
  for (const { sx, label } of sides) {
    addBone(`${label} clavicle (collarbone)`, 'arm', 'Shoulder', tube([
      V(sx * 0.022, 1.357, sternumTop.z + 0.004), V(sx * 0.07, 1.37, sternumTop.z + 0.01), V(sx * 0.13, 1.382, Math.min(0.03, sternumTop.z)), V(sx * 0.172, 1.385, -0.028),
    ], 0.0065));

    const shape = new THREE.Shape();
    shape.moveTo(0, 0.012);
    shape.lineTo(-0.012, 0.025);
    shape.lineTo(-0.078, 0.032);
    shape.lineTo(-0.088, -0.02);
    shape.lineTo(-0.062, -0.15);
    shape.lineTo(-0.008, -0.03);
    shape.lineTo(0, -0.012);
    const plate = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2 }), mat);
    plate.position.set(sx * 0.162, 1.345, -0.05);
    plate.scale.x = sx;
    plate.rotation.y = -sx * 0.55;
    const sp = (u, v) => { const x = u * Math.cos(-0.55) ; return V(sx * (0.162 + x), 1.345 + v, -0.05 + u * Math.sin(0.55) - 0.008); };
    addBone(`${label} scapula (shoulder blade)`, 'arm', 'Shoulder', [
      plate,
      ellipsoid(V(sx * 0.165, 1.345, -0.044), 0.008, 0.016, 0.012),
      ellipsoid(V(sx * 0.176, 1.386, -0.03), 0.012, 0.006, 0.012),                                   // acromion
      longBone(V(sx * 0.148, 1.37, -0.035), V(sx * 0.158, 1.358, 0.0), 0.006, 0.004, 0.004, 10),       // coracoid process
      ...tube([sp(-0.08, 0.005), sp(-0.03, 0.018), sp(0.0, 0.035), V(sx * 0.172, 1.382, -0.03)], 0.004),
    ]);

    const shoulder = V(sx * 0.182, 1.343, -0.036), elbow = V(sx * 0.212, 1.03, -0.045);
    const armStart = bones.length;
    addBone(`${label} humerus`, 'arm', 'Arm', [
      ellipsoid(shoulder, 0.023, 0.023, 0.023),
      ellipsoid(V(shoulder.x - sx * 0.009, shoulder.y + 0.002, shoulder.z - 0.002), 0.017, 0.019, 0.018, cartMat), // articular cartilage
      ellipsoid(V(sx * 0.196, 1.352, -0.026), 0.012, 0.012, 0.012),
      longBone(V(sx * 0.18, 1.335, -0.034), elbow, 0.02, 0.0105, 0.022),
      ellipsoid(V(elbow.x - sx * 0.022, elbow.y + 0.006, elbow.z - 0.002), 0.009, 0.008, 0.008),
      ellipsoid(V(elbow.x + sx * 0.018, elbow.y + 0.008, elbow.z), 0.007, 0.007, 0.007),
      ellipsoid(V(elbow.x - sx * 0.006, elbow.y - 0.004, elbow.z + 0.004), 0.015, 0.009, 0.011),
      ellipsoid(V(elbow.x - sx * 0.003, elbow.y + 0.022, elbow.z), 0.021, 0.022, 0.009),   // flat, flared lower humerus
      ellipsoid(V(elbow.x - sx * 0.004, elbow.y - 0.008, elbow.z + 0.003), 0.017, 0.007, 0.011, cartMat), // trochlea & capitulum
    ]);
    addBone(`${label} ulna`, 'arm', 'Forearm', [longBone(V(sx * 0.203, 1.045, -0.055), V(sx * 0.222, 0.8, -0.002), 0.012, 0.0062, 0.008), ellipsoid(V(sx * 0.202, 1.05, -0.063), 0.009, 0.013, 0.009)]);
    addBone(`${label} radius`, 'arm', 'Forearm', [longBone(V(sx * 0.226, 1.028, -0.036), V(sx * 0.252, 0.8, 0.012), 0.008, 0.006, 0.014), ellipsoid(V(sx * 0.226, 1.026, -0.036), 0.0105, 0.005, 0.0105), ellipsoid(V(sx * 0.246, 0.797, 0.008), 0.013, 0.004, 0.01, cartMat)]);

    // Hand, palm forward, thumb lateral.
    const W = V(sx * 0.238, 0.785, 0.006);
    carpalNames.forEach((n, k) => {
      const row = k < 4 ? 0 : 1, col = k % 4;
      const lat = row === 0 ? 0.02 - col * 0.013 : 0.022 - col * 0.014;
      addBone(`${label} ${n.toLowerCase()} (carpal)`, 'arm', 'Hand', [
        ellipsoid(V(W.x + sx * lat, W.y - row * 0.016, W.z + (k === 3 ? 0.008 : 0)), 0.0068, 0.0072, 0.0068),
      ]);
    });
    const mcLen = [0.064, 0.063, 0.058, 0.052];
    const phLen = [[0.04, 0.024, 0.018], [0.045, 0.028, 0.019], [0.042, 0.026, 0.019], [0.033, 0.019, 0.017]];
    const lats = [0.02, 0.005, -0.009, -0.022];
    fingerNames.forEach((f, k) => {
      let a = V(W.x + sx * lats[k], W.y - 0.028, W.z + 0.002);
      let b = V(W.x + sx * lats[k] * 1.25, a.y - mcLen[k], W.z + 0.006);
      addBone(`${label} ${f} metacarpal`, 'arm', 'Hand', [longBone(a, b, 0.0055, 0.0034, 0.005, 10)]);
      ['proximal', 'middle', 'distal'].forEach((seg, j) => {
        const L = phLen[k][j];
        const na = b.clone().add(V(0, -0.003, 0.0006));
        const nb = V(na.x + sx * lats[k] * 0.12, na.y - L, na.z + L * (0.22 + j * 0.3));
        addBone(`${label} ${f} finger ${seg} phalanx`, 'arm', 'Hand', [longBone(na, nb, j === 2 ? 0.004 : 0.0045, 0.0028, j === 2 ? 0.0032 : 0.004, 10), ellipsoid(na.clone().add(V(0, 0.0012, 0)), 0.0036, 0.0022, 0.0034, cartMat)]);
        b = nb;
      });
    });
    {
      const a = V(W.x + sx * 0.03, W.y - 0.022, W.z + 0.012);
      const b = V(W.x + sx * 0.05, W.y - 0.058, W.z + 0.03);
      addBone(`${label} thumb metacarpal`, 'arm', 'Hand', [longBone(a, b, 0.0058, 0.0036, 0.0052, 10)]);
      const p1 = V(b.x + sx * 0.014, b.y - 0.03, b.z + 0.016);
      addBone(`${label} thumb proximal phalanx`, 'arm', 'Hand', [longBone(b.clone().add(V(sx * 0.002, -0.003, 0.002)), p1, 0.005, 0.0032, 0.0045, 10)]);
      const p2 = V(p1.x + sx * 0.008, p1.y - 0.024, p1.z + 0.012);
      addBone(`${label} thumb distal phalanx`, 'arm', 'Hand', [longBone(p1.clone().add(V(sx * 0.001, -0.003, 0.001)), p2, 0.0045, 0.003, 0.0035, 10)]);
    }
    // Relaxed stance (as in the reference): arms hang almost straight beside the thighs, palms facing in.
    const hand = bones.slice(armStart + 3), forearm = bones.slice(armStart + 1), arm = bones.slice(armStart);
    rotateAbout(hand, W, V(0, 1, 0), -sx * 1.4);
    rotateAbout(forearm, elbow, V(1, 0, 0), -0.05);
    rotateAbout(forearm, elbow, V(0, 0, 1), sx * 0.04);
    rotateAbout(arm, shoulder, V(0, 0, 1), sx * 0.07);
  }

  // ---------- Pelvis, legs and feet ----------
  const tarsals = ['Talus', 'Calcaneus', 'Navicular', 'Cuboid', 'Medial cuneiform', 'Intermediate cuneiform', 'Lateral cuneiform'];
  const toeNames = ['big toe', 'second toe', 'third toe', 'fourth toe', 'little toe'];
  for (const { sx, label } of sides) {
    // Hip bone: curved iliac wing (a shell cut from an ellipsoid), acetabulum, pubis and ischium around the obturator foramen.
    const WC = [-0.02, 1.07, -0.005], WR = [0.17, 0.16, 0.085]; // large, flat ellipsoid: wing flares outward toward the crest
    const crestPts = [];
    for (let zc = -0.056; zc <= 0.052; zc += 0.012) {
      const yc = 1.012 - 0.35 * Math.max(0, zc - 0.02);            // crest dips toward the anterior superior spine
      const q = 1 - ((yc - WC[1]) / WR[1]) ** 2 - ((zc - WC[2]) / WR[2]) ** 2;
      crestPts.push([WC[0] + WR[0] * Math.sqrt(Math.max(0, q)), yc, zc]);
    }
    const hip = (wx, y, z) => {
      const x = sx * wx;
      let d = -smin(-(Math.abs(sdE(x, y, z, WC[0], WC[1], WC[2], WR[0], WR[1], WR[2])) - 0.0035),
                    -sdRB(x, y, z, 0.105, 0.972, -0.005, 0.07, 0.042, 0.06, 0.01), 0.008);                   // iliac wing (thin fan)
      if (y > 0.985) for (let k = 0; k < crestPts.length - 1; k++) {                                    // thick iliac crest
        const [x0, y0, z0] = crestPts[k], [x1, y1, z1] = crestPts[k + 1];
        d = smin(d, sdC(x, y, z, x0, y0, z0, x1, y1, z1, 0.0048), 0.005);
      }
      d = smin(d, sdC(x, y, z, 0.1, 0.91, 0.012, 0.118, 0.955, -0.005, 0.014), 0.015);              // ilium body
      d = smin(d, sdE(x, y, z, 0.094, 0.905, 0.018, 0.025, 0.03, 0.028), 0.01);                      // acetabular mass
      d = smin(d, sdC(x, y, z, 0.085, 0.905, 0.04, 0.018, 0.876, 0.07, 0.0075), 0.01);               // superior pubic ramus
      d = smin(d, sdE(x, y, z, 0.011, 0.868, 0.068, 0.007, 0.02, 0.01), 0.008);                      // symphysis
      d = smin(d, sdC(x, y, z, 0.015, 0.854, 0.066, 0.06, 0.826, 0.005, 0.0065), 0.01);              // inferior ramus
      d = smin(d, sdE(x, y, z, 0.062, 0.83, 0.0, 0.013, 0.016, 0.016), 0.01);                        // ischial tuberosity
      d = smin(d, sdC(x, y, z, 0.066, 0.835, 0.0, 0.088, 0.895, 0.0, 0.009), 0.01);                 // ischium body
      d = smin(d, sdC(x, y, z, 0.048, 0.965, -0.056, 0.088, 0.962, -0.036, 0.011), 0.012);          // sacroiliac / PSIS
      d = cut(d, sdE(x, y, z, 0.114, 0.905, 0.022, 0.022, 0.022, 0.022), 0.003);                    // acetabulum socket
      return d;
    };
    addBone(`${label} hip bone (os coxae)`, 'pelvis', 'Pelvis', [
      sdfMesh(hip, V(sx > 0 ? -0.005 : -0.2, 0.8, -0.1), V(sx > 0 ? 0.2 : 0.005, 1.06, 0.09), 144, V(0, 0, 0)),
      sx > 0 ? ellipsoid(V(0, 0.868, 0.068), 0.0055, 0.018, 0.009, cartMat) : [],                      // pubic symphysis disc
    ]);

    const head = V(sx * 0.106, 0.905, 0.022);
    addBone(`${label} femur (thigh bone)`, 'leg', 'Thigh', [
      ellipsoid(head, 0.021, 0.021, 0.021),
      longBone(head, V(sx * 0.142, 0.874, 0.01), 0.012, 0.011, 0.016, 12),
      ellipsoid(V(sx * 0.156, 0.888, -0.002), 0.016, 0.022, 0.017),
      longBone(V(sx * 0.148, 0.88, 0.004), V(sx * 0.09, 0.505, 0.006), 0.021, 0.012, 0.03, 16, 0.012),
      ellipsoid(V(sx * 0.109, 0.498, 0.0), 0.017, 0.02, 0.026),
      ellipsoid(V(sx * 0.072, 0.498, 0.0), 0.017, 0.02, 0.026),
    ]);
    addBone(`${label} patella (kneecap)`, 'leg', 'Knee', [ellipsoid(V(sx * 0.093, 0.5, 0.043), 0.02, 0.024, 0.009)]);
    addBone(`${label} tibia (shinbone)`, 'leg', 'Lower leg', [
      longBone(V(sx * 0.092, 0.476, 0.004), V(sx * 0.09, 0.078, 0.0), 0.03, 0.012, 0.02, 16, 0.004),
      ellipsoid(V(sx * 0.091, 0.468, 0.003), 0.033, 0.009, 0.026),
      ellipsoid(V(sx * 0.093, 0.44, 0.024), 0.01, 0.016, 0.008),
      ellipsoid(V(sx * 0.077, 0.068, 0.003), 0.008, 0.013, 0.01),
    ]);
    addBone(`${label} fibula`, 'leg', 'Lower leg', [longBone(V(sx * 0.128, 0.452, -0.012), V(sx * 0.124, 0.06, -0.008), 0.009, 0.005, 0.01), ellipsoid(V(sx * 0.129, 0.448, -0.012), 0.011, 0.012, 0.011), ellipsoid(V(sx * 0.125, 0.058, -0.008), 0.009, 0.016, 0.01)]);

    const A = V(sx * 0.09, 0.058, 0.0);
    const tPos = [
      [V(A.x, A.y, A.z + 0.004), [0.018, 0.013, 0.02]],
      [V(A.x + sx * 0.004, 0.03, -0.035), [0.017, 0.02, 0.035]],
      [V(A.x - sx * 0.012, 0.045, 0.034), [0.012, 0.011, 0.009]],
      [V(A.x + sx * 0.022, 0.028, 0.036), [0.011, 0.01, 0.014]],
      [V(A.x - sx * 0.02, 0.04, 0.056), [0.008, 0.012, 0.011]],
      [V(A.x - sx * 0.005, 0.042, 0.054), [0.0065, 0.01, 0.01]],
      [V(A.x + sx * 0.008, 0.04, 0.054), [0.0065, 0.01, 0.01]],
    ];
    tarsals.forEach((n, k) => {
      const [p, s] = tPos[k];
      addBone(`${label} ${n.toLowerCase()} (tarsal)`, 'leg', 'Foot', [ellipsoid(p, s[0], s[1], s[2])]);
    });
    const rays = [-0.022, -0.006, 0.006, 0.018, 0.03];
    const mtLen = [0.066, 0.072, 0.068, 0.064, 0.06];
    toeNames.forEach((toe, k) => {
      const a = V(A.x + sx * rays[k], 0.036, 0.068 - (k > 2 ? 0.012 : 0));
      const b = V(A.x + sx * rays[k] * 1.25, 0.013, a.z + mtLen[k]);
      addBone(`${label} ${k === 0 ? 'first' : ['second', 'third', 'fourth', 'fifth'][k - 1]} metatarsal`, 'leg', 'Foot',
        [longBone(a, b, k === 0 ? 0.008 : 0.006, k === 0 ? 0.0055 : 0.0033, k === 0 ? 0.0085 : 0.0055, 10)]);
      const segs = k === 0 ? ['proximal', 'distal'] : ['proximal', 'middle', 'distal'];
      let p = b;
      segs.forEach((seg, j) => {
        const L = k === 0 ? [0.03, 0.024][j] : [0.022, 0.011, 0.01][j] * (1 - k * 0.06);
        const na = V(p.x, p.y, p.z + 0.003);
        const nb = V(na.x + sx * rays[k] * 0.1, Math.max(0.006, na.y - L * 0.12), na.z + L);
        const r = k === 0 ? 0.0065 : 0.0042;
        addBone(`${label} ${toe} ${seg} phalanx`, 'leg', 'Foot', [longBone(na, nb, r, r * 0.65, r * 0.8, 10)]);
        p = nb;
      });
    });
  }

  } // end of the modelled (non-scanned) skeleton

  // ---------- Surface: aged-bone mottling baked into vertex colours, plus crevice darkening on sculpted parts ----------
  const hash = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const u = x - xi, v = y - yi, w = z - zi;
    const fu = u * u * (3 - 2 * u), fv = v * v * (3 - 2 * v), fw = w * w * (3 - 2 * w);
    const L = (a, b, t) => a + (b - a) * t;
    const c = (i, j, k) => hash(xi + i, yi + j, zi + k);
    return L(L(L(c(0, 0, 0), c(1, 0, 0), fu), L(c(0, 1, 0), c(1, 1, 0), fu), fv),
             L(L(c(0, 0, 1), c(1, 0, 1), fu), L(c(0, 1, 1), c(1, 1, 1), fu), fv), fw);
  }
  const fbm = (x, y, z) => vnoise(x, y, z) * 0.5 + vnoise(x * 2.03 + 3.1, y * 2.03, z * 2.03) * 0.3 + vnoise(x * 4.1, y * 4.1 + 1.7, z * 4.1) * 0.2;
  const ivory = new THREE.Color(0xccb07e), straw = new THREE.Color(0x9f814f), stain = new THREE.Color(0x5c4428);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  function cavityMap(g) {
    const pa = g.attributes.position, na = g.attributes.normal, ix = g.index.array, n = pa.count;
    const sum = new Float32Array(n * 3), cnt = new Uint16Array(n);
    for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = ix[t + k], b = ix[t + (k + 1) % 3];
      sum[a * 3] += pa.getX(b); sum[a * 3 + 1] += pa.getY(b); sum[a * 3 + 2] += pa.getZ(b); cnt[a]++;
      sum[b * 3] += pa.getX(a); sum[b * 3 + 1] += pa.getY(a); sum[b * 3 + 2] += pa.getZ(a); cnt[b]++;
    }
    let raw = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      if (!cnt[v]) continue;
      const dx = sum[v * 3] / cnt[v] - pa.getX(v), dy = sum[v * 3 + 1] / cnt[v] - pa.getY(v), dz = sum[v * 3 + 2] / cnt[v] - pa.getZ(v);
      raw[v] = dx * na.getX(v) + dy * na.getY(v) + dz * na.getZ(v);   // > 0: concave
    }
    for (let pass = 0; pass < 4; pass++) {                              // smooth so cavities read as soft shading
      const next = new Float32Array(n), c2 = new Uint16Array(n);
      for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) { const a = ix[t + k], b = ix[t + (k + 1) % 3]; next[a] += raw[b]; c2[a]++; next[b] += raw[a]; c2[b]++; }
      for (let v = 0; v < n; v++) raw[v] = (raw[v] + (c2[v] ? next[v] / c2[v] : 0)) / 2;
    }
    return raw;
  }
  root.updateMatrixWorld(true);
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), Nn = new THREE.Vector3(), col = new THREE.Color();
  root.traverse((o) => {
    if (!o.isMesh || o.material !== mat) return;
    const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal;
    const cols = new Float32Array(pa.count * 3);
    const cav = o.userData.cavity ? cavityMap(g) : null;
    for (let v = 0; v < pa.count; v++) {
      Q.fromBufferAttribute(pa, v);
      P.copy(Q).applyMatrix4(o.matrixWorld);
      const broad = fbm(P.x * 22, P.y * 22, P.z * 22), fine = fbm(P.x * 150 + 7, P.y * 150, P.z * 150);
      col.copy(ivory).lerp(straw, clamp01(broad * 1.2 + fine * 0.4 - 0.2));
      if (broad > 0.5) col.lerp(stain, clamp01((broad - 0.5) * 2.4));
      col.multiplyScalar(0.88 + fine * 0.2);
      if (o.userData.sdf && na) {
        Nn.fromBufferAttribute(na, v);
        const s = o.userData.sdf, d1 = 0.004, d2 = 0.011, d3 = 0.022;
        const ao = 0.35 * clamp01(s(Q.x + Nn.x * d1, Q.y + Nn.y * d1, Q.z + Nn.z * d1) / d1)
                 + 0.35 * clamp01(s(Q.x + Nn.x * d2, Q.y + Nn.y * d2, Q.z + Nn.z * d2) / d2)
                 + 0.3 * clamp01(s(Q.x + Nn.x * d3, Q.y + Nn.y * d3, Q.z + Nn.z * d3) / d3);
        col.multiplyScalar(0.18 + 0.82 * ao * ao);
        if (o.userData.sutures) col.multiplyScalar(1 - 0.6 * o.userData.sutures(Q.x, Q.y, Q.z));
      }
      if (cav) col.multiplyScalar(Math.max(0.3, Math.min(1.08, 1 - cav[v] * 900)));
      cols[v * 3] = col.r; cols[v * 3 + 1] = col.g; cols[v * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  });
  mat.vertexColors = true;
  mat.color.set(0xffffff);

  root.traverse((o) => { if (o.isMesh) { o.userData.baseMaterial = o.material; } });
  return { root, bones, materials: { bone: mat, cavity: dark, enamel: tooth, disc: discMat, cartilage: cartMat } };
}
