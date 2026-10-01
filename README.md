# FractoVue XR

**Upload one X-ray. The fractured bone of a full 3D human skeleton breaks where the film shows the fracture. Explore it in VR or AR.**

**Live app:** <https://shwetha2811.github.io/Fracture-WebXR/>

> **Research and visualisation prototype, not a medical device.** A radiograph is a 2D projection: in-film
> displacement and angulation are measured, out-of-plane displacement is not. Do not use it for diagnosis or
> treatment decisions.

---

## What it does

FractoVue XR keeps a complete, individually addressable human skeleton as the anatomical reference. You pick a
body region and the bone you care about, then upload a radiograph (PNG or JPEG, AP or lateral). The app:

1. **Detects the fracture.** A YOLOv8m model trained on the HBFMID bone-fracture dataset decides whether there is a
   fracture and names its type (transverse, oblique, spiral, comminuted, greenstick…). The built-in image-analysis
   detector places the break along the bone. If the model sees only healthy bone, nothing is reported and the
   skeleton is left unchanged.
2. **Lays the X-ray onto the skeleton.** The film is registered to the skeleton joint by joint (elbow, hip, knee,
   shoulder, wrist), so each bone on the film lands on its skeleton bone.
3. **Breaks only the fractured bone.** The skeleton bone is cut where the film shows the break, and the fragments
   are moved by the displacement and angulation measured on the film. Loose fragments seen on the film (butterfly
   or comminuted pieces) are carved out of that bone and moved to where the film shows them. Every other bone
   stays exactly as it was.
4. **Shows it in 3D, VR and AR.** You can orbit the skeleton in the browser, walk around it in VR, or place it on a
   table or the floor in AR.

Every step of the pipeline is shown in the side panel with its intermediate image, so you can see what was
measured and what was estimated.

## How to use

1. Open the [live app](https://shwetha2811.github.io/Fracture-WebXR/).
2. **Region:** choose the body region (e.g. Forearm, Leg, Lower leg, Wrist, Hip, Ankle).
3. **Bone of interest:** pick the bone (e.g. Left radius).
4. **X-ray:** drop or browse for the radiograph. Optionally crop to the bone, or tick "Image is inverted".
5. **Detector:**
   * **Built-in + your model** (default): the model decides fracture / no fracture, the built-in detector locates it.
   * **Your model:** the model decides and its box sets the location.
   * **Built-in:** the image-analysis detector alone. It is more sensitive and may report growth plates as fractures.
6. Press **Analyze**, then use **Skeleton / Patient bone / Fracture / X-ray** to change the view.
7. If the break is missed or misplaced, click it on the X-ray to mark it manually and analyse again.

## VR and AR

| Device | How |
|---|---|
| **Meta Quest** | Open the link in the Quest Browser, then press **Enter VR** or **Enter AR** (passthrough) |
| **Android phone** (ARCore) | Open the link in Chrome, then press **Enter AR** and place the skeleton on a surface |
| **Desktop** | 3D view in any modern browser (Chrome, Edge, Firefox); VR with a PC headset in Chrome / Edge |

WebXR needs HTTPS, which GitHub Pages provides.

## Install as an app (works offline)

* **Android or desktop Chrome / Edge:** open the link, then use **Install app** (menu → *Install* / *Add to Home screen*).
* **Meta Quest:** open the link in the Quest Browser and install it from the browser menu, or sideload the FractoVue
  APK built from this site.

After the first launch the app, the 3D skeleton and the fracture model (~72 MB in total) are stored on the device,
so it works without internet.

## Privacy

All analysis runs **on your device**, in the browser. X-ray images are never uploaded anywhere.

## Technology

* [three.js](https://threejs.org/) r160 and WebXR (immersive VR / AR, hit-test, anchors)
* [ONNX Runtime Web](https://onnxruntime.ai/) (WebAssembly) running the YOLOv8m fracture detector in the browser.
  The weights are stored as float16 in `models/fracture_detector/web/` and expanded to float32 on load. The `.wasm`
  extension only makes static hosts serve them as binary.
* An image-analysis engine (CLAHE, segmentation, bone-profile template matching, film-to-skeleton registration)
  written in plain JavaScript
* A service worker and web manifest for offline install

## Repository layout

| Path | Contents |
|---|---|
| `index.html`, `style.css` | App page and styles |
| `app.js` | UI and the analysis flow |
| `pipeline.js` | Image pipeline: segmentation, detection, localisation, fragments |
| `registration.js` | Film ↔ skeleton registration (per-bone, articulated joints) |
| `reconstruction.js`, `fracture.js` | Cutting and moving the fractured bone's fragments |
| `mldetect.js` | Fracture-detector loading and inference (ONNX Runtime Web) |
| `skeleton.js`, `anatomy.js` | The skeleton and the region / bone catalogue |
| `viewer.js`, `vr.js`, `ar.js`, `xr.js`, `controls.js` | 3D viewer, VR and AR modes |
| `sw.js`, `manifest.webmanifest`, `precache.json` | Offline app |
| `assets/` | Skeleton geometry and app icons |
| `models/fracture_detector/web/` | Fracture model for the browser |
| `vendor/` | three.js and ONNX Runtime Web (served locally for offline use) |

The site is static: any HTTPS static host works. To run it locally, serve the folder (for example with
`python -m http.server 8000`) and open <http://localhost:8000>.

## Fracture model

YOLOv8m trained on HBFMID (Human Bone Fractures Multi-modal Image Dataset, "Bone Fracture Detection" Roboflow export,
1,539 images). It has 10 classes: Comminuted, Greenstick, Healthy, Linear, Oblique Displaced, Oblique, Segmental,
Spiral, Transverse Displaced and Transverse.

A fracture is reported when a fracture box on the chosen bone scores **≥ 0.40** and above any Healthy box. On
held-out data at that threshold it found 163 of 182 fractured images (90%) and called none of 67 healthy images a
fracture. With only 10 held-out healthy images, the false-alarm rate on other normal films is not established.

## Limits

* One X-ray is a 2D projection: depth and out-of-plane displacement are estimated from the reference skeleton, not
  measured.
* Placement along the bone is least reliable when the film shows only one end of a long bone, or at strongly bent
  joints.
* Films with two views side by side, splints or casts can confuse the bone segmentation. Crop to one view, or mark
  the break by hand.
* Confidence values are not calibrated probabilities.

## Credits

* Fracture model: trained by the repository owner on HBFMID. YOLOv8 by Ultralytics (AGPL-3.0).
* 3D rendering: three.js (MIT). Inference: ONNX Runtime Web (MIT).
