// Client-side seed analysis. Generates a seed's universe in the browser (WASM),
// estimates each zone's ore client-side, and renders the zone table — with NO
// backend per-seed calls (only static assets: universe.wasm, ore-model.json).
// Clicking a row opens that surface's own page (surface.html?seed=&target=),
// which generates terrain + ore in the browser. Seed and mod config come from
// the query string (shell.js).
(function () {
  var estimator = null;   // { estimateZoneOre }
  var MODS = { base: "Base", sa: "Space Age", se: "Space Exploration", k2se: "SE + K2" };
  var state = { mod: MODS[window.Shell.mod] ? window.Shell.mod : "k2se", k2: true, zones: [], sortKey: "dv", sortDir: "asc", q: "", calidus: true, onlyHl: false };
  state.k2 = state.mod === "k2se";

  function loadEstimator() {
    if (estimator) return Promise.resolve(estimator);
    return fetch(window.Shell.asset("ore-model.json")).then(function (r) { return r.json(); })
      .then(function (m) { estimator = window.createEstimator(m); return estimator; });
  }

  var GEN = { planet: 1, moon: 1, "asteroid-field": 1 };

  // Surfaces worth settling for a resource combination: a planet or moon with
  // water and a radius over COMBO_RADIUS that holds every resource of a combo
  // at COMBO_MIN or more (amounts are relative to the primary's, which is 1).
  // Such a row is washed with a gradient of its resources' colours; the first
  // combo is the one the Top seeds list is picked for.
  var COMBO_MIN = 0.05, COMBO_RADIUS = 800;
  var COMBOS = [
    { res: ["se-vulcanite", "se-holmium-ore", "se-cryonite"], colors: ["#f85149", "#ff8fd8", "#58a6ff"] },
    { res: ["se-vitamelange", "stone"], colors: ["#3fb950", "#c2ad7a"], key: "se-vitamelange", keyColor: "#3fb950" }
  ];
  // Resources wanted on a surface of their own: the nearest home-system planet
  // or moon with water whose primary is the resource is marked in its colour.
  var NEAREST_PRIMARY = [
    { res: "se-iridium-ore", color: "#e6b422" },
    { res: "se-beryllium-ore", color: "#39d3d3" }
  ];
  function settleable(z) {
    return (z.t === "planet" || z.t === "moon") && !!z.rs && !!z.water && z.water !== "none" && z.r > COMBO_RADIUS;
  }
  function combosOf(z) {
    if (!settleable(z)) return [];
    return COMBOS.filter(function (c) { return c.res.every(function (r) { return z.rs[r] >= COMBO_MIN; }); });
  }
  function nearestPrimary(zones, res) {
    var best = null;
    zones.forEach(function (z) { if (z.p === res && z.dv != null && (!best || z.dv < best.dv)) best = z; });
    return best;
  }
  // Marks that depend on the whole home system -> [[zone, highlight], ...]:
  // the nearest primaries above, and a stand-in for a combo no surface has -
  // the nearest surface whose primary is the combo's `key` (the resource it
  // is wanted for), in that resource's colour.
  function systemMarks(zones) {
    var home = zones.filter(function (z) { return z.c === 1 && (z.t === "planet" || z.t === "moon") && z.water && z.water !== "none"; });
    var out = [];
    NEAREST_PRIMARY.forEach(function (n) {
      var z = nearestPrimary(home, n.res);
      if (z) out.push([z, { label: "nearest " + nm(n.res) + "-primary surface with water", colors: [n.color, n.color] }]);
    });
    var settle = home.filter(settleable);
    COMBOS.forEach(function (c) {
      if (!c.key || settle.some(function (z) { return combosOf(z).indexOf(c) !== -1; })) return;
      var z = nearestPrimary(settle, c.key);
      if (z) out.push([z, {
        label: "nearest " + nm(c.key) + " surface (this seed has none with " + c.res.map(nm).join(" + ") + ")",
        colors: [c.keyColor, c.keyColor]
      }]);
    });
    return out;
  }
  // The naquium source a seed is judged by: the nearest asteroid field whose
  // primary resource is naquium. Its row gets a wash of its own.
  var NAQ_FIELD = { label: "nearest naquium-primary field", colors: ["#a371f7", "#58a6ff"] };
  function nearestNaqField(zones) {
    var best = null;
    zones.forEach(function (z) {
      if (z.t === "asteroid-field" && z.p === "se-naquium-ore" && z.dv != null && (!best || z.dv < best.dv)) best = z;
    });
    return best;
  }
  // Nauvis is where every game starts, so it is always marked.
  var HOME = { label: "home surface", colors: ["#c9d1d9", "#8b949e"] };
  // What a row is highlighted for (empty = not highlighted).
  function highlightsOf(z, marks) {
    if (z.kind !== "se") return [];
    if (z.nauvis) return [HOME];
    if (z === marks.naqField) return [NAQ_FIELD];
    return combosOf(z).concat(marks.system.filter(function (m) { return m[0] === z; }).map(function (m) { return m[1]; }));
  }

  // Space Age / base surfaces — static row descriptors (the SA data stage has
  // no universe generator; these five surfaces always exist for any seed).
  // kind: "se" = SE universe zone; "surface-nauvis" = Nauvis via the game's
  // default map-gen path (terrain + ores); "sa" = SA planet tile map from the
  // data-driven generator (sa.wasm).
  var SA_SURFACES = [
    { n: "Nauvis",   icon: "🌍", t: "planet", water: "some", enemy: "some", kind: "surface-nauvis" },
    { n: "Vulcanus", icon: "🌋", t: "planet", water: "none", enemy: "yes",  kind: "sa", planet: "vulcanus", ok: true },
    { n: "Fulgora",  icon: "⚡", t: "planet", water: "none", enemy: "none", kind: "sa", planet: "fulgora",  ok: true },
    { n: "Gleba",    icon: "🍄", t: "planet", water: "some", enemy: "yes",  kind: "sa", planet: "gleba",    ok: true },
    { n: "Aquilo",   icon: "🧊", t: "planet", water: "none", enemy: "none", kind: "sa", planet: "aquilo",   ok: true }
  ];

  function listSurfaces() {
    // base → Nauvis only; sa → the five surfaces (Nauvis + 4 SA planets).
    var defs = state.mod === "base" ? SA_SURFACES.slice(0, 1) : SA_SURFACES;
    state.zones = defs.map(function (d) {
      var z = { n: d.n, icon: d.icon, t: d.t, water: d.water, enemy: d.enemy, p: null, r: null, infinity: true, kind: d.kind };
      if (d.kind === "sa") { z.planet = d.planet; z.ok = !!d.ok; z.why = d.why || ""; }
      else if (d.kind === "surface-nauvis") { z.nauvis = true; z.s = state.seed || 0; z.r = 5000; }
      return z;
    });
    renderTable();
    var st = document.getElementById("gen-status");
    if (st) st.textContent = "";
  }
  function nm(r) { return r.replace(/^se-/, "").replace(/^kr-/, "").replace(/-ore$/, ""); }
  function fmt(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n); }
  function fmtDv(v) { return v == null || isNaN(v) ? "—" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v); }
  function cw(w) { return (w || "none").replace(/^water[_-]?/, "") || "none"; }
  function ce(e) { return (e || "none").replace(/^enemy[_-]?/, "").replace("very_", "v") || "none"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // Map a WASM zone to the estimator's shape and estimate its ore.
  function estimateZone(z) {
    return estimator.estimateZoneOre(
      { name: z.n, zone_type: z.t, radius: z.r, water: z.water, primary_resource: z.p, resource_scores: z.rs },
      { k2: state.k2 });
  }

  function resChips(est) {
    var keys = Object.keys(est).sort(function (a, b) { return est[b] - est[a]; });
    if (!keys.length) return '<span class="hint">—</span>';
    return keys.map(function (r) {
      return '<span class="res-chip est ore ore-' + nm(r) + '" title="calibrated estimate">' + nm(r) + ' <strong>~' + fmt(est[r]) + "</strong></span>";
    }).join(" ");
  }

  function applyMod() {} // mod-mode element was removed from the /seed layout

  function sortZones(rows) {
    var k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va, vb;
      if (k === "radius") { va = a.r || 0; vb = b.r || 0; return (va - vb) * dir; }
      if (k === "dv") { va = a.dv == null ? -1 : a.dv; vb = b.dv == null ? -1 : b.dv; return (va - vb) * dir; }
      if (k === "primary") { va = a.p || ""; vb = b.p || ""; }
      else if (k === "type") { va = a.t; vb = b.t; }
      else { va = a.n; vb = b.n; }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  // Dedicated route for generating one surface on its own page.
  function surfHref(z) {
    if (state.seed == null) return null;
    // Open at the zone's ACTUAL radius (disk-cropped to it). Asteroid fields
    // carry no radius in the universe data — open them at 5000 (SE's default
    // field radius). Max SE zone radius is 10000, which is also the page
    // slider max; ?r is clamped to that only. Nauvis carries no ?r: it opens
    // at the surface page's default preview radius.
    var r0 = z.nauvis ? null : z.r ? Math.round(z.r) : (z.t === "asteroid-field" ? 5000 : null);
    return window.Shell.surfaceHref(state.seed, z.n, state.mod, r0 ? Math.min(r0, 10000) : null);
  }
  // True when the row can open a surface (seed present + engine support).
  function rowOpen(z) {
    if (z.kind === "sa") return !!z.ok && state.seed != null;
    return state.seed != null;
  }

  function renderTable() {
    var q = state.q.toLowerCase();
    var rows = state.zones.filter(function (z) {
      // SA/base planet rows pass via GEN (they're "planet" type); SE rows only
      // when their zone type is generatable.
      if (!GEN[z.t]) return false;
      // Default view = the Calidus home system PLUS every asteroid field:
      // fields orbit other stars (incl. the naquium-primary one), so a strict
      // Calidus membership test would drop all of them.
      if (state.calidus && z.kind === "se" && z.c !== 1 && z.t !== "asteroid-field") return false;
      if (!q) return true;
      return (z.n + " " + z.t + " " + (z.p || "")).toLowerCase().indexOf(q) !== -1;
    });
    var marks = { naqField: nearestNaqField(state.zones), system: systemMarks(state.zones) };
    // "Only highlighted" (the static base / Space Age surface lists have no
    // highlights, so it leaves them alone)
    if (state.onlyHl) rows = rows.filter(function (z) { return z.kind !== "se" || highlightsOf(z, marks).length; });
    rows = sortZones(rows);
    var body = rows.map(function (z) {
      var estCell;
      if (z.kind === "se") estCell = resChips(estimateZone(z));
      else estCell = '<span class="hint" title="ore estimates for this surface are not modelled yet">—</span>';
      var gated = z.kind === "sa" && !z.ok ? z.why || "not supported yet" : null;
      var ttl = gated ? esc(z.n) + ": " + esc(gated) : rowOpen(z) ? "Open " + esc(z.n) + " on its own page" : "enter a seed first";
      var combos = highlightsOf(z, marks);
      var cls = (rowOpen(z) ? "" : "row-closed") + (combos.length ? " row-combo" : "");
      // the row is washed with a gradient of its combinations' resource colours
      var rowStyle = "";
      if (combos.length) {
        var colors = [];
        combos.forEach(function (c) { c.colors.forEach(function (col) { if (colors.indexOf(col) === -1) colors.push(col); }); });
        if (colors.length === 1) colors.push(colors[0]); // a gradient needs two stops
        rowStyle = ' style="--combo:linear-gradient(90deg,' + colors.map(function (col) { return col + "55"; }).join(",") + ')"';
        ttl += " — " + combos.map(function (c) { return c.label || c.res.map(nm).join(" + ") + " together"; }).join("; ");
      }
      return '<tr' + (cls ? ' class="' + cls.trim() + '"' : "") + (rowOpen(z) ? ' data-href="' + esc(surfHref(z)) + '"' : (gated ? ' data-why="' + esc(gated) + '"' : '')) + rowStyle + ' title="' + ttl + '">' +
        "<td><strong>" + (z.icon ? z.icon + " " : "") + esc(z.n) + "</strong>" +
          "</td>" +
        '<td><span class="badge zone-type">' + z.t + "</span></td>" +
        "<td>" + (z.infinity ? "∞" : (z.r ? Math.round(z.r) : "—")) + "</td>" +
        "<td class=\"num\">" + fmtDv(z.dv) + "</td>" +
        "<td>" + cw(z.water) + "</td>" +
        "<td>" + ce(z.enemy) + "</td>" +
        "<td>" + (z.p ? '<span class="ore ore-' + nm(z.p) + '">' + nm(z.p) + "</span>" : "—") + "</td>" +
        '<td class="yields-cell">' + estCell + "</td>" +
        "</tr>";
    }).join("");
    document.getElementById("zt-body").innerHTML = body || '<tr><td colspan="8" class="hint">No generatable zones.</td></tr>';
    var zc = document.getElementById("zt-count");
    if (zc) zc.textContent = rows.length +
      (state.zones.length && state.zones[0].kind === "se" ? " zones" : " surfaces");
    document.querySelectorAll("#zt-head .sort-ind").forEach(function (s) { s.textContent = ""; });
    var active = document.querySelector('#zt-head th[data-key="' + state.sortKey + '"] .sort-ind');
    if (active) active.textContent = state.sortDir === "asc" ? " ▲" : " ▼";
  }

  // Best seeds of the seed-search runs for this mod config
  // (featured-seeds.json, exported from the explorer database by
  // scripts/export-featured-seeds.mjs). Shown open until a seed is chosen.
  function loadFeatured() {
    var box = document.getElementById("featured");
    if (!box) return;
    fetch(window.Shell.asset("featured-seeds.json")).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var cfg = data && data.configs && data.configs[state.mod];
        if (!cfg || !cfg.seeds || !cfg.seeds.length) return;
        document.getElementById("featured-note").textContent =
          "· best " + cfg.seeds.length + " of " + Number(cfg.searched).toLocaleString() + " seeds searched (" + window.Shell.modLabel(state.mod) + ")";
        state.featured = cfg.seeds;
        renderFeatured();
        box.hidden = false;
        box.open = state.seed == null;
      })
      .catch(function () {}); // optional data: the page works without it
  }

  // The loot sequence, a letter per module: P productivity, S speed, E efficiency.
  var LOOT = { P: "productivity", S: "speed", E: "efficiency" };
  function lootHtml(loot) {
    return String(loot || "").split("").map(function (c) {
      return LOOT[c] ? '<span class="loot-' + c + '" title="' + LOOT[c] + ' module">' + c + "</span>" : esc(c);
    }).join("");
  }

  // The list arrives best first; a header click sorts by that column instead
  // (every column starts at its high end except the seed number).
  function renderFeatured() {
    var num = function (v) { return v == null ? "—" : Number(v).toLocaleString(); };
    var pct = function (v) { return v == null ? "—" : v + "%"; };
    var k = state.featuredKey, dir = state.featuredDir === "asc" ? 1 : -1;
    var rows = state.featured.slice();
    if (k) rows.sort(function (a, b) {
      var va = a[k], vb = b[k];
      if (va == null || vb == null) return (va == null) - (vb == null); // unknowns last either way
      // loot sorts by how long the sequence is, not by its letters
      if (k === "loot") return (va.length - vb.length) * dir || va.localeCompare(vb) || a.seed - b.seed;
      return (va - vb) * dir || a.seed - b.seed;
    });
    document.getElementById("featured-body").innerHTML = rows.map(function (f) {
      return '<tr data-seed="' + f.seed + '" style="cursor:pointer" title="Open seed ' + f.seed + '">' +
        '<td><a style="color:var(--accent)" href="' + esc(pageHref(f.seed)) + '">' + f.seed + "</a></td>" +
        "<td><strong>" + num(f.score) + "</strong></td><td>" + num(f.planets) + "</td><td>" + num(f.bodies) + "</td>" +
        "<td>" + num(f.naquiumDv) + "</td><td>" + num(f.fieldDv) + "</td>" +
        "<td" + (f.combinedSurface ? ' title="' + esc(f.combinedSurface) + '"' : "") + ">" + num(f.combinedDv) + "</td>" +
        "<td" + (f.combinedSurface ? ' title="' + esc(f.combinedSurface) + '"' : "") + ">" + num(f.combinedRadius) + "</td>" +
        "<td>" + pct(f.hostile) + "</td><td>" + pct(f.water) + "</td>" +
        '<td><code>' + lootHtml(f.loot) + "</code></td></tr>";
    }).join("");
    document.querySelectorAll("#featured-head .sort-ind").forEach(function (el) { el.textContent = ""; });
    var active = k && document.querySelector('#featured-head th[data-key="' + k + '"] .sort-ind');
    if (active) active.textContent = dir === 1 ? " ▲" : " ▼";
  }

  // This page's address for a seed: the mod config, the seed and whether only
  // the highlighted rows are shown (?hl=1), so a reload or a shared link opens
  // the same view.
  function pageHref(seed) {
    return window.Shell.seedHref(seed, state.mod) + (state.onlyHl ? "&hl=1" : "");
  }
  function syncUrl() {
    history.replaceState(null, "", pageHref(state.seed));
  }

  function generate() {
    var seedVal = parseInt(document.getElementById("seed-input").value, 10);
    if (!Number.isFinite(seedVal) || seedVal < 0) return;
    state.seed = seedVal;
    syncUrl();
    var status = document.getElementById("gen-status");
    if (status) status.textContent = "";
    // base / sa: the surfaces are static (no universe to enumerate) — list them.
    if (state.mod === "base" || state.mod === "sa") {
      listSurfaces();
      return;
    }
    status.textContent = "generating…";
    Promise.all([window.generateUniverse(seedVal, state.k2), loadEstimator()])
      .then(function (res) {
        var uni = res[0];
        var zones = uni.z.slice();
        // Synthetic Nauvis (the universe generator never emits it): default-FSR
        // planet, r5000. Estimated client-side (base ores + K2 rare-metal);
        // surface generation uses the game's default map-gen settings (nauvis).
        zones.unshift({ n: "Nauvis", t: "planet", s: seedVal, r: 5000, water: "none", enemy: "none", c: 1, dv: 0, nauvis: true, kind: "se" });
        zones.forEach(function (z) { z.kind = "se"; });
        state.zones = zones;
        status.textContent = uni.z.length + " zones · generated client-side";
        renderTable();
      })
      .catch(function (e) { if (status) status.textContent = "error: " + e.message; console.error(e); });
  }

  function bind() {
    document.getElementById("gen-btn").addEventListener("click", generate);
    document.getElementById("seed-input").addEventListener("keydown", function (e) { if (e.key === "Enter") generate(); });
    document.getElementById("zt-search").addEventListener("input", function (e) { state.q = e.target.value; renderTable(); });
    var calEl = document.getElementById("cal-filter");
    if (calEl) calEl.addEventListener("change", function (e) { state.calidus = e.target.checked; renderTable(); });
    var hlEl = document.getElementById("hl-filter");
    if (hlEl) {
      state.onlyHl = new URLSearchParams(location.search).get("hl") === "1";
      hlEl.checked = state.onlyHl;
      hlEl.addEventListener("change", function (e) {
        state.onlyHl = e.target.checked;
        syncUrl();
        renderTable();
        if (state.featured) renderFeatured(); // its seed links carry the setting
      });
    }
    document.getElementById("zt-head").addEventListener("click", function (e) {
      var thEl = e.target.closest("th[data-key]"); if (!thEl) return;
      var k = thEl.dataset.key;
      state.sortDir = state.sortKey === k && state.sortDir === "asc" ? "desc" : "asc";
      state.sortKey = k; renderTable();
    });
    document.getElementById("zt-body").addEventListener("click", function (e) {
      // Ignore clicks on disabled cells but let anything else on an open row
      // navigate (whole row opens the surface's own page).
      if (e.target.closest("button[disabled]")) return;
      if (e.target.closest("a")) return; // links handle themselves
      var row = e.target.closest("tr[data-href]");
      if (row) { location.href = row.dataset.href; return; }
      // Rows listed before a seed is entered (or not yet supported): explain.
      var closed = e.target.closest("tr.row-closed");
      if (closed) {
        var st = document.getElementById("gen-status");
        if (st) st.textContent = closed.getAttribute("data-why") || "enter a seed first";
      }
    });
    var featuredHead = document.getElementById("featured-head");
    if (featuredHead) featuredHead.addEventListener("click", function (e) {
      var thEl = e.target.closest("th[data-key]");
      if (!thEl || !state.featured) return;
      var k = thEl.dataset.key, first = k === "seed" ? "asc" : "desc";
      state.featuredDir = state.featuredKey === k ? (state.featuredDir === "asc" ? "desc" : "asc") : first;
      state.featuredKey = k;
      renderFeatured();
    });
    var featuredBody = document.getElementById("featured-body");
    if (featuredBody) featuredBody.addEventListener("click", function (e) {
      if (e.target.closest("a")) return; // the link navigates by itself
      var row = e.target.closest("tr[data-seed]");
      if (!row) return;
      document.getElementById("seed-input").value = row.dataset.seed;
      document.getElementById("featured").open = false;
      generate();
    });
    window.preloadUniverseWasm && window.preloadUniverseWasm();
    applyMod();
    var crumb = document.getElementById("seed-crumb");
    if (crumb) crumb.textContent = "Seed (client-side · " + window.Shell.modLabel(state.mod) + ")";
    // Auto-generate / list if a seed was in the URL (?seed=...).
    var pre = window.Shell.seed;
    if (pre != null) state.seed = pre;
    loadFeatured();
    if (pre != null) {
      document.getElementById("seed-input").value = pre;
      generate();
    } else if (state.mod === "sa" || state.mod === "base") {
      listSurfaces();  // static surface lists need no seed
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
