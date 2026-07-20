# Tab Share

A Firefox extension that exposes your open tabs over a local HTTP API and lets you manage tab groups.

> **Installing on a new machine?** See the full guide (including the snap-Firefox path) at
> [`../INSTALL.md`](../INSTALL.md).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Firefox                                                 │
│  ┌──────────────┐  native messaging  ┌──────────────┐  │
│  │ background.js │ ◄──────────────► │ native_host  │  │
│  │ (extension)   │   stdin/stdout    │ .py :8765    │  │
│  └──────────────┘                    └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                                          ▲
                                          │ HTTP
                                     curl / any client
```

- `background.js` pushes tab data to `native_host.py` every 2s and on tab events
- `native_host.py` caches the data and serves it over HTTP on `127.0.0.1:8765`
- Commands (like grouping tabs) are relayed back from the HTTP API through native messaging to the extension

## Installation

```bash
./install.sh    # registers native messaging host
```

Then load the extension in Firefox:
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from this directory

## HTTP API

### `GET /tabs`

Returns all open tabs in the current window.

```bash
curl -s http://localhost:8765/tabs | jq
```

```json
{
  "activeTab": { "id": 3, "title": "Example", "url": "https://example.com", "active": true, "index": 0 },
  "tabs": [
    { "id": 3, "title": "Example", "url": "https://example.com", "active": true, "index": 0 },
    { "id": 7, "title": "Other", "url": "https://other.com", "active": false, "index": 1 }
  ]
}
```

### `POST /group`

Moves a tab into a tab group by URL. Creates the group if it doesn't exist.

```bash
curl -s -X POST http://localhost:8765/group \
  -H 'Content-Type: application/json' \
  -d '{"tabUrl": "https://example.com", "groupName": "My Group"}' | jq
```

```json
{ "ok": true, "groupId": 42, "type": "result", "id": "..." }
```

| Field | Type | Description |
|---|---|---|
| `tabUrl` | `string` | Exact URL of the tab to group |
| `groupName` | `string` | Name of the group (created if it doesn't exist) |

The host also exposes `/open`, `/navigate`, `/extract`, `/eval`, `/groups`, `/containers`,
and the safety-gated `/close` (below) — same shapes as the Chromium build.

### `POST /close` (safety-gated)

Closes tabs, but only ones matching **all** the required guards, so a stale `tabId` or a
broad URL match can't nuke the wrong tab.

```bash
curl -s -X POST http://localhost:8765/close \
  -H 'Content-Type: application/json' \
  -d '{"tabId": 12, "expectHost": "example.com", "expectGroup": "Scratch"}' | jq
```

| Field | Type | Description |
|---|---|---|
| `tabId` | `int` \| `int[]` | Tab(s) to close (from `/tabs`). |
| `url` | `string` \| `string[]` | Alternative selector by exact URL (`prefix:true` for startswith). |
| `expectHost` | `string` | **Required.** The tab URL's hostname must equal this. |
| `expectGroup` | `string` \| `null` | **Required.** Group title must match; `null`/`""` = must be ungrouped; `"*"` = skip the group check. |

A concrete `expectGroup` (a real name) with no `tabId`/`url` closes **every tab in that
group**. Returns `{ ok, closed:[ids], rejected:[{id, why}] }`.

## Security (CORS)

`localhost` origins may call every endpoint; `file://` (Origin `null`) pages only reach
`/tabs` and `/navigate`; all other websites are denied. `curl` (no Origin) is unaffected.
See [`../README.md`](../README.md#security-cors).

## Files

| File | Description |
|---|---|
| `manifest.json` | Extension manifest |
| `background.js` | Queries tabs, handles group commands, pushes to native host |
| `native_host.py` | Native messaging host + HTTP server on :8765 |
| `popup.html` | Toolbar popup showing endpoint and status |
| `tab_share.json` | Native messaging manifest template |
| `install.sh` | Registers native messaging host with Firefox |
| `icon.svg` | Toolbar icon |

## Requirements

- Firefox 138+ (for native tab groups API)
- Python 3
- `jq` (for install script)
