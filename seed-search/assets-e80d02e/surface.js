// Dedicated surface-generation page (surface.html?seed=&target=&mod=). Renders ONE surface
// full-page. SE zones / Nauvis use surface.wasm; SA planets use sa.wasm.
//
// Why chunking: the surface.wasm work is split into SQUARE CELL chunks exactly
// like the backend segen job pages did it (surface.wasm gained an optional
// absolute-rect so any rect is renderable): an N×N grid of ~320-tile cells
// over the square, dispatched CENTRE-OUTWARD (nearest cell to spawn first) so
// the landing area appears first and the map grows outward, fanned out across
// a small pool of gen workers (one wasm instance each → cells run in parallel
// across CPU cores) and blitted onto the canvas as each cell lands —
// GPU-accelerated canvas2d putImageData. This mirrors job-manager.js
// planSurfaceCells() (the backend's cell plan + order), so the fill animation
// matches the old job pages' live grid.
//
// Terrain is chunked freely (it's per-tile deterministic — a union of cells is
// bit-identical to one whole call). Ore placement is NOT split across cell
// calls (the ore pass is rect-dependent: starting-area enrichment scans whole
// regions), so ores are computed once for the whole rect in a separate
// "terrainless" pass queued onto its own worker, and each cell composites its
// ore sub-rect over the terrain as it lands. Resource totals come from that
// pass. There's no backend process to reuse in a browser tab — surface.wasm IS
// the segen code compiled to WASM, and each gen worker is one segen worker's
// worth of parallelism; the pool replaces the backend's job queue.
(function () {
  // seed, surface name and mod config come from the query string (shell.js)
  var SEED = window.Shell.seed;
  var TARGET = window.Shell.target;
  var MOD = window.Shell.mod;
  var K2 = MOD === "k2se";
  // WebGPU is the DEFAULT terrain backend when the browser supports it;
  // ?cpu=1 forces the CPU wasm pipeline (ore always comes from CPU wasm).
  var USE_GPU = !/[?&]cpu=1\b/.test(location.search) && !!(window.navigator && navigator.gpu);
  var GPU_MS = null;
  // 2D canvases above the GPU texture size silently no-op every drawing op in
  // Chrome, so the usable display size is probed at runtime (binary search for
  // the largest square where a draw round-trips) instead of hardcoded. Disks
  // larger than that render into a capped canvas with cells downscaled.
  var DISP_MAX = 4096; // fallback until the probe resolves
  var canvasMaxP = null;
  function canvasMax() {
    if (!canvasMaxP) {
      canvasMaxP = (async function () {
        function works(W) {
          try {
            var cv = document.createElement("canvas");
            cv.width = W; cv.height = W;
            var ctx = cv.getContext("2d");
            if (!ctx) return false;
            ctx.fillStyle = "#f00";
            ctx.fillRect(1, 1, 2, 2);
            var px = ctx.getImageData(2, 2, 1, 1).data;
            return px[0] === 255 && px[3] === 255;
          } catch (e) { return false; }
        }
        // doubling scan (max disk we ever display is 20000 = 2*r10000), then
        // binary refine between the last working and first failing size.
        var good = 1024;
        var bad = 20000;
        if (!works(good)) { DISP_MAX = good; return good; }
        for (var step = 2048; step <= 20000; step *= 2) {
          if (!works(step)) { bad = step; break; }
          good = step;
        }
        if (good === 20000) { DISP_MAX = good; return good; }
        while (bad - good > 64) {
          var mid = (good + bad) >> 1;
          if (works(mid)) good = mid; else bad = mid;
        }
        DISP_MAX = good;
        return good;
      })();
    }
    return canvasMaxP;
  }
  window.__probeCanvasMax = function () { return canvasMax(); };
  var cellCv = null, cellCx = null;
  function cellCanvas(w, h) {
    if (!cellCv || cellCv.width < w || cellCv.height < h) {
      cellCv = document.createElement("canvas");
      cellCv.width = w; cellCv.height = h;
      cellCx = cellCv.getContext("2d");
    }
    return cellCx;
  }
  // ?r=N -> initialise the preview radius to the zone's radius (passed by the
  // seed page rows) so the surface opens disk-cropped to the zone.
  var RADIUS_INIT = null;
  try {
    var _rv = parseInt(new URLSearchParams(location.search).get("r"), 10);
    if (Number.isFinite(_rv)) RADIUS_INIT = _rv;
  } catch (e) {}

  // Space Age planets: every one in sa.wasm's data file renders the same way.
  var PLANETS = {
    vulcanus: { label: "🌋 Vulcanus" },
    fulgora:  { label: "⚡ Fulgora" },
    gleba:    { label: "🍄 Gleba" },
    aquilo:   { label: "🧊 Aquilo" }
  };

  var els = {
    badge: document.getElementById("sf-badge"),
    meta: document.getElementById("sf-meta"),
    radius: document.getElementById("sf-radius"),
    layerWrap: document.getElementById("sf-layer-wrap"),
    layer: document.getElementById("sf-layer"),
    dimWrap: document.getElementById("sf-dim-wrap"),
    dim: document.getElementById("sf-dim"),
    go: document.getElementById("sf-go"),
    status: document.getElementById("sf-status"),
    canvas: document.getElementById("sf-canvas"),
    res: document.getElementById("sf-res"),
    progress: document.getElementById("sf-progress")
  };
  var busy = false;
  var kind = null;        // "nauvis" | "sa" | "zone"
  var planetKey = null;   // lower-cased planet name when kind === "sa"
  var zone = null;        // SE universe zone object when kind === "zone"
  var universe = null;    // cached generateUniverse result for this seed

  function nm(r) { return r.replace(/^se-/, "").replace(/^kr-/, "").replace(/-ore$/, ""); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function status(msg) { els.status.textContent = msg || ""; }
  function setProgress(pct) {
    if (els.progress) {
      els.progress.style.width = Math.round(pct * 100) + "%";
      els.progress.title = Math.round(pct * 100) + "%";
    }
  }

  function surfChips(totals) {
    var keys = Object.keys(totals).sort(function (a, b) { return totals[b].amount - totals[a].amount; });
    if (!keys.length) return "";
    return keys.map(function (r) {
      return '<span class="res-chip surf" title="exact — generated in your browser">' + nm(r) + " <strong>" + totals[r].display + "</strong></span>";
    }).join(" ");
  }

  // ── Worker pool ───────────────────────────────────────────────────────────
  var pool = null;
  var pending = {};   // id -> { resolve, reject }
  var queue = [];     // [{ id, type, req, resolve, reject }]
  var nextId = 1;

  function spawnPool() {
    pool = [];
    var n = 2;
    // one worker per logical core (safety-capped at 16 for very large hosts).
    try { n = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16)); } catch (e) {}
    for (var i = 0; i < n; i++) {
      var w = new Worker(window.Shell.asset("gen-worker.js"));
      w.idle = true;
      (function (worker) {
        worker.onmessage = function (ev) {
          var m = ev.data;
          var p = pending[m.id];
          if (!p) return;
          delete pending[m.id];
          if (m.ok) p.resolve({ summary: m.summary, pixels: m.pixels });
          else p.reject(new Error(m.error || "surface call failed"));
          if (queue.length) {
            var j = queue.shift();
            pending[j.id] = { resolve: j.resolve, reject: j.reject };
            worker.postMessage({ id: j.id, type: j.type, req: j.req });
          } else worker.idle = true;
        };
      })(w);
      pool.push(w);
    }
  }

  function sendToPool(req, type) {
    type = type || "surface";
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var free = null;
      for (var i = 0; i < pool.length; i++) { if (pool[i].idle) { free = pool[i]; break; } }
      if (free) {
        free.idle = false;
        pending[id] = { resolve: resolve, reject: reject };
        free.postMessage({ id: id, type: type, req: req });
      } else {
        queue.push({ id: id, type: type, req: req, resolve: resolve, reject: reject });
      }
    });
  }

  function putImg(ctx, w, h, px, dx, dy) {
    var img = ctx.createImageData(w, h);
    img.data.set(px);
    ctx.putImageData(img, dx, dy);
  }

  // ── Map render orchestration ──────────────────────────────────────────────
  // Mirrors the backend segen cell scheduler (job-manager.js planSurfaceCells):
  // an N×N grid of ~CELL_TILES-tile SQUARE cells over [-R,R)², dispatched
  // centre-outward (nearest cell to spawn first, row-major tie-break) so the
  // map fills from the middle like the old job pages' live grids. Cells wholly
  // outside the rendered disk are skipped (they'd paint all-transparent
  // anyway). The disk radius is the ZONE's radius (the wasm clips to it, not
  // to the preview R — previews are usually smaller than the zone). A union of
  // cells is pixel-identical to one whole call (every tile depends only on its
  // own coords), so the partition never changes the image — only the order it
  // appears in.
  var CELL_TILES = 32; // one Factorio chunk (32x32 tiles) per cell — per-cell
  //    time is then directly comparable to in-game chunk generation. NOTE: a
  //    2000-tile radius needs a 125x125 grid; the per-call wasm setup (~ms)
  //    is paid once per cell, so this trades per-cell granularity for overhead.
  //    ?cells=N overrides the cell edge (tuning/benchmarks).
  try {
    var _qc = new URLSearchParams(location.search).get("cells");
    if (_qc) CELL_TILES = Math.max(1, Math.min(512, parseInt(_qc, 10) || 32));
  } catch (e) {}
  var GRID_CAP = 512;   // allow up to a 512x512 grid at CELL_TILES=32

  // Space Exploration surfaces are finite disks, so they render as an R-disk.
  // Without SE, Nauvis is an unbounded map: fill the whole square instead.
  function squareSurface(zoneObj) {
    return !!(zoneObj && zoneObj.nauvis) && MOD !== "se" && MOD !== "k2se";
  }
  // Clip radius for the cell plan and the disk masks. A square surface uses a
  // radius beyond the square's corners, which makes every clip a no-op.
  function zoneDiskRadius(zoneObj, R) {
    return squareSurface(zoneObj) ? 2 * R : R;
  }

  function planSurfaceCells(R, diskR) {
    var n = Math.max(1, Math.min(GRID_CAP, Math.ceil((2 * R) / CELL_TILES)));
    if (n === 1) return { n: 1, cells: [{ gx: 0, gy: 0, x0: -R, y0: -R, x1: R, y1: R, d2: 0, i: 0 }] };
    var full = 2 * R;
    var cellW = Math.ceil(full / n);
    var planned = [];
    for (var i = 0; i < n * n; i++) {
      var gx = i % n;
      var gy = Math.floor(i / n);
      var x0 = -R + gx * cellW;
      var x1 = Math.min(R, x0 + cellW);
      var y0 = -R + gy * cellW;
      var y1 = Math.min(R, y0 + cellW);
      if (x1 <= x0 || y1 <= y0) continue;
      // nearest point of this cell to the origin; skip when outside the disk.
      var nx = Math.max(x0, Math.min(0, x1 - 1));
      var ny = Math.max(y0, Math.min(0, y1 - 1));
      if (nx * nx + ny * ny > diskR * diskR) continue;
      var cx = (x0 + x1) / 2;
      var cy = (y0 + y1) / 2;
      planned.push({ gx: gx, gy: gy, x0: x0, y0: y0, x1: x1, y1: y1, d2: cx * cx + cy * cy, i: i });
    }
    // centre-out: nearest cell to (0,0) first; row-major breaks ties (stable).
    planned.sort(function (a, b) { return (a.d2 - b.d2) || (a.i - b.i); });
    return { n: n, cells: planned };
  }

  // layer 0: centre-out terrain cells + one whole-rect ore pass, composited
  //          per cell as each lands.
  // layer 1: terrain cells only.
  // layer 2: whole-rect ore-only call (legacy).
  function renderSurfaceMap(zoneObj, R, layer, palette, onCell) {
    var npx = 2 * R;
    var ctx = els.canvas.getContext("2d");
    els.canvas.width = npx;
    els.canvas.height = npx;
    // layered: terrain draws go to the offscreen terrain layer, ore to the
    // ore layer, and the visible canvas is composited from both
    var L = layersBegin(npx, null);
    if (L) ctx = L.terrain.getContext("2d");
    var fullRect = { x0: -R, y0: -R, x1: R, y1: R };
    var diskR = zoneDiskRadius(zoneObj, R); // clip radius for the wasm + cell plan
    var plan = planSurfaceCells(R, diskR);
    var cells = plan.cells;
    // tuning/bench hook: cell edge, grid N and the number of planned cells
    window.__SURF_CELLS__ = { cellTiles: CELL_TILES, n: plan.n, cells: cells.length };

    var totals = {};
    return new Promise(function (resolve, reject) {
      var oreCanvas = null; // whole-rect ore pixels (layer 0) for per-cell composite
      var oreDone = false;
      var landed = [];      // cells drawn before the ore pass finished
      var done = 0;
      var failed = 0;

      function blitOreRect(cell) {
        if (!oreCanvas) return;
        var sx = cell.x0 + R;
        var sy = cell.y0 + R;
        var w = cell.x1 - cell.x0;
        var h = cell.y1 - cell.y0;
        if (L) { compositeSA(sx, sy, w, h); return; }
        // source-over: ore pixels are opaque only where patches are, so terrain
        // under the transparent pixels stays visible.
        ctx.drawImage(oreCanvas, sx, sy, w, h, sx, sy, w, h);
      }

      function oreReady() {
        oreDone = true;
        for (var i = 0; i < landed.length; i++) blitOreRect(landed[i]);
        landed = [];
      }

      // Whole-rect ore pass (single request) — queued first so a worker picks
      // it up while the pool streams terrain cells.
      var ore = layer === 1 ? Promise.resolve(null) : (function () {
        return orePass({
          seed: SEED, k2: K2, zone: zoneObj, layer: layer, radius: diskR,
          terrainless: layer === 0, palette: palette, rect: fullRect, square: squareSurface(zoneObj)
        }).then(function (r) {
          var res = r.summary.resources || {};
          Object.keys(res).forEach(function (rn) {
            totals[rn] = { amount: res[rn].amount, display: res[rn].display };
          });
          // ore fills the whole rect; clip to the disk (terrain cells already
          // disk-crop, so unmasked ore would spill onto transparent corners).
          diskClearOutside(r.pixels, r.summary.width, diskR);
          if (layer === 0) {
            oreCanvas = document.createElement("canvas");
            oreCanvas.width = r.summary.width;
            oreCanvas.height = r.summary.height;
            var octx = oreCanvas.getContext("2d");
            var img = octx.createImageData(r.summary.width, r.summary.height);
            img.data.set(r.pixels);
            octx.putImageData(img, 0, 0);
            if (L) L.ore = oreCanvas;
            oreReady();
          } else if (L) {
            putImg(L.ore.getContext("2d"), r.summary.width, r.summary.height, r.pixels, 0, 0);
            compositeSA();
          } else {
            // layer 2 ore-only view: whole-rect blit (transparent background).
            var cimg = ctx.createImageData(r.summary.width, r.summary.height);
            cimg.data.set(r.pixels);
            ctx.putImageData(cimg, 0, 0);
          }
        }).catch(function (e) {
          failed++;
          console.error("ore pass failed:", e);
        });
      })();

      function terrainCell(cell) {
        return sendToPool({
          seed: SEED, k2: K2, zone: zoneObj, layer: 1, radius: diskR, palette: palette,
          rect: { x0: cell.x0, y0: cell.y0, x1: cell.x1, y1: cell.y1 }, square: squareSurface(zoneObj)
        }).then(function (r) {
          // blit this cell (pixel data uploaded to the GPU-backed canvas).
          var img = ctx.createImageData(r.summary.width, r.summary.height);
          img.data.set(r.pixels);
          ctx.putImageData(img, cell.x0 + R, cell.y0 + R);
          if (L) compositeSA(cell.x0 + R, cell.y0 + R, cell.x1 - cell.x0, cell.y1 - cell.y0);
          if (oreDone) blitOreRect(cell);
          else landed.push(cell);
          done++;
          if (onCell) onCell(done, cells.length);
        }).catch(function (e) {
          failed++;
          console.error("cell (" + cell.gx + "," + cell.gy + ") failed:", e);
        });
      }

      function finish() {
        if (layer !== 1 && Object.keys(totals).length === 0) failed++;
        if (failed > 0) reject(new Error("render failed (" + failed + " stage(s))"));
        else resolve(totals);
      }

      if (layer === 2) {
        // no terrain to stream — blit the ore-only call when it lands.
        ore.then(finish, finish);
        return;
      }

      var jobs = [];
      for (var c = 0; c < cells.length; c++) jobs.push(terrainCell(cells[c]));
      // All terrain cells, then the ore overlay, then resolve.
      Promise.all(jobs).then(function () {
        return ore;
      }).then(finish, finish);
    });
  }

  // ── GPU-terrain helpers (default backend; ore always from CPU wasm) ──────
  // SE zones (alien biomes + asteroid fields) and Nauvis (base 21-tile
  // competition) render terrain on the GPU; Space Age planets stay on the CPU
  // wasm pipeline.
  function gpuTerrainSupported() {
    return USE_GPU && (kind === "zone" || kind === "nauvis");
  }

  // Clear pixels outside the disk radius (GPU kernels fill the whole square).
  function diskClearOutside(rgba, W, diskR) {
    var c = W >> 1, R2 = diskR * diskR;
    for (var y = 0; y < W; y++) {
      var dy = y - c;
      for (var x = 0; x < W; x++) {
        var dx = x - c;
        if (dx * dx + dy * dy > R2) rgba[(y * W + x) * 4 + 3] = 0;
      }
    }
  }

  // One ore request over a rect -> { summary: { width, height, resources },
  // pixels }. SE surfaces run it as a single whole-rect call. Base-game Nauvis
  // (req.square) uses the base game's placement, which is decided chunk by
  // chunk and costs more per tile, so the rect is split into chunk-aligned
  // cells across the pool and stitched back together - the union is identical
  // to one whole call.
  // Fluid patches (oil wells and the like) are 3x3 entities but the generator
  // reports one pixel each: grow every fluid-coloured pixel to its footprint.
  // Done on the whole stitched image so a well on a cell edge is not clipped.
  var FLUID_COLORS = [
    [199, 51, 196],  // crude oil, base game
    [255, 153, 0],   // crude oil, Space Exploration / Krastorio 2
    [89, 127, 191],  // kr-mineral-water
    [255, 127, 255]  // kr-imersite
  ];
  function growFluids(px, W, H) {
    var wells = [];
    for (var i = 0; i < px.length; i += 4) {
      if (!px[i + 3]) continue;
      for (var c = 0; c < FLUID_COLORS.length; c++) {
        var f = FLUID_COLORS[c];
        if (px[i] === f[0] && px[i + 1] === f[1] && px[i + 2] === f[2]) { wells.push(i >> 2, c); break; }
      }
    }
    for (var k = 0; k < wells.length; k += 2) {
      var wx = wells[k] % W, wy = (wells[k] - wx) / W, col = FLUID_COLORS[wells[k + 1]];
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nx = wx + dx, ny = wy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var j = (ny * W + nx) * 4;
          px[j] = col[0]; px[j + 1] = col[1]; px[j + 2] = col[2]; px[j + 3] = 255;
        }
      }
    }
  }

  function orePass(req) {
    if (!req.square) {
      return sendToPool(req).then(function (r) {
        growFluids(r.pixels, r.summary.width, r.summary.height);
        return r;
      });
    }
    var rc = req.rect, W = rc.x1 - rc.x0, H = rc.y1 - rc.y0, CELL = 256;
    var out = new Uint8Array(W * H * 4);
    var totals = {};
    var jobs = [];
    for (var y = Math.floor(rc.y0 / CELL) * CELL; y < rc.y1; y += CELL) {
      for (var x = Math.floor(rc.x0 / CELL) * CELL; x < rc.x1; x += CELL) {
        (function (c) {
          var q = {};
          Object.keys(req).forEach(function (k) { q[k] = req[k]; });
          q.rect = c;
          jobs.push(sendToPool(q).then(function (r) {
            var w = c.x1 - c.x0, h = c.y1 - c.y0;
            for (var row = 0; row < h; row++) {
              out.set(r.pixels.subarray(row * w * 4, (row + 1) * w * 4), ((c.y0 - rc.y0 + row) * W + (c.x0 - rc.x0)) * 4);
            }
            var res = r.summary.resources || {};
            Object.keys(res).forEach(function (rn) {
              if (!totals[rn]) totals[rn] = { amount: 0, tiles: 0 };
              totals[rn].amount += res[rn].amount;
              totals[rn].tiles += res[rn].tiles || 0;
            });
          }));
        })({ x0: Math.max(x, rc.x0), y0: Math.max(y, rc.y0), x1: Math.min(x + CELL, rc.x1), y1: Math.min(y + CELL, rc.y1) });
      }
    }
    return Promise.all(jobs).then(function () {
      growFluids(out, W, H);
      Object.keys(totals).forEach(function (rn) {
        var v = totals[rn].amount;
        totals[rn].display = v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : String(v);
      });
      return { summary: { width: W, height: H, resources: totals }, pixels: out };
    });
  }

  // Single whole-rect CPU ore pass, source-over onto the GPU terrain canvas.
  // Mirrors the layer-0 ore pass in renderSurfaceMap (layer 0, terrainless).
  function cpuOre(z, R, diskR, palette) {
    return orePass({
      seed: SEED, k2: K2, zone: z, layer: 0, radius: diskR, terrainless: true,
      palette: palette, rect: { x0: -R, y0: -R, x1: R, y1: R }, square: squareSurface(z)
    }).then(function (r) {
      var res = r.summary.resources || {};
      // the wasm ore pass fills the whole rect; clip it to the disk so no ore
      // leaks onto the transparent corners (terrain+ore and ore-only views).
      diskClearOutside(r.pixels, r.summary.width, diskR);
      var ov = document.createElement("canvas");
      ov.width = r.summary.width;
      ov.height = r.summary.height;
      var octx = ov.getContext("2d");
      var oi = octx.createImageData(r.summary.width, r.summary.height);
      oi.data.set(r.pixels);
      octx.putImageData(oi, 0, 0);
      if (sa && sa.ore.width === ov.width) { sa.ore = ov; compositeSA(); }
      else els.canvas.getContext("2d").drawImage(ov, 0, 0);
      var totals = {};
      Object.keys(res).forEach(function (rn) {
        totals[rn] = { amount: res[rn].amount, display: res[rn].display };
      });
      return totals;
    });
  }

  function resolveKind() {
    if (TARGET === "Nauvis") return { kind: "nauvis" };
    var lower = TARGET.toLowerCase();
    if (PLANETS[lower]) return { kind: "sa", planetKey: lower };
    if (MOD !== "se" && MOD !== "k2se") {
      return { kind: "error", msg: TARGET + " is not an SE zone of seed " + SEED + " (mod " + MOD + " has no universe generator)." };
    }
    return { kind: "zone" };
  }

  function nauvisZone() {
    return { n: "Nauvis", t: "planet", s: SEED, r: 5000, water: "none", enemy: "none", c: 1, nauvis: true };
  }

  function zoneMeta(z) {
    var bits = [];
    if (z.t) bits.push('<span class="badge zone-type">' + esc(z.t) + "</span>");
    if (z.r) bits.push("radius " + Math.round(z.r));
    if (z.water) bits.push("water " + esc(z.water));
    if (z.enemy) bits.push("enemy " + esc(z.enemy));
    if (z.p) bits.push("primary " + esc(z.p));
    return bits.join(" · ");
  }

  function radiusLimits() {
    if (kind === "sa") return { min: 16, max: 10000, step: 50, value: 2000 };
    // zone / base Nauvis: preview radius IS the disk radius (planets render an
    // R-disk even though the real map is "infinite"). Allow up to 10000 — the
    // max radius of an SE zone/planet.
    return { min: 10, max: 10000, step: 50, value: 2000 };
  }

  function adaptForKind() {
    els.badge.textContent = kind === "sa" ? "planet" : kind === "nauvis" ? "planet (base)" : "zone";
    els.layerWrap.hidden = false;
    if (els.dimWrap) els.dimWrap.hidden = false;
    var lim = radiusLimits();
    els.radius.min = lim.min; els.radius.max = lim.max; els.radius.step = lim.step; els.radius.value = lim.value;
    // ?r=N drives the radius on this page directly (disk radius; the seed page
    // rows pass the zone radius, base Nauvis presets pass an arbitrary preview).
    if (RADIUS_INIT != null) {
      els.radius.value = Math.max(lim.min, RADIUS_INIT);
    }
  }

  // ── Space Age planet layers ───────────────────────────────────────────────
  var sa = null;   // { R, terrain, ore, done } - offscreen layers of the last render
  var SA_LAYER_MAX = 5000; // px per side of each layer canvas
  var LAYERED_MAX = 6000;  // zones/Nauvis: keep layers up to this canvas size

  function fmtAmount(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
  }

  // Start a layered render for a canvas of `px` x `px`: terrain and ore are
  // kept on separate offscreen canvases so the "Terrain" slider can darken the
  // terrain under the ore without regenerating. Returns null (plain drawing,
  // slider inactive) when the canvases would be too large to keep three of.
  function layersBegin(px, key) {
    if (px > LAYERED_MAX) { sa = null; return null; }
    var mk = function () { var c = document.createElement("canvas"); c.width = px; c.height = px; return c; };
    sa = { R: key, terrain: mk(), ore: mk(), done: false };
    return sa;
  }

  // Draw the visible canvas from the two layers (optionally just one rect).
  // The "Terrain" slider darkens the terrain only where it has pixels, so a
  // disk's transparent corners stay transparent.
  function compositeSA(x, y, w, h) {
    if (!sa) return;
    var ctx = els.canvas.getContext("2d");
    if (x == null) { x = 0; y = 0; w = els.canvas.width; h = els.canvas.height; }
    var layer = parseInt(els.layer.value, 10) || 0;
    var dim = els.dim ? parseInt(els.dim.value, 10) / 100 : 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.clearRect(x, y, w, h);
    if (layer !== 2) {
      ctx.drawImage(sa.terrain, x, y, w, h, x, y, w, h);
      if (layer === 0 && dim < 1) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.globalAlpha = 1 - dim;
        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, w, h);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
    }
    if (layer !== 1) ctx.drawImage(sa.ore, x, y, w, h, x, y, w, h);
    ctx.restore();
  }

  function run() {
    if (busy) return;
    busy = true;
    els.go.disabled = true;
    setProgress(0);
    var t0 = Date.now();
    var radius = parseInt(els.radius.value, 10);
    if (!Number.isFinite(radius)) radius = 200;
    var layer = parseInt(els.layer.value, 10) || 0;
    var layerName = ["terrain + ore", "terrain only", "ore only"][layer];
    var palette = "se"; // alien-biomes ground is Space-Exploration-only
    if (kind === "nauvis" && MOD !== "se" && MOD !== "k2se") palette = "vanilla";
    var gpu = gpuTerrainSupported();
    if ((kind === "zone" || kind === "nauvis") && !pool) spawnPool();

    function doneUI() { busy = false; els.go.disabled = false; setProgress(1); }
    function fail(e, tag) { busy = false; els.go.disabled = false; status(tag + ": " + e.message); console.error(e); }

    // CPU wasm pipeline (default for ore-only layers & SA planets; also the
    // fallback whenever WebGPU terrain is unavailable or fails).
    function runCpu() {
      var needZone = kind === "zone";
      if (!pool) spawnPool();
      Promise.resolve(needZone ? fetchZone() : nauvisZone())
        .then(function (z) {
          return renderSurfaceMap(z, radius, layer, palette, function (done, total) {
            status("rendering terrain " + done + "/" + total + " cells…");
            setProgress(total ? done / total : 0);
          }).then(function (totals) {
            doneUI();
            window.__LAST_SURF__ = { zone: z.n, type: z.t, resources: totals, layer: layer }; // test hook
            window.__LAST_SURF_AT__ = Date.now();
            window.__SURF_MS__ = window.__LAST_SURF_AT__ - t0;
            var width = 2 * radius;
            var nres = Object.keys(totals).length;
            els.res.innerHTML =
              (layer !== 1 ? surfChips(totals) + " " : "") +
              '<span class="hint">· ' + width + "×" + width + " · " + layerName +
              (nres ? " · " + nres + " resources" : "") +
              " · generated client-side (" + pool.length + " workers) · " + window.__SURF_MS__ + " ms</span>";
            status("zone " + z.n + " · " + z.t + " · r" + radius + (USE_GPU ? " (CPU wasm)" : ""));
          });
        })
        .catch(function (e) { fail(e, "error"); });
    }

    // WebGPU terrain, with the CPU ore overlay when layer = terrain + ore.
    async function runGpu() {
      window.__GPU_STAGE__ = "terrain";
      var dispMax = await canvasMax();
      return Promise.resolve(kind === "zone" ? fetchZone() : nauvisZone()).then(function (z) {
        var R = radius;
        var diskR = zoneDiskRadius(z, R);
        // display canvas is capped at the probed max (usually the GPU texture
        // size); larger disks are downscaled
        var disp = Math.min(2 * R, dispMax);
        var scaleS = (2 * R) / disp;
        var downscaled = scaleS > 1;
        els.canvas.width = disp;
        els.canvas.height = disp;
        var GL = layersBegin(disp, null);
        var gpuKind, backend, label;
        // Nauvis: base-game tiles, except under Space Exploration, where the
        // ground is alien-biomes like every other SE surface
        var seNauvis = kind === "nauvis" && (MOD === "se" || MOD === "k2se");
        if (kind === "nauvis" && !seNauvis) { gpuKind = "tiles"; backend = "nauvis-tiles"; label = "nauvis tiles"; }
        else if (z.t === "asteroid-field") { gpuKind = "field-color"; backend = "se-field"; label = "asteroid field"; }
        else { gpuKind = "se-color"; backend = "se-alien-biomes"; label = "alien biomes"; }
        // field kernel seeds its billows gen with the ZONE's map seed
        var seed = gpuKind === "field-color" && z.s != null ? z.s : SEED;
        status("gpu: dispatching " + label + " kernel…");
        // Centre-out cells: each dispatch has a small readback and blits into
        // the canvas as it lands, so slower devices visibly fill the disk.
        return window.generateSurfaceProgressive({
          seed: seed, zone: z, kind: gpuKind, radius: R, diskR: diskR, cell: 512,
          onCell: function (c) {
            var ctx = (GL ? GL.terrain : els.canvas).getContext("2d");
            if (scaleS === 1) {
              var img = ctx.createImageData(c.w, c.h);
              img.data.set(c.rgba);
              ctx.putImageData(img, c.x, c.y);
            } else {
              // downscale: draw the cell through an offscreen canvas
              var cx = cellCanvas(c.w, c.h);
              var cimg = cx.createImageData(c.w, c.h);
              cimg.data.set(c.rgba);
              cx.putImageData(cimg, 0, 0);
              ctx.imageSmoothingEnabled = true;
              ctx.drawImage(cellCv, 0, 0, c.w, c.h,
                c.x / scaleS, c.y / scaleS, c.w / scaleS, c.h / scaleS);
            }
            if (GL) compositeSA(Math.floor(c.x / scaleS), Math.floor(c.y / scaleS), Math.ceil(c.w / scaleS) + 1, Math.ceil(c.h / scaleS) + 1);
            status("gpu: " + label + " " + c.done + "/" + c.total + " cells…");
            setProgress(c.total ? c.done / c.total : 0);
          }
        }).then(function (cells) {
          // The alien-biomes kernel has no starting lake (SE moons have none),
          // but Nauvis does. The lake sits within ~105 tiles of spawn, so the
          // square around spawn is redrawn from the CPU renderer, which has it.
          if (!seNauvis || scaleS !== 1) return cells;
          var h = Math.min(128, R);
          return sendToPool({
            seed: SEED, k2: K2, zone: z, layer: 1, radius: R, palette: "se",
            rect: { x0: -h, y0: -h, x1: h, y1: h }
          }).then(function (r) {
            var W = r.summary.width;
            for (var py = 0; py < W; py++) {
              for (var px = 0; px < W; px++) {
                var dx = px - h, dy = py - h;
                if (dx * dx + dy * dy > diskR * diskR) r.pixels[(py * W + px) * 4 + 3] = 0;
              }
            }
            putImg((GL ? GL.terrain : els.canvas).getContext("2d"), W, r.summary.height, r.pixels, R - h, R - h);
            if (GL) compositeSA(R - h, R - h, 2 * h, 2 * h);
            return cells;
          }, function (e) { console.error("lake patch failed:", e); return cells; });
        }).then(function (cells) {
          var out = { cells: cells, backend: backend, width: disp, height: disp, scale: scaleS, downscaled: downscaled };
          if (downscaled && layer === 0) {
            // ore overlay is not practical at >DISPLAY_MAX-res disks yet
            window.__GPU_STAGE__ = "done";
            return { out: out, z: z, totals: {} };
          }
          if (layer === 0) {
            window.__GPU_STAGE__ = "ore";
            status("gpu terrain ready — placing ore (CPU wasm)…");
            return cpuOre(z, R, diskR, palette).then(function (totals) {
              window.__GPU_STAGE__ = "done";
              return { out: out, z: z, totals: totals };
            });
          }
          window.__GPU_STAGE__ = "done";
          return { out: out, z: z, totals: {} };
        });
      });
    }

    if (kind === "sa") {
      // Space Age planet: tiles + resources straight from the game's own
      // map-gen data (sa.wasm compiles the planet once per worker). Each cell
      // comes back as TWO layers - terrain and a transparent resource overlay
      // - kept on separate offscreen canvases so the page can dim the terrain
      // under the resources without regenerating.
      var p = PLANETS[planetKey];
      var R = radius;
      if (sa && sa.R === R && sa.done) { compositeSA(); doneUI(); return; }
      if (!pool) spawnPool();
      // three canvases (two layers + the visible one) are kept, so the layer
      // size is capped; larger disks draw their cells downscaled
      var disp = Math.min(2 * R, SA_LAYER_MAX);
      var scale = (2 * R) / disp;
      els.canvas.width = disp;
      els.canvas.height = disp;
      var mk = function () { var c = document.createElement("canvas"); c.width = disp; c.height = disp; return c; };
      sa = { R: R, terrain: mk(), ore: mk(), done: false };
      var blit = function (ctx, w, h, px, tx, ty) {
        if (scale === 1) { putImg(ctx, w, h, px, tx, ty); return; }
        var cx = cellCanvas(w, h);
        var cimg = cx.createImageData(w, h);
        cimg.data.set(px);
        cx.putImageData(cimg, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(cellCv, 0, 0, w, h, tx / scale, ty / scale, w / scale, h / scale);
      };
      var run_ = sa;
      var tctx = sa.terrain.getContext("2d");
      var octx = sa.ore.getContext("2d");
      // cells on the 128-tile grid (whole chunks), clipped to [-R,R)
      var CELL = R > 1500 ? 256 : 128;
      var cells = [];
      for (var yc = Math.floor(-R / CELL) * CELL; yc < R; yc += CELL) {
        for (var xc = Math.floor(-R / CELL) * CELL; xc < R; xc += CELL) {
          var cx0 = Math.max(xc, -R), cy0 = Math.max(yc, -R);
          cells.push({ x0: cx0, y0: cy0, w: Math.min(xc + CELL, R) - cx0, h: Math.min(yc + CELL, R) - cy0 });
        }
      }
      var mid = function (c) { var mx = c.x0 + c.w / 2, my = c.y0 + c.h / 2; return mx * mx + my * my; };
      cells.sort(function (a, b) { return mid(a) - mid(b); });
      status(p.label + ": rendering " + cells.length + " cells…");
      var doneCells = 0;
      var counts = {};   // tile name -> { color, count }
      var ores = {};     // resource name -> { color, count, amount }
      var failed = false;
      cells.forEach(function (c) {
        sendToPool({ seed: SEED, planet: planetKey, property: "all", x0: c.x0, y0: c.y0, width: c.w, height: c.h }, "sa")
          .then(function (r) {
            if (failed || sa !== run_) return;
            var n = r.summary.width * r.summary.height * 4;
            blit(tctx, r.summary.width, r.summary.height, r.pixels.subarray(0, n), c.x0 + R, c.y0 + R);
            blit(octx, r.summary.width, r.summary.height, r.pixels.subarray(n, 2 * n), c.x0 + R, c.y0 + R);
            (r.summary.tiles || []).forEach(function (t) {
              if (!counts[t.name]) counts[t.name] = { color: t.color, count: 0 };
              counts[t.name].count += t.count;
            });
            (r.summary.resources || []).forEach(function (t) {
              if (!ores[t.name]) ores[t.name] = { color: t.color, count: 0, amount: 0 };
              ores[t.name].count += t.count;
              ores[t.name].amount += t.amount;
            });
            compositeSA(Math.floor((c.x0 + R) / scale), Math.floor((c.y0 + R) / scale), Math.ceil(c.w / scale) + 1, Math.ceil(c.h / scale) + 1);
            doneCells++;
            setProgress(doneCells / cells.length);
            if (doneCells < cells.length) {
              status(p.label + " " + doneCells + "/" + cells.length + " cells…");
              return;
            }
            sa.done = true;
            doneUI();
            window.__SURF_MS__ = Date.now() - t0;
            window.__LAST_SURF__ = { zone: p.label, type: "planet", resources: ores, layer: layer, gpu: false, tiles: counts };
            var swatch = function (col) {
              return '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;' +
                "border:1px solid #888;background:rgb(" + col.join(",") + ')"></span>';
            };
            var oreChips = Object.keys(ores).map(function (n) {
              var t = ores[n];
              return '<span class="res-chip surf" title="' + t.count + " entities · total amount " + t.amount.toLocaleString() + '">' +
                swatch(t.color) + esc(n) + " <strong>" + fmtAmount(t.amount) + "</strong> <span class=\"hint\">×" + t.count + "</span></span>";
            }).join(" ");
            els.res.innerHTML = oreChips + ' <span class="hint">· ' + (2 * R) + "×" + (2 * R) + " tiles" +
              (scale > 1 ? " (shown ×1/" + scale.toFixed(1) + ")" : "") + " · " + pool.length + " workers · " + window.__SURF_MS__ + " ms</span>";
            status(p.label + " · r" + radius + " · tiles + resources");
          })
          .catch(function (e) {
            if (failed) return;
            failed = true;
            sa = null;
            fail(e, "error");
          });
      });
      return;
    }

    // SE zone / Nauvis: WebGPU terrain by default; CPU wasm for ore-only
    // layers and any ground WebGPU can't produce.
    if (layer === 2 || !gpu) { runCpu(); return; }

    runGpu().then(function (res) {
      var out = res.out;
      var z = res.z;
      var totals = res.totals;
      doneUI();
      var ms = Date.now() - t0;
      GPU_MS = ms;
      window.__SURF_MS__ = ms;
      window.__LAST_SURF_AT__ = Date.now();
      window.__LAST_SURF__ = { zone: z.n, type: z.t, resources: totals, layer: layer, gpu: true, ore: layer === 0 ? "cpu" : null };
      var px = out.width * out.height;
      var modeTxt = layer === 0 && !out.downscaled ? "WebGPU terrain + CPU ore" : "WebGPU " + (out.backend || "kernel");
      els.res.innerHTML =
        (layer === 0 && !out.downscaled && surfChips(totals) ? surfChips(totals) + " " : "") +
        '<span class="hint">· ' + out.width + "×" + out.height + (out.downscaled ? " (downscaled ×" + out.scale.toFixed(1) + ", ore overlay above usable canvas size not yet)" : "") + " · " + modeTxt + " (" +
        out.cells + (out.cells === 1 ? " cell dispatch" : " cell dispatches") + ") · " + ms + " ms · " +
        (px / ms / 1000).toFixed(2) + " Mpx/s</span>";
      status("zone " + z.n + " · " + z.t + " · r" + radius + (layer === 0 && !out.downscaled ? " (WebGPU terrain + CPU ore)" : " (WebGPU" + (out.downscaled ? ", downscaled preview)" : ")")));
    }, function (e) {
      // WebGPU unavailable / failure -> CPU wasm pipeline for the same request.
      console.error("WebGPU terrain failed, falling back to wasm:", e);
      window.__GPU_FAIL__ = String((e && e.message) || e);
      status("WebGPU error (" + window.__GPU_FAIL__ + ") — falling back to CPU wasm…");
      runCpu();
    });
  }

  function fetchZone() {
    if (universe) return Promise.resolve(findZone());
    return window.generateUniverse(SEED, K2).then(function (uni) {
      universe = uni;
      return findZone();
    });
  }
  function findZone() {
    var found = null;
    for (var i = 0; i < universe.z.length; i++) {
      if (universe.z[i].n === TARGET) { found = universe.z[i]; break; }
    }
    if (!found) throw new Error("zone “" + TARGET + "” not found in seed " + SEED + "’s universe (mod " + MOD + ").");
    return found;
  }

  function init() {
    // the shell is a static file: fill in the names it cannot know
    var nameEl = document.getElementById("sf-name");
    if (nameEl) nameEl.textContent = TARGET;
    var crumbName = document.getElementById("sf-crumb-name");
    if (crumbName) crumbName.textContent = TARGET;
    var crumbSeed = document.getElementById("sf-crumb-seed");
    if (crumbSeed) {
      crumbSeed.href = window.Shell.seedHref(SEED, MOD);
      if (SEED != null) crumbSeed.textContent = "🌍 Seed " + SEED;
    }
    if (SEED != null && TARGET) document.title = "Seed " + SEED + " · " + TARGET + " — Surface Explorer";
    if (SEED == null || !TARGET) {
      status("missing seed or surface name in URL");
      return;
    }
    var r = resolveKind();
    if (r.kind === "error") { status(r.msg); return; }
    kind = r.kind;
    if (kind === "sa") planetKey = r.planetKey;
    els.badge.textContent = "…";
    // ?layer=N optionally preselects the layer (terrain+ore 0 / terrain 1 / ore 2)
    try {
      var _ly = new URLSearchParams(location.search).get("layer");
      if (_ly != null && ["0", "1", "2"].indexOf(_ly) !== -1) els.layer.value = _ly;
    } catch (e2) {}
    adaptForKind();
    els.go.addEventListener("click", run);
    els.radius.addEventListener("change", run);
    els.layer.addEventListener("change", run);
    if (els.dim) els.dim.addEventListener("input", function () { compositeSA(); });
    if (kind === "sa") {
      var p = PLANETS[planetKey];
      els.meta.innerHTML = p.label + ' <span class="hint">· seed ' + SEED + " · Space Age planet tiles, generated from the game's map-gen data (sa.wasm).</span>";
      els.badge.textContent = "planet";
    } else if (kind === "nauvis") {
      var vanilla = MOD !== "se" && MOD !== "k2se";
      els.meta.innerHTML = "🌍 Nauvis <span class=\"hint\">· seed " + SEED + " · game-default map settings" +
        (vanilla
          ? ", base-game Nauvis tiles (real 2.0 tile palette; tile selection approximated until expression_in_range is ported)."
          : ", SE ground (alien-biomes, exact).") + "</span>";
    } else {
      els.meta.innerHTML = "SE zone of seed " + SEED + " <span class=\"hint\">· resolving universe…</span>";
      fetchZone().then(function (z) {
        zone = z;
        els.meta.innerHTML = zoneMeta(z) + ' <span class="hint">· seed ' + SEED + ", mod " + esc(MOD) + ".</span>";
      }).catch(function (e) {
        status(e.message);
        console.error(e);
      });
    }
    run();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
