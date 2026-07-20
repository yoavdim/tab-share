# Installing the Tab Share extensions on a new machine

This repo holds the **Tab Share** browser extension: a local HTTP API on `localhost` that
lets tooling query/drive your open browser tabs. It's consumed by the `firefox-tabs` and
`amazon-internal-website-fetch` Kiro skills, but the extension itself is self-contained and
has no dependency on Kiro.

It can live anywhere. When used as part of the [kiro-config](https://github.com/yoavdim/kiro-config)
backup it's mounted as a submodule at `~/.kiro/tab-share/`, and the examples below assume
that path — adjust if you cloned it elsewhere.

There are two builds:

| Folder | Browser | Extension ID | Port |
|---|---|---|---|
| `firefox/`  | Firefox (MV2)   | `tab-share@local` | **8765** |
| `chromium/` | Chromium (MV3)  | assigned at load time     | **8766** |

Different ports let both browsers run at the same time. The skills default to Firefox
(8765); pass `--browser chromium` (or target 8766) to drive Chromium.

> **Containers note:** Firefox Multi-Account Containers have **no Chromium equivalent**.
> On Chromium `/containers` returns an empty list. Everything else works on both.

## Prerequisites

- **Python 3** (`python3` on PATH) — the native host is pure stdlib, no pip installs.
- **jq** — used by the install scripts.
- **Firefox 138+** and/or **Chromium/Chrome 116+**.

```bash
command -v python3 jq    # both must print a path
```

## Step 0 — Is your browser a snap? (Linux)

This matters a lot. Check:

```bash
ls -d ~/snap/firefox ~/snap/chromium 2>/dev/null   # if these exist, that browser is a snap
```

- **Not a snap (deb/rpm/Chrome from Google):** use the bundled `install.sh` /
  `install_snap.sh` as written — see "Standard install" below.
- **Snap (default on Ubuntu):** snaps are confined and **cannot read hidden dirs like
  `~/.kiro`** and use non-standard config paths. Follow "Snap install" below, which stages
  files into snap-accessible locations.

---

## Firefox

### Standard install (non-snap Firefox)

```bash
cd ~/.kiro/tab-share/firefox
./install.sh                       # registers the native host in ~/.mozilla/native-messaging-hosts
```

Then load the extension:
1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**
3. Select `~/.kiro/tab-share/firefox/manifest.json`
4. Verify: `curl -s http://localhost:8765/tabs | jq`

### Snap install (snap Firefox)

Snap Firefox reaches native hosts through the WebExtensions portal, which only reads
manifests from **real host paths** (not `~/snap/...`). It also can't read hidden dirs. So
copy the host to a non-hidden host path and register the manifest in the real `~/.mozilla`:

```bash
# 1. Copy the native host somewhere the snap can execute (NOT under a hidden dir)
mkdir -p ~/.local/lib/tab_share
cp ~/.kiro/tab-share/firefox/native_host.py ~/.local/lib/tab_share/native_host.py
chmod +x ~/.local/lib/tab_share/native_host.py

# 2. Register the manifest in the REAL ~/.mozilla (read by the portal backend)
mkdir -p ~/.mozilla/native-messaging-hosts
python3 - <<'PY'
import json, os
src = os.path.expanduser('~/.kiro/tab-share/firefox/tab_share.json')
dst = os.path.expanduser('~/.mozilla/native-messaging-hosts/tab_share.json')
m = json.load(open(src))
m['path'] = os.path.expanduser('~/.local/lib/tab_share/native_host.py')
json.dump(m, open(dst, 'w'), indent=2)
print('wrote', dst)
PY

# 3. Stage the extension itself somewhere the snap can read it
cp -r ~/.kiro/tab-share/firefox ~/snap/firefox/common/tab_share_extension
```

Then load it:
1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**
3. Select `~/snap/firefox/common/tab_share_extension/manifest.json`
4. Verify: `curl -s http://localhost:8765/tabs | jq`

> If `connectNative` still fails, the snap's WebExtensions portal backend (provided by
> snapd) may be missing. As a fallback, install the host system-wide (needs sudo):
> ```bash
> sudo install -d /usr/lib/mozilla/native-messaging-hosts
> sudo install -m0755 ~/.local/lib/tab_share/native_host.py /usr/lib/mozilla/native-messaging-hosts/native_host.py
> sudo sed "s#\"path\":.*#\"path\": \"/usr/lib/mozilla/native-messaging-hosts/native_host.py\",#" \
>   ~/.kiro/tab-share/firefox/tab_share.json | sudo tee /usr/lib/mozilla/native-messaging-hosts/tab_share.json
> ```

> **Temporary add-on caveat:** "Load Temporary Add-on" does not survive a Firefox restart.
> Reload it each session, or use Firefox Developer/ESR with `xpinstall.signatures.required`
> disabled to install a packaged copy permanently.

---

## Chromium / Chrome / Brave / Edge

Chromium pins the native host to a specific **extension ID**, which only exists after you
load the unpacked extension. So the order is: load first, then register.

### 1. Load the unpacked extension

1. Open `chrome://extensions` (or `chromium://extensions`, `brave://extensions`, `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the extension folder:
   - **Non-snap:** `~/.kiro/tab-share/chromium`
   - **Snap Chromium:** first stage it where the snap can read it, then select that:
     ```bash
     cp -r ~/.kiro/tab-share/chromium ~/snap/chromium/common/tab_share_extension
     ```
     then Load unpacked → `~/snap/chromium/common/tab_share_extension`
4. Copy the extension **ID** shown under the name (32 chars, a–p).

### 2. Register the native host with that ID

```bash
# Non-snap Chromium/Chrome/Brave/Edge:
~/.kiro/tab-share/chromium/install.sh <EXTENSION_ID>

# Snap Chromium:
~/.kiro/tab-share/chromium/install_snap.sh <EXTENSION_ID>
```

### 3. Reload + verify

Reload the extension on the extensions page, then:

```bash
curl -s http://localhost:8766/tabs | jq
```

---

## Verifying it works

```bash
# cached tab list (passive)
curl -s http://localhost:8765/tabs | jq '.tabs | length'      # Firefox
curl -s http://localhost:8766/tabs | jq '.tabs | length'      # Chromium

# live round-trip (proves the extension is responding, not just cached)
curl -s http://localhost:8765/groups | jq                     # Firefox
curl -s http://localhost:8766/groups | jq                     # Chromium
```

If `/tabs` returns data but `/groups` times out, the extension's background context is
asleep — on Chromium the native host pings every 20s to keep the MV3 service worker awake,
so just retry once.

---

## Wiring up the Kiro skill (optional)

The `firefox-tabs` Kiro skill that drives this extension lives in this repo at
`kiro-skill/firefox-tabs/SKILL.md`. If you use Kiro, expose it under `~/.kiro/skills/` so
Kiro can discover it.

Kiro does **not** follow a symlinked skill *folder*
([kirodotdev/Kiro#6401](https://github.com/kirodotdev/Kiro/issues/6401)), but it **does**
discover a real folder that contains a symlinked `SKILL.md`. So symlink the file, not the
folder:

```bash
# from the kiro-config root (~/.kiro), with this repo checked out as the tab-share submodule
mkdir -p skills/firefox-tabs
ln -sf ../../tab-share/kiro-skill/firefox-tabs/SKILL.md skills/firefox-tabs/SKILL.md

# verify the link resolves
head -3 skills/firefox-tabs/SKILL.md
```

The link is relative and points into the submodule, so it only resolves after the submodule
is checked out (`git submodule update --init`). Reload Kiro; the `firefox-tabs` skill should
appear in the available skills.

## Troubleshooting

- **`connection refused` on the port:** the extension hasn't connected. Reload it on the
  extensions page. Confirm the browser actually spawned the host:
  `pgrep -af native_host.py`.
- **Many `native_host.py` processes / flapping:** the host is self-healing (newest-wins:
  a freshly spawned host kills a stale one and takes the port). It should settle to **one**
  process within a few seconds.
- **Chromium `/groups` times out:** MV3 service worker went idle. Retry; the keepalive ping
  should have woken it. If persistent, reload the extension.
- **Firefox host never launches (snap):** see the system-wide fallback in the Snap install
  section; verify the manifest path points at an executable the snap can reach (not a hidden dir).
- **Port conflict:** Firefox = 8765, Chromium = 8766. They're separate, so both can run at
  once. Don't point two browsers at the same port.

## What each file is

```
firefox/                        Firefox MV2 build
  manifest.json                 extension manifest (id: tab-share@local)
  background.js                 connects to native host; exposes tabs/groups/open/navigate/extract/eval/group/close
  native_host.py                stdio<->HTTP bridge, serves :8765 (newest-wins singleton)
  tab_share.json                native-messaging manifest template (allowed_extensions)
  install.sh                    registers the host for non-snap Firefox
  popup.html, icon.svg, README.md

chromium/                       Chromium MV3 build
  manifest.json                 MV3 manifest (service worker, scripting/tabGroups perms)
  background.js                 chrome.* service worker; chrome.scripting for extract; keepalive
  native_host.py                same bridge, serves :8766
  tab_share.json                native-messaging manifest template (allowed_origins)
  install.sh                    registers the host for non-snap Chromium browsers
  install_snap.sh               registers the host for snap Chromium
  popup.html, icon.svg, README.md

kiro-skill/                     Kiro skill(s) that drive this extension
  firefox-tabs/SKILL.md         symlinked into ~/.kiro/skills/firefox-tabs/ (see above)
```
