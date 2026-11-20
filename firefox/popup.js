// Determine the correct API namespace and port
const IS_FIREFOX = navigator.userAgent.includes("Firefox");
const PORT = IS_FIREFOX ? 8765 : 8766;

// Split-mode badge: show when the active tab is a page-API-eligible tab in a split view.
browser.runtime.sendMessage({ type: "getSplitMode" }, (res) => {
  if (browser.runtime.lastError) return;
  if (res && res.splitMode) {
    document.getElementById("split-badge").style.display = "inline-block";
  }
});

// Native host status + live tab count from the background script.
browser.runtime.sendMessage({ type: "getTabCount" }, (res) => {
  const el = document.getElementById("status");
  if (browser.runtime.lastError || !res || !res.ok) {
    el.textContent = "✗ Native host not responding";
    el.className = "status-line err";
    return;
  }
  const count = res.count;
  el.textContent = `✓ ${count} tab${count === 1 ? "" : "s"} on :${PORT}`;
  el.className = "status-line ok";
});

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Toggle side panel
document.getElementById("toggle-panel").addEventListener("click", () => {
  if (browser.sidePanel) {
    browser.windows.getCurrent().then(win => {
      browser.runtime.sendMessage({ type: "pingSidePanel" }, (response) => {
        const err = browser.runtime.lastError;
        if (response && response.isOpen) {
          browser.sidePanel.setOptions({ enabled: false }).then(() => {
            browser.sidePanel.setOptions({ enabled: true });
          });
        } else {
          browser.sidePanel.open({ windowId: win.id }).catch(e => console.error(e));
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

// ---- TabTimer popup logic ----

function renderTimers(timers) {
  const el = document.getElementById("timer-list");
  if (!el) return;
  if (!timers || timers.length === 0) {
    el.innerHTML = '<div class="timer-empty">No timer tabs open</div>';
    return;
  }
  el.innerHTML = timers.map(t => {
    const isUp = t.direction === "up";
    const running = !!t.isRunning;
    return `<div class="timer-row">
      <span class="timer-dir ${isUp ? "up" : "down"}">${isUp ? "▲" : "▼"}</span>
      <span class="timer-val">${escHtml(t.value || "--:--")}</span>
      <span class="timer-badge ${running ? "badge-run" : "badge-pause"}">${running ? "run" : "paused"}</span>
      <span class="timer-spacer"></span>
      <button class="timer-btn" data-tid="${t.tabId}" data-act="toggle">${running ? "❚❚" : "▶"}</button>
      <button class="timer-btn" data-tid="${t.tabId}" data-act="reset">↺</button>
      <button class="timer-btn" data-tid="${t.tabId}" data-act="goto">↗</button>
    </div>`;
  }).join("");

  el.querySelectorAll(".timer-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = parseInt(btn.dataset.tid, 10);
      const act = btn.dataset.act;
      if (act === "goto") {
        browser.tabs.update(tabId, { active: true });
        browser.tabs.get(tabId).then(tab => {
          if (tab && tab.windowId) browser.windows.update(tab.windowId, { focused: true });
        }).catch(() => {});
        return;
      }
      browser.runtime.sendMessage({ type: "timerAction", action: act, tabId }, () => {
        loadTimers();
      });
    });
  });
}

function loadTimers() {
  browser.runtime.sendMessage({ type: "getTimerTabs" }, (res) => {
    if (browser.runtime.lastError) return;
    renderTimers(res ? res.timerTabs : []);
  });
}

// Event-driven: background broadcasts timerTabsChanged on tab create/remove/update.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "timerTabsChanged") loadTimers();
});

// Also poll every second for live value updates (popup is short-lived).
loadTimers();
setInterval(loadTimers, 1000);

// ▲ button: new count-up timer
document.getElementById("btn-up").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "createTimerTab", value: "stoper", direction: "up" });
});

// ▼ button: new countdown timer
document.getElementById("btn-down").addEventListener("click", () => {
  const val = (document.getElementById("timer-down-val").value || "").trim();
  browser.runtime.sendMessage({
    type: "createTimerTab",
    value: val || "5:00",
    direction: "down",
  });
});
