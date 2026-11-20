// tabtimer.js — content script for TabTimer pages.
// Bridges extension messages (from background/popup) to the page's timerAPI
// CustomEvent interface. Runs in the content script isolated world; the page
// responds via CustomEvent which crosses the world boundary on the shared DOM.

(function () {
  const TIMER_URL_PREFIX = "https://yoavdim.github.io/TabTimer";

  // Only run on TabTimer pages, never inside iframes.
  if (window.top !== window) return;
  if (!location.href.startsWith(TIMER_URL_PREFIX)) return;

  function getTimerState(opts) {
    return new Promise(function (resolve) {
      var resolved = false;
      function handler(e) {
        if (resolved) return;
        resolved = true;
        window.removeEventListener("timerAPI:response", handler);
        resolve(e.detail || null);
      }
      window.addEventListener("timerAPI:response", handler);
      window.dispatchEvent(new CustomEvent("timerAPI:request", { detail: opts || {} }));
      // Timeout: if page hasn't loaded the script yet, resolve with null.
      setTimeout(function () {
        if (!resolved) {
          resolved = true;
          window.removeEventListener("timerAPI:response", handler);
          resolve(null);
        }
      }, 600);
    });
  }

  function doTimerAction(action, value) {
    window.dispatchEvent(new CustomEvent("timerAPI:action", {
      detail: { action: action, value: value }
    }));
  }

  // Listen for messages from the background / popup.
  browser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    if (msg.type === "GET_TIMER_STATE") {
      getTimerState({ include_log: !!msg.include_log }).then(function (state) {
        sendResponse(state);
      });
      return true; // async sendResponse
    }

    if (msg.type === "TIMER_ACTION") {
      doTimerAction(msg.action, msg.value);
      // Give the page a tick to process, then read back the new state.
      setTimeout(function () {
        getTimerState().then(function (state) {
          sendResponse({ ok: true, state: state });
        });
      }, 50);
      return true;
    }
  });

  // Listen for timerAPI:timesup event from the webpage and forward to background script.
  window.addEventListener("timerAPI:timesup", function (e) {
    browser.runtime.sendMessage({
      type: "TIMES_UP",
      detail: e ? e.detail : {}
    });
  });
})();
