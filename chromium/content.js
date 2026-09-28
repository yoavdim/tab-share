// Tab Share content script
// Listens for custom events from the page and forwards them to the background script.

window.addEventListener("TabShare:OpenSidePanel", (e) => {
  try {
    const path = e.detail && e.detail.path ? e.detail.path : undefined;
    const msg = { type: "openSidePanelFromContent", path };
    browser.runtime.sendMessage(msg).then((res) => {
      // In Firefox, sidebarAction.open() is strictly forbidden from content scripts, 
      // so it always fails silently on the background side.
      const isFirefox = navigator.userAgent.includes("Firefox");
      if (!res || !res.ok || isFirefox) {
        window.dispatchEvent(new CustomEvent("TabShare:SidePanelBlocked", { detail: { message: "Firefox requires clicking the extension icon." } }));
      }
    }).catch(() => {});
  } catch (err) {
    console.error("TabShare: Failed to send message to background", err);
  }
});
