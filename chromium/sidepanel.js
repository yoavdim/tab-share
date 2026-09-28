function redirect(port) {
  if (port >= 1 && port <= 65535) {
    document.getElementById('loading').style.display = 'none';
    const frame = document.getElementById('frame');
    const targetUrl = 'http://127.0.0.1:' + port + '/';
    // Only set src if it's not already pointing to the same server
    // (We use startsWith to allow for any inner paths the user navigated to)
    if (!frame.src.startsWith(targetUrl)) {
      frame.src = targetUrl;
    }
    frame.style.display = 'block';
  }
}

const params = new URLSearchParams(location.search);
if (params.has('port')) {
  redirect(parseInt(params.get('port'), 10));
} else {
  // Opened directly (via popup toggle or manually). Ask to start session.
    browser.runtime.sendMessage({ type: "startSessionIfNone" });
  
  // Poll until background gets the port
  const interval = setInterval(() => {
    browser.runtime.sendMessage({ type: "getOpencodePort" }, (response) => {
      if (response && response.port) {
        clearInterval(interval);
        redirect(response.port);
      }
    });
  }, 250);
}

// Also listen for messages
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "pingSidePanel") {
    sendResponse({ isOpen: true });
  } else if (msg.type === "redirectSidePanel" && msg.port) {
    redirect(msg.port);
  } else if (msg.type === "sidePanelError" && msg.error) {
    const el = document.getElementById('loading');
    if (el) el.textContent = msg.error;
  }
});
