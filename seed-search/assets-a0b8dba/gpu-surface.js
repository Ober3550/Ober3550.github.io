// Client loader for the WebGPU surface worker (gpu-worker.js). Same call shape
// as surface-wasm.js so the surface page can swap backends.
//
//   window.generateSurfaceGPU(req) -> Promise<{ summary, pixels }>
//     req: { seed, kind: "elevation"|"fields"|"tiles", rect:{x0,y0,x1,y1} }
//     tiles  -> pixels = Uint8Array of palette tile indices (0..20)
//     fields -> pixels = Float32Array aux, extra = Float32Array moisture
//   window.preloadSurfaceGPU()
//
// Palette order matches biome.zig nauvis_base_palette:
//   0 water, 1 deepwater, 2 sand-1, 3 sand-2, 4 sand-3, 5 dry-dirt, 6..12
//   dirt-1..7, 13..16 grass-1..4, 17..20 red-desert-0..3
(function () {
  var NAUVIS_COLORS = [
    [51, 83, 95], [38, 64, 73], [138, 103, 58], [128, 93, 52], [115, 83, 47],
    [94, 66, 37], [141, 104, 60], [136, 96, 59], [133, 92, 53], [103, 72, 43],
    [91, 63, 38], [80, 55, 31], [80, 54, 28], [55, 53, 11], [66, 57, 15],
    [65, 52, 28], [59, 40, 18], [103, 70, 32], [116, 81, 39], [116, 84, 43],
    [128, 93, 52]
  ];
  var worker = null;
  var nextId = 1;
  var pending = {};

  function ensure() {
    if (worker) return worker;
    worker = new Worker(((window.Shell && window.Shell.base) || "") + "gpu-worker.js");
    worker.onmessage = function (ev) {
      var m = ev.data;
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error || "gpu surface failed"));
    };
    worker.onerror = function (e) {
      try { window.__GPU_WORKER_ERR__ = String((e && e.message) || e); } catch (e2) {}
      var err = new Error("gpu worker crashed: " + (e.message || "unknown"));
      Object.keys(pending).forEach(function (id) { pending[id].reject(err); });
      pending = {};
      worker.terminate();
      worker = null;
    };
    return worker;
  }

  window.generateSurfaceGPU = function (req) {
    var w = ensure();
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      w.postMessage({ id: id, type: "gpu-surface", req: req });
    });
  };
  window.preloadSurfaceGPU = function () { return ensure(); };

  // Turn tile-index pixels into RGBA (terrain layer only).
  window.gpuIndicesToRgba = function (indices, w, h) {
    var out = new Uint8Array(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var c = NAUVIS_COLORS[indices[i]] || [0, 0, 0];
      var o = i * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
    return out;
  };

  // ── Progressive disk renderer (GPU) ───────────────────────────────────────
  // Splits the disk into `cell`-sized squares (centre-out, like the CPU
  // pipeline) so each dispatch has a small readback and, on slower devices,
  // the map visibly fills from spawn while work continues. onCell is called
  // per cell with { x, y, w, h, rgba, done, total } where (x,y) is the canvas
  // offset of the cell's top-left corner.
  // req: { seed, zone?, kind: "tiles"|"se-color"|"field-color", radius,
  //        diskR?, cell?, onCell } -> { cells }

  function diskPlan(R, diskR, cell) {
    var cells = [];
    for (var ya = -R; ya < R; ya += cell) {
      var yb = Math.min(ya + cell, R);
      for (var xa = -R; xa < R; xa += cell) {
        var xb = Math.min(xa + cell, R);
        var cdx = Math.max(xa, Math.min(0, xb - 1));
        var cdy = Math.max(ya, Math.min(0, yb - 1));
        if (cdx * cdx + cdy * cdy > diskR * diskR) continue; // fully outside disk
        var cx = (xa + xb) / 2, cy = (ya + yb) / 2;
        cells.push({ xa: xa, ya: ya, xb: xb, yb: yb, d2: cx * cx + cy * cy });
      }
    }
    // centre-out so the spawn area appears first; row-major tie-break.
    cells.sort(function (a, b) { return (a.d2 - b.d2) || (a.xa - b.xa) || (a.ya - b.ya); });
    return cells;
  }

  // Colour a cell's pixels: tiles -> palette indices -> RGBA; the classifier
  // and field kernels already return packed 0xRRGGBB colours.
  function cellRgba(kind, px, w, h) {
    if (kind === "tiles") return window.gpuIndicesToRgba(px, w, h);
    var packed = new Uint32Array(px);
    var out = new Uint8Array(w * h * 4);
    for (var i = 0; i < packed.length; i++) {
      var o = i * 4;
      out[o] = (packed[i] >> 16) & 255;
      out[o + 1] = (packed[i] >> 8) & 255;
      out[o + 2] = packed[i] & 255;
      out[o + 3] = 255;
    }
    return out;
  }

  // Zero the alpha of pixels outside the disk (kernel fills the whole cell
  // square; only the disk region belongs to the surface).
  function maskCell(rgba, w, h, diskR, x0, y0) {
    var R2 = diskR * diskR;
    for (var y = 0; y < h; y++) {
      var row = (y0 + y);
      for (var x = 0; x < w; x++) {
        var dx = x0 + x;
        if (dx * dx + row * row > R2) rgba[(y * w + x) * 4 + 3] = 0;
      }
    }
  }

  window.generateSurfaceProgressive = function (req) {
    var R = req.radius, diskR = req.diskR || R, cell = req.cell || 512;
    var cells = diskPlan(R, diskR, cell);
    var offset = R; // canvas index of map coord 0
    var onCell = req.onCell || null;
    function step(i) {
      if (i >= cells.length) return Promise.resolve(cells.length);
      var c = cells[i];
      var w = c.xb - c.xa;
      var h = c.yb - c.ya;
      return window.generateSurfaceGPU({
        seed: req.seed, kind: req.kind, zone: req.zone || null,
        rect: { x0: c.xa, y0: c.ya, x1: c.xb, y1: c.yb }
      }).then(function (r) {
        var rgba = cellRgba(req.kind, r.pixels, w, h);
        maskCell(rgba, w, h, diskR, c.xa, c.ya);
        if (onCell) onCell({ x: c.xa + offset, y: c.ya + offset, w: w, h: h, rgba: rgba, done: i + 1, total: cells.length });
        return step(i + 1);
      });
    }
    return step(0);
  };

  // Whole-buffer helpers (kept for callers that want the final RGBA square;
  // the page uses generateSurfaceProgressive directly so work streams in).
  function gpuFull(req, workerKind) {
    var size = 2 * req.radius;
    var rgba = new Uint8Array(size * size * 4);
    var R = req.radius;
    return window.generateSurfaceProgressive({
      seed: req.seed, zone: req.zone, kind: workerKind, radius: R,
      diskR: req.diskR, cell: req.cell || 512,
      onCell: function (c) {
        var dst = (c.y * size + c.x) * 4;
        var w = c.w, h = c.h;
        for (var y = 0; y < h; y++) rgba.set(c.rgba.subarray(y * w * 4, (y + 1) * w * 4), dst + y * size * 4);
      }
    }).then(function (cells) { return { rgba: rgba, width: size, height: size, cells: cells }; });
  }

  window.generateSEZoneGPU = function (req) { return gpuFull(req, "se-color"); };
  window.generateSEFieldGPU = function (req) {
    // the field kernel seeds its billows gen with the ZONE's map seed, not the
    // world seed
    var r2 = {};
    for (var k in req) r2[k] = req[k];
    if (req.zone && req.zone.s != null) r2.seed = req.zone.s;
    return gpuFull(r2, "field-color");
  };
})();
