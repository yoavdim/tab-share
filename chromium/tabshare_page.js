// Runs in the page's own JS world (manifest "world": "MAIN", top frame only, document_start).
// Defines window.TabShareFetch(endpoint, params) -> Promise<{ok, ...}> and relays the
// call to content.js (isolated world), which forwards it to the extension. This file
// carries no identity: the extension identifies the caller from the browser-supplied
// message sender, so nothing here (or anything a page does) can fake a tabId or url.
(function () {
  if (window.top !== window || window.TabShareFetch) return;
  const pending = new Map();
  let seq = 0;

  window.addEventListener("TabShare:FetchResult", (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch (err) { return; }
    const resolve = d && pending.get(d.id);
    if (!resolve) return;
    pending.delete(d.id);
    resolve(d.result);
  });

  Object.defineProperty(window, "TabShareFetch", {
    configurable: false,
    writable: false,
    value: function TabShareFetch(endpoint, params) {
      return new Promise((resolve) => {
        const id = Date.now() + "-" + (++seq) + "-" + Math.random().toString(36).slice(2);
        pending.set(id, resolve);
        let detail;
        try { detail = JSON.stringify({ id, endpoint, params: params || {} }); }
        catch (err) { pending.delete(id); resolve({ ok: false, error: "params not serializable" }); return; }
        window.dispatchEvent(new CustomEvent("TabShare:Fetch", { detail }));
        setTimeout(() => {
          if (pending.delete(id)) resolve({ ok: false, error: "timeout" });
        }, 60000);
      });
    },
  });
})();
