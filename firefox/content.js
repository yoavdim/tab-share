// Tab Share content script
// Exposes window.TabShareFetch(endpoint, params) -> Promise<result> to the page.
// The page cannot choose its own tabId/url: background.js identifies the caller from
// the browser-supplied message sender, so identity can't be spoofed.
//
// Top frame only: never run inside iframes (manifest also sets all_frames:false).
(function () {
  if (window.top !== window) return;

  // Endpoints: get_split, set_split, get_timers, timer_action, create_timer, open_side_panel.
  // (Validated and restricted in background.js `handlePageFetch`.)
  function callBackground(endpoint, params) {
    if (typeof endpoint !== "string") return Promise.resolve({ ok: false, error: "endpoint required" });
    let p = {};
    try { p = JSON.parse(JSON.stringify(params || {})); } catch (e) {}
    return browser.runtime.sendMessage({ type: "tabShareFetch", endpoint, params: p })
      .then((res) => res || { ok: false, error: "no response" })
      .catch((err) => ({ ok: false, error: String(err && err.message || err) }));
  }

  if (typeof exportFunction === "function") {
    // Firefox: define the function directly in the page's realm.
    const pageWin = window.wrappedJSObject;
    exportFunction(function (endpoint, params) {
      return new pageWin.Promise(exportFunction(function (resolve) {
        callBackground(endpoint, params).then((res) => resolve(cloneInto(res, window)));
      }, window));
    }, window, { defineAs: "TabShareFetch" });
  } else {
    // Chromium: tabshare_page.js (world:"MAIN") defines TabShareFetch and talks to this
    // content script over CustomEvents carrying JSON strings.
    window.addEventListener("TabShare:Fetch", (e) => {
      let req;
      try { req = JSON.parse(e.detail); } catch (err) { return; }
      if (!req || typeof req.id !== "string") return;
      callBackground(req.endpoint, req.params).then((result) => {
        window.dispatchEvent(new CustomEvent("TabShare:FetchResult", {
          detail: JSON.stringify({ id: req.id, result })
        }));
      });
    });
  }
})();
