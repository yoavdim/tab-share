---
name: firefox-tabs
description: Query open Firefox tabs, list tab groups, open tabs in groups, and manage Firefox Multi-Account Containers via the Tab Share extension HTTP API on localhost:8765. Use when user asks about open tabs, browser tabs, tab groups, opening URLs in tab groups, or wants to organize tabs into groups.
---

# Firefox Tabs

Interact with Firefox tabs, tab groups, and containers via the Tab Share extension's local HTTP API.

## Prerequisites

The Tab Share extension must be installed and running. The native host serves on
`http://localhost:8765` for **Firefox** (the default) and `http://localhost:8766` for
**Chromium**.

### Browser / port selection

- **Default to Firefox (`:8765`).** Use it unless the user explicitly asks for Chromium
  (or Chrome/Brave/Edge), or Firefox's host is unreachable.
- **Use Chromium (`:8766`)** only when the user explicitly requests it. Note that Firefox
  Multi-Account Containers are NOT available on Chromium, so `/containers` returns an empty
  list there.
- All `curl` examples below use `:8765`. To target Chromium, swap the port to `:8766`.
- Quick probe to see which is live:
  ```bash
  for p in 8765 8766; do curl -s --connect-timeout 1 http://localhost:$p/tabs >/dev/null && echo "$p up"; done
  ```

## Available Endpoints

### List Open Tabs

```bash
curl -s http://localhost:8765/tabs | jq .
```

Returns `activeTab` (currently focused) and `tabs` (all open tabs in the current window), each with `id`, `title`, `url`, `active`, and `index`.

### List Tab Groups

```bash
curl -s http://localhost:8765/groups | jq .
```

Returns `groups` array, each with `id`, `title`, and `color`.

### List Containers (Firefox Multi-Account Containers)

```bash
curl -s http://localhost:8765/containers | jq .
```

Returns `containers` array, each with `name`, `cookieStoreId`, and `color`.

### Open URL in Tab Group (preferred method)

```bash
curl -s -X POST http://localhost:8765/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "groupName": "My Group"}' | jq .
```

Opens a new tab with the given URL and places it in the named group (created automatically if it doesn't exist).

Optional `cookieStoreId` parameter opens the tab in a specific Firefox container (look up
IDs via `/containers`):

```bash
curl -s -X POST http://localhost:8765/open \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "groupName": "My Group", "cookieStoreId": "firefox-container-6"}' | jq .
```

Returns `ok: true`, `groupId`, and `tabId` on success.

### Add Existing Tab to Group

```bash
curl -s -X POST http://localhost:8765/group \
  -H 'Content-Type: application/json' \
  -d '{"tabUrl": "EXACT_TAB_URL", "groupName": "Group Name"}' | jq .
```

- `tabUrl`: must exactly match a URL from the `/tabs` response
- `groupName`: name of the group; created automatically if it doesn't exist

Returns `ok: true` and `groupId` on success.

### Close Tabs (safety-gated)

```bash
curl -s -X POST http://localhost:8765/close \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 12, "expectHost": "example.com", "expectGroup": "Scratch"}' | jq .
```

Closes tabs, but only ones matching **all** guards (prevents closing the wrong tab):

- `tabId` (`int`/`int[]`) and/or `url` (`string`/`string[]`, `prefix:true` for startswith) — the selector.
- `expectHost` (**required**): the tab URL's hostname must equal this.
- `expectGroup` (**required**): group title must match; `null`/`""` = must be ungrouped; `"*"` = skip the group check.

A concrete `expectGroup` (a real name) with no `tabId`/`url` closes **every tab in that group**.
Returns `{ ok, closed:[ids], rejected:[{id, why}] }`.

> **CORS:** `localhost` origins reach every endpoint; `file://` pages only `/tabs` + `/navigate`; other websites are denied. `curl` is unaffected.

## Workflow for Opening Tabs in Groups

1. Use `POST /open` to open URLs directly in a tab group — this is the preferred method.
2. To open a tab in a specific Firefox container, look up its `cookieStoreId` via
   `/containers` and pass it to `/open`.

## Error Handling

- If the native host is not running, curl will get connection refused
- If a tab URL doesn't match any open tab, the response contains `"error": "Tab not found"`
- If the extension hasn't sent data yet, `/tabs` returns `{}`
- Timeout responses (504) mean the extension didn't respond within 5 seconds
- Invalid `cookieStoreId` returns an error from the extension
