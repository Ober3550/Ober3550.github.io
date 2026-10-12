// Main-thread bridge to the generation worker (gen-worker.js). All heavy
// generation — the universe (universe.wasm) and zone surfaces (surface.wasm) —
// runs off the main thread so the page never blocks. Loaded BEFORE
// universe-wasm.js / surface-wasm.js, which are now thin proxies over
// window.__genCall.
//
//   window.__genEnsure()        → spawn the worker (and start its wasm fetches)
//   window.__genCall(t, payload) → Promise of { id, ok, universe|summary|pixels }
//                                  (resolves with the full reply message)
(function () {
  // assets sit next to this script, wherever the folder is served from
  var BASE = (window.Shell && window.Shell.base) ||
    (document.currentScript && document.currentScript.src ? new URL(".", document.currentScript.src).href : "");
  var worker = null;
  var nextId = 1;
  var pending = {}; // id -> { resolve, reject }

  function ensure() {
    if (worker) return worker;
    worker = new Worker(BASE + "gen-worker.js");
    worker.onmessage = function (ev) {
      var msg = ev.data;
      if (!msg || msg.id == null) return; // ignore worker-only notices
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || "generation worker error"));
    };
    worker.onerror = function (e) {
      // Fail every in-flight call; the next call respawns a fresh worker.
      var err = new Error("generation worker crashed: " + (e.message || "unknown"));
      Object.keys(pending).forEach(function (id) { pending[id].reject(err); });
      pending = {};
      worker.terminate();
      worker = null;
    };
    return worker;
  }

  window.__genEnsure = ensure;

  window.__genCall = function (type, payload) {
    var w = ensure();
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      try {
        w.postMessage(Object.assign({ id: id, type: type }, payload || {}));
      } catch (err) {
        delete pending[id];
        reject(err);
      }
    });
  };
})();
