let port = null;

function connect() {
  port = browser.runtime.connectNative("tab_share");
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 3000);
  });
  port.onMessage.addListener(handleCommand);
}

async function sendTabs() {
  if (!port) return;
  try {
    const win = await browser.windows.getCurrent();
    const allTabs = await browser.tabs.query({ windowId: win.id });
    const activeTab = allTabs.find(t => t.active);

    // expose id/active/index so callers (e.g. /close by tabId) can target tabs reliably.
    const shape = t => ({ id: t.id, title: t.title, url: t.url, active: !!t.active, index: t.index });
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

async function handleOpen(msg) {
  try {
    const { url, groupName, cookieStoreId: requestedStoreId } = msg;
    const win = await browser.windows.getCurrent();

    // Check if a tab with this URL already exists — move it instead of opening a duplicate
    const allTabs = await browser.tabs.query({ windowId: win.id });
    let tab = allTabs.find(t => t.url === url || t.url === url + "/");
    if (!tab) {
      const opts = { url, windowId: win.id };
      if (requestedStoreId) opts.cookieStoreId = requestedStoreId;
      tab = await browser.tabs.create(opts);
    }

    // Find or create group
    const groups = await browser.tabGroups.query({ title: groupName, windowId: win.id });
    let groupId;
    if (groups.length > 0) {
      groupId = groups[0].id;
      await browser.tabs.group({ tabIds: [tab.id], groupId });
    } else {
      groupId = await browser.tabs.group({ tabIds: [tab.id] });
      await browser.tabGroups.update(groupId, { title: groupName });
    }

    port.postMessage({ type: "result", id: msg.id, ok: true, groupId, tabId: tab.id });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function handleContainers(msg) {
  try {
    const containers = await browser.contextualIdentities.query({});
    port.postMessage({ type: "result", id: msg.id, containers: containers.map(c => ({ name: c.name, cookieStoreId: c.cookieStoreId, color: c.color })) });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Resolve a target tab from msg: prefer tabId, then exact url match, else active tab.
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

// Wait until a tab finishes loading (status === "complete"), up to timeoutMs.
async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    const t = await browser.tabs.get(tabId);
    if (t.status === "complete") return t;
    await new Promise(r => setTimeout(r, 400));
  }
  return browser.tabs.get(tabId);
}

async function handleEval(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await browser.tabs.executeScript(tab.id, { code: msg.code });
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, url: tab.url, result: results && results.length === 1 ? results[0] : results });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// CSP-safe alternative to /eval: runs the extension's own DOM code, not a caller string.
// Keep in sync with chromium/background.js.
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

// Serialize a page op for MV2's `code:` API. Args are JSON-encoded, so a selector
// containing quotes cannot break out of the source.
function pageOpSource(fn, args) {
  const encoded = (args || [])
    .map(a => JSON.stringify(a === undefined ? null : a))
    .join(",");
  return "(" + fn.toString() + ")(" + encoded + ")";
}

async function handleQuery(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await browser.tabs.executeScript(tab.id, {
      code: pageOpSource(queryElements, [msg.selector]),
    });
    const out = results && results.length ? results[0] : null;
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, url: tab.url, result: out });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

async function handleScroll(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await browser.tabs.executeScript(tab.id, {
      code: pageOpSource(scrollPage, [msg.selector || null, msg.mode || null]),
    });
    const out = results && results.length ? results[0] : null;
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
      const opts = { url: msg.url, windowId: win.id };
      if (msg.cookieStoreId) opts.cookieStoreId = msg.cookieStoreId;
      tab = await browser.tabs.create(opts);
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

// Extract page text + interactive elements via a content script.
const EXTRACT_CODE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const links = [...document.querySelectorAll('a[href]')].filter(vis).map(a => ({ text: (a.innerText||'').trim().slice(0,100), href: a.href })).filter(x => x.text || x.href).slice(0, 200);
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')].filter(vis).map(b => ({ text: (b.innerText||b.value||b.getAttribute('aria-label')||'').trim().slice(0,100) })).filter(x => x.text).slice(0, 100);
  const inputs = [...document.querySelectorAll('input, select, textarea')].filter(vis).map(i => ({ name: i.name||'', id: i.id||'', type: i.type||i.tagName.toLowerCase(), placeholder: i.placeholder||'' })).slice(0, 100);
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), links, buttons, inputs };
})()`;

async function handleExtract(msg) {
  try {
    const tab = await resolveTab(msg);
    if (!tab) { port.postMessage({ type: "result", id: msg.id, error: "No target tab" }); return; }
    const results = await browser.tabs.executeScript(tab.id, { code: EXTRACT_CODE });
    const data = results && results.length ? results[0] : {};
    port.postMessage({ type: "result", id: msg.id, ok: true, tabId: tab.id, ...data });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

// Close tabs — SAFETY-GATED. A tab is closed only if it matches ALL of:
//   - selector: tabId(s) and/or url(s); OR a concrete expectGroup (name) closes the
//     whole group,
//   - expectHost: the tab URL's hostname must equal this — REQUIRED,
//   - expectGroup: the tab's group title must equal this; null/"" => require UNGROUPED,
//     "*" => skip the group check — REQUIRED.
// Mirrors the Chromium handler so callers behave identically across browsers.
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

    // resolve group titles once (tabGroups may be unavailable on older Firefox)
    const groupTitle = {};
    try {
      const groups = await browser.tabGroups.query({ windowId: win.id });
      groups.forEach(g => { groupTitle[g.id] = g.title || ""; });
    } catch (e) {}

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
      // SAFETY: host must match
      if (hostOf(t.url) !== msg.expectHost) { rejected.push({ id: t.id, why: "host-mismatch", host: hostOf(t.url) }); continue; }
      // SAFETY: group must match (null/"" => ungrouped; "*" => skip)
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

async function handleCommand(msg) {
  if (!port) return;
  if (msg.type === "groups") return handleGroups(msg);
  if (msg.type === "open") return handleOpen(msg);
  if (msg.type === "containers") return handleContainers(msg);
  if (msg.type === "eval") return handleEval(msg);
  if (msg.type === "query") return handleQuery(msg);
  if (msg.type === "scroll") return handleScroll(msg);
  if (msg.type === "navigate") return handleNavigate(msg);
  if (msg.type === "extract") return handleExtract(msg);
  if (msg.type === "close") return handleClose(msg);
  if (msg.type !== "group") return;
  try {
    const { tabUrl, groupName } = msg;
    const win = await browser.windows.getCurrent();
    const tabs = await browser.tabs.query({ windowId: win.id, url: undefined });
    const tab = tabs.find(t => t.url === tabUrl);
    if (!tab) {
      port.postMessage({ type: "result", id: msg.id, error: "Tab not found" });
      return;
    }

    // Find existing group by name
    const groups = await browser.tabGroups.query({ title: groupName, windowId: win.id });
    let groupId;
    if (groups.length > 0) {
      groupId = groups[0].id;
      await browser.tabs.group({ tabIds: [tab.id], groupId });
    } else {
      groupId = await browser.tabs.group({ tabIds: [tab.id] });
      await browser.tabGroups.update(groupId, { title: groupName });
    }

    port.postMessage({ type: "result", id: msg.id, ok: true, groupId });
  } catch (e) {
    port.postMessage({ type: "result", id: msg.id, error: e.message });
  }
}

connect();
setInterval(sendTabs, 2000);
browser.tabs.onUpdated.addListener(sendTabs);
browser.tabs.onRemoved.addListener(sendTabs);
browser.tabs.onCreated.addListener(sendTabs);
browser.tabs.onActivated.addListener(sendTabs);
