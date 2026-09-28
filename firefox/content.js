// Tab Share content script
// Listens for custom events from the page and forwards them to the background script.

window.addEventListener("TabShare:OpenSidePanel", (e) => {
  try {
    const path = e.detail && e.detail.path ? e.detail.path : undefined;
    const msg = { type: "openSidePanelFromContent", path };
    browser.runtime.sendMessage(msg).catch(() => {});
    window.dispatchEvent(new CustomEvent("TabShare:SidePanelBlocked", { detail: { message: "Please click the extension icon." } }));
  } catch (err) {
    console.error("TabShare: Failed to send message to background", err);
  }
});
