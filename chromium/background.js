// Tab Share — Chromium MV3 service worker.
// Mirrors the Firefox extension's commands (tabs/groups/open/navigate/extract/eval/group)
// but uses the chrome.* namespace and chrome.scripting. Containers are NOT supported on
// Chromium, so contextualIdentities / cookieStoreId handling is intentionally omitted.
// /opencode opens the opencode web UI in the side panel (chrome.sidePanel).

let port = null;
let connecting = false;

function connect() {
  // Guard against the MV3 connection storm: never open a second native port.
  // A live native-messaging port also keeps the service worker alive, which is
  // exactly what we want, so we hold a single connection for the SW's lifetime.
  if (port || connecting) return;
  connecting = true;
  try {
    port = chrome.runtime.connectNative("tab_share");
  } catch (e) {
    port = null;
    connecting = false;
    return;
  }
  connecting = false;
  port.onDisconnect.addListener(() => {
    port = null;
    // Reconnect only if we're not already mid-connect; small delay avoids a tight loop.
    setTimeout(connect, 3000);
  });
  port.onMessage.addListener(handleCommand);
  sendTabs();
}

function ensurePort() {
  if (!port) connect();
}

async function sendTabs() {
  ensurePort();
  if (!port) return;
  try {
    const win = await chrome.windows.getCurrent();
    const allTabs = await chrome.tabs.query({ windowId: win.id });
    const activeTab = allTabs.find(t => t.active);
    // splitViewId (Chrome 137+) is shared by both panes of a split view; expose it plus
    // id/active/index so callers can find a tab's split partner without relying on order.
    const shape = t => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: !!t.active,
      index: t.index,
      splitViewId: (t.splitViewId !== undefined ? t.splitViewId : null),
    });
    port.postMessage({
      type: "tabs",
      activeTab: activeTab ? shape(activeTab) : null,
      tabs: allTabs.map(shape),
    });
  } catch (e) {}
}

async function handleGroups(msg) {
  try {
    const groups = await chrome.tabGroups.query({});
    port.postMessage({ type: "result", id: msg.id, groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color })) });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Chromium has no Multi-Account Containers — report an empty list so callers degrade gracefully.
async function handleContainers(msg) {
  port.postMessage({ type: "result", id: msg.id, containers: [], note: "containers unsupported on Chromium" });
}

async function findOrCreateGroup(tabId, groupName, windowId) {
  const groups = await chrome.tabGroups.query({ title: groupName, windowId });
  if (groups.length > 0) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    return groups[0].id;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: groupName });
  return groupId;
}

async function handleOpen(msg) {
  try {
    const { url, groupName } = msg;
    const win = await chrome.windows.getCurrent();
    const allTabs = await chrome.tabs.query({ windowId: win.id });
    let tab = allTabs.find(t => t.url === url || t.url === url + "/");
    if (!tab) {
      tab = await chrome.tabs.create({ url, windowId: win.id });
    }
    const groupId = await findOrCreateGroup(tab.id, groupName, win.id);
    port.postMessage({ type: "result", id: msg.id, ok: true, groupId, tabId: tab.id });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function resolveTab(msg) {
  const win = await chrome.windows.getCurrent();
  const allTabs = await chrome.tabs.query({ windowId: win.id });
  if (msg.tabId) {
    const t = allTabs.find(t => t.id === msg.tabId);
    if (t) return t;
  }
  if (msg.url) {
    const t = allTabs.find(t => t.url === msg.url || t.url === msg.url + "/");
    if (t) return t;
  }
  return allTabs.find(t => t.active);
}

async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return t;
    await new Promise(r => setTimeout(r, 400));
  }
  return chrome.tabs.get(tabId);
}

// Injected into the page to extract text + interactive elements (MV3 func injection).
function extractPage() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const links = [...document.querySelectorAll('a[href]')].filter(vis).map(a => ({ text: (a.innerText || '').trim().slice(0, 100), href: a.href })).filter(x => x.text || x.href).slice(0, 200);
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')].filter(vis).map(b => ({ text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 100) })).filter(x => x.text).slice(0, 100);
  const inputs = [...document.querySelectorAll('input, select, textarea')].filter(vis).map(i => ({ name: i.name || '', id: i.id || '', type: i.type || i.tagName.toLowerCase(), placeholder: i.placeholder || '' })).slice(0, 100);
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), links, buttons, inputs };
}

async function handleExtract(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    const data = results && results.length ? results[0].result : {};
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, ...data });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// ---- CSP-safe DOM access (/query, /scroll) ---------------------------------

// CSP-safe alternative to /eval: runs in the extension's isolated world.
// Keep in sync with firefox/background.js.
function queryElements(selector) {
  let els;
  try {
    els = document.querySelectorAll(selector);
  } catch (e) {
    return { error: "invalid selector: " + String(e) };
  }
  const items = Array.from(els, el => el.outerHTML);
  return { count: items.length, items: items, ready: document.readyState };
}

// Scroll to the bottom of the window, or of the first match's innermost scrollable
// ancestor. mode "wiggle" nudges up first to restart a stalled lazy-loader.
function scrollPage(selector, mode) {
  try {
    if (!selector) {
      window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
      return { ok: true, position: "window", ready: document.readyState };
    }
    let c;
    try {
      c = document.querySelector(selector);
    } catch (e) {
      return { error: "invalid selector: " + String(e) };
    }
    if (!c) return { ok: true, position: "no-match", ready: document.readyState };
    let el = c;
    while (el && el.scrollHeight <= el.clientHeight + 50 && el.parentElement) {
      el = el.parentElement;
    }
    if (mode === "wiggle") {
      // Unconditional: the point is to jolt a stalled loader even when the walk
      // found nothing scrollable.
      if (!el) return { ok: true, position: "none", ready: document.readyState };
      el.scrollTop = Math.max(0, el.scrollTop - 600);
      el.scrollTop = el.scrollHeight;
      return { ok: true, position: el.scrollTop + "/" + el.scrollHeight,
               ready: document.readyState };
    }
    // Only scroll a genuinely scrollable ancestor — otherwise the walk's fallback
    // (documentElement) would scroll the whole page instead.
    if (el && el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
    return { ok: true,
             position: el ? (el.scrollTop + "/" + el.scrollHeight) : "none",
             ready: document.readyState };
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleQuery(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: queryElements,
      args: [msg.selector],
    });
    const out = results && results.length ? results[0].result : null;
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, url: tab.url, result: out });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function handleScroll(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollPage,
      args: [msg.selector || null, msg.mode || null],
    });
    const out = results && results.length ? results[0].result : null;
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, url: tab.url, result: out });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// MV3 cannot inject arbitrary code strings. We wrap the requested code in a function
// that evals it in the page world. This requires the page CSP to allow it; on strict-CSP
// pages /eval may fail — prefer /extract for content scraping.
function evalInPage(code) {
  try {
    // eslint-disable-next-line no-eval
    return { ok: true, value: (0, eval)(code) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function handleEval(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: evalInPage,
      args: [msg.code],
    });
    const out = results && results.length ? results[0].result : null;
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, url: tab.url, result: out });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function handleNavigate(msg) {
  try {
    const win = await chrome.windows.getCurrent();
    let tab;
    if (msg.newTab) {
      tab = await chrome.tabs.create({ url: msg.url, windowId: win.id });
    } else {
      tab = await resolveTab(msg);
      if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
      await chrome.tabs.update(tab.id, { url: msg.url, active: true });
    }
    const final = await waitForLoad(tab.id, msg.timeoutMs || 30000);
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: final.id, url: final.url, title: final.title, status: final.status });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function handleGroup(msg) {
  try {
    const { tabUrl, groupName } = msg;
    const win = await chrome.windows.getCurrent();
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const tab = tabs.find(t => t.url === tabUrl);
    if (!tab) {
      port.postMessage({ type: "result", id: msg.id, error: "Tab not found" });
      return;
    }
    const groupId = await findOrCreateGroup(tab.id, groupName, win.id);
    port.postMessage({ type: "result", id: msg.id, ok: true, groupId });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Close tabs — SAFETY-GATED. A tab is closed only if it matches ALL of:
//   - selector: tabId(s) and/or url(s) (at least one required),
//   - expectHost: the tab URL's hostname must equal this (the "DNS part") — REQUIRED,
//   - expectGroup: the tab's group title must equal this; pass null/"" to require the tab
//     be UNGROUPED — REQUIRED (use the sentinel "*" to explicitly skip the group check).
// This prevents closing the wrong tab when a tabId is stale/reused or a URL matched broadly.
function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return null; } }

async function handleClose(msg) {
  try {
    if (msg.expectHost == null) {
      port.postMessage({ type: "result", id: msg.id, error: "expectHost required (safety)" });
      return;
    }
    if (msg.expectGroup === undefined) {
      port.postMessage({ type: "result", id: msg.id, error: "expectGroup required (name, or null for ungrouped, or \"*\" to skip)" });
      return;
    }
    const win = await chrome.windows.getCurrent();
    const allTabs = await chrome.tabs.query({ windowId: win.id });

    // resolve group titles once
    const groups = await chrome.tabGroups.query({ windowId: win.id });
    const groupTitle = {};
    groups.forEach(g => { groupTitle[g.id] = g.title || ""; });

    // 1) candidate selection by tabId and/or url. As a special case, a concrete
    // expectGroup (not "*") with NO tabId/url selects every tab in that group — the
    // "close the whole Scratch group" flow. (Still host-gated below.)
    const ids = msg.tabId != null ? (Array.isArray(msg.tabId) ? msg.tabId : [msg.tabId]) : null;
    const urls = msg.url != null ? (Array.isArray(msg.url) ? msg.url : [msg.url]) : null;
    const skipGroup = msg.expectGroup === "*";
    const selectWholeGroup = !ids && !urls && !skipGroup;  // expectGroup is the selector
    if (!ids && !urls && skipGroup) {
      port.postMessage({ type: "result", id: msg.id, error: "tabId or url required when expectGroup is \"*\"" });
      return;
    }

    const closed = [], rejected = [];
    for (const t of allTabs) {
      const selected = selectWholeGroup ||
                       (ids && ids.includes(t.id)) ||
                       (urls && urls.some(u => t.url === u || t.url === u + "/" ||
                                               (msg.prefix && t.url && t.url.startsWith(u))));
      if (!selected) continue;
      // 2) SAFETY: host must match
      if (hostOf(t.url) !== msg.expectHost) { rejected.push({ id: t.id, why: "host-mismatch", host: hostOf(t.url) }); continue; }
      // 3) SAFETY: group must match (null/"" => ungrouped; "*" => skip)
      if (!skipGroup) {
        const gid = (t.groupId != null && t.groupId !== -1) ? t.groupId : null;
        const title = gid == null ? null : (groupTitle[gid] || "");
        const want = (msg.expectGroup === null || msg.expectGroup === "") ? null : msg.expectGroup;
        if (title !== want) { rejected.push({ id: t.id, why: "group-mismatch", group: title }); continue; }
      }
      closed.push(t.id);
    }
    if (closed.length) await chrome.tabs.remove(closed);
    port.postMessage({ type: "result", id: msg.id, ok: true, closed, rejected });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Per-port auth map for /opencode servers. Keyed by port number, value is {password, tabId}.
// Passwords flow here from native_host via native messaging only — never via the web page.
// The webRequest.onAuthRequired listener below uses this map.
const embedAuthMap = new Map(); // port (number) -> {password, tabId}

// We store the latest port here temporarily to handle the race condition
// where the Python script responds before sidepanel.html finishes loading.
let latestOpencodePort = null;

// Open the opencode side panel for the requesting tab.
async function handleOpenSidePanel(msg) {
  const logToTab = (m) => {
    if (msg.tabId) {
      chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        func: (mStr) => console.log("TabShare BG (handleOpenSidePanel):", mStr),
        args: [m]
      }).catch(()=>{});
    }
  };

  try {
    logToTab("Received openSidePanel from native host, port=" + msg.port);
    latestOpencodePort = msg.port;
    const path = `sidepanel.html?port=${msg.port}`;
    
    // Only call open() if we haven't opened it yet, because open() without a user
    // gesture throws an error. We must call this synchronously BEFORE any await!
    let openPromise = null;
    if (!sidePanelOpenTabs.has(msg.tabId)) {
      logToTab("sidePanel wasn't marked as open, calling open()...");
      openPromise = chrome.sidePanel.open({ windowId: msg.windowId });
      sidePanelOpenTabs.add(msg.tabId);
    }

    // Set options globally (no tabId) so it persists across tab switches
    await chrome.sidePanel.setOptions({ path, enabled: true });
    
    if (openPromise) {
      await openPromise;
    }
    
    // Changing the query string via setOptions doesn't always trigger a reload if the 
    // panel is already open to the base HTML. We send a message to force the redirect.
    chrome.runtime.sendMessage({ type: "redirectSidePanel", port: msg.port }).catch((e) => logToTab("sendMessage error: " + e));
    
    if (msg.id) port.postMessage({ type: "result", id: msg.id, ok: true });
    logToTab("Successfully processed openSidePanel");
  } catch (e) {
    logToTab("handleOpenSidePanel error: " + e);
    console.error("handleOpenSidePanel error:", e);
    if (msg.id) port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Track which tabs have the side panel open (best-effort; user closing via X
// makes the state stale, but the next toggle click self-corrects).
const sidePanelOpenTabs = new Set();

// popup.html sends getEmbeds to list active opencode sessions, and
// toggleSidePanel to open/close the panel from the popup button.
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "getEmbeds") {
    const servers = [];
    for (const [p, entry] of embedAuthMap) {
      servers.push({ port: p, path: entry.path, tabId: entry.tabId });
    }
    sendResponse({ servers });
  } else if (req.type === "toggleSidePanel") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        if (sidePanelOpenTabs.has(tab.id)) {
          // Close: disable then re-enable so it can be opened again later.
          await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
          sidePanelOpenTabs.delete(tab.id);
          await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true });
        } else {
          // Open: find the first active session's port.
          let activePort = null;
          for (const [p] of embedAuthMap) { activePort = p; break; }
          if (activePort) {
            const path = `sidepanel.html?port=${activePort}`;
            await chrome.sidePanel.setOptions({ tabId: tab.id, path, enabled: true });
            await chrome.sidePanel.open({ tabId: tab.id });
            sidePanelOpenTabs.add(tab.id);
          }
        }
      } catch (e) {}
    })();
    sendResponse({ ok: true });
  } else if (req.type === "openSidePanelFromContent") {
    // Fired from content script during a user click
    (async () => {
      const logToTab = (msg) => {
         if (sender.tab && sender.tab.id) {
           chrome.scripting.executeScript({
             target: { tabId: sender.tab.id },
             func: (m) => console.log("TabShare BG:", m),
             args: [msg]
           }).catch(()=>{});
         }
      };

      try {
        const tab = sender.tab;
        if (!tab) { logToTab("Error: No tab"); return; }
        
        const isAllowed = tab.url.startsWith("file://") || 
                          tab.url.startsWith("http://127.0.0.1") ||
                          tab.url.startsWith("http://localhost") ||
                          tab.url.startsWith("https://yoavdim.github.io");
        
        if (!isAllowed) { logToTab("Error: Origin not allowed: " + tab.url); return; }

        // Open the panel immediately (must not await anything before calling .open() 
        // to preserve the user gesture passed from the content script)
        chrome.sidePanel.open({ tabId: tab.id }).catch(e => logToTab("sidePanel.open error: " + e));
        sidePanelOpenTabs.add(tab.id);
        
        logToTab("Opening side panel...");

        if (port) {
          logToTab("Sending startOpencode to native host...");
          port.postMessage({ type: "startOpencode", tabId: sender.tab.id, windowId: sender.tab.windowId, path: req.path });
        } else {
          logToTab("Error: Native host port is disconnected!");
        }
      } catch (e) {
        logToTab("Failed to open side panel from content script: " + e);
        console.error("Failed to open side panel from content script", e);
      }
    })();
    sendResponse({ ok: true });
  } else if (req.type === "getOpencodePort") {
    sendResponse({ port: latestOpencodePort });
    return true;
  }
  return true;  // keep channel open for async sendResponse
});

// Silently supply opencode's Basic Auth challenge when the request targets a known
// /opencode port on 127.0.0.1 and originates from the tab that called /opencode.
// The side panel does a top-level navigation so we no longer restrict to frameId !== 0.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    const url = new URL(details.url);
    if (url.hostname !== "127.0.0.1") { callback({}); return; }
    const entry = embedAuthMap.get(parseInt(url.port, 10));
    if (entry && (details.tabId === entry.tabId || details.tabId === -1)) {
      callback({ authCredentials: { username: "opencode", password: entry.password } });
    } else {
      callback({});
    }
  },
  { urls: ["http://127.0.0.1/*", "ws://127.0.0.1/*", "wss://127.0.0.1/*"] },
  ["asyncBlocking"]
);

function handleCommand(msg) {
  if (!port) return;
  switch (msg.type) {
    case "groups": return handleGroups(msg);
    case "open": return handleOpen(msg);
    case "containers": return handleContainers(msg);
    case "eval": return handleEval(msg);
    case "query": return handleQuery(msg);
    case "scroll": return handleScroll(msg);
    case "navigate": return handleNavigate(msg);
    case "extract": return handleExtract(msg);
    case "group": return handleGroup(msg);
    case "close": return handleClose(msg);
    case "openSidePanel": return handleOpenSidePanel(msg);
    case "injectEmbedAuth": embedAuthMap.set(msg.port, { password: msg.password, tabId: msg.tabId, path: msg.path }); return;
    case "removeEmbedAuth": embedAuthMap.delete(msg.port); return;
  }
}

// Keep tab state fresh. Service workers can be suspended, so use an alarm (min 0.5s in dev,
// clamped by Chrome to ~30s for unpacked) plus event-driven pushes.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("tab-share-poll", { periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tab-share-poll") sendTabs(); });
chrome.tabs.onUpdated.addListener(sendTabs);
chrome.tabs.onRemoved.addListener(sendTabs);
chrome.tabs.onCreated.addListener(sendTabs);
chrome.tabs.onActivated.addListener(sendTabs);

connect();
