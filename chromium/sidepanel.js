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

// Check URL params first
const params = new URLSearchParams(location.search);
if (params.has('port')) {
  redirect(parseInt(params.get('port'), 10));
}

// Also listen for messages
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "redirectSidePanel" && msg.port) {
    redirect(msg.port);
  }
});

// Actively poll the background script
const interval = setInterval(() => {
  chrome.runtime.sendMessage({ type: "getOpencodePort" }, (response) => {
    if (response && response.port) {
      clearInterval(interval);
      redirect(response.port);
    }
  });
}, 200);
