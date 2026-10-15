// Dedicated surface-generation page (surface.html?seed=&target=&mod=). Renders ONE surface
// full-page. SE zones / Nauvis use surface.wasm; SA planets use sa.wasm.
//
// Why chunking: every pass is split into the same square cells (256 tiles a
// side, see cellPlan), dispatched CENTRE-OUTWARD (nearest cell to spawn first)
// so the landing area appears first and the map grows outward. Terrain comes
// from the GPU (or a pool of gen workers, one wasm instance each); as each
// cell's terrain is drawn, its ore and entities go to the workers, so the
// layers fill in together cell by cell. A union of cells is identical to one
// whole-rect call for every pass (checked on zones, asteroid fields and
// Nauvis), and the resource totals are summed over the cells. There's no
// backend process to reuse in a browser tab — surface.wasm IS the segen code
// compiled to WASM, and the worker pool replaces the backend's job queue.
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
            // (not exactly 255: Brave's fingerprinting protection nudges
            // what a page reads back from a canvas; a canvas past the limit
            // reads back nothing at all)
            return px[0] > 200 && px[1] < 60 && px[3] > 200;
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
    // The radius drawn (state) and its box: fixed on a Space Exploration
    // surface, which has a radius of its own; editable with a Generate button
    // on base-game Nauvis and the Space Age planets, which have no edge.
    radius: { value: "2000" },
    radiusRow: document.getElementById("sf-radius-row"),
    radiusIn: document.getElementById("sf-radius"),
    goBtn: document.getElementById("sf-go"),
    // The page always draws terrain + ore (0). There is no selector for it;
    // ?layer=1 (terrain only) / ?layer=2 (ore only) remain for testing.
    layer: { value: "0" },
    dimWrap: document.getElementById("sf-dim-wrap"),
    download: document.getElementById("sf-download"),
    dim: document.getElementById("sf-dim"),
    go: { disabled: false },
    dimVal: document.getElementById("sf-dim-val"),
    enemyWrap: document.getElementById("sf-enemy-wrap"),
    enemy: document.getElementById("sf-enemy"),
    areas: document.getElementById("sf-areas"),
    groups: document.getElementById("sf-groups"),
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

  // the surface type pill, coloured by kind as on the seed page
  function setBadge(t) {
    els.badge.textContent = t;
    els.badge.className = "badge zone-type" + (/^[a-z-]+$/.test(t) ? " zt-" + t : "");
  }
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
  var pending = {};   // id -> { resolve, reject, lane }
  var queue = [];     // [{ id, type, req, resolve, reject }]
  // Ore cells wait in a lane of their own and take at most half the job
  // slots while terrain cells are waiting, so neither starves the other;
  // whichever lane is empty gives its slots to the other.
  var oreQueue = [];
  var oreBusy = 0;
  // Jobs a worker holds at once: the next one is already with it when it
  // finishes one, so it does not sit idle while its reply travels to the
  // page and the page sends the next (~9 ms a job, a tenth of an SE Nauvis
  // render with one at a time).
  var DEPTH = 2;

  var nextId = 1;

  function nextJob() {
    var oreCap = Math.max(1, (pool.length * DEPTH) >> 1);
    if (oreQueue.length && (!queue.length || oreBusy < oreCap)) return oreQueue.shift();
    if (queue.length) return queue.shift();
    return null;
  }
  function startJob(worker, j) {
    worker.jobs++;
    if (j.lane === "ore") oreBusy++;
    pending[j.id] = { resolve: j.resolve, reject: j.reject, lane: j.lane };
    if (j.tiles) worker.postMessage({ id: j.id, type: j.type, req: j.req, tiles: j.tiles }, [j.tiles.buffer]);
    else worker.postMessage({ id: j.id, type: j.type, req: j.req });
  }
  // hand out waiting jobs, the least busy worker first
  function fill() {
    for (;;) {
      var best = null;
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].jobs < DEPTH && (!best || pool[i].jobs < best.jobs)) best = pool[i];
      }
      if (!best) return;
      var j = nextJob();
      if (!j) return;
      startJob(best, j);
    }
  }

  function spawnPool() {
    pool = [];
    var n = 2;
    // one worker per logical core (safety-capped at 16 for very large hosts).
    try { n = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16)); } catch (e) {}
    for (var i = 0; i < n; i++) {
      var w = new Worker(window.Shell.asset("gen-worker.js"));
      w.jobs = 0;
      (function (worker) {
        worker.onmessage = function (ev) {
          var m = ev.data;
          var p = pending[m.id];
          if (!p) return;
          delete pending[m.id];
          worker.jobs--;
          if (p.lane === "ore") oreBusy--;
          // (the next job goes out before this one's result is drawn)
          fill();
          if (m.ok) p.resolve({ summary: m.summary, pixels: m.pixels });
          else p.reject(new Error(m.error || "surface call failed"));
        };
      })(w);
      pool.push(w);
    }
  }

  // `tiles`: optional bytes handed to the worker with the request
  function sendToPool(req, type, lane, tiles) {
    type = type || "surface";
    return new Promise(function (resolve, reject) {
      (lane === "ore" ? oreQueue : queue).push({ id: nextId++, type: type, req: req, lane: lane, tiles: tiles, resolve: resolve, reject: reject });
      fill();
    });
  }

  function putImg(ctx, w, h, px, dx, dy) {
    var img = ctx.createImageData(w, h);
    img.data.set(px);
    ctx.putImageData(img, dx, dy);
  }

  // ── Cells ─────────────────────────────────────────────────────────────────
  // Every pass works on the same cells: a grid of 256-tile squares (?cells=N)
  // laid so the first cell is centred on spawn and every edge falls on a chunk
  // boundary (the grid is offset by 128 tiles, 4 chunks), clipped to
  // [-R,R)^2, nearest to spawn first. A cell's terrain, ore and entities are
  // done together: its ore and entity requests go out as soon as its terrain
  // is drawn, so the CPU workers place ore and entities while the GPU (or the
  // other workers) are still drawing later cells. A union of cells is
  // identical to one whole-rect call for every pass.
  var CELL = 256;
  try {
    var _qc = parseInt(new URLSearchParams(location.search).get("cells"), 10);
    if (_qc >= 32) CELL = Math.min(2048, _qc - _qc % 32);
  } catch (e) {}

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

  // The cells of [-R,R)^2. `off`: wholly outside the surface's disk (no
  // terrain or entities there; see cellPasses for the ore).
  function cellPlan(R, diskR) {
    var half = CELL / 2, cells = [];
    var start = Math.floor((-R + half) / CELL) * CELL - half; // grid line at or before -R
    for (var y = start; y < R; y += CELL) {
      for (var x = start; x < R; x += CELL) {
        var c = { x0: Math.max(x, -R), y0: Math.max(y, -R), x1: Math.min(x + CELL, R), y1: Math.min(y + CELL, R) };
        if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
        var nx = Math.max(c.x0, Math.min(0, c.x1 - 1)), ny = Math.max(c.y0, Math.min(0, c.y1 - 1));
        c.off = nx * nx + ny * ny > diskR * diskR;
        var mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2;
        c.d2 = mx * mx + my * my;
        c.i = cells.length;
        cells.push(c);
      }
    }
    cells.sort(function (a, b) { return (a.d2 - b.d2) || (a.i - b.i); });
    return cells;
  }

  // The cell `c`'s pixels (RGBA, one per tile) out of a buffer whose top-left
  // tile is (sx0, sy0) and which is `sw` tiles wide.
  function cutRect(src, sx0, sy0, sw, c) {
    var w = c.x1 - c.x0, h = c.y1 - c.y0, out = new Uint8Array(w * h * 4);
    for (var row = 0; row < h; row++) {
      var o = ((c.y0 - sy0 + row) * sw + (c.x0 - sx0)) * 4;
      out.set(src.subarray(o, o + w * 4), row * w * 4);
    }
    return out;
  }
  // Paste `p` ({ x0, y0, w, h, px }) over the cell `c`'s pixels `t` where they
  // overlap (opaque pixels of p only, as drawn on the canvas).
  function pasteRect(t, c, p) {
    var w = c.x1 - c.x0;
    var x0 = Math.max(c.x0, p.x0), x1 = Math.min(c.x1, p.x0 + p.w);
    var y0 = Math.max(c.y0, p.y0), y1 = Math.min(c.y1, p.y0 + p.h);
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var si = ((y - p.y0) * p.w + (x - p.x0)) * 4, di = ((y - c.y0) * w + (x - c.x0)) * 4;
        if (!p.px[si + 3]) continue;
        t[di] = p.px[si]; t[di + 1] = p.px[si + 1]; t[di + 2] = p.px[si + 2]; t[di + 3] = p.px[si + 3];
      }
    }
  }

  // CPU terrain (the fallback when WebGPU is unavailable, and ?cpu=1).
  // layer 0: terrain, then each cell's ore and entities as its terrain lands.
  // layer 1: terrain cells only.
  // layer 2: ore cells only.
  // onProgress(terrain cells drawn, cells placed, cells) after each step.
  function renderSurfaceMap(zoneObj, R, layer, palette, onProgress) {
    var npx = 2 * R;
    var ctx = els.canvas.getContext("2d");
    els.canvas.width = npx;
    els.canvas.height = npx;
    // terrain goes on the page's canvas, ore on a canvas laid over it
    oreOverlayClear();
    var diskR = zoneDiskRadius(zoneObj, R); // clip radius for the wasm + cell plan
    var cells = cellPlan(R, diskR);
    var disk = cells.filter(function (c) { return !c.off; });
    // tuning/bench hook: cell edge and the number of cells
    window.__SURF_CELLS__ = { cellTiles: CELL, cells: disk.length };
    var oreCv = layer === 1 ? null : oreOverlay(npx);
    var passes = oreCv ? cellPasses(zoneObj, R, diskR, palette, oreCv, {
      exact: layer === 0 && exactZone(zoneObj, true),
      entities: layer === 0 && wantsEntityLayer(zoneObj, true),
      fullSize: true
    }) : null;
    var tDone = 0, pDone = 0;
    function progress() { if (onProgress) onProgress(tDone, pDone, disk.length); }
    // `tiles`: the cell's terrain pixels as the worker returned them (not read
    // back from the canvas: a browser may blur what it reads back, Brave does)
    function place(c, tiles) {
      return passes.cell(c, passes.needTiles ? tiles : null).then(function () { if (!c.off) { pDone++; progress(); } });
    }
    function terrainCell(c) {
      return sendToPool({
        seed: SEED, k2: K2, zone: zoneObj, layer: 1, radius: diskR, palette: palette,
        rect: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, square: squareSurface(zoneObj)
      }).then(function (r) {
        // blit this cell (pixel data uploaded to the GPU-backed canvas).
        var img = ctx.createImageData(r.summary.width, r.summary.height);
        img.data.set(r.pixels);
        ctx.putImageData(img, c.x0 + R, c.y0 + R);
        tDone++;
        progress();
        return r.pixels;
      });
    }
    var jobs = cells.map(function (c) {
      if (c.off) return passes ? place(c, null) : null;   // (ore only, see cellPasses)
      if (layer === 2) return place(c, null);              // no terrain to draw
      var t = terrainCell(c);
      return passes ? t.then(function (px) { return place(c, px); }) : t;
    });
    return Promise.all(jobs).then(function () {
      return passes ? passes.done() : {};
    }).then(function (totals) {
      if (layer !== 1 && Object.keys(totals).length === 0) throw new Error("render failed (no ore totals)");
      return totals;
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

  // The ore and entity passes of a surface, a cell at a time (see cellPlan).
  // passes.cell(c, tiles) places one cell: `tiles` are its terrain pixels as
  // drawn (passes.needTiles says whether it wants them). passes.done(), once
  // every cell is in, finishes the layers and resolves to the resource totals
  // { name: { amount, display } }.
  //
  // opts.exact (see exactZone): the ore comes from the data-driven pass over
  // the terrain's tiles, which places it the way the game does on them. That
  // pass places the entities too (it has to evaluate them: they come before
  // the resources in placement order), so one request returns both images.
  // Otherwise the ore comes from the ore code (no tiles needed) and, with
  // opts.entities, the entities or enemy areas from a second request.
  //
  // Cells wholly off the disk: the old ore code still places them (its totals
  // are for the whole square, as they always were); nothing else does.
  function cellPasses(z, R, diskR, palette, oreCv, opts) {
    var octx = oreCv.getContext("2d");
    var exact = !!opts.exact;
    var withEnts = !!opts.entities;
    // the entities themselves, or (a surface not drawn at full size) the
    // enemy areas
    var entities = exact || entitySurface(z, opts.fullSize);
    var ectx = withEnts ? enemyOverlay(oreCv.width, entities ? "Entities" : undefined).getContext("2d") : null;
    if (ectx) ectx.imageSmoothingEnabled = true;
    var scale = (2 * R) / oreCv.width; // tiles per canvas pixel
    octx.imageSmoothingEnabled = true;
    var R2 = diskR * diskR;
    var totals = {};
    var wells = [];   // [tile x, tile y, FLUID_COLORS index, ...]
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
    function drawOre(c, px, r) {
      var w = c.x1 - c.x0, h = c.y1 - c.y0, mine = [];
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
    }
    function drawEnts(c, px) {
      var w = c.x1 - c.x0, h = c.y1 - c.y0;
      if (entities) {
        drawEntityCell(px, w, h, (c.x0 + R) / scale, (c.y0 + R) / scale, w / scale, h / scale);
        return;
      }
      var cx = cellCanvas(w, h);
      var img = cx.createImageData(w, h);
      img.data.set(px);
      cx.putImageData(img, 0, 0);
      ectx.drawImage(cellCv, 0, 0, w, h, (c.x0 + R) / scale, (c.y0 + R) / scale, w / scale, h / scale);
    }
    var rect = function (c) { return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }; };
    return {
      // (an SE surface's entities need the terrain's tiles; base-game Nauvis
      // takes them when they are there rather than working them out again)
      needTiles: exact || (withEnts && entities),
      cell: function (c, tiles) {
        if (exact) {
          if (c.off) return Promise.resolve();
          return sendToPool({
            seed: SEED, k2: K2, zone: z, layer: 4, radius: diskR, tiles_in: true, entities: withEnts, rect: rect(c),
            palette: palette, square: squareSurface(z)
          }, "surface", "ore", tiles).then(function (r) {
            var n = (c.x1 - c.x0) * (c.y1 - c.y0) * 4;
            if (withEnts && r.summary.enemy_tiles) drawEnts(c, r.pixels.subarray(n, 2 * n));
            drawOre(c, r.pixels.subarray(0, n), r);
          });
        }
        var jobs = [sendToPool({
          seed: SEED, k2: K2, zone: z, layer: 0, radius: diskR, terrainless: true,
          palette: palette, rect: rect(c), square: squareSurface(z)
        }, "surface", "ore").then(function (r) { drawOre(c, r.pixels, r); })];
        if (withEnts && !c.off) {
          var t = entities ? tiles : null;
          jobs.push(sendToPool({
            seed: SEED, k2: K2, zone: z, layer: 3, radius: diskR, palette: palette, tiles_in: !!t, entities: entities,
            rect: rect(c), square: squareSurface(z)
          }, "surface", "ore", t).then(function (r) {
            if (r.summary.enemy_tiles) drawEnts(c, r.pixels);
          }, function (e) { console.error("entities cell failed:", e); }));
        }
        return Promise.all(jobs);
      },
      done: function () {
        // wells go over ore, whichever cell landed first
        for (var k = 0; k < wells.length; k += 3) drawWell(wells[k], wells[k + 1], wells[k + 2]);
        Object.keys(totals).forEach(function (rn) {
          var v = totals[rn].amount;
          totals[rn].display = v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : String(v);
        });
        return (withEnts ? drawSeams(z, R) : Promise.resolve()).then(function () { return totals; });
      }
    };
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
    // (under Space Exploration Nauvis is a planet of SE's default radius)
    var se = MOD === "se" || MOD === "k2se";
    return { n: "Nauvis", t: "planet", s: SEED, r: se ? window.Shell.seNauvisRadius : 5000, water: "med", enemy: "high", c: 1, nauvis: true };
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
    // Nauvis under Space Exploration opens whole, at SE's default radius.
    var seNauvis = kind === "nauvis" && (MOD === "se" || MOD === "k2se");
    return { min: 10, max: 10000, step: 50, value: seNauvis ? Math.round(window.Shell.seNauvisRadius) : 2000 };
  }

  function adaptForKind() {
    setBadge(kind === "zone" ? "…" : "planet");
    if (els.dimWrap) els.dimWrap.hidden = false;
    showLayerChecks();
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
    enemyOverlayClear();
    els.canvas.style.filter = "";
  }
  // a canvas of `px` x `px` placed exactly over the terrain canvas
  function overlayCanvas(px, z) {
    var c = newCanvas(px);
    var box = els.canvas.parentNode;
    box.style.position = "relative";
    // sized by the same rules as the canvas under it (#sf-canvas in style.css)
    c.style.cssText = "position:absolute;pointer-events:none;width:100%;max-width:720px;height:auto;image-rendering:pixelated;" +
      "z-index:" + z + ";left:" + els.canvas.offsetLeft + "px;top:" + els.canvas.offsetTop + "px";
    box.appendChild(c);
    return c;
  }
  // A fresh ore canvas, over the terrain (and over the enemy areas).
  function oreOverlay(px) {
    oreOverlayClear();
    oreOverlayEl = overlayCanvas(px, 2);
    applyDim();
    return oreOverlayEl;
  }

  // ── Enemy base areas / entities ───────────────────────────────────────────
  // A third canvas between the terrain and the ore: translucent red wherever
  // the game can place a nest (spawners and worms), stronger where that is
  // likelier - or, on a Space Age planet, the entities themselves (rocks,
  // trees, plants, nests). It is drawn once; the checkbox only shows or
  // hides the canvas. ?entities=0 (or ?enemies=0) skips generating it.
  var ENEMIES = !/[?&](enemies|entities)=0\b/.test(location.search);
  var SE_HIDDEN_GROUPS = ["rocks", "huge"];
  var enemyOverlayEl = null;
  // Entities arrive in one image, each class in its own colour (classColor
  // in sa_surface.zig), and are kept on two canvases: the trees under the ore
  // (ore shows through a forest, as on the game's map) and everything else -
  // nests, rocks, cliffs - over it. Hiding the trees hides their canvas; the
  // other per-group checkboxes show a copy of the upper canvas with the
  // unticked groups' pixels left out - made only while one is unticked.
  var ENTITY_GROUPS = {
    enemies: [[255, 40, 40], [255, 64, 40]],
    trees: [[50, 92, 44], [62, 104, 52]],
    rocks: [[129, 105, 78], [160, 120, 190]],
    huge: [[176, 148, 112]],
    cliffs: [[144, 119, 87]]
  };
  var entityMode = false;   // the overlay holds entities (else enemy areas)
  var entityViewEl = null;  // the filtered copy, while a group is hidden
  var treeEl = null;        // the trees, under the ore
  var LOWER_GROUPS = ["trees"];
  function enemyOverlayClear() {
    if (enemyOverlayEl) { enemyOverlayEl.remove(); enemyOverlayEl = null; }
    if (treeEl) { treeEl.remove(); treeEl = null; }
    seamsClear();
    if (entityViewEl) { entityViewEl.remove(); entityViewEl = null; }
  }
  // The layer checkboxes are on the page from the start (showLayerChecks),
  // so they can be set before the layers they control have been drawn.
  function showLayerChecks() {
    if (!els.enemyWrap || !ENEMIES) return;
    var se = MOD === "se" || MOD === "k2se";
    els.enemyWrap.hidden = false;
    if (els.areas) els.areas.hidden = true;
    if (els.groups) {
      els.groups.hidden = false;
      // alien-biomes rocks are flagged "not-on-map": the game's own map does
      // not draw them, so on an SE surface they start unticked
      els.groups.querySelectorAll("input[data-group]").forEach(function (cb) {
        cb.checked = !se || SE_HIDDEN_GROUPS.indexOf(cb.dataset.group) === -1;
      });
    }
    var seams = document.getElementById("sf-seams");
    if (seams) seams.hidden = !se || kind === "sa";
  }
  // label = "Entities": the per-group checkboxes; otherwise the one checkbox
  function enemyOverlay(px, label) {
    enemyOverlayClear();
    entityMode = label === "Entities";
    // enemy areas lie under the ore; entities other than trees over it
    enemyOverlayEl = overlayCanvas(px, entityMode ? 3 : 1);
    if (entityMode) {
      treeEl = overlayCanvas(px, 1);
      // (read back whenever a group is hidden)
      enemyOverlayEl.getContext("2d", { willReadFrequently: true });
    }
    if (els.enemyWrap) {
      els.enemyWrap.hidden = false;
      if (els.areas) els.areas.hidden = entityMode;
      if (els.groups) els.groups.hidden = !entityMode;
    }
    showEnemies();
    return enemyOverlayEl;
  }
  function hiddenGroups() {
    var off = [];
    if (els.groups) els.groups.querySelectorAll("input[data-group]").forEach(function (cb) { if (!cb.checked) off.push(cb.dataset.group); });
    return off;
  }
  // the hidden groups of the upper canvas
  function hiddenUpper() {
    return hiddenGroups().filter(function (g) { return LOWER_GROUPS.indexOf(g) === -1; });
  }
  // Draw one cell of entity pixels (RGBA, w x h) at (dx, dy), dw x dh on the
  // canvases: the trees onto the tree canvas, everything else onto the entity
  // canvas. Drawn over what is there - an entity on a cell's edge reaches
  // into the next cell, whose own transparent pixels must not erase it.
  //
  // While a group of the upper canvas is hidden, the cell is also drawn onto
  // the filtered view without that group's pixels - sorted here from the
  // cell's own pixels, not read back from the canvas (reading a large canvas
  // back once per cell was most of an SE Nauvis render).
  var groupOfColor = {};  // r,g,b -> group (nearest entity colour)
  function groupOf(r, g, b) {
    var key = (r << 16) | (g << 8) | b;
    var hit = groupOfColor[key];
    if (hit !== undefined) return hit;
    var best = null, bd = Infinity;
    Object.keys(ENTITY_GROUPS).forEach(function (gr) {
      ENTITY_GROUPS[gr].forEach(function (c) {
        var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
        if (d < bd) { bd = d; best = gr; }
      });
    });
    groupOfColor[key] = best;
    return best;
  }
  function drawEntityCell(px, w, h, dx, dy, dw, dh) {
    var n = w * h * 4;
    var low = new Uint8ClampedArray(n), up = new Uint8ClampedArray(n);
    var off = entityViewEl ? hiddenUpper() : [];
    var vis = off.length ? new Uint8ClampedArray(n) : null;
    var anyLow = false, anyUp = false, anyVis = false, cols = [];
    LOWER_GROUPS.forEach(function (g) { ENTITY_GROUPS[g].forEach(function (c) { cols.push(c); }); });
    for (var i = 0; i < n; i += 4) {
      if (!px[i + 3]) continue;
      // (the lower canvas takes its groups' exact colours only)
      var isLow = false;
      for (var k = 0; k < cols.length; k++) {
        if (px[i] === cols[k][0] && px[i + 1] === cols[k][1] && px[i + 2] === cols[k][2]) { isLow = true; break; }
      }
      var t = isLow ? low : up;
      t[i] = px[i]; t[i + 1] = px[i + 1]; t[i + 2] = px[i + 2]; t[i + 3] = px[i + 3];
      if (isLow) { anyLow = true; continue; }
      anyUp = true;
      if (vis && off.indexOf(groupOf(px[i], px[i + 1], px[i + 2])) === -1) {
        vis[i] = px[i]; vis[i + 1] = px[i + 1]; vis[i + 2] = px[i + 2]; vis[i + 3] = px[i + 3];
        anyVis = true;
      }
    }
    [[up, enemyOverlayEl, anyUp], [low, treeEl, anyLow], [vis, entityViewEl, anyVis]].forEach(function (job) {
      if (!job[2] || !job[1]) return;
      var cx = cellCanvas(w, h);
      cx.putImageData(new ImageData(job[0], w, h), 0, 0);
      var ctx = job[1].getContext("2d");
      ctx.imageSmoothingEnabled = dw !== w;
      ctx.drawImage(cellCv, 0, 0, w, h, dx, dy, dw, dh);
    });
  }
  // Copy a rect of the entity canvas to the filtered view without the
  // hidden groups (a pixel belongs to the group whose colour it is nearest,
  // which also sorts the blended pixels of a downscaled canvas).
  function filterEntities(x, y, w, h, off) {
    var src = enemyOverlayEl.getContext("2d"), dst = entityViewEl.getContext("2d");
    var drop = [];
    Object.keys(ENTITY_GROUPS).forEach(function (g) { ENTITY_GROUPS[g].forEach(function (c) { drop.push([c[0], c[1], c[2], off.indexOf(g) !== -1]); }); });
    var STEP = 1024;
    for (var ty = y; ty < y + h; ty += STEP) {
      for (var tx = x; tx < x + w; tx += STEP) {
        var bw = Math.min(STEP, x + w - tx), bh = Math.min(STEP, y + h - ty);
        var img = src.getImageData(tx, ty, bw, bh), d = img.data;
        for (var i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          var best = 0, bd = Infinity;
          for (var k = 0; k < drop.length; k++) {
            var dr = d[i] - drop[k][0], dg = d[i + 1] - drop[k][1], db = d[i + 2] - drop[k][2];
            var dist = dr * dr + dg * dg + db * db;
            if (dist < bd) { bd = dist; best = k; }
          }
          if (drop[best][3]) d[i + 3] = 0;
        }
        dst.putImageData(img, tx, ty);
      }
    }
  }
  function showEnemies() {
    if (!enemyOverlayEl) return;
    if (!entityMode) {
      enemyOverlayEl.style.display = !els.enemy || els.enemy.checked ? "" : "none";
      return;
    }
    if (treeEl) treeEl.style.display = hiddenGroups().indexOf("trees") === -1 ? "" : "none";
    var off = hiddenUpper();
    if (!off.length) {
      if (entityViewEl) { entityViewEl.remove(); entityViewEl = null; }
      enemyOverlayEl.style.display = "";
      return;
    }
    if (!entityViewEl) entityViewEl = overlayCanvas(enemyOverlayEl.width, 3);
    enemyOverlayEl.style.display = "none";
    filterEntities(0, 0, enemyOverlayEl.width, enemyOverlayEl.height, off);
  }

  // Does this SE surface have enemies to map? (Nauvis always; a zone by its
  // enemy tag; never an asteroid field.)
  function zoneHasEnemies(z) {
    return ENEMIES && z.t !== "asteroid-field" && (!!z.nauvis || (!!z.enemy && z.enemy !== "none"));
  }
  // A Space Exploration planet, moon or Nauvis.
  function seSolid(z) {
    return (MOD === "se" || MOD === "k2se") && !!z && z.t !== "asteroid-field";
  }
  // Does the layer hold the entities themselves (rocks, trees, cliffs, nests)
  // rather than the enemy areas? Base-game Nauvis always; an SE surface when
  // the terrain is on the canvas at full size (`fullSize`), since its
  // entities are placed on those tiles - a surface too large for that keeps
  // the enemy areas.
  function entitySurface(z, fullSize) {
    return squareSurface(z) || (seSolid(z) && !!fullSize);
  }
  // ── Download ──────────────────────────────────────────────────────────────
  // The map as it is shown: the terrain at the slider's brightness, then every
  // overlay that is visible, in stacking order (trees or enemy areas, ore, the
  // other entities), then the core seam icons. One pixel a tile (or whatever
  // the page's canvases hold).
  //
  // drawMapRows(ctx, y0, h, icon) draws rows y0 .. y0+h of that onto `ctx`
  // (whose row 0 is map row y0), so a large map can be done a strip at a time.
  function mapLayers() {
    var box = els.canvas.parentNode;
    return Array.prototype.slice.call(box.querySelectorAll("canvas")).filter(function (c) {
      return c !== els.canvas && c.style.display !== "none";
    }).sort(function (a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
  }
  function drawMapRows(ctx, y0, h, icon, layers) {
    var W = els.canvas.width;
    ctx.clearRect(0, 0, W, h);
    ctx.drawImage(els.canvas, 0, y0, W, h, 0, 0, W, h);
    // brightness(d) scales the colours by d: the same as black over them at
    // 1 - d, kept to where the terrain is
    var dim = els.dim ? parseInt(els.dim.value, 10) / 100 : 1;
    if (oreOverlayEl && dim < 1) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(0,0,0," + (1 - dim) + ")";
      ctx.fillRect(0, 0, W, h);
      ctx.globalCompositeOperation = "source-over";
    }
    layers.forEach(function (c) {
      // (an overlay canvas has the terrain canvas's size)
      var sy = y0 * c.height / els.canvas.height, sh = h * c.height / els.canvas.height;
      ctx.drawImage(c, 0, sy, c.width, sh, 0, 0, W, h);
    });
    if (!icon) return;
    ctx.imageSmoothingEnabled = false;
    icon.places.forEach(function (p) {
      if (p[1] + icon.h < y0 || p[1] > y0 + h) return;
      ctx.drawImage(icon.img, p[0], p[1] - y0, icon.w, icon.h);
    });
  }
  // The seam icons as one image and where they go (null: none shown). They
  // are page elements: drawn from the same SVG, at the size they have on
  // screen relative to the map, with crisp edges (no blended colours).
  function seamIcon() {
    var icons = seamEl && !seamEl.hidden ? Array.prototype.slice.call(seamEl.querySelectorAll(".seam-icon")) : [];
    if (!icons.length) return Promise.resolve(null);
    var W = els.canvas.width, H = els.canvas.height;
    var fill = getComputedStyle(icons[0].querySelector(".seam-bg")).fill || "#6ed7ff";
    var shown = els.canvas.getBoundingClientRect().width || W;
    var w = Math.round(Math.max(6, 9 * W / shown)), h = Math.round(w * 17 / 18);
    // rasterised at the size it is drawn, without anti-aliasing
    var svg = SEAM_SVG.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" width="' + w + '" height="' + h + '" preserveAspectRatio="none" ')
      .replace('class="seam-bg"', 'fill="' + fill + '"');
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        // The browser anti-aliases the SVG whatever it is told, and every
        // blended edge pixel is a colour of its own (hundreds of them on a
        // big map, too many for a palette): snap each pixel of the raster to
        // the icon's fill, its outline or nothing.
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var cx = cv.getContext("2d");
        cx.drawImage(img, 0, 0, w, h);
        var id = cx.getImageData(0, 0, w, h), d = id.data;
        var probe = document.createElement("canvas").getContext("2d");
        probe.fillStyle = fill; probe.fillRect(0, 0, 1, 1);
        var fc = probe.getImageData(0, 0, 1, 1).data, oc = [13, 17, 23];
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
          var df = Math.abs(d[i] - fc[0]) + Math.abs(d[i + 1] - fc[1]) + Math.abs(d[i + 2] - fc[2]);
          var dk = Math.abs(d[i] - oc[0]) + Math.abs(d[i + 1] - oc[1]) + Math.abs(d[i + 2] - oc[2]);
          var c = df <= dk ? fc : oc;
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
        }
        cx.putImageData(id, 0, 0);
        // top-left corners on whole pixels, so an icon cut by a strip edge
        // is drawn the same in both strips
        resolve({ img: cv, w: w, h: h, places: icons.map(function (el) {
          return [Math.round(parseFloat(el.style.left) / 100 * W - w / 2), Math.round(parseFloat(el.style.top) / 100 * H - h * 0.55)];
        }) });
      };
      img.onerror = function () { resolve(null); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }
  // The whole map on one canvas (the test hook; the download goes by strips).
  function flattenMap() {
    var out = document.createElement("canvas");
    out.width = els.canvas.width; out.height = els.canvas.height;
    return seamIcon().then(function (icon) {
      drawMapRows(out.getContext("2d"), 0, out.height, icon, mapLayers());
      return out;
    });
  }
  window.__flattenMap = flattenMap; // test hook

  // PNG with a palette. A map has a few hundred colours at most, so it is
  // stored a byte a pixel (with the transparency in the palette) - about a
  // third of the 32-bit image the browser would write, and the same pixels.
  // It is built a strip of rows at a time - never the whole map as RGBA - and
  // compressed as it goes (CompressionStream). Resolves to the Blob, or null
  // when the map has more than 256 colours.
  var CRC_TABLE = null;
  function crc32(bytes, crc) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    crc = crc === undefined ? 0xffffffff : crc;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }
  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    return out;
  }
  function palettePng(onProgress) {
    if (typeof CompressionStream === "undefined") return Promise.resolve(null);
    var W = els.canvas.width, H = els.canvas.height, STRIP = 256;
    var strip = document.createElement("canvas");
    strip.width = W; strip.height = Math.min(STRIP, H);
    var sctx = strip.getContext("2d", { willReadFrequently: true });
    var layers = mapLayers();
    var colours = new Map(), palette = []; // packed RGBA -> index, in first-seen order
    var cs = new CompressionStream("deflate"); // zlib, as PNG's IDAT wants
    var writer = cs.writable.getWriter(), parts = [];
    var reading = (function read(reader) {
      return reader.read().then(function (r) { if (r.done) return; parts.push(r.value); return read(reader); });
    })(cs.readable.getReader());
    return seamIcon().then(function (icon) {
      var y0 = 0;
      function next() {
        if (y0 >= H) return writer.close().then(function () { return reading; }).then(function () { return true; });
        var h = Math.min(STRIP, H - y0);
        drawMapRows(sctx, y0, h, icon, layers);
        var px = new Uint32Array(sctx.getImageData(0, 0, W, h).data.buffer);
        var rows = new Uint8Array(h * (W + 1)); // filter byte 0, then an index a pixel
        var last = -1, lastIdx = 0;
        for (var y = 0; y < h; y++) {
          var o = y * (W + 1) + 1, p = y * W;
          for (var x = 0; x < W; x++) {
            var v = px[p + x];
            if (v !== last) {
              var idx = colours.get(v);
              if (idx === undefined) {
                if (palette.length === 256) return writer.abort().then(function () { return false; }, function () { return false; });
                idx = palette.length; colours.set(v, idx); palette.push(v);
              }
              last = v; lastIdx = idx;
            }
            rows[o + x] = lastIdx;
          }
        }
        y0 += h;
        if (onProgress) onProgress(y0 / H);
        return writer.write(rows).then(next);
      }
      return next();
    }).then(function (ok) {
      if (!ok) return null;
      var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
      dv.setUint32(0, W); dv.setUint32(4, H);
      ihdr[8] = 8; ihdr[9] = 3; // 8-bit palette indices
      var plte = new Uint8Array(palette.length * 3), trns = new Uint8Array(palette.length);
      // (the packed value is the pixel's bytes read as one little-endian word)
      palette.forEach(function (v, i) {
        plte[i * 3] = v & 0xff; plte[i * 3 + 1] = (v >>> 8) & 0xff; plte[i * 3 + 2] = (v >>> 16) & 0xff;
        trns[i] = v >>> 24;
      });
      var out = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("PLTE", plte), pngChunk("tRNS", trns)];
      parts.forEach(function (d) { out.push(pngChunk("IDAT", d)); });
      out.push(pngChunk("IEND", new Uint8Array(0)));
      return new Blob(out, { type: "image/png" });
    });
  }
  window.__palettePng = palettePng; // test hook

  function downloadMap() {
    if (!els.download) return;
    els.download.disabled = true;
    var label = els.download.textContent;
    palettePng(function (f) { els.download.textContent = "Saving… " + Math.round(f * 100) + "%"; }).then(function (blob) {
      if (blob) return blob;
      // more than 256 colours (or no CompressionStream): the browser's own PNG
      return flattenMap().then(function (cv) { return new Promise(function (resolve) { cv.toBlob(resolve, "image/png"); }); });
    }).then(function (blob) {
      els.download.disabled = false;
      els.download.textContent = label;
      if (!blob) { status("This map is too large for the browser to save as one image."); return; }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "seed-" + SEED + "-" + String(TARGET).replace(/[^A-Za-z0-9_-]+/g, "_") + ".png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    }, function (e) {
      els.download.disabled = false;
      els.download.textContent = label;
      console.error("download failed:", e);
      status("download failed: " + e.message);
    });
  }

  // ── Core seams ────────────────────────────────────────────────────────────
  // Where a core miner can be built. Space Exploration does not autoplace
  // them: CoreMiner.generate_core_seam_positions walks a golden-angle spiral
  // out from the centre, one seam per band, with a random generator seeded by
  // the zone's seed - so they follow from the seed exactly (checked against
  // the game on five surfaces).
  function coreSeams(seed, radius) {
    var s = seed >>> 0;
    if (s < 341) s = 341;
    var a = s, b = s, c = s;
    function rnd() { // the game's generator, a float in [0, 1)
      a = (((a & 0xFFFFFFFE) << 12) ^ (((a << 13) ^ a) >>> 19)) >>> 0;
      b = (((b & 0xFFFFFFF8) << 4) ^ (((b << 2) ^ b) >>> 25)) >>> 0;
      c = (((c & 0xFFFFFFF0) << 17) ^ (((c << 3) ^ c) >>> 11)) >>> 0;
      return ((a ^ b ^ c) >>> 0) * 2.3283064365386963e-10;
    }
    var target = 5 + 95 * (radius / 10000), band = radius / (target + 2), phi = (1 + Math.sqrt(5)) / 2;
    var build = function (v) { return Math.floor(v + (v >= 0 ? 0 : 1 / 256)) + 0.5; };
    var out = [];
    for (var i = 1; i <= target; i++) {
      var o = i * phi + 0.2 * rnd(), d = (i + rnd()) * band;
      out.push([build(d * Math.sin(o * 2 * Math.PI)), build(-d * Math.cos(o * 2 * Math.PI))]);
    }
    return out;
  }
  window.__coreSeams = coreSeams; // test hook
  // The surface's core seams as icons laid over the map: one element per
  // seam, positioned by its coordinates (so they stay crisp at any map size)
  // and filled with the colour of the zone's core resource - its primary; the
  // homeworld's mixed fragments keep the game icon's blue. Hovering one gives
  // its coordinates.
  var SEAM_SVG = '<svg viewBox="0 0 24 22" aria-hidden="true">' +
    '<path class="seam-bg" d="M12 1.6 22.4 20.2H1.6Z" stroke="#0d1117" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path fill="#0d1117" d="M9.4 7h5.2v2.3H9.4zM10.1 9.8h3.8l-.5 2h-2.8zM10.7 12.3h2.6l-.4 1.9h-1.8zM11.2 14.7h1.6L12 18.2zM5.6 18.4h3.6v1H5.6zM14.8 18.4h3.6v1h-3.6z"/></svg>';
  var seamEl = null;
  function seamsClear() {
    if (seamEl) { seamEl.remove(); seamEl = null; }
  }
  function showSeams() {
    var cb = document.getElementById("sf-seams-cb");
    if (seamEl) seamEl.hidden = !!cb && !cb.checked;
  }
  function drawSeams(z, R) {
    if (!ENEMIES || !seSolid(z)) return Promise.resolve();
    var owner = enemyOverlayEl;
    var zone = z.nauvis
      ? (universe ? Promise.resolve(universe) : window.generateUniverse(SEED, K2)).then(function (u) { return { s: u.hs, r: u.hr }; })
      : Promise.resolve({ s: z.s, r: z.r });
    return zone.then(function (q) {
      if (!q.s || !q.r || enemyOverlayEl !== owner) return;
      seamsClear();
      var box = els.canvas.parentNode;
      box.style.position = "relative";
      seamEl = document.createElement("div");
      seamEl.className = "seam-layer" + (z.p ? " ore-" + nm(z.p) : "");
      seamEl.style.left = els.canvas.offsetLeft + "px";
      seamEl.style.top = els.canvas.offsetTop + "px";
      var what = "Core seam" + (z.p ? " · " + nm(z.p) : "");
      var list = [];
      coreSeams(q.s, q.r).forEach(function (p) {
        if (p[0] * p[0] + p[1] * p[1] > R * R) return; // outside the disk being drawn
        list.push(p);
        var el = document.createElement("div");
        el.className = "seam-icon";
        el.style.left = ((p[0] + R) / (2 * R) * 100) + "%";
        el.style.top = ((p[1] + R) / (2 * R) * 100) + "%";
        el.title = what + " · x " + Math.floor(p[0]) + ", y " + Math.floor(p[1]);
        el.innerHTML = SEAM_SVG;
        seamEl.appendChild(el);
      });
      window.__SEAMS__ = list; // test hook: [[x, y], ...]
      box.appendChild(seamEl);
      var count = document.getElementById("sf-seams-n");
      if (count) count.textContent = "(" + list.length + ")";
      showSeams();
    }, function (e) { console.error("core seams failed:", e); });
  }

  // A surface drawn at full size whose ore and entities come from one
  // data-driven pass over the terrain's tiles (cellPasses with opts.exact) -
  // the game's own placement, ore and entities together: every Space
  // Exploration planet and moon (Nauvis too, with or without Krastorio 2)
  // and base-game Nauvis.
  function exactZone(z, fullSize) {
    if (!z || !fullSize) return false;
    return squareSurface(z) || ((MOD === "se" || MOD === "k2se") && (z.t === "planet" || z.t === "moon"));
  }
  function wantsEntityLayer(z, fullSize) {
    return ENEMIES && (entitySurface(z, fullSize) || zoneHasEnemies(z));
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
    if (els.goBtn) els.goBtn.disabled = true;
    if (els.download) els.download.hidden = true;
    if (els.radiusIn) els.radiusIn.value = els.radius.value;
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
    function doneUI() {
      busy = false; els.go.disabled = false; setProgress(1); status(""); setTimeout(releasePool, 0);
      if (els.goBtn) els.goBtn.disabled = false;
      if (els.download) els.download.hidden = false;
    }
    // There is no Generate button to press again, so a failure offers a
    // reload: that restarts the workers and refetches the page's files (the
    // usual cause is a file that could not be loaded).
    function fail(e, tag) {
      busy = false; els.go.disabled = false; status(tag + ": " + e.message + " "); console.error(e);
      if (els.goBtn) els.goBtn.disabled = false;
      var retry = document.createElement("button");
      retry.type = "button"; retry.className = "btn-sm"; retry.textContent = "Reload and retry";
      retry.addEventListener("click", function () { location.reload(); });
      els.status.appendChild(retry);
    }

    function secs(ms) { return ms == null ? "?" : (ms / 1000).toFixed(1) + " s"; }
    function mpx(tiles, ms) { return ms ? (tiles / ms / 1000).toFixed(1) + " Mpx/s" : "? Mpx/s"; }
    // " (10 workers, 2.4 Mpx/s)"
    function workersTxt(rate) {
      return " (" + (pool ? pool.length : 0) + " workers" + (rate ? ", " + rate : "") + ")";
    }
    // progress of a cell render: terrain cells drawn (`t`) and cells whose
    // ore and entities are placed (`p`), of `n`
    function cellStatus(t, p, n, terrainLabel) {
      var parts = [];
      if (layer !== 2) parts.push(terrainLabel + " " + t + "/" + n);
      if (layer !== 1) parts.push((layer === 0 && ENEMIES ? "ore & entities " : "ore ") + p + "/" + n);
      status(parts.join(" · ") + " cells…");
      var steps = (layer === 0 ? 2 : 1) * n;
      setProgress(steps ? ((layer !== 2 ? t : 0) + (layer !== 1 ? p : 0)) / steps : 0);
    }

    // CPU wasm pipeline (default for ore-only layers & SA planets; also the
    // fallback whenever WebGPU terrain is unavailable or fails).
    function runCpu() {
      var needZone = kind === "zone";
      if (!pool) spawnPool();
      Promise.resolve(needZone ? fetchZone() : nauvisZone())
        .then(function (z) {
          return renderSurfaceMap(z, radius, layer, palette, function (t, p, n) {
            cellStatus(t, p, n, "terrain");
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
              " · CPU " + secs(window.__SURF_MS__) + workersTxt(mpx(width * width, window.__SURF_MS__)) + "</span>";
          });
        })
        .catch(function (e) { fail(e, "error"); });
    }

    // WebGPU terrain; each cell's ore and entities go to the CPU workers as
    // soon as the GPU has drawn it (layer 0), so both run at once.
    async function runGpu() {
      window.__GPU_STAGE__ = "terrain";
      // when the GPU's last cell landed, and when the CPU's ore and entity
      // passes started and finished (ms since t0)
      var times = { gpu: null, cpuStart: null, cpu: null };
      var dispMax = await canvasMax();
      return Promise.resolve(kind === "zone" ? fetchZone() : nauvisZone()).then(function (z) {
        var R = radius;
        var diskR = zoneDiskRadius(z, R);
        // display canvas is capped at the probed max (usually the GPU texture
        // size); larger disks are downscaled
        var disp = Math.min(2 * R, dispMax);
        var scaleS = (2 * R) / disp;
        var full = scaleS === 1;
        els.canvas.width = disp;
        els.canvas.height = disp;
        oreOverlayClear();
        var tctx = els.canvas.getContext("2d");
        var oreCv = layer === 0 ? oreOverlay(disp) : null;
        var cells = cellPlan(R, diskR);
        var disk = cells.filter(function (c) { return !c.off; });
        // (a downscaled surface keeps the enemy areas and the older ore code:
        // its tiles cannot be read back from the canvas)
        var passes = oreCv ? cellPasses(z, R, diskR, palette, oreCv, {
          exact: exactZone(z, full), entities: wantsEntityLayer(z, full), fullSize: full
        }) : null;
        var gpuKind, backend, label;
        // Nauvis: base-game tiles, except under Space Exploration, where the
        // ground is alien-biomes like every other SE surface
        var seNauvis = kind === "nauvis" && (MOD === "se" || MOD === "k2se");
        // (the kernels write finished canvas pixels, transparent off the disk)
        if (kind === "nauvis" && !seNauvis) { gpuKind = "tiles-rgba"; backend = "nauvis-tiles"; label = "nauvis tiles"; }
        else if (z.t === "asteroid-field") { gpuKind = "field-rgba"; backend = "se-field"; label = "asteroid field"; }
        else { gpuKind = "se-rgba"; backend = "se-alien-biomes"; label = "alien biomes"; }
        // field kernel seeds its billows gen with the ZONE's map seed
        var seed = gpuKind === "field-rgba" && z.s != null ? z.s : SEED;

        // The alien-biomes kernel has no starting lake, but every surface
        // with water has one. The lake sits within ~105 tiles of spawn, so
        // the square around spawn is redrawn from the CPU renderer, which has
        // it - once the GPU has drawn the cells under it - and pasted into
        // those cells' terrain before their ore and entities are placed.
        var lake = full && (seNauvis || (kind === "zone" && z.t !== "asteroid-field" && !!z.water && z.water !== "none"));
        var h = Math.min(128, R);
        var underLake = function (c) { return c.x0 < h && c.x1 > -h && c.y0 < h && c.y1 > -h; };
        var lakeLeft = lake ? disk.filter(underLake).length : 0;
        var lakeP = lake ? sendToPool({
          seed: SEED, k2: K2, zone: z, layer: 1, radius: R, palette: "se",
          rect: { x0: -h, y0: -h, x1: h, y1: h }
        }) : null;
        var lakeDrawn = null, lakeGo = null, lakePatch = null;
        if (lake) lakeDrawn = new Promise(function (res) { lakeGo = res; });
        var drawLake = function () {
          lakeP.then(function (r) {
            var W = r.summary.width;
            for (var py = 0; py < W; py++) {
              for (var px = 0; px < W; px++) {
                var dx = px - h, dy = py - h;
                if (dx * dx + dy * dy > diskR * diskR) r.pixels[(py * W + px) * 4 + 3] = 0;
              }
            }
            putImg(tctx, W, r.summary.height, r.pixels, R - h, R - h);
            lakePatch = { x0: -h, y0: -h, w: W, h: r.summary.height, px: r.pixels };
          }, function (e) { console.error("lake patch failed:", e); }).then(lakeGo);
        };
        // a cell's terrain pixels, cut from its GPU block (and the lake patch)
        var cellTerrain = function (g, c) {
          if (!passes || !passes.needTiles || !full) return null;
          var t = cutRect(g.rgba, g.x - R, g.y - R, g.w, c);
          if (lakePatch) pasteRect(t, c, lakePatch);
          return t;
        };

        var tDone = 0, pDone = 0;
        var show = function () { cellStatus(tDone, pDone, disk.length, "gpu: " + label); };
        var placed = [];
        var place = function (c, tiles) {
          if (times.cpuStart == null) times.cpuStart = Date.now() - t0;
          return passes.cell(c, tiles).then(function () {
            if (!c.off) { pDone++; show(); }
          });
        };
        // (the older ore code also places the cells off the disk)
        if (passes) cells.forEach(function (c) { if (c.off) placed.push(place(c, null)); });
        show();
        // The GPU draws a 2x2 block of cells per dispatch: a dispatch has a
        // fixed cost (SE Nauvis: 51 s of terrain one cell at a time, 14 s
        // four at a time). Each cell of a block is placed when the block is in.
        var blocks = {}, order = [];
        disk.forEach(function (c) {
          var k = Math.floor((c.x0 + CELL / 2) / (2 * CELL)) + "," + Math.floor((c.y0 + CELL / 2) / (2 * CELL));
          var b = blocks[k];
          if (!b) { b = blocks[k] = { xa: c.x0, ya: c.y0, xb: c.x1, yb: c.y1, cells: [] }; order.push(b); }
          b.xa = Math.min(b.xa, c.x0); b.ya = Math.min(b.ya, c.y0);
          b.xb = Math.max(b.xb, c.x1); b.yb = Math.max(b.yb, c.y1);
          b.cells.push(c);
        });
        // (disk is nearest-first, so the blocks are too, by their nearest cell)
        return window.generateSurfaceProgressive({
          seed: seed, zone: z, kind: gpuKind, radius: R, diskR: diskR,
          cells: order.map(function (b) { return { xa: b.xa, ya: b.ya, xb: b.xb, yb: b.yb, src: b }; }),
          onCell: function (g) {
            // (the pixels are the canvas's own bytes: no copy)
            var gimg = new ImageData(new Uint8ClampedArray(g.rgba.buffer, g.rgba.byteOffset, g.w * g.h * 4), g.w, g.h);
            if (full) {
              tctx.putImageData(gimg, g.x, g.y);
            } else {
              // downscale: draw the cell through an offscreen canvas
              var cx = cellCanvas(g.w, g.h);
              cx.putImageData(gimg, 0, 0);
              tctx.imageSmoothingEnabled = true;
              tctx.drawImage(cellCv, 0, 0, g.w, g.h, g.x / scaleS, g.y / scaleS, g.w / scaleS, g.h / scaleS);
            }
            tDone += g.src.cells.length;
            show();
            g.src.cells.forEach(function (c) {
              if (lake && underLake(c)) {
                if (--lakeLeft === 0) drawLake();
                placed.push(lakeDrawn.then(function () { return passes ? place(c, cellTerrain(g, c)) : null; }));
              } else if (passes) {
                placed.push(place(c, cellTerrain(g, c)));
              }
            });
          }
        }).then(function (n) {
          times.gpu = Date.now() - t0;
          window.__GPU_STAGE__ = "placing";
          return Promise.all(placed)
            .then(function () { return passes ? passes.done() : {}; })
            .then(function (totals) {
              if (passes) times.cpu = Date.now() - t0;
              window.__GPU_STAGE__ = "done";
              var out = { cells: n, backend: backend, width: disp, height: disp, scale: scaleS, downscaled: !full };
              return { out: out, z: z, totals: totals, times: times };
            });
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
      var ectx = null;
      // cells on the page's grid (whole chunks, see cellPlan), clipped to
      // [-R,R); one request draws a cell's terrain, ore and entities
      var cells = cellPlan(R, 2 * R).map(function (c) {
        return { x0: c.x0, y0: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0 };
      });
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
            if (r.summary.entity_layer && ENEMIES) {
              // third layer: the planet's rocks, trees, plants and nests
              if (!ectx) ectx = enemyOverlay(disp, "Entities").getContext("2d");
              drawEntityCell(r.pixels.subarray(2 * n, 3 * n), r.summary.width, r.summary.height,
                (c.x0 + R) / scale, (c.y0 + R) / scale, r.summary.width / scale, r.summary.height / scale);
            }
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
              (scale > 1 ? " (shown ×1/" + scale.toFixed(1) + ")" : "") + " · CPU " + secs(window.__SURF_MS__) + workersTxt(mpx(4 * R * R, window.__SURF_MS__)) + "</span>";
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
      // the GPU's terrain and the CPU's ore and entities run side by side:
      // each is timed from the start
      var tm = res.times || {};
      // (rates per map tile, so a downscaled surface counts all its tiles)
      var tiles = 4 * radius * radius;
      var gpuTxt = "GPU terrain " + secs(tm.gpu) + " (" + out.cells + (out.cells === 1 ? " dispatch, " : " dispatches, ") + mpx(tiles, tm.gpu) + ")";
      var cpuTxt = tm.cpu != null ? " · CPU " + (ENEMIES ? "ore & entities " : "ore ") + secs(tm.cpu) + workersTxt(mpx(tiles, tm.cpu)) : "";
      els.res.innerHTML =
        (layer === 0 && surfChips(totals) ? surfChips(totals) + " " : "") +
        '<span class="hint">· ' + out.width + "×" + out.height + (out.downscaled ? " (shown at 1/" + out.scale.toFixed(1) + " size: this device's canvas limit)" : "") +
        " · " + gpuTxt + cpuTxt + "</span>";
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
    setBadge("…");
    // ?layer=N optionally preselects the layer (terrain+ore 0 / terrain 1 / ore 2)
    try {
      var _ly = new URLSearchParams(location.search).get("layer");
      if (_ly != null && ["0", "1", "2"].indexOf(_ly) !== -1) els.layer.value = _ly;
    } catch (e2) {}
    adaptForKind();
    if (els.enemy) els.enemy.addEventListener("change", showEnemies);
    if (els.groups) els.groups.addEventListener("change", showEnemies);
    if (els.download) els.download.addEventListener("click", downloadMap);
    var seamsCb = document.getElementById("sf-seams-cb");
    if (seamsCb) seamsCb.addEventListener("change", showSeams);
    if (els.dim) els.dim.addEventListener("input", function () {
      if (els.dimVal) els.dimVal.textContent = els.dim.value + "%";
      compositeSA();
    });
    if (kind === "sa") {
      var p = PLANETS[planetKey];
      els.meta.innerHTML = '<span class="hint">default map settings</span>';
      setBadge("planet");
    } else if (kind === "nauvis") {
      els.meta.innerHTML = '<span class="hint">default map settings</span>';
    } else {
      els.meta.innerHTML = '<span class="hint">resolving universe…</span>';
      fetchZone().then(function (z) {
        zone = z;
        setBadge(z.t);
        // (an asteroid field has none of these layers)
        if (z.t === "asteroid-field" && els.enemyWrap) els.enemyWrap.hidden = true;
        els.meta.innerHTML = zoneMeta(z);
      }).catch(function (e) {
        status(e.message);
        console.error(e);
      });
    }
    // the radius box: read-only where the surface has a radius of its own
    var fixed = kind === "zone" || (kind === "nauvis" && (MOD === "se" || MOD === "k2se"));
    if (els.radiusRow) {
      els.radiusRow.hidden = false;
      els.radiusIn.readOnly = fixed;
      els.radiusIn.title = fixed ? "This surface's radius" : "Half the width of the square drawn, in tiles (16 to 10000)";
      els.goBtn.hidden = fixed;
      var go = function () {
        var v = parseInt(els.radiusIn.value, 10);
        if (!Number.isFinite(v)) { els.radiusIn.value = els.radius.value; return; }
        v = Math.max(16, Math.min(10000, v));
        els.radiusIn.value = v;
        els.radius.value = String(v);
        // kept in the address, so a reload or a shared link draws the same
        var q = new URLSearchParams(location.search);
        q.set("r", v);
        history.replaceState(null, "", location.pathname + "?" + q.toString());
        run();
      };
      els.goBtn.addEventListener("click", go);
      els.radiusIn.addEventListener("keydown", function (e) { if (e.key === "Enter" && !fixed) go(); });
    }
    // An SE zone opened without a radius in the address is drawn whole.
    if (kind === "zone" && RADIUS_INIT == null) {
      fetchZone().then(function (z) {
        els.radius.value = String(Math.round(z.r || (z.t === "asteroid-field" ? 5000 : 2000)));
        run();
      }, function () { run(); });
      return;
    }
    run();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
