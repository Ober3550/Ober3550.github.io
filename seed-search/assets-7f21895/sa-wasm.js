// Client-side Space Age planet terrain preview, run in the gen worker. Same
// pattern as surface-wasm.js:
//
//   window.generateSA(req) → Promise<{ summary, pixels }>
//   req: { seed, planet, x0, y0, width, height, property? }  (see sa_wasm.zig)
//   summary = { ok, planet, property, seed, surface_seed, x0, y0, width, height, tiles }
(function () {
  window.generateSA = function (req) {
    return window.__genCall("sa", { req: req }).then(function (m) {
      return { summary: m.summary, pixels: m.pixels };
    });
  };
})();
