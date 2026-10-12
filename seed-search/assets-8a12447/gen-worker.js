// Generation worker: runs ALL heavy generation off the main thread so the
// analyze page never blocks — the universe (universe.wasm) and zone surfaces
// (surface.wasm) are the same WASM binaries the old inline loaders used, with
// identical results (bit-identical to native segen).
//
// Speaks the gen-bridge.js protocol: { id, type: "universe"|"surface", ... } →
// { id, ok, ... }. Surface pixel buffers are copied and transferred back
// (zero-copy across the worker boundary); they're a copy because the wasm arena
// resets on the next call.
(function () {
  function loadWasm(url) {
    return fetch(url)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (bytes) { return WebAssembly.instantiate(bytes, {}); });
  }

  // Each module is fetched and instantiated on its first use, and only then:
  // a worker that draws surface cells never needs the universe generator, and
  // every instance counts against the browser's limit of about a hundred live
  // wasm instances per site. (URLs are relative to this worker script, so the
  // folder can be served from anywhere.)
  var loaded = {};
  function wasm(name) {
    if (!loaded[name]) loaded[name] = loadWasm(name);
    return loaded[name];
  }

  function generateUniverse(seed, k2) {
    return wasm("universe.wasm").then(function (inst) {
      var e = inst.instance.exports;
      e.generate(seed >>> 0, k2 ? 1 : 0);
      var bytes = new Uint8Array(e.memory.buffer, e.resultPtr(), e.resultLen());
      return JSON.parse(new TextDecoder("utf-8").decode(bytes));
    });
  }

  function generateSA(req) {
    return wasm("sa.wasm").then(function (inst) {
      var e = inst.instance.exports;
      var bytes = new TextEncoder().encode(JSON.stringify(req));
      if (bytes.length > e.inputCap()) {
        if (!e.growInput(bytes.length)) throw new Error("sa wasm: input buffer grow failed");
      }
      var mem = new Uint8Array(e.memory.buffer);
      mem.set(bytes, e.inputPtr());
      e.generate(bytes.length);
      var summary = JSON.parse(new TextDecoder("utf-8").decode(
        new Uint8Array(e.memory.buffer, e.resultPtr(), e.resultLen())));
      if (!summary.ok) throw new Error(summary.error || "sa generation failed");
      var pixels = new Uint8Array(e.memory.buffer, e.pixelsPtr(), e.pixelsLen());
      return { summary: summary, pixels: new Uint8Array(pixels) };
    });
  }

  // `tiles`: optional bytes for the module's second input buffer (the rect's
  // terrain pixels, for a request with tiles_in)
  function generateSurface(req, tiles) {
    return wasm("surface.wasm").then(function (inst) {
      var e = inst.instance.exports;
      var bytes = new TextEncoder().encode(JSON.stringify(req));
      // growInput may grow wasm memory → re-create the view afterwards.
      if (bytes.length > e.inputCap()) {
        if (!e.growInput(bytes.length)) throw new Error("surface wasm: input buffer grow failed");
      }
      if (tiles) {
        if (!e.growTilesIn(tiles.length)) throw new Error("surface wasm: tile buffer grow failed");
        new Uint8Array(e.memory.buffer).set(tiles, e.tilesInPtr());
      }
      var mem = new Uint8Array(e.memory.buffer);
      mem.set(bytes, e.inputPtr());
      e.generateSurface(bytes.length);
      var summary = JSON.parse(new TextDecoder("utf-8").decode(
        new Uint8Array(e.memory.buffer, e.resultPtr(), e.resultLen())));
      if (!summary.ok) throw new Error(summary.error || "surface generation failed");
      // Copy the pixels out of wasm memory (valid only until the next call)
      // into a plain transferable array.
      var pixels = new Uint8Array(e.memory.buffer, e.pixelsPtr(), e.pixelsLen());
      return { summary: summary, pixels: new Uint8Array(pixels) };
    });
  }

  function errMsg(e) { return (e && e.message) || String(e); }

  self.onmessage = function (ev) {
    var msg = ev.data;
    // { preload: "universe.wasm" }: start loading a module ahead of its first call
    if (msg && msg.preload) { wasm(msg.preload).catch(function () {}); return; }
    if (!msg || msg.id == null) return;
    if (msg.type === "universe") {
      generateUniverse(msg.seed, msg.k2).then(
        function (u) { self.postMessage({ id: msg.id, ok: true, universe: u }); },
        function (e) { self.postMessage({ id: msg.id, ok: false, error: errMsg(e) }); }
      );
    } else if (msg.type === "sa") {
      generateSA(msg.req).then(
        function (r) {
          self.postMessage({ id: msg.id, ok: true, summary: r.summary, pixels: r.pixels }, [r.pixels.buffer]);
        },
        function (e) { self.postMessage({ id: msg.id, ok: false, error: errMsg(e) }); }
      );
    } else if (msg.type === "surface") {
      generateSurface(msg.req, msg.tiles).then(
        function (r) {
          self.postMessage({ id: msg.id, ok: true, summary: r.summary, pixels: r.pixels }, [r.pixels.buffer]);
        },
        function (e) { self.postMessage({ id: msg.id, ok: false, error: errMsg(e) }); }
      );
    }
  };
})();
