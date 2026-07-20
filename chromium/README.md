# Tab Share (Chromium)

Chromium/MV3 port of the Firefox Tab Share extension. Exposes your open tabs and tab-group
controls over a local HTTP API on `127.0.0.1:8766`, so the `firefox-tabs` and
`amazon-internal-website-fetch` skills work against Chrome/Chromium/Brave/Edge.

> **Installing on a new machine?** See the full guide (including the snap-Chromium path) at
> [`../INSTALL.md`](../INSTALL.md).

> **Port note:** this Chromium host runs on **8766**, while the Firefox host stays on
> **8765**. That lets both browsers run at the same time without colliding. The bundled
> skills hardcode 8765 (Firefox); to drive Chromium, point requests at 8766 or run a copy
> of the skills against that port.

The HTTP API and `native_host.py` are identical to the Firefox version, so the skills need
no changes — same endpoints, same port.

## What's different from the Firefox version

| Area | Firefox | Chromium (this port) |
|---|---|---|
| Manifest | MV2, `applications.gecko` | MV3, `service_worker` |
| API namespace | `browser.*` (promises) | `chrome.*` (promises) |
| Page extraction | `tabs.executeScript({code})` | `chrome.scripting.executeScript({func})` |
| `/eval` | arbitrary code string | injected via `world:"MAIN"`; may fail on strict-CSP pages |
| Containers | Multi-Account Containers | **Not supported** — `/containers` returns `[]`, `cookieStoreId` ignored |
| Host registration | `~/.mozilla/native-messaging-hosts/`, `allowed_extensions` | per-browser `NativeMessagingHosts/`, `allowed_origins` with the extension ID |

The container workflow from the `firefox-tabs` skill does **not** work here
(Chromium has no container equivalent). All other endpoints —
`/tabs`, `/groups`, `/open`, `/navigate`, `/extract`, `/group` — behave the same.

## Install

Chromium pins the native host to a specific extension ID, which is only assigned when you
load the unpacked extension. So the order matters:

1. Open `chrome://extensions` (or `chromium://extensions`, `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Copy the extension's **ID** (32-char string shown under the name).
5. Register the native host with that ID:
   ```bash
   ./install.sh <EXTENSION_ID>
   ```
6. Back on `chrome://extensions`, click the reload icon on the extension.
7. Test:
   ```bash
   curl -s http://localhost:8766/tabs | jq
   ```

`install.sh` auto-detects installed Chromium-family browsers under `~/.config` (chrome,
chromium, brave, edge) and writes the host manifest into each.

## Files

| File | Description |
|---|---|
| `manifest.json` | MV3 manifest (service worker, `scripting`/`tabGroups`/`tabs` perms) |
| `background.js` | Service worker: tab push + command handling via `chrome.*` |
| `native_host.py` | Native messaging host + HTTP server on :8766 (shared with Firefox version) |
| `tab_share.json` | Native messaging manifest template (`allowed_origins`, filled by install.sh) |
| `popup.html` | Toolbar popup showing status |
| `icon.svg` | Icon (not wired into the action; Chrome wants PNG for action icons) |
| `install.sh` | Registers the native host for installed Chromium browsers |

## Requirements

- Chrome/Chromium 116+ (MV3 service workers + `tabGroups`)
- Python 3
- `jq` (install script)

## Notes / gotchas

- **Service worker lifecycle:** MV3 workers sleep when idle. An `alarms` poll plus tab
  events wake it to refresh `/tabs`. The first request after idle may lag briefly.
- **`/eval` and CSP:** code is injected into the page's MAIN world; pages with strict CSP
  may block it. Prefer `/extract` for scraping.
- **Re-running install:** safe — it just rewrites the host manifest with the same ID.
