// Shared shell for the static pages (index.html = seed, surface.html).
//
// The pages are plain files: everything they need to know (seed, surface
// name, mod config) comes from the query string, and every asset is loaded
// relative to this script's own location, so the same folder works at the
// root of a site, under a project path (GitHub Pages) or under the Node
// server's /static/ mount.
//
// A published build keeps the two HTML pages at the top and everything else
// in a versioned sub-folder (scripts/build-pages.mjs), so page links resolve
// against the document and assets against this script.
//
//   window.Shell = { base, pages, mod, seed, target, modLabel(m), asset(name),
//                    seedHref(seed, mod), surfaceHref(seed, target, mod, r) }
(function () {
  var MODS = { base: "Base", sa: "Space Age", se: "Space Exploration", k2se: "SE + K2" };
  var here = document.currentScript && document.currentScript.src;
  var base = here ? new URL(".", here).href : new URL(".", location.href).href;
  var pages = new URL(".", location.href).href; // where index.html / surface.html live
  var q = new URLSearchParams(location.search);

  var mod = q.get("mod") || "";
  if (mod === "se+k2") mod = "k2se"; // legacy alias
  if (!MODS[mod]) mod = "k2se";
  var seedQ = q.get("seed");
  var seed = /^\d+$/.test(seedQ || "") ? parseInt(seedQ, 10) : null;
  var target = (q.get("target") || "").trim();

  function seedHref(s, m) {
    var u = pages + "index.html?mod=" + encodeURIComponent(m || mod);
    if (s != null) u += "&seed=" + encodeURIComponent(s);
    return u;
  }
  function surfaceHref(s, t, m, r) {
    var u = pages + "surface.html?seed=" + encodeURIComponent(s) + "&target=" + encodeURIComponent(t) +
      "&mod=" + encodeURIComponent(m || mod);
    if (r) u += "&r=" + encodeURIComponent(r);
    return u;
  }

  window.Shell = {
    base: base,
    pages: pages,
    mod: mod,
    seed: seed,
    target: target,
    mods: MODS,
    modLabel: function (m) { return MODS[m] || m; },
    asset: function (name) { return base + name; },
    seedHref: seedHref,
    surfaceHref: surfaceHref
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  // Sidebar: mod selector + the seed link. The job / database pages only exist
  // when the Node server is serving this folder (it mounts it at /static/).
  function buildSidebar() {
    var nav = document.getElementById("sidebar");
    if (!nav) return;
    var served = /\/static\/$/.test(new URL(base).pathname);
    var opts = Object.keys(MODS).map(function (m) {
      return '<option value="' + m + '"' + (m === mod ? " selected" : "") + ">" + esc(MODS[m]) + "</option>";
    }).join("");
    var extra = served
      ? '<li><a href="/seeds?mod=' + encodeURIComponent(mod) + '">Seeds</a></li>' +
        '<li><a href="/presets?mod=' + encodeURIComponent(mod) + '">Filter Presets</a></li>'
      : "";
    nav.innerHTML =
      "<h1>🌌 Surface Explorer</h1>" +
      '<label class="modcfg">Mod config <select id="mod-nav">' + opts + "</select></label>" +
      '<ul class="nav-links">' +
      '<li><a href="' + esc(seedHref(seed, mod)) + '" title="Seed → universe → surface, entirely in your browser">🌍 Seed</a></li>' +
      extra + "</ul>";
    // changing the mod config reloads the same page with ?mod= swapped
    document.getElementById("mod-nav").addEventListener("change", function (e) {
      var p = new URLSearchParams(location.search);
      p.set("mod", e.target.value);
      location.href = location.pathname + "?" + p.toString();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildSidebar);
  else buildSidebar();
})();
