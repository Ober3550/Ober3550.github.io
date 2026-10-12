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
// bit-identical to one whole call). Ore is chunked too, in larger cells: a
// union of chunk-aligned "terrainless" ore calls is identical to one
// whole-rect call, pixel for pixel and amount for amount (checked on zones,
// asteroid fields and Nauvis), so the ore streams in cell by cell on its own
// layer next to the terrain and the resource totals are summed over the
// cells. There's no backend process to reuse in a browser tab — surface.wasm IS
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
        // ?maxcanvas=N pretends the device stops at N (testing the downscaled
        // path a phone takes on a desktop)
        var forced = parseInt(new URLSearchParams(location.search).get("maxcanvas"), 10);
        if (forced > 0) { DISP_MAX = forced; return forced; }
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
    // The surface is drawn once, at the radius in the address (?r=, which the
    // seed page sets to the zone's radius): there is no radius box and no
    // Generate button, so these two only hold state.
    radius: { value: "2000" },
    // The page always draws terrain + ore (0). There is no selector for it;
    // ?layer=1 (terrain only) / ?layer=2 (ore only) remain for testing.
    layer: { value: "0" },
    dimWrap: document.getElementById("sf-dim-wrap"),
    dim: document.getElementById("sf-dim"),
    go: { disabled: false },
    dimVal: document.getElementById("sf-dim-val"),
    status: document.getElementById("sf-status"),
    canvas: document.getElementById("sf-canvas"),
    // The result line is written as "<resource chips> <hint>· size · timing…";
    // the hint goes on a line of its own under the chips (no leading dot).
    res: (function (el) {
      return { set innerHTML(html) { el.innerHTML = html.replace('<span class="hint">· ', '<span class="hint res-info">'); } };
    })(document.getElementById("sf-res")),
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
      return '<span class="res-chip ore ore-' + nm(r) + '" title="exact — generated in your browser">' + nm(r) + " <strong>" + totals[r].display + "</strong></span>";
    }).join(" ");
  }

  // ── Worker pool ───────────────────────────────────────────────────────────
  var pool = null;
  var pending = {};   // id -> { resolve, reject }
  var queue = [];     // [{ id, type, req, resolve, reject }]
  // Ore cells wait in a lane of their own and take at most half the workers
  // while terrain cells are waiting, so neither starves the other; whichever
  // lane is empty gives its workers to the other.
  var oreQueue = [];
  var oreBusy = 0;
  var nextId = 1;

  function nextJob() {
    var oreCap = Math.max(1, pool.length >> 1);
    if (oreQueue.length && (!queue.length || oreBusy < oreCap)) return oreQueue.shift();
    if (queue.length) return queue.shift();
    return null;
  }
  function startJob(worker, j) {
    worker.idle = false;
    worker.ore = j.lane === "ore";
    if (worker.ore) oreBusy++;
    pending[j.id] = { resolve: j.resolve, reject: j.reject };
    worker.postMessage({ id: j.id, type: j.type, req: j.req });
  }

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
          if (worker.ore) { worker.ore = false; oreBusy--; }
          if (m.ok) p.resolve({ summary: m.summary, pixels: m.pixels });
          else p.reject(new Error(m.error || "surface call failed"));
          var j = nextJob();
          if (j) startJob(worker, j);
          else worker.idle = true;
        };
      })(w);
      pool.push(w);
    }
  }

  function sendToPool(req, type, lane) {
    type = type || "surface";
    return new Promise(function (resolve, reject) {
      (lane === "ore" ? oreQueue : queue).push({ id: nextId++, type: type, req: req, lane: lane, resolve: resolve, reject: reject });
      for (var i = 0; i < pool.length; i++) {
        if (!pool[i].idle) continue;
        var j = nextJob();
        if (!j) break;
        startJob(pool[i], j);
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

  // layer 0: centre-out terrain cells + centre-out ore cells, each drawn as it
  //          lands.
  // layer 1: terrain cells only.
  // layer 2: ore cells only.
  function renderSurfaceMap(zoneObj, R, layer, palette, onCell) {
    var npx = 2 * R;
    var ctx = els.canvas.getContext("2d");
    els.canvas.width = npx;
    els.canvas.height = npx;
    // terrain goes on the page's canvas, ore on a canvas laid over it
    oreOverlayClear();
    var diskR = zoneDiskRadius(zoneObj, R); // clip radius for the wasm + cell plan
    var plan = planSurfaceCells(R, diskR);
    var cells = plan.cells;
    // tuning/bench hook: cell edge, grid N and the number of planned cells
    window.__SURF_CELLS__ = { cellTiles: CELL_TILES, n: plan.n, cells: cells.length };

    var totals = {};
    return new Promise(function (resolve, reject) {
      var oreCv = layer === 1 ? null : oreOverlay(npx);
      var done = 0;
      var failed = 0;

      var ore = !oreCv ? Promise.resolve(null) : streamOre(zoneObj, R, diskR, palette, oreCv, function (n, total) {
        // the terrain's progress is shown until it is done, then the ore's
        if (layer === 2 || done === cells.length) {
          status("placing ore " + n + "/" + total + " cells…");
          setProgress(total ? n / total : 0);
        }
      }).then(function (t) { totals = t; }, function (e) {
        failed++;
        console.error("ore pass failed:", e);
      });

      function terrainCell(cell) {
        return sendToPool({
          seed: SEED, k2: K2, zone: zoneObj, layer: 1, radius: diskR, palette: palette,
          rect: { x0: cell.x0, y0: cell.y0, x1: cell.x1, y1: cell.y1 }, square: squareSurface(zoneObj)
        }).then(function (r) {
          // blit this cell (pixel data uploaded to the GPU-backed canvas).
          var img = ctx.createImageData(r.summary.width, r.summary.height);
          img.data.set(r.pixels);
          ctx.putImageData(img, cell.x0 + R, cell.y0 + R);
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
        // no terrain to stream
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

  // Fluid patches (oil wells and the like) are 3x3 entities but the generator
  // reports one pixel each; they are drawn grown to their footprint.
  var FLUID_COLORS = [
    [199, 51, 196],  // crude oil, base game
    [255, 153, 0],   // crude oil, Space Exploration / Krastorio 2
    [89, 127, 191],  // kr-mineral-water
    [255, 127, 255]  // kr-imersite
  ];
  function newCanvas(px) {
    var c = document.createElement("canvas");
    c.width = px; c.height = px;
    return c;
  }

  // Ore for the square [-R,R)^2, one request per chunk-aligned cell: spread
  // over the worker pool nearest-to-spawn first and drawn onto `oreCv`
  // (transparent where there is no ore) as each cell lands. `oreCv` is 2R px a
  // side, or smaller when the surface is shown downscaled (a phone's canvas
  // limit): cells are then drawn scaled down to it. `onProgress(done, total)`
  // is called after each cell. Resolves to { name: { amount, display } }.
  var ORE_CELL = 256;
  function streamOre(z, R, diskR, palette, oreCv, onProgress) {
    var octx = oreCv.getContext("2d");
    var scale = (2 * R) / oreCv.width; // tiles per canvas pixel
    octx.imageSmoothingEnabled = true;
    var R2 = diskR * diskR;
    var cells = [];
    for (var y = Math.floor(-R / ORE_CELL) * ORE_CELL; y < R; y += ORE_CELL) {
      for (var x = Math.floor(-R / ORE_CELL) * ORE_CELL; x < R; x += ORE_CELL) {
        var c = { x0: Math.max(x, -R), y0: Math.max(y, -R), x1: Math.min(x + ORE_CELL, R), y1: Math.min(y + ORE_CELL, R) };
        // (cells wholly off the disk draw nothing but still count: the totals
        // are for the whole square, as they always were)
        c.d2 = Math.pow((c.x0 + c.x1) / 2, 2) + Math.pow((c.y0 + c.y1) / 2, 2);
        cells.push(c);
      }
    }
    cells.sort(function (a, b) { return a.d2 - b.d2; });

    var totals = {};
    var wells = [];   // [tile x, tile y, FLUID_COLORS index, ...]
    var done = 0;
    // a well's 3x3 footprint, clipped to the disk and the canvas
    function drawWell(wx, wy, ci) {
      octx.fillStyle = "rgb(" + FLUID_COLORS[ci].join(",") + ")";
      if (scale !== 1) {
        // downscaled: one square, kept at least 2 px so a well stays visible
        if (wx * wx + wy * wy > R2) return;
        var side = Math.max(2, 3 / scale);
        octx.fillRect((wx + 0.5 + R) / scale - side / 2, (wy + 0.5 + R) / scale - side / 2, side, side);
        return;
      }
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var tx = wx + dx, ty = wy + dy;
          if (tx < -R || ty < -R || tx >= R || ty >= R || tx * tx + ty * ty > R2) continue;
          octx.fillRect(tx + R, ty + R, 1, 1);
        }
      }
    }
    var jobs = cells.map(function (c) {
      return sendToPool({
        seed: SEED, k2: K2, zone: z, layer: 0, radius: diskR, terrainless: true,
        palette: palette, rect: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, square: squareSurface(z)
      }, "surface", "ore").then(function (r) {
        var w = c.x1 - c.x0, h = c.y1 - c.y0, px = r.pixels, mine = [];
        for (var row = 0; row < h; row++) {
          var ty = c.y0 + row;
          for (var col = 0; col < w; col++) {
            var i = (row * w + col) * 4;
            if (!px[i + 3]) continue;
            var tx = c.x0 + col;
            for (var f = 0; f < FLUID_COLORS.length; f++) {
              var fc = FLUID_COLORS[f];
              if (px[i] === fc[0] && px[i + 1] === fc[1] && px[i + 2] === fc[2]) { mine.push(tx, ty, f); break; }
            }
            // the generator fills the whole rect: keep the disk only
            if (tx * tx + ty * ty > R2) px[i + 3] = 0;
          }
        }
        // through a scratch canvas, so the transparent pixels of this cell do
        // not erase a neighbouring cell's wells that reach into it
        var cx = cellCanvas(w, h);
        var img = cx.createImageData(w, h);
        img.data.set(px);
        cx.putImageData(img, 0, 0);
        octx.drawImage(cellCv, 0, 0, w, h, (c.x0 + R) / scale, (c.y0 + R) / scale, w / scale, h / scale);
        for (var k = 0; k < mine.length; k += 3) { drawWell(mine[k], mine[k + 1], mine[k + 2]); wells.push(mine[k], mine[k + 1], mine[k + 2]); }
        var res = r.summary.resources || {};
        Object.keys(res).forEach(function (rn) {
          if (!totals[rn]) totals[rn] = { amount: 0 };
          totals[rn].amount += res[rn].amount;
        });
        done++;
        if (onProgress) onProgress(done, cells.length);
      });
    });
    return Promise.all(jobs).then(function () {
      // wells go over ore, whichever cell landed first
      for (var k = 0; k < wells.length; k += 3) drawWell(wells[k], wells[k + 1], wells[k + 2]);
      Object.keys(totals).forEach(function (rn) {
        var v = totals[rn].amount;
        totals[rn].display = v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : String(v);
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

  // The zone's line of the card, as the seed page's table shows it: radius,
  // Δv from Nauvis, water, enemies and the primary resource in its colour.
  function zoneMeta(z) {
    var item = function (k, v) { return '<span><span class="k">' + k + "</span> " + v + "</span>"; };
    var dv = z.dv == null || isNaN(z.dv) ? null : z.dv >= 1e6 ? (z.dv / 1e6).toFixed(2) + "M" : z.dv >= 1000 ? (z.dv / 1000).toFixed(1) + "k" : String(z.dv);
    var bits = [];
    if (z.r) bits.push(item("r", Math.round(z.r)));
    if (dv != null) bits.push(item("Δv", '<span class="num">' + dv + "</span>"));
    bits.push(item("water", esc(z.water || "none")));
    bits.push(item("enemy", esc((z.enemy || "none").replace("very_", "v"))));
    if (z.p) bits.push(item("primary", '<span class="ore ore-' + esc(nm(z.p)) + '">' + esc(nm(z.p)) + "</span>"));
    return bits.join("");
  }

  function radiusLimits() {
    if (kind === "sa") return { min: 16, max: 10000, step: 50, value: 2000 };
    // zone / base Nauvis: preview radius IS the disk radius (planets render an
    // R-disk even though the real map is "infinite"). Allow up to 10000 — the
    // max radius of an SE zone/planet.
    return { min: 10, max: 10000, step: 50, value: 2000 };
  }

  function adaptForKind() {
    els.badge.textContent = kind === "zone" ? "…" : "planet";
    if (els.dimWrap) els.dimWrap.hidden = false;
    var lim = radiusLimits();
    els.radius.min = lim.min; els.radius.max = lim.max; els.radius.step = lim.step; els.radius.value = lim.value;
    // ?r=N drives the radius on this page directly (disk radius; the seed page
    // rows pass the zone radius, base Nauvis presets pass an arbitrary preview).
    if (RADIUS_INIT != null) {
      els.radius.value = Math.max(lim.min, RADIUS_INIT);
    }
  }

  // ── Terrain and ore as two canvases ───────────────────────────────────────
  // The page's canvas holds the terrain and a second canvas, laid over it in
  // the page, holds the ore (transparent elsewhere). Nothing is composited, so
  // only those two images are kept in memory, and the "Terrain Brightness"
  // slider darkens the terrain with a CSS filter instead of a redraw.
  var sa = null;   // { R, done } - the Space Age render in progress / on screen
  var SA_LAYER_MAX = 5000; // Space Age planets: px per side of each canvas

  function fmtAmount(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
  }

  var oreOverlayEl = null;
  function oreOverlayClear() {
    if (oreOverlayEl) { oreOverlayEl.remove(); oreOverlayEl = null; }
    els.canvas.style.filter = "";
  }
  // A fresh ore canvas of `px` x `px`, placed exactly over the terrain canvas.
  function oreOverlay(px) {
    oreOverlayClear();
    var c = newCanvas(px);
    var box = els.canvas.parentNode;
    box.style.position = "relative";
    // sized by the same rules as the canvas under it (#sf-canvas in style.css)
    c.style.cssText = "position:absolute;pointer-events:none;width:100%;max-width:720px;height:auto;image-rendering:pixelated;" +
      "left:" + els.canvas.offsetLeft + "px;top:" + els.canvas.offsetTop + "px";
    box.appendChild(c);
    oreOverlayEl = c;
    applyDim();
    return c;
  }
  // Terrain brightness from the slider. (Only under ore: a terrain-only view
  // stays at full brightness.)
  function applyDim() {
    var dim = els.dim ? parseInt(els.dim.value, 10) / 100 : 1;
    els.canvas.style.filter = oreOverlayEl && dim < 1 ? "brightness(" + dim + ")" : "";
  }
  var compositeSA = applyDim; // the slider's handler calls it by this older name

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

    // finished: the progress text goes; the card and the line under the map
    // already say what was generated
    // (the workers are released a tick later: the result line written right
    // after this still reports how many there were)
    function doneUI() { busy = false; els.go.disabled = false; setProgress(1); status(""); setTimeout(releasePool, 0); }
    // There is no Generate button to press again, so a failure offers a
    // reload: that restarts the workers and refetches the page's files (the
    // usual cause is a file that could not be loaded).
    function fail(e, tag) {
      busy = false; els.go.disabled = false; status(tag + ": " + e.message + " "); console.error(e);
      var retry = document.createElement("button");
      retry.type = "button"; retry.className = "btn-sm"; retry.textContent = "Reload and retry";
      retry.addEventListener("click", function () { location.reload(); });
      els.status.appendChild(retry);
    }

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
        oreOverlayClear();
        // Ore runs on the CPU workers while the GPU does the terrain; on a
        // downscaled surface it is drawn scaled down like the terrain.
        var oreCv = layer === 0 ? oreOverlay(disp) : null;
        var terrainDone = false;
        var oreP = !oreCv ? null : streamOre(z, R, diskR, palette, oreCv, function (n, total) {
          if (!terrainDone) return; // the terrain's progress is shown first
          status("placing ore (CPU wasm) " + n + "/" + total + " cells…");
          setProgress(total ? n / total : 0);
        });
        if (oreP) oreP.catch(function () {}); // reported where it is awaited below
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
            var ctx = els.canvas.getContext("2d");
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
            putImg(els.canvas.getContext("2d"), W, r.summary.height, r.pixels, R - h, R - h);
            return cells;
          }, function (e) { console.error("lake patch failed:", e); return cells; });
        }).then(function (cells) {
          var out = { cells: cells, backend: backend, width: disp, height: disp, scale: scaleS, downscaled: downscaled };
          if (oreP) {
            window.__GPU_STAGE__ = "ore";
            terrainDone = true;
            status("gpu terrain ready — placing ore (CPU wasm)…");
            return oreP.then(function (totals) {
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
      // - drawn on the page's canvas and on the ore canvas over it.
      var p = PLANETS[planetKey];
      var R = radius;
      if (sa && sa.R === R && sa.done) { applyDim(); doneUI(); return; }
      if (!pool) spawnPool();
      // the canvas size is capped; larger disks draw their cells downscaled
      var disp = Math.min(2 * R, SA_LAYER_MAX);
      var scale = (2 * R) / disp;
      els.canvas.width = disp;
      els.canvas.height = disp;
      sa = { R: R, done: false };
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
      var tctx = els.canvas.getContext("2d");
      var octx = oreOverlay(disp).getContext("2d");
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
      var modeTxt = layer === 0 ? "WebGPU terrain + CPU ore" : "WebGPU " + (out.backend || "kernel");
      els.res.innerHTML =
        (layer === 0 && surfChips(totals) ? surfChips(totals) + " " : "") +
        '<span class="hint">· ' + out.width + "×" + out.height + (out.downscaled ? " (shown at 1/" + out.scale.toFixed(1) + " size: this device's canvas limit)" : "") + " · " + modeTxt + " (" +
        out.cells + (out.cells === 1 ? " cell dispatch" : " cell dispatches") + ") · " + ms + " ms · " +
        (px / ms / 1000).toFixed(2) + " Mpx/s</span>";
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

  // Stop the workers once the surface is drawn, and when the page is left.
  // A browser allows only about a hundred live wasm instances per site
  // process; workers that linger across a few reloads or tabs use that up, and
  // the next page then fails with "Cannot allocate Wasm memory".
  function releasePool() {
    if (!pool) return;
    for (var i = 0; i < pool.length; i++) pool[i].terminate();
    pool = null;
  }
  window.addEventListener("pagehide", releasePool);

  function init() {
    // the shell is a static file: fill in the names it cannot know
    var nameEl = document.getElementById("sf-name");
    if (nameEl) nameEl.textContent = TARGET;
    var crumbSeed = document.getElementById("sf-crumb-seed");
    if (crumbSeed) {
      crumbSeed.href = window.Shell.seedHref(SEED, MOD);
      if (SEED != null) crumbSeed.textContent = "Seed: " + SEED;
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
    if (els.dim) els.dim.addEventListener("input", function () {
      if (els.dimVal) els.dimVal.textContent = els.dim.value + "%";
      compositeSA();
    });
    if (kind === "sa") {
      var p = PLANETS[planetKey];
      els.meta.innerHTML = '<span class="hint">Space Age planet tiles, generated from the game\'s map-gen data (sa.wasm).</span>';
      els.badge.textContent = "planet";
    } else if (kind === "nauvis") {
      var vanilla = MOD !== "se" && MOD !== "k2se";
      els.meta.innerHTML = "<span class=\"hint\">game-default map settings" +
        (vanilla
          ? ", base-game Nauvis tiles (real 2.0 tile palette; tile selection approximated until expression_in_range is ported)."
          : ", SE ground (alien-biomes, exact).") + "</span>";
    } else {
      els.meta.innerHTML = '<span class="hint">resolving universe…</span>';
      fetchZone().then(function (z) {
        zone = z;
        els.badge.textContent = z.t;
        els.meta.innerHTML = zoneMeta(z);
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
