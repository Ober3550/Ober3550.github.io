// Client-side universe generation, run in a Web Worker (gen-worker.js) so the
// page never blocks. Same public API as the old inline loader:
//
//   window.generateUniverse(seed, k2) → Promise<{ s, k, z: [...] }>
//   window.preloadUniverseWasm()      → spawn the worker (starts its wasm fetch)
//
// The worker runs the SAME universe.wasm (Zig universe generator — same pure
// logic as native seedgen, so FSR values are equivalent); only the plumbing
// moved off the main thread. Requires gen-bridge.js to be loaded first.
(function () {
  window.generateUniverse = function (seed, k2) {
    return window.__genCall("universe", { seed: seed, k2: !!k2 }).then(function (m) { return m.universe; });
  };
  window.preloadUniverseWasm = function () { return window.__genEnsure(); };
})();
