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

  // Nauvis's radius under Space Exploration with the default map settings:
  // 10000 / 6 * (6 + log2(1 / planet-size frequency / 6)), frequency 1.
  var SE_NAUVIS_RADIUS = 10000 / 6 * (6 - Math.log2(6));

  window.Shell = {
    seNauvisRadius: SE_NAUVIS_RADIUS,
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
})();
