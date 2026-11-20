// Unified background script for Chromium MV3 and Firefox MV2.
const IS_FIREFOX = browser.runtime.getManifest().manifest_version === 2;


// Tab Share — Chromium MV3 service worker.
// Mirrors the Firefox extension's commands (tabs/groups/open/navigate/extract/eval/group)
// but uses the browser.* namespace and browser.scripting. Containers are NOT supported on
// Chromium, so contextualIdentities / cookieStoreId handling is intentionally omitted.
// /opencode opens the opencode web UI in the side panel (browser.sidePanel).

let port = null;
let connecting = false;

function connect() {
  // Guard against the MV3 connection storm: never open a second native port.
  // A live native-messaging port also keeps the service worker alive, which is
  // exactly what we want, so we hold a single connection for the SW's lifetime.
  if (port || connecting) return;
  connecting = true;
  try {
    port = browser.runtime.connectNative("tab_share");
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
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });
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
    const groups = await browser.tabGroups.query({});
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
  const groups = await browser.tabGroups.query({ title: groupName, windowId });
  if (groups.length > 0) {
    await browser.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
    return groups[0].id;
  }
  const groupId = await browser.tabs.group({ tabIds: [tabId] });
  await browser.tabGroups.update(groupId, { title: groupName });
  return groupId;
}

async function handleOpen(msg) {
  try {
    const { url, groupName } = msg;
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });
    let tab = allTabs.find(t => t.url === url || t.url === url + "/");
    if (!tab) {
      tab = await browser.tabs.create({ url, windowId: win.id });
    }
    const groupId = await findOrCreateGroup(tab.id, groupName, win.id);
    port.postMessage({ type: "result", id: msg.id, ok: true, groupId, tabId: tab.id });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function resolveTab(msg) {
  const win = await browser.windows.getCurrent();
  const allTabs = await browser.tabs.query({ windowId: win.id });
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
    const t = await browser.tabs.get(tabId);
    if (t.status === "complete") return t;
    await new Promise(r => setTimeout(r, 400));
  }
  return browser.tabs.get(tabId);
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
    const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
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
  // Filter out top-level form field elements and strip nested ones from others
  // to prevent leaking field values via outerHTML.
  const SENSITIVE = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const items = Array.from(els)
    .filter(el => !SENSITIVE.has(el.tagName))
    .map(el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, script, style").forEach(i => i.remove());
      return clone.outerHTML;
    });
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
    const results = await browser.scripting.executeScript({
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
    const results = await browser.scripting.executeScript({
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
    const results = await browser.scripting.executeScript({
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
    const win = await browser.windows.getCurrent();
    let tab;
    if (msg.newTab) {
      tab = await browser.tabs.create({ url: msg.url, windowId: win.id });
    } else {
      tab = await resolveTab(msg);
      if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
      await browser.tabs.update(tab.id, { url: msg.url, active: true });
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
    const win = await browser.windows.getCurrent();
    const tabs = await browser.tabs.query({ windowId: win.id });
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
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });

    // resolve group titles once
    const groups = await browser.tabGroups.query({ windowId: win.id });
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
    if (closed.length) await browser.tabs.remove(closed);
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
      browser.scripting.executeScript({
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
    if (browser.sidePanel) {
      logToTab("calling sidePanel.open()...");
      openPromise = browser.sidePanel.open({ windowId: msg.windowId }).catch(e => logToTab("sidePanel.open error (expected if no gesture): " + e));
    } else if (browser.sidebarAction) {
      openPromise = browser.sidebarAction.open().catch(()=>{});
    }

    // Set options globally (no tabId) so it persists across tab switches
    await browser.sidePanel.setOptions({ path, enabled: true });
    
    if (openPromise) {
      await openPromise;
    }
    
    // Changing the query string via setOptions doesn't always trigger a reload if the 
    // panel is already open to the base HTML. We send a message to force the redirect.
    browser.runtime.sendMessage({ type: "redirectSidePanel", port: msg.port }).catch((e) => logToTab("sendMessage error: " + e));
    
    if (msg.id) port.postMessage({ type: "result", id: msg.id, ok: true });
    logToTab("Successfully processed openSidePanel");
  } catch (e) {
    logToTab("handleOpenSidePanel error: " + e);
    console.error("handleOpenSidePanel error:", e);
    if (msg.id) port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// tracked completely locally within popup.js now.

// popup.html sends getEmbeds to list active opencode sessions, and
// toggleSidePanel to open/close the panel from the popup button.
browser.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "getEmbeds") {
    const servers = [];
    for (const [p, entry] of embedAuthMap) {
      servers.push({ port: p, path: entry.path, tabId: entry.tabId });
    }
    sendResponse({ servers });

  } else if (req.type === "getTabCount") {
    if (!port) { sendResponse({ ok: false }); return; }
    browser.tabs.query({ currentWindow: true })
      .then(tabs => sendResponse({ ok: true, count: tabs.length }))
      .catch(() => sendResponse({ ok: false }));
    return true;

  } else if (req.type === "startSessionIfNone") {
    // Internal event from popup or sidepanel
    if (!sender.tab && embedAuthMap.size === 0) {
      if (port) {
        port.postMessage({ type: "startOpencode", tabId: null, windowId: null, path: undefined });
      } else {
        browser.runtime.sendMessage({ type: "sidePanelError", error: "Native host disconnected." }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
  } else if (req.type === "getOpencodePort") {
    sendResponse({ port: latestOpencodePort });
  } else if (req.type === "getTimerTabs" && !sender.tab) {
    handleGetTimerTabs(req).then(timerTabs => sendResponse({ timerTabs }));
    return true;
  } else if (req.type === "createTimerTab" && !sender.tab) {
    handleCreateTimerTab(req).then(res => sendResponse(res));
    return true;
  } else if (req.type === "timerAction" && !sender.tab) {
    handleTimerAction(req).then(res => sendResponse(res));
    return true;
  } else if (req.type === "getSplitMode") {
    browser.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab) { sendResponse({ splitMode: false }); return; }
      if (isPageApiUrl(tab.url)) {
        const partner = await findSplitPartner(tab);
        sendResponse({ splitMode: partner !== null });
      } else {
        const partner = await findSplitPartner(tab);
        sendResponse({ splitMode: partner !== null && isPageApiUrl(partner.url) });
      }
    }).catch(() => sendResponse({ splitMode: false }));
    return true;
  } else if (req.type === "tabShareFetch") {
    // From content.js TabShareFetch(). Identity comes from `sender`, never from the page.
    handlePageFetch(req, sender).then(res => sendResponse(res));
    return true;
  }
});

// Silently supply opencode's Basic Auth challenge when the request targets a known
// /opencode port on 127.0.0.1 and originates from the tab that called /opencode.
// The side panel does a top-level navigation so we no longer restrict to frameId !== 0.
browser.webRequest.onAuthRequired.addListener(
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

// ---- TabTimer integration ----

const TIMER_URL_PREFIX = "https://yoavdim.github.io/TabTimer";
const timerCallerMap = new Map(); // caller tabId (browser-verified) -> timer tabId

function isTimerUrl(url) {
  if (!url) return false;
  // Match /TabTimer, /TabTimer/, /TabTimer?..., /TabTimer/index.html etc.
  if (!url.startsWith(TIMER_URL_PREFIX)) return false;
  const rest = url.slice(TIMER_URL_PREFIX.length);
  return rest === "" || rest[0] === "/" || rest[0] === "?" || rest[0] === "#";
}

async function handleGetTimerTabs(msg) {
  try {
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });
    const timerTabs = allTabs.filter(t => isTimerUrl(t.url));

    const includeLog = !!(msg && msg.include_log);

    const results = await Promise.all(timerTabs.map(async (t) => {
      let state = null;
      try {
        state = await Promise.race([
          browser.tabs.sendMessage(t.id, { type: "GET_TIMER_STATE", include_log: includeLog }),
          new Promise(r => setTimeout(() => r(null), 800)),
        ]);
      } catch (e) { /* content script not ready yet */ }
      const entry = {
        tabId: t.id,
        direction: state ? state.direction : "up",
        value: state ? state.value : "--:--",
        rawValue: state ? state.rawValue : 0,
        isRunning: state ? !!state.isRunning : false,
      };
      if (includeLog && state && state.log) entry.log = state.log;
      return entry;
    }));

    if (msg && msg.id && port) {
      port.postMessage({ type: "result", id: msg.id, ok: true, timerTabs: results });
    }
    return results;
  } catch (e) {
    if (msg && msg.id && port) port.postMessage({ type: "result", id: msg.id, error: e.message });
    return [];
  }
}

async function handleCreateTimerTab(msg) {
  try {
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });

    if (msg.callerTabId != null) {
      const existingId = timerCallerMap.get(msg.callerTabId);
      if (existingId != null) {
        const existingTab = allTabs.find(t => t.id === existingId);
        if (existingTab && isTimerUrl(existingTab.url)) {
          if (msg && msg.id && port) {
            port.postMessage({ type: "result", id: msg.id, ok: true, tabId: existingTab.id, reused: true });
          }
          return { ok: true, tabId: existingTab.id, reused: true };
        }
      }
    }

    const value = msg.value;
    const direction = msg.direction || "up";
    let targetUrl = TIMER_URL_PREFIX + "/";

    if (direction === "up" && (!value || value === "0" || value === "stoper")) {
      targetUrl += "?val=stoper";
    } else if (value) {
      const dirParam = direction === "down" ? "down" : "up";
      targetUrl += "?val=" + encodeURIComponent(value) + "&dir=" + dirParam;
    } else {
      targetUrl += "?val=stoper";
    }

    const tab = await browser.tabs.create({ url: targetUrl, windowId: win.id });
    if (msg.callerTabId != null) {
      timerCallerMap.set(msg.callerTabId, tab.id);
    }
    if (msg && msg.id && port) {
      port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id });
    }
    return { ok: true, tabId: tab.id };
  } catch (e) {
    if (msg && msg.id && port) port.postMessage({ type: "result", id: msg.id, error: e.message });
    return { error: e.message };
  }
}

async function handleTimerAction(msg) {
  try {
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });
    let targetTab = null;

    if (msg.tabId != null) {
      targetTab = allTabs.find(t => t.id === msg.tabId && isTimerUrl(t.url));
    } else if (msg.callerTabId != null) {
      const existingId = timerCallerMap.get(msg.callerTabId);
      if (existingId != null) {
        targetTab = allTabs.find(t => t.id === existingId);
      }
    }
    
    if (!targetTab && msg.tabId == null) {
      targetTab = allTabs.find(t => isTimerUrl(t.url));
    }
    if (!targetTab) {
      if (msg && msg.id && port) port.postMessage({ type: "result", id: msg.id, error: "No TabTimer tab found" });
      return { error: "No TabTimer tab found" };
    }

    const res = await browser.tabs.sendMessage(targetTab.id, {
      type: "TIMER_ACTION", action: msg.action, value: msg.value,
    });

    if (msg && msg.id && port) {
      port.postMessage({ type: "result", id: msg.id, ok: true, tabId: targetTab.id, result: res });
    }
    return { ok: true, tabId: targetTab.id, result: res };
  } catch (e) {
    if (msg && msg.id && port) port.postMessage({ type: "result", id: msg.id, error: e.message });
    return { error: e.message };
  }
}

// Notify popup when timer tabs change (created/removed/navigated).
function broadcastTimerTabsChanged() {
  browser.runtime.sendMessage({ type: "timerTabsChanged" }).catch(() => {});
}

// ---- Policy loading and initialization -------------------------------------
let POLICY = null;
let PAGE_API_ALLOWED_ORIGINS = [];
let ENDPOINT_REQUIREMENTS = {};

async function loadPolicy() {
  try {
    const url = browser.runtime.getURL("policy.json");
    const response = await fetch(url);
    POLICY = await response.json();
    
    // Build allowed origins list from policy
    const patterns = POLICY.origin_patterns;
    const allowed = POLICY.surfaces.page_api.allowed_origins;
    PAGE_API_ALLOWED_ORIGINS = [];
    
    for (const ref of allowed) {
      if (ref === "file://") {
        PAGE_API_ALLOWED_ORIGINS.push("file://");
      } else if (ref === "localhost") {
        PAGE_API_ALLOWED_ORIGINS.push("localhost");
      } else if (ref === "whitelist" && Array.isArray(patterns.whitelist)) {
        PAGE_API_ALLOWED_ORIGINS.push(...patterns.whitelist);
      }
    }
    
    // Cache endpoint requirements
    ENDPOINT_REQUIREMENTS = POLICY.surfaces.page_api.endpoints;
  } catch (e) {
    console.error("Failed to load policy.json:", e);
  }
}

// Load policy at startup
loadPolicy();

// ---- Page API: content.js TabShareFetch(endpoint, params) ----
// Web pages (file://, trusted public site, localhost) cannot be trusted to say who
// they are, so they never talk to the REST host. content.js forwards their request
// here; the browser attaches `sender` (tab, frame, url), which pages cannot forge.
// All restrictions below are derived from `sender`, never from page-supplied values.
const NOT_ALLOWED = { ok: false, error: "NOT_ALLOWED" };

function isPageApiUrl(url) {
  if (!url) return false;
  if (url.startsWith("file://")) return PAGE_API_ALLOWED_ORIGINS.includes("file://");
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return PAGE_API_ALLOWED_ORIGINS.includes(u.origin);
    if (u.protocol === "http:") {
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        return PAGE_API_ALLOWED_ORIGINS.includes("localhost");
      }
    }
  } catch (e) {}
  return false;
}

// The other pane of `tab`'s split view, or null. Page never sees the partner's tabId.
async function findSplitPartner(tab) {
  const svid = tab.splitViewId;
  if (svid === undefined || svid === null || svid === -1) return null;
  const tabs = await browser.tabs.query({ windowId: tab.windowId });
  return tabs.find(t => t.splitViewId === svid && t.id !== tab.id) || null;
}

async function handlePageFetch(req, sender) {
  try {
    if (!sender.tab || sender.frameId !== 0 || !isPageApiUrl(sender.url)) return NOT_ALLOWED;
    const tab = await browser.tabs.get(sender.tab.id);   // fresh state
    const params = (req.params && typeof req.params === "object") ? req.params : {};
    const caller = tab.id;
    
    // Check endpoint requirements from policy
    const requirements = ENDPOINT_REQUIREMENTS[req.endpoint];
    if (!requirements) return { ok: false, error: "UNSUPPORTED_ENDPOINT" };
    
    if (requirements.require_active && !tab.active) return NOT_ALLOWED;
    if (requirements.require_split) {
      const partner = await findSplitPartner(tab);
      if (!partner) return NOT_ALLOWED;
    }

    switch (req.endpoint) {
      case "get_split": {
        const partner = await findSplitPartner(tab);
        return { ok: true, url: partner ? partner.url : null, title: partner ? partner.title : null };
      }
      case "set_split": {
        const url = params.url;
        if (typeof url !== "string" || !/^(https?|file):\/\//i.test(url)) {
          return { ok: false, error: "invalid url" };
        }
        const partner = await findSplitPartner(tab);
        if (!partner) return { ok: false, error: "NO_SPLIT_TAB" };
        await browser.tabs.update(partner.id, { url });
        return { ok: true };
      }
      case "get_timers": {
        const all = await handleGetTimerTabs({ include_log: !!params.include_log });
        // Only expose the timer this caller created; don't enumerate all timer tabs.
        const ownedId = timerCallerMap.get(caller);
        const owned = ownedId != null ? all.filter(t => t.tabId === ownedId) : [];
        // Strip tabId before returning to the page.
        return { ok: true, timers: owned.map(({ tabId: _, ...rest }) => rest) };
      }
      case "timer_action": {
        if (typeof params.action !== "string") return { ok: false, error: "action required" };
        const tabId = Number.isInteger(params.tabId) ? params.tabId : null;
        const value = params.value != null ? String(params.value) : undefined;
        const res = await handleTimerAction({ action: params.action, value, tabId, callerTabId: caller });
        const { tabId: _, ...safeRes } = res;
        return safeRes;
      }
      case "create_timer": {
        const direction = params.direction === "down" ? "down" : "up";
        const value = params.value != null ? String(params.value) : undefined;
        const res = await handleCreateTimerTab({ value, direction, callerTabId: caller });
        const { tabId: _, ...safeRes } = res;
        return safeRes;
      }
      case "open_side_panel": {
        const path = params.path && typeof params.path === "string" ? params.path : undefined;
        if (IS_FIREFOX) {
          browser.sidebarAction.open().catch(e => console.error("sidebarAction.open error:", e));
        } else {
          browser.sidePanel.open({ windowId: tab.windowId }).catch(e => console.error("sidePanel.open error:", e));
        }
        if (port) {
          port.postMessage({ type: "startOpencode", tabId: tab.id, windowId: tab.windowId, path });
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: "UNSUPPORTED_ENDPOINT" };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

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
    case "openSidePanelError": 
      browser.runtime.sendMessage({ type: "sidePanelError", error: msg.error || "Failed to open side panel" }).catch(() => {});
      return;
    case "getTimerTabs": return handleGetTimerTabs(msg);
    case "createTimerTab": return handleCreateTimerTab(msg);
    case "timerAction": return handleTimerAction(msg);
  }
}

// Keep tab state fresh. Service workers can be suspended, so use an alarm (min 0.5s in dev,
// clamped by Chrome to ~30s for unpacked) plus event-driven pushes.
browser.runtime.onStartup.addListener(connect);
browser.runtime.onInstalled.addListener(connect);
if (!IS_FIREFOX) { browser.alarms.create("tab-share-poll", { periodInMinutes: 0.1 });
browser.alarms.onAlarm.addListener((a) => { if (a.name === "tab-share-poll") sendTabs(); }); }
browser.tabs.onUpdated.addListener((...a) => { sendTabs(); broadcastTimerTabsChanged(); });
browser.tabs.onRemoved.addListener((...a) => { sendTabs(); broadcastTimerTabsChanged(); });
browser.tabs.onCreated.addListener((...a) => { sendTabs(); broadcastTimerTabsChanged(); });
browser.tabs.onActivated.addListener((...a) => { sendTabs(); broadcastTimerTabsChanged(); });

connect();
