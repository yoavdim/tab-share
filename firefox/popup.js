// Determine the correct API namespace and port
const IS_FIREFOX = navigator.userAgent.includes("Firefox");
const PORT = IS_FIREFOX ? 8765 : 8766;

// Native host status
fetch(`http://127.0.0.1:${PORT}/tabs`)
  .then(r => r.json())
  .then(d => {
    const el = document.getElementById("status");
    el.textContent = `✓ ${d.tabs?.length ?? 0} tab${d.tabs?.length === 1 ? "" : "s"} on :${PORT}`;
    el.className = "status-line ok";
  })
  .catch(() => {
    const el = document.getElementById("status");
    el.textContent = "✗ Native host not responding";
    el.className = "status-line err";
  });

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Determine the correct API namespace

// Toggle side panel
document.getElementById("toggle-panel").addEventListener("click", () => {
  if (browser.sidePanel) {
    browser.windows.getCurrent().then(win => {
      // Ping the side panel to see if it is running
      browser.runtime.sendMessage({ type: "pingSidePanel" }, (response) => {
        // Clear lastError if side panel isn't listening (meaning it's closed)
        const err = browser.runtime.lastError;
        
        if (response && response.isOpen) {
          // It's open, so close it by disabling and re-enabling globally
          browser.sidePanel.setOptions({ enabled: false }).then(() => {
            browser.sidePanel.setOptions({ enabled: true });
          });
        } else {
          // It's closed, so open it
          browser.sidePanel.open({ windowId: win.id }).catch(e => console.error(e));
          // Start session if none running
          browser.runtime.sendMessage({ type: "startSessionIfNone" }).catch(() => {});
        }
        window.close();
      });
    });
  } else if (browser.sidebarAction) {
    browser.sidebarAction.toggle().catch(e => console.error(e));
    browser.runtime.sendMessage({ type: "startSessionIfNone" }).catch(() => {});
    window.close();
  }
});

// Active opencode sessions
browser.runtime.sendMessage({ type: "getEmbeds" }, (res) => {
  if (!res || !res.servers) return;
  const servers = res.servers;
  const section = document.getElementById("servers-section");
  const list = document.getElementById("servers-list");
  const toggleBtn = document.getElementById("toggle-panel");

  section.style.display = "block";

  if (servers.length === 0) {
    list.innerHTML = '<div class="no-servers">No active sessions</div>';
  } else {
    list.innerHTML = servers.map(s => {
    const parts = s.path ? s.path.split("/") : [];
    const name = parts[parts.length - 1] || s.path || "unknown";
    const homePath = s.path ? s.path.replace(/^\/home\/[^/]+/, "~") : "";
    return `
      <div class="server-item">
        <div class="server-dot"></div>
        <div class="server-info">
          <div class="server-name">${escHtml(name)}</div>
          <div class="server-path">${escHtml(homePath)}</div>
        </div>
        <div class="server-port">:${s.port}</div>
      </div>`;
    }).join("");
  }
});

