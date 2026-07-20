#!/bin/bash
# Snap-specific installer for Chromium Tab Share native host.
#
# Snap Chromium is confined: it CANNOT read ~/.kiro (hidden dirs are blocked by the
# snap home interface), and its config lives under ~/snap/chromium/common/chromium,
# not ~/.config/chromium. This script copies the host into a snap-accessible dir and
# registers the manifest at the snap-correct path.
#
# Run AFTER loading the unpacked extension at chromium://extensions:
#   ./install_snap.sh <EXTENSION_ID>
set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install_snap.sh <EXTENSION_ID>"
  echo "  Load the unpacked extension first (chromium://extensions), then pass its ID."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$HOME/snap/chromium/common/tab_share_host"
NMH_DIR="$HOME/snap/chromium/common/chromium/NativeMessagingHosts"

mkdir -p "$HOST_DIR" "$NMH_DIR"
cp "$SCRIPT_DIR/native_host.py" "$HOST_DIR/native_host.py"
chmod +x "$HOST_DIR/native_host.py"

jq --arg path "$HOST_DIR/native_host.py" --arg origin "chrome-extension://$EXT_ID/" \
  '.path = $path | .allowed_origins = [$origin]' \
  "$SCRIPT_DIR/tab_share.json" > "$NMH_DIR/tab_share.json"

echo "✓ Native host: $HOST_DIR/native_host.py"
echo "✓ Manifest:    $NMH_DIR/tab_share.json"
echo ""
echo "Reload the extension at chromium://extensions, then test:"
echo "  curl -s http://localhost:8766/tabs | jq"
