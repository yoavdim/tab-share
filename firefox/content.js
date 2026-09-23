// Tab Share content script
// Listens for custom events from the page and forwards them to the background script.

window.addEventListener("TabShare:OpenSidePanel", (e) => {
  try {
    const path = e.detail && e.detail.path ? e.detail.path : undefined;
    const msg = { type: "openSidePanelFromContent", path };
    if (typeof chrome !== "undefined" && chrome.runtime) {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } else if (typeof browser !== "undefined" && browser.runtime) {
      browser.runtime.sendMessage(msg).catch(() => {});
    }
  } catch (err) {
    console.error("TabShare: Failed to send message to background", err);
  }
});
