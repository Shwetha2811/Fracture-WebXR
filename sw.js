// FractoVue XR service worker: makes the installed app work offline.
//
// precache.json (written by tools/build_app.py) lists every file of the app — pages, scripts, the skeleton, the
// bundled three.js / onnxruntime and your fracture model — with a version. On install they are all stored; a new
// version replaces the old cache. Pages and scripts are served network-first (updates arrive when online, the
// stored copy is used offline); large static files (model, skeleton, wasm) cache-first. Anything fetched later
// (e.g. VR controller models) is cached as it is used. X-ray images are never sent anywhere or cached here.

const PREFIX = 'fractovue-';
let VERSION = '7adf244ed0d0'; // build stamp

async function manifest() {
  try {
    const r = await fetch('precache.json', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch { /* offline or dev server */ }
  return { version: 'dev', files: [] };
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const m = await manifest();
    VERSION = m.version;
    const cache = await caches.open(PREFIX + VERSION);
    // one by one, so a single failure is reported instead of aborting silently
    for (const f of m.files) {
      try { if (!(await cache.match(f))) await cache.add(new Request(f, { cache: 'reload' })); } catch (e) { console.warn('[sw] could not cache', f, e); }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const m = await manifest();
    VERSION = m.version;
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== PREFIX + VERSION && k !== PREFIX + 'runtime') await caches.delete(k);
    await self.clients.claim();
  })());
});

const BIG = /\.(wasm|json|png|svg|mjs)$|\/vendor\/|\/models\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return;
  if (url.pathname.endsWith('/precache.json') || url.pathname.includes('/api/')) return; // never cache the manifest or backend calls
  if (url.origin !== self.location.origin) { // e.g. VR controller models: cache as used
    event.respondWith(caches.open(PREFIX + 'runtime').then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (BIG.test(url.pathname) && !url.pathname.endsWith('manifest.webmanifest')) { // cache-first
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then(async (r) => {
      if (r.ok) (await caches.open(PREFIX + 'runtime')).put(req, r.clone());
      return r;
    })));
    return;
  }
  // pages, scripts, styles: network first, stored copy offline
  event.respondWith(fetch(req).then(async (r) => {
    if (r.ok) (await caches.open(PREFIX + 'runtime')).put(req, r.clone());
    return r;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html', { ignoreSearch: true }) : Response.error())));
});
