// Client-side zone surface generation, run in a Web Worker (gen-worker.js) so
// the page never blocks. Same public API as the old inline loader:
//
//   window.generateSurface(req)  → Promise<{ summary, pixels }>
//   window.preloadSurfaceWasm()  → spawn the worker (starts its wasm fetch)
//
// req: { seed, k2, zone, radius, layer }. summary = { ok, zone, zone_seed,
// type, radius, width, height, layer, resources: { name: { amount, display,
// tiles } } }; pixels is a Uint8Array copy (RGBA8, width*height*4). The worker
// runs the SAME surface.wasm (SE surface generator — bit-identical to native
// segen); only the plumbing moved off the main thread. Requires gen-bridge.js
// to be loaded first.
(function () {
  window.generateSurface = function (req) {
    return window.__genCall("surface", { req: req }).then(function (m) {
      return { summary: m.summary, pixels: m.pixels };
    });
  };
  window.preloadSurfaceWasm = function () { return window.__genEnsure(); };
})();
