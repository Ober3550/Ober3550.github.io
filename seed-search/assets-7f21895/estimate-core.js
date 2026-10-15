// Calibrated ore-count estimator — shared by the Node server (ore-estimate.js)
// and the browser (client-side seed page). UMD: exposes createEstimator(MODEL).
//
// MOON / PLANET model (hybrid — see ore-model.json). Per resource in a zone:
//   scored .................... est = KS[res][water] · score · R^B
//   unscored, always-present .. est = PMED[primary][water][res] · R^B
//   scored AND always-present . est = max(scoreEst, PLO[...] · R^B)
// The surface generator places base ores on EVERY surface but the universe
// generator only scores a few per zone, so the profile fills the unscored base
// ores. R^B (B≈1.49): ore concentrates near spawn, density falls with radius.
// Validation: 95% completeness, median 1.06, 72% within 2×, 87% within 3×.
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else global.createEstimator = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Asteroid fields: fixed per-primary yield table (72 real fields).
  const FIELD_TABLE = {
    "iron-ore":         { "iron-ore": 4404894871, "copper-ore": 31755627, "uranium-ore": 25666816, "stone": 39003574, "se-water-ice": 107276695, "se-methane-ice": 26686499, "se-naquium-ore": 2255302 },
    "copper-ore":       { "iron-ore": 83401512, "copper-ore": 3546134734, "uranium-ore": 6964197, "stone": 45140736, "se-water-ice": 32676733, "se-methane-ice": 26861364, "se-naquium-ore": 1899967 },
    "uranium-ore":      { "iron-ore": 112688602, "copper-ore": 17527549, "uranium-ore": 238708086, "stone": 126128929, "se-water-ice": 96525271, "se-methane-ice": 50691211, "se-naquium-ore": 4065844 },
    "stone":            { "iron-ore": 92836852, "copper-ore": 49959145, "uranium-ore": 8313636, "stone": 3639079371, "se-water-ice": 15408638, "se-methane-ice": 7492264, "se-naquium-ore": 8596839 },
    "se-water-ice":     { "iron-ore": 113781583, "copper-ore": 256575057, "uranium-ore": 5930279, "stone": 10357259, "se-water-ice": 1270070251, "se-methane-ice": 23819319, "se-naquium-ore": 11162724 },
    "se-methane-ice":   { "iron-ore": 273810829, "copper-ore": 15599559, "uranium-ore": 9236802, "stone": 56494476, "se-water-ice": 49263144, "se-methane-ice": 1307228748, "se-naquium-ore": 9418998 },
    "se-naquium-ore":   { "iron-ore": 140188911, "copper-ore": 138791388, "uranium-ore": 15134597, "stone": 41379171, "se-water-ice": 5779695, "se-methane-ice": 67516506, "se-naquium-ore": 262188281 },
    "kr-rare-metal-ore":{ "iron-ore": 28763922, "copper-ore": 52206181, "uranium-ore": 19344573, "stone": 73357469, "se-water-ice": 37940902, "se-methane-ice": 139188278, "se-naquium-ore": 4269053 },
  };
  // Nauvis: synthetic (default 1/1/1 FSR, r5000). K2 adds rare-metal-ore;
  // mineral-water is a fluid the ore path doesn't count.
  const NAUVIS_BASE = { "iron-ore": 720891788, "copper-ore": 645692931, "coal": 502851057, "stone": 643189231, "uranium-ore": 61560588 };
  const NAUVIS_K2 = { "kr-rare-metal-ore": 430267684 };
  const MAX_RADIUS = 5000, DISPLAY_MIN = 1e6;

  // Build an estimator bound to a calibration MODEL ({ B, KS, PMED, PLO }).
  return function createEstimator(MODEL) {
    const otherW = w => (w === "none" ? "water" : "none");
    const ksOf = (res, w) => (MODEL.KS[res] || {})[w] != null ? (MODEL.KS[res] || {})[w] : (MODEL.KS[res] || {})[otherW(w)];
    const profOf = (T, p, w) => (T[p] || {})[w] || (T[p] || {})[otherW(w)] || {};

    // zone: { name, zone_type, radius, water, primary_resource, resource_scores }
    // resource_scores may be an object (browser: zone.rs) or a JSON string (DB).
    function estimateZoneOre(zone, opts) {
      if (!zone) return {};
      if (zone.name === "Nauvis") {
        const out = {};
        for (const r in NAUVIS_BASE) if (NAUVIS_BASE[r] >= DISPLAY_MIN) out[r] = NAUVIS_BASE[r];
        if (opts && opts.k2) for (const r in NAUVIS_K2) if (NAUVIS_K2[r] >= DISPLAY_MIN) out[r] = NAUVIS_K2[r];
        return out;
      }
      if (zone.zone_type === "asteroid-field") {
        const t = FIELD_TABLE[zone.primary_resource], out = {};
        if (t) for (const r in t) if (t[r] >= DISPLAY_MIN) out[r] = t[r];
        return out;
      }
      const R = Math.min(Math.round(zone.radius || 0), MAX_RADIUS);
      if (!R) return {};
      const rB = Math.pow(R, MODEL.B);
      const w = (!zone.water || zone.water === "none") ? "none" : "water";
      let scores = zone.resource_scores;
      if (typeof scores === "string") { try { scores = JSON.parse(scores); } catch (_) { scores = null; } }
      const out = {};
      if (scores && typeof scores === "object") {
        for (const res in scores) {
          const sc = scores[res];
          if (!(sc > 0)) continue;
          const k = ksOf(res, w);
          if (k) out[res] = k * sc * rB;
        }
      }
      const pmed = profOf(MODEL.PMED, zone.primary_resource, w);
      const plo = profOf(MODEL.PLO, zone.primary_resource, w);
      for (const res in pmed) {
        if (out[res] == null) out[res] = pmed[res] * rB;
        else out[res] = Math.max(out[res], (plo[res] || 0) * rB);
      }
      const f = {};
      for (const res in out) if (out[res] >= DISPLAY_MIN) f[res] = Math.round(out[res]);
      return f;
    }
    return { estimateZoneOre: estimateZoneOre, FIELD_TABLE: FIELD_TABLE, MODEL: MODEL };
  };
});
