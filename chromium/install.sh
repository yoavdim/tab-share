#!/bin/bash
# Installs the Tab Share native messaging host for Chromium-family browsers.
#
# Unlike Firefox, Chromium pins the native host to a specific extension ID via
# "allowed_origins". Unpacked extensions get their ID assigned when you load them,
# so you must load the extension FIRST, copy its ID, then run this script:
#
#   1. Open  chrome://extensions  (or chromium://extensions / edge://extensions)
#   2. Enable "Developer mode"
#   3. "Load unpacked" -> select this directory
#   4. Copy the extension's ID (a 32-char string under the extension name)
#   5. Run:  ./install.sh <EXTENSION_ID>
#
# Re-run with the same ID anytime; it just rewrites the manifests.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="$1"

if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install.sh <EXTENSION_ID>"
  echo "  Load the unpacked extension first (chrome://extensions), then pass its ID."
  exit 1
fi

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Warning: '$EXT_ID' doesn't look like a Chrome extension ID (expected 32 chars a-p)."
  echo "Continuing anyway..."
fi

HOST_PATH="$SCRIPT_DIR/native_host.py"
chmod +x "$HOST_PATH"

# Build the host manifest with the real path + extension origin.
TMP_MANIFEST="$(mktemp)"
jq --arg path "$HOST_PATH" --arg origin "chrome-extension://$EXT_ID/" \
  '.path = $path | .allowed_origins = [$origin]' \
  "$SCRIPT_DIR/tab_share.json" > "$TMP_MANIFEST"

# Candidate native-messaging-host directories for installed Chromium browsers (Linux).
TARGET_DIRS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/.config/microsoft-edge/NativeMessagingHosts"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

INSTALLED=0
for base in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/chromium" \
  "$HOME/.config/microsoft-edge" \
  "$HOME/.config/BraveSoftware/Brave-Browser"; do
  if [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    cp "$TMP_MANIFEST" "$base/NativeMessagingHosts/tab_share.json"
    echo "✓ Registered native host in $base/NativeMessagingHosts"
    INSTALLED=$((INSTALLED + 1))
  fi
done

rm -f "$TMP_MANIFEST"

if [ "$INSTALLED" -eq 0 ]; then
  echo "No Chromium-family browser config dirs found under ~/.config."
  echo "Is Chrome/Chromium installed and run at least once?"
  exit 1
fi

echo ""
echo "Done. Reload the extension at chrome://extensions, then test:"
echo "  curl -s http://localhost:8766/tabs | jq"
