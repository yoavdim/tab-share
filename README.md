# Tab Share

A browser extension (Firefox + Chromium) that exposes a small local HTTP API on
`localhost` for querying and driving your open browser tabs — list tabs, read tab groups,
open/navigate tabs, and extract page content. The extension talks to a pure-stdlib Python
native-messaging host that serves the HTTP endpoints.

It powers the `firefox-tabs` and `amazon-internal-website-fetch` Kiro skills, but the
extension is self-contained and can be used on its own.

The matching Kiro skill lives in this repo too, under [`kiro-skill/`](kiro-skill/), so the
extension and its skill travel together. See [Kiro skill](#kiro-skill) below.

## Builds

| Folder | Browser | Extension ID | Port |
|---|---|---|---|
| [`firefox/`](firefox/)   | Firefox (MV2)   | `tab-share@local` | **8765** |
| [`chromium/`](chromium/) | Chromium (MV3)  | assigned at load time     | **8766** |

Different ports let both browsers run at the same time.

## Install

See [`INSTALL.md`](INSTALL.md) for the full guide, including the snap-confined Firefox and
Chromium paths on Linux.

Quick start (non-snap):

```bash
# Firefox
cd firefox && ./install.sh          # then load manifest.json via about:debugging

# Chromium (load unpacked first to get the extension ID, then:)
cd chromium && ./install.sh <EXTENSION_ID>
```

Verify:

```bash
curl -s http://localhost:8765/tabs | jq   # Firefox
curl -s http://localhost:8766/tabs | jq   # Chromium
```

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

## Security (CORS)

The host binds to `127.0.0.1` only, and its CORS policy limits which *browser* origins can
call it (both builds behave the same):

- **`localhost` / `127.0.0.1` origins** — allowed on every endpoint.
- **`file://` pages** (browsers send `Origin: null`) — allowed only on the low-risk
  `/tabs` and `/navigate` (what a local file-based UI needs). Sensitive
  endpoints (`/eval`, `/open`, `/extract`, `/close`, `/group`) are blocked.
- **Any other website** — denied on all endpoints, so a random page you visit can't drive
  your browser.
- **`curl` / non-browser clients** send no `Origin` header and are unaffected — CORS only
  constrains cross-origin *browser* requests.

## Notes

- The native host is pure Python stdlib — no pip installs.
- Firefox Multi-Account Containers have no Chromium equivalent; on Chromium `/containers`
  returns an empty list.

## License

Licensed under the [GNU GPL v3](LICENSE) © 2026 Yoav Dim. If you use, modify, or
redistribute this software, please retain the notice and credit the original author
([@yoavdim](https://github.com/yoavdim)).
