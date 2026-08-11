# Tab Share

A browser extension (Firefox + Chromium) that exposes a small local HTTP API on
`localhost` for querying and driving your open browser tabs — list tabs, read tab groups,
open/navigate tabs, and extract page content. The extension talks to a pure-stdlib Python
native-messaging host that serves the HTTP endpoints.

It powers the `firefox-tabs` and `amazon-internal-website-fetch` Kiro skills, but the
extension is self-contained and can be used on its own.

The matching Kiro skill lives in this repo too, under [`kiro-skill/`](kiro-skill/), so the
extension and its skill travel together. See [Kiro skill](#kiro-skill) below.

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│ Browser (Firefox / Chromium)                            │
│  ┌──────────────┐  native messaging  ┌──────────────┐  │
│  │ background.js │ ◄──────────────► │ native_host  │  │
│  │ (extension)   │   stdin/stdout    │ .py          │  │
│  └──────────────┘                    └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                                          ▲
                                          │ HTTP (:8765 / :8766)
                                     curl / any client
```

- `background.js` pushes tab data to `native_host.py`
- `native_host.py` caches the data and serves it over HTTP
- Commands (like grouping tabs) are relayed back from the HTTP API through native messaging to the extension

## Builds

| Folder | Browser | Extension ID | Port |
|---|---|---|---|
| [`firefox/`](firefox/)   | Firefox (MV2)   | `tab-share@local` | **8765** |
| [`chromium/`](chromium/) | Chromium (MV3)  | assigned at load time     | **8766** |

Different ports let both browsers run at the same time.

## Install

See [`INSTALL.md`](INSTALL.md) for the full guide, including the snap-confined Firefox and
Chromium paths on Linux.

Quick start:

```bash
# Interactive setup (auto-detects Snap vs non-Snap, Firefox vs Chromium):
./install.sh

# Or specify browser target directly:
./install.sh chrome
./install.sh firefox
./install.sh both
```

Or run directly via curl:

```bash
curl -sSL https://raw.githubusercontent.com/yoavdim/tab-share/main/install.sh | bash
```

Verify:

```bash
curl -s http://localhost:8765/tabs | jq   # Firefox
curl -s http://localhost:8766/tabs | jq   # Chromium
```

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
and the safety-gated `/close` (below).

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

## Differences (Firefox MV2 vs Chromium MV3)

The HTTP API and `native_host.py` are identical across both versions. The skills require no changes (except pointing to the right port).

| Area | Firefox | Chromium |
|---|---|---|
| Manifest | MV2, `applications.gecko` | MV3, `service_worker` |
| API namespace | `browser.*` (promises) | `chrome.*` (promises) |
| Page extraction | `tabs.executeScript({code})` | `chrome.scripting.executeScript({func})` |
| `/eval` | arbitrary code string | injected via `world:"MAIN"`; may fail on strict-CSP pages |
| Containers | Multi-Account Containers | **Not supported** — `/containers` returns `[]`, `cookieStoreId` ignored |
| Host registration | `~/.mozilla/native-messaging-hosts/`, `allowed_extensions` | per-browser `NativeMessagingHosts/`, `allowed_origins` with the extension ID |

## Security (CORS)

The host binds to `127.0.0.1` only, and its CORS policy limits which *browser* origins can
call it (both builds behave the same):

- **`localhost` / `127.0.0.1` origins** — allowed on every endpoint.
- **`file://` pages** (browsers send `Origin: null`) — restricted strictly to split-view
  manipulation. They can only reach `/tabs` and `/navigate`, and **only** if the currently
  active tab is a `file://` URL that is part of a split-view pair. They must also send a matching `X-Tab-Url` header. The API strictly sandboxes
  the payload, meaning the `file://` page can only see and navigate its specific split-view
  partner. Sensitive endpoints (`/eval`, `/open`, `/extract`, `/close`, `/group`) are completely blocked.
- **Any other website** — denied on all endpoints, so a random page you visit can't drive
  your browser.
- **`curl` / non-browser clients** send no `Origin` header and are unaffected — CORS only
  constrains cross-origin *browser* requests.

## Kiro skill

The `firefox-tabs` Kiro skill that drives this extension ships here at
[`kiro-skill/firefox-tabs/SKILL.md`](kiro-skill/firefox-tabs/SKILL.md). Keeping it in this
repo means the skill and the extension it depends on stay in sync.

Kiro discovers skills at `~/.kiro/skills/<name>/SKILL.md` and does **not** follow a
symlinked skill *folder* (see [kirodotdev/Kiro#6401](https://github.com/kirodotdev/Kiro/issues/6401)).
A real folder containing a symlinked `SKILL.md`, however, **is** discovered — so point a
real `~/.kiro/skills/firefox-tabs/` folder at this repo's `SKILL.md`:

```bash
mkdir -p ~/.kiro/skills/firefox-tabs
ln -sf /path/to/tab-share/kiro-skill/firefox-tabs/SKILL.md ~/.kiro/skills/firefox-tabs/SKILL.md
```

Reload Kiro afterwards; the `firefox-tabs` skill should appear.

## Notes

- The native host is pure Python stdlib — no pip installs.
- Firefox Multi-Account Containers have no Chromium equivalent; on Chromium `/containers`
  returns an empty list.

## License

Licensed under the [GNU GPL v3](LICENSE) © 2026 Yoav Dim. If you use, modify, or
redistribute this software, please retain the notice and credit the original author
([@yoavdim](https://github.com/yoavdim)).
