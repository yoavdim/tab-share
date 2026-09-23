// Native host status
fetch("http://127.0.0.1:8766/tabs")
  .then(r => r.json())
  .then(d => {
    const el = document.getElementById("status");
    el.textContent = `✓ ${d.tabs?.length ?? 0} tab${d.tabs?.length === 1 ? "" : "s"} on :8766`;
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

// Active opencode sessions
chrome.runtime.sendMessage({ type: "getEmbeds" }, (res) => {
  if (!res || !res.servers) return;
  const servers = res.servers;
  const section = document.getElementById("servers-section");
  const list = document.getElementById("servers-list");
  const toggleBtn = document.getElementById("toggle-panel");

  section.style.display = "block";

  if (servers.length === 0) {
    list.innerHTML = '<div class="no-servers">No active sessions</div>';
    return;
  }

  // Show toggle button when there's at least one session
  toggleBtn.style.display = "block";

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
});

// Toggle side panel
document.getElementById("toggle-panel").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggleSidePanel" });
  window.close();
});

