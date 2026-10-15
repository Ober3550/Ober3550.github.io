// Client-side seed analysis. Generates a seed's universe in the browser (WASM),
// estimates each zone's ore client-side, and renders the zone table — with NO
// backend per-seed calls (only static assets: universe.wasm, ore-model.json).
// Clicking a row opens that surface's own page (surface.html?seed=&target=),
// which generates terrain + ore in the browser. Seed and mod config come from
// the query string (shell.js).
(function () {
  var estimator = null;   // { estimateZoneOre }
  var MODS = { base: "Base", sa: "Space Age", se: "Space Exploration", k2se: "SE + K2" };
  var state = { mod: MODS[window.Shell.mod] ? window.Shell.mod : "k2se", k2: true, zones: [], sortKey: "dv", sortDir: "asc", q: "", calidus: true, onlyHl: true, hlCombined: true, hlPrimary: false, hlEnemyMax: "", hlWet: true };
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
    { res: ["se-vulcanite", "se-holmium-ore", "se-cryonite"], colors: ["#f85149", "#ff8fd8", "#58a6ff"],
      // without it, each of the three from its own nearest watered surface
      standIns: [{ res: "se-vulcanite", color: "#f85149" }, { res: "se-holmium-ore", color: "#ff8fd8" }, { res: "se-cryonite", color: "#58a6ff" }] },
    // the pairs a seed without the three-resource surface is settled for
    { res: ["se-vulcanite", "se-iridium-ore"], colors: ["#f85149", "#e6b422"], standIns: [] },
    { res: ["se-cryonite", "se-holmium-ore"], colors: ["#58a6ff", "#ff8fd8"], standIns: [] },
    // vitamelange has to be the surface's primary: the last biological science
    // needs vitamelange core fragments, which only such a surface's core gives
    { res: ["se-vitamelange", "stone"], colors: ["#3fb950", "#c2ad7a"], primary: "se-vitamelange",
      // the resource the pair is wanted for; its stand-in is a settleable surface
      standIns: [{ res: "se-vitamelange", color: "#3fb950", settleable: true }] }
  ];
  // Resources wanted on a surface of their own: the nearest home-system planet
  // or moon with water whose primary is the resource is marked in its colour
  // (a waterless one only when no surface with water has it).
  var NEAREST_PRIMARY = [
    { res: "se-iridium-ore", color: "#e6b422" },
    { res: "se-beryllium-ore", color: "#39d3d3" }
  ];
  // Enemy levels, mildest first. The "exclude enemies" setting names the
  // first level that is too much: a zone at that level or above is passed
  // over by the highlighting, and the next suitable zone is marked instead.
  var ENEMY_LEVELS = ["none", "very_low", "low", "med", "high", "very_high", "max"];
  // (an asteroid field has no enemies and no water to speak of: neither
  // exclusion applies to it)
  function enemyOk(z) {
    var cut = ENEMY_LEVELS.indexOf(state.hlEnemyMax);
    return cut < 0 || z.t === "asteroid-field" || ENEMY_LEVELS.indexOf(z.enemy || "none") < cut;
  }
  // "Exclude zones with no water": a waterless zone is never highlighted,
  // not even as the last resort for a resource no watered zone has.
  function waterOk(z) {
    return !state.hlWet || z.t === "asteroid-field" || (!!z.water && z.water !== "none");
  }
  function settleable(z) {
    return (z.t === "planet" || z.t === "moon") && !!z.rs && !!z.water && z.water !== "none" && z.r > COMBO_RADIUS && enemyOk(z);
  }
  function combosOf(z) {
    if (!settleable(z)) return [];
    return COMBOS.filter(function (c) {
      return (!c.primary || z.p === c.primary) && c.res.every(function (r) { return z.rs[r] >= COMBO_MIN; });
    });
  }
  function nearestPrimary(zones, res) {
    var best = null;
    zones.forEach(function (z) { if (z.p === res && z.dv != null && (!best || z.dv < best.dv)) best = z; });
    return best;
  }
  // Marks that depend on the whole home system -> [[zone, highlight], ...]:
  // the nearest primaries above, and the stand-ins for a combo no surface has -
  // for each of its `standIns`, the nearest surface whose primary is that
  // resource, in the resource's colour.
  function systemMarks(zones) {
    var bodies = zones.filter(function (z) { return z.c === 1 && (z.t === "planet" || z.t === "moon") && enemyOk(z) && waterOk(z); });
    var home = bodies.filter(function (z) { return z.water && z.water !== "none"; });
    var settle = home.filter(settleable);
    var out = [];
    // nearest surface whose primary is `res`: one with water (from `pool`),
    // or as a last resort a waterless one
    function mark(res, color, pool, why) {
      var z = nearestPrimary(pool, res), dry = false;
      if (!z) { z = nearestPrimary(bodies, res); dry = true; }
      if (z) out.push([z, {
        label: "nearest " + nm(res) + "-primary surface" + (dry ? " (none of them has water)" : " with water") + (why ? " — this seed has none with " + why : ""),
        colors: [color, color]
      }]);
    }
    // is `res` part of a combination some surface of this seed holds
    // (other than combination `but`)?
    function covered(res, but) {
      return settle.some(function (z) {
        return combosOf(z).some(function (o) { return o !== but && o.res.indexOf(res) !== -1; });
      });
    }
    // (not for a resource a combination covers: iridium beside vulcanite)
    NEAREST_PRIMARY.forEach(function (n) { if (!covered(n.res, null)) mark(n.res, n.color, home, ""); });
    COMBOS.forEach(function (c) {
      if (settle.some(function (z) { return combosOf(z).indexOf(c) !== -1; })) return;
      c.standIns.forEach(function (n) {
        // no stand-in for a resource another combination of this seed covers
        // (vulcanite by vulcanite + iridium, cryonite and holmium by their pair)
        if (!covered(n.res, c)) mark(n.res, n.color, n.settleable ? settle : home, c.res.map(nm).join(" + "));
      });
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
  // "Primary core resources": every zone whose primary is one of the special
  // resources, in that resource's colour - where its core fragments come from.
  var CORE_PRIMARY = {
    "se-vulcanite": "#f85149", "se-cryonite": "#58a6ff", "se-holmium-ore": "#ff8fd8", "se-iridium-ore": "#e6b422",
    "se-beryllium-ore": "#39d3d3", "se-vitamelange": "#3fb950", "se-naquium-ore": "#a371f7"
  };
  // Nauvis is where every game starts, so it is always marked.
  var HOME = { label: "home surface", colors: ["#c9d1d9", "#8b949e"] };
  // What a row is highlighted for (empty = not highlighted).
  function highlightsOf(z, marks) {
    if (z.kind !== "se") return [];
    if (z.nauvis) return [HOME];
    if (z === marks.naqField) return [NAQ_FIELD];
    var out = [];
    // "Combined resources": the surfaces holding a combination, and the
    // nearest surfaces that stand in where a seed has none
    if (state.hlCombined) out = combosOf(z).concat(marks.system.filter(function (m) { return m[0] === z; }).map(function (m) { return m[1]; }));
    if (state.hlPrimary && CORE_PRIMARY[z.p] && enemyOk(z) && waterOk(z)) out.push({ label: nm(z.p) + "-primary", colors: [CORE_PRIMARY[z.p], CORE_PRIMARY[z.p]] });
    return out;
  }

  // Space Age / base surfaces — static row descriptors (the SA data stage has
  // no universe generator; these five surfaces always exist for any seed).
  // kind: "se" = SE universe zone; "surface-nauvis" = Nauvis via the game's
  // default map-gen path (terrain + ores); "sa" = SA planet tile map from the
  // data-driven generator (sa.wasm).
  var SA_SURFACES = [
    { n: "Nauvis",   icon: "🌍", t: "planet", water: "some", enemy: "some", kind: "surface-nauvis", colors: ["#3fb950", "#58a6ff"] },
    { n: "Vulcanus", icon: "🌋", t: "planet", water: "none", enemy: "yes",  kind: "sa", planet: "vulcanus", ok: true, colors: ["#f85149", "#e6b422"] },
    { n: "Fulgora",  icon: "⚡", t: "planet", water: "none", enemy: "none", kind: "sa", planet: "fulgora",  ok: true, colors: ["#a371f7", "#d24fd0"] },
    { n: "Gleba",    icon: "🍄", t: "planet", water: "some", enemy: "yes",  kind: "sa", planet: "gleba",    ok: true, colors: ["#a4e22a", "#ff8fd8"] },
    { n: "Aquilo",   icon: "🧊", t: "planet", water: "none", enemy: "none", kind: "sa", planet: "aquilo",   ok: true, colors: ["#58a6ff", "#39d3d3"] }
  ];

  function listSurfaces() {
    // base → Nauvis only; sa → the five surfaces (Nauvis + 4 SA planets).
    var defs = state.mod === "base" ? SA_SURFACES.slice(0, 1) : SA_SURFACES;
    state.zones = defs.map(function (d) {
      var z = { n: d.n, icon: d.icon, t: d.t, water: d.water, enemy: d.enemy, p: null, r: null, infinity: true, kind: d.kind, colors: d.colors };
      if (d.kind === "sa") { z.planet = d.planet; z.ok = !!d.ok; z.why = d.why || ""; }
      else if (d.kind === "surface-nauvis") { z.nauvis = true; z.s = state.seed || 0; z.r = 5000; }
      return z;
    });
    renderPlanetCards();
    var st = document.getElementById("gen-status");
    if (st) st.textContent = "";
  }
  // Base / Space Age: the surfaces are the same for every seed and have no
  // universe data worth a table, so each is a card in its planet's colours.
  // A card opens the surface once a seed has been entered.
  function renderPlanetCards() {
    document.getElementById("planet-cards").innerHTML = state.zones.map(function (z) {
      var open = rowOpen(z);
      return '<div class="planet-card' + (open ? "" : " row-closed") + '"' + (open ? ' data-href="' + esc(surfHref(z)) + '"' : "") +
        ' style="--combo:linear-gradient(90deg,' + z.colors.map(function (c) { return c + "66"; }).join(",") + ')"' +
        ' title="' + (open ? "Open " + esc(z.n) + " on its own page" : "enter a seed first") + '">' +
        '<span class="planet-icon">' + z.icon + "</span> " + esc(z.n) + "</div>";
    }).join("");
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
    // slider max; ?r is clamped to that only. Base-game Nauvis has no edge
    // and carries no ?r: it opens at the surface page's default preview
    // radius. Under Space Exploration it is a planet like the others.
    var r0 = z.nauvis && z.kind !== "se" ? null : z.r ? Math.round(z.r) : (z.t === "asteroid-field" ? 5000 : null);
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
        '<td><span class="badge zone-type zt-' + esc(z.t) + '">' + z.t + "</span></td>" +
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
        state.featured = cfg.seeds;
        state.featuredSearched = cfg.searched;
        // one checkbox per productivity-module count the list holds
        var counts = {};
        cfg.seeds.forEach(function (f) { var n = prodCount(f); counts[n] = (counts[n] || 0) + 1; });
        state.featuredProd = {};
        var prodBox = document.getElementById("featured-prod");
        if (prodBox) prodBox.innerHTML = "<span>Productivity modules:</span> " + Object.keys(counts).sort().map(function (n) {
          state.featuredProd[n] = true;
          return '<label class="hint" title="' + counts[n] + " seeds whose loot has " + n + ' productivity modules"><input type="checkbox" data-prod="' + n + '" checked> ' + n + "</label>";
        }).join(" ");
        // and a floor on the planet count
        var planetCounts = {};
        cfg.seeds.forEach(function (f) { planetCounts[f.planets] = true; });
        state.featuredMinPlanets = 0;
        state.featuredLimit = FEATURED_PAGE;
        var planetSel = document.getElementById("featured-planets");
        if (planetSel) planetSel.innerHTML = '<option value="0">any</option>' + Object.keys(planetCounts).map(Number).sort(function (a, b) { return a - b; }).slice(1).map(function (n) {
          return '<option value="' + n + '">&gt;= ' + n + "</option>";
        }).join("");
        document.getElementById("featured-head").innerHTML = "<tr>" + FEATURED_COLS.map(function (c) {
          return "<th" + (c[0] ? ' class="sortable' + (c[3] ? " " + c[3] : "") + '" data-key="' + c[0] + '"' : "") + (c[2] ? ' title="' + esc(c[2]) + '"' : "") + ">" +
            c[1] + (c[0] ? ' <span class="sort-ind"></span>' : "") + "</th>";
        }).join("") + "</tr>";
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

  // One table for every seed, whichever way it covers the special resources.
  // A seed with vulcanite, cryonite and holmium on one surface has that as
  // zone 1 and its iridium surface as zone 2; a seed without has vulcanite +
  // iridium as zone 1 and cryonite + holmium as zone 2. Beryllium and
  // vitamelange + stone are the same for both. Each zone says what it is for.
  // Columns: [sort key, heading, tooltip, header class].
  var FEATURED_COLS = [
    ["seed", "Seed"], ["loot", "Loot", "Loot sequence"],
    ["planets", "Planets", "Planets in the Calidus home system, including Nauvis"],
    ["bodies", "Bodies", "Planets and moons in the Calidus home system"],
    [null, "Zone", "What each line of the zone columns is"],
    ["z1", "Zone 1", "Vulcanite + cryonite + holmium together where the seed has such a surface, vulcanite + iridium otherwise (sorts by its Δv)", "slot"],
    ["z2", "Zone 2", "Iridium beside a three-resource zone 1, cryonite + holmium otherwise (sorts by its Δv)", "slot"],
    ["be", "Beryl", "Nearest watered home-system surface whose primary resource is beryllium (sorts by its Δv)", "slot"],
    ["vs", "Vita + Stone", "Nearest watered home-system surface whose primary resource is vitamelange and that has stone too (sorts by its Δv)", "slot"],
    ["naquiumDv", "Naq Δv", "Travel Δv to the nearest asteroid field whose primary resource is naquium"]
  ];
  var SLOTS = ["z1", "z2", "be", "vs"];
  // what a zone is for: its resources, each in its own colour
  var SLOT_RES = {
    vch: ["vulcanite", "cryonite", "holmium"], vi: ["vulcanite", "iridium"], ch: ["cryonite", "holmium"],
    ir: ["iridium"], be: ["beryllium"], vs: ["vitamelange", "stone"]
  };
  var RES_SHORT = { vulcanite: "Vulc", cryonite: "Cryo", holmium: "Holm", iridium: "Iridium", beryllium: "Beryl", vitamelange: "Vita", stone: "Stone" };
  // One zone: what it is for, its name (a link to the surface), radius,
  // travel Δv from Nauvis and enemy level, a line each. A zone the seed lacks
  // keeps the first line and dashes the rest.
  function slotCell(seed, z) {
    if (!z) return '<div class="slot-lines"><span class="none">—</span></div>';
    var res = (SLOT_RES[z.c] || []).map(function (r) { return '<span class="ore ore-' + r + '">' + RES_SHORT[r] + "</span>"; }).join(" + ");
    if (!z.n) return '<div class="slot-lines"><span>' + res + '</span><span class="none">—</span><span class="none">—</span><span class="none">—</span><span class="none">—</span></div>';
    var e = ce(z.e), level = e === "none" ? "none" : /low/.test(e) ? "low" : /high|max/.test(e) ? "high" : "";
    return '<div class="slot-lines"><span>' + res + "</span>" +
      '<a href="' + esc(window.Shell.surfaceHref(seed, z.n, state.mod, Math.min(z.r, 10000))) + '" title="Open ' + esc(z.n) + " (" + z.t + ')">' + esc(z.n) + "</a>" +
      "<span>" + Number(z.r).toLocaleString() + "</span><span>" + Number(z.dv).toLocaleString() + "</span>" +
      '<span class="' + (level ? "enemy-" + level : "") + '">' + e + "</span></div>";
  }

  // rows drawn at a time: the list runs to a couple of thousand seeds
  var FEATURED_PAGE = 200;
  function prodCount(f) { return String(f.loot || "").split("P").length - 1; }

  // The list arrives best first; a header click sorts by that column instead
  // (every column starts at its high end except the seed number).
  function renderFeatured() {
    var num = function (v) { return v == null ? "—" : Number(v).toLocaleString(); };
    var k = state.featuredKey, dir = state.featuredDir === "asc" ? 1 : -1;
    var rows = state.featured.filter(function (f) {
      return (!state.featuredProd || state.featuredProd[prodCount(f)] !== false) && f.planets >= (state.featuredMinPlanets || 0);
    });
    document.getElementById("featured-note").textContent = "· " + rows.length + " of " +
      Number(state.featuredSearched).toLocaleString() + " seeds searched (" + window.Shell.modLabel(state.mod) + ")";
    if (k) rows.sort(function (a, b) {
      var va = a[k], vb = b[k];
      // a surface column sorts by how far the surface is
      if (va && typeof va === "object") va = va.dv;
      if (vb && typeof vb === "object") vb = vb.dv;
      if (va == null || vb == null) return (va == null) - (vb == null); // unknowns last either way
      // loot sorts by how long the sequence is, not by its letters
      if (k === "loot") return (va.length - vb.length) * dir || va.localeCompare(vb) || a.seed - b.seed;
      return (va - vb) * dir || a.seed - b.seed;
    });
    var total = rows.length;
    rows = rows.slice(0, state.featuredLimit || FEATURED_PAGE);
    document.getElementById("featured-body").innerHTML = rows.map(function (f) {
      return '<tr data-seed="' + f.seed + '" style="cursor:pointer" title="Open seed ' + f.seed + '">' +
        '<td><a style="color:var(--accent)" href="' + esc(pageHref(f.seed)) + '">' + f.seed + "</a></td>" +
        "<td><code>" + lootHtml(f.loot) + "</code></td><td>" + num(f.planets) + "</td><td>" + num(f.bodies) + "</td>" +
        '<td><div class="slot-lines labels"><span>Resources</span><span>Zone</span><span>Radius</span><span>Δv</span><span>Enemy</span></div></td>' +
        SLOTS.map(function (slot) { return "<td>" + slotCell(f.seed, f[slot]) + "</td>"; }).join("") +
        "<td>" + num(f.naquiumDv) + "</td></tr>";
    }).join("") + (total > rows.length ? '<tr class="featured-more"><td colspan="' + FEATURED_COLS.length + '">' +
      '<button type="button" class="btn" data-more="' + FEATURED_PAGE + '">Show ' + Math.min(FEATURED_PAGE, total - rows.length) + " more</button> " +
      '<button type="button" class="btn" data-more="all">Show all ' + total.toLocaleString() + "</button>" +
      ' <span class="hint">showing ' + rows.length + " of " + total.toLocaleString() + "</span></td></tr>" : "");
    document.querySelectorAll("#featured-head .sort-ind").forEach(function (el) { el.textContent = ""; });
    var active = k && document.querySelector('#featured-head th[data-key="' + k + '"] .sort-ind');
    if (active) active.textContent = dir === 1 ? " ▲" : " ▼";
  }

  // This page's address for a seed: the mod config, the seed and whether only
  // the highlighted rows are shown (on unless ?hl=0), so a reload or a shared link opens
  // the same view.
  function pageHref(seed) {
    return window.Shell.seedHref(seed, state.mod) + (state.onlyHl ? "" : "&hl=0") +
      (state.hlCombined ? "" : "&cmb=0") + (state.hlPrimary ? "&pri=1" : "") + (state.hlEnemyMax ? "&en=" + state.hlEnemyMax : "") + (state.hlWet ? "" : "&wet=0");
  }
  function syncUrl() {
    history.replaceState(null, "", pageHref(state.seed));
  }

  function generate() {
    // a pasted seed often comes with spaces, separators or a label: keep the
    // digits only (the field is plain text so the browser does not reject it)
    var input = document.getElementById("seed-input");
    var digits = String(input.value || "").replace(/[^0-9]/g, "");
    input.value = digits;
    var seedVal = digits ? parseInt(digits, 10) : NaN;
    var genStatus = document.getElementById("gen-status");
    if (!Number.isFinite(seedVal)) { if (genStatus) genStatus.textContent = "enter a seed number"; return; }
    if (seedVal > 4294967295) { if (genStatus) genStatus.textContent = "a map seed is at most 4294967295"; return; }
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
        // the universe's loot sequence, in the card with the other settings
        var lootRow = document.getElementById("seed-loot-row");
        if (lootRow) {
          lootRow.hidden = !uni.l;
          document.getElementById("seed-loot").innerHTML = lootHtml(uni.l);
        }
        var zones = uni.z.slice();
        // Synthetic Nauvis (the universe generator never emits it): default-FSR
        // planet, r5000. Estimated client-side (base ores + K2 rare-metal);
        // surface generation uses the game's default map-gen settings (nauvis).
        // Its water and enemies are the map's own settings; with the defaults
        // (every control 1 / 1 / 1) those are what SE's tags call water "med"
        // and enemy "high".
        zones.unshift({ n: "Nauvis", t: "planet", s: seedVal, r: window.Shell.seNauvisRadius, water: "med", enemy: "high", c: 1, dv: 0, nauvis: true, kind: "se" });
        zones.forEach(function (z) { z.kind = "se"; });
        // Without Krastorio 2 its resources do not exist: the generator still
        // rolls a share for them (the roll keeps the others' in step), which
        // must not reach the estimates.
        if (!state.k2) zones.forEach(function (z) {
          if (z.rs) Object.keys(z.rs).forEach(function (r) { if (r.indexOf("kr-") === 0) delete z.rs[r]; });
        });
        state.zones = zones;
        status.textContent = "";
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
      state.onlyHl = new URLSearchParams(location.search).get("hl") !== "0";
      hlEl.checked = state.onlyHl;
      hlEl.addEventListener("change", function (e) {
        state.onlyHl = e.target.checked;
        syncUrl();
        renderTable();
        if (state.featured) renderFeatured(); // its seed links carry the setting
      });
    }
    // what is highlighted: both kept in the address, like "Only highlighted"
    [["hl-combined", "hlCombined", "cmb", true], ["hl-primary", "hlPrimary", "pri", false], ["hl-wet", "hlWet", "wet", true]].forEach(function (spec) {
      var el = document.getElementById(spec[0]);
      if (!el) return;
      var v = new URLSearchParams(location.search).get(spec[2]);
      state[spec[1]] = v == null ? spec[3] : v !== "0";
      el.checked = state[spec[1]];
      el.addEventListener("change", function (e) {
        state[spec[1]] = e.target.checked;
        syncUrl();
        renderTable();
        if (state.featured) renderFeatured();
      });
    });
    var enEl = document.getElementById("hl-enemy");
    if (enEl) {
      var en = new URLSearchParams(location.search).get("en");
      state.hlEnemyMax = ENEMY_LEVELS.indexOf(en) > 0 ? en : "";
      enEl.innerHTML = '<option value="">none</option>' + ENEMY_LEVELS.slice(1).map(function (l, i) {
        return '<option value="' + l + '">' + (i === ENEMY_LEVELS.length - 2 ? "= " : "&gt;= ") + ce(l) + "</option>";
      }).join("");
      enEl.value = state.hlEnemyMax;
      enEl.addEventListener("change", function (e) {
        state.hlEnemyMax = e.target.value;
        syncUrl();
        renderTable();
        if (state.featured) renderFeatured();
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
    document.getElementById("planet-cards").addEventListener("click", function (e) {
      var card = e.target.closest(".planet-card");
      if (!card) return;
      if (card.dataset.href) { location.href = card.dataset.href; return; }
      var st = document.getElementById("gen-status");
      if (st) st.textContent = "enter a seed first";
    });
    // the zone table and its filters belong to the Space Exploration universe
    var staticMod = state.mod === "sa" || state.mod === "base";
    document.getElementById("zone-table").hidden = staticMod;
    document.querySelectorAll(".se-only").forEach(function (el) { el.hidden = staticMod; });
    var featuredHead = document.getElementById("featured-head");
    if (featuredHead) featuredHead.addEventListener("click", function (e) {
      var thEl = e.target.closest("th[data-key]");
      if (!thEl || !state.featured) return;
      // (a surface column starts with the nearest surface)
      var k = thEl.dataset.key, first = k === "seed" || SLOTS.indexOf(k) !== -1 ? "asc" : "desc";
      state.featuredDir = state.featuredKey === k ? (state.featuredDir === "asc" ? "desc" : "asc") : first;
      state.featuredKey = k;
      renderFeatured();
    });
    var featuredProd = document.getElementById("featured-prod");
    if (featuredProd) featuredProd.addEventListener("change", function (e) {
      var cb = e.target.closest("input[data-prod]");
      if (!cb || !state.featuredProd) return;
      state.featuredProd[cb.dataset.prod] = cb.checked;
      renderFeatured();
    });
    var featuredPlanets = document.getElementById("featured-planets");
    if (featuredPlanets) featuredPlanets.addEventListener("change", function (e) {
      state.featuredMinPlanets = +e.target.value;
      state.featuredLimit = FEATURED_PAGE;
      renderFeatured();
    });
    var featuredBody = document.getElementById("featured-body");
    if (featuredBody) featuredBody.addEventListener("click", function (e) {
      var more = e.target.closest("button[data-more]");
      if (more) {
        state.featuredLimit = more.dataset.more === "all" ? Infinity : (state.featuredLimit || FEATURED_PAGE) + FEATURED_PAGE;
        renderFeatured();
        return;
      }
      if (e.target.closest("a")) return; // the link navigates by itself
      var row = e.target.closest("tr[data-seed]");
      if (!row) return;
      document.getElementById("seed-input").value = row.dataset.seed;
      document.getElementById("featured").open = false;
      generate();
    });
    // Mod config: changing it reloads the page with ?mod= swapped (the seed
    // and the other settings in the address are kept).
    var modEl = document.getElementById("mod-select");
    if (modEl) {
      modEl.innerHTML = Object.keys(MODS).map(function (m) {
        return '<option value="' + m + '"' + (m === state.mod ? " selected" : "") + ">" + esc(MODS[m]) + "</option>";
      }).join("");
      modEl.addEventListener("change", function (e) {
        var p = new URLSearchParams(location.search);
        p.set("mod", e.target.value);
        location.href = location.pathname + "?" + p.toString();
      });
    }
    window.preloadUniverseWasm && window.preloadUniverseWasm();
    applyMod();
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
