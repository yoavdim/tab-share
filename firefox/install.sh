#!/bin/bash
# Installs Tab Share native messaging host.
# The extension itself must be loaded via about:debugging (unsigned).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Register native messaging host
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$MANIFEST_DIR"
jq --arg path "$SCRIPT_DIR/native_host.py" '.path = $path' \
  "$SCRIPT_DIR/tab_share.json" > "$MANIFEST_DIR/tab_share.json"

echo "✓ Native messaging host registered"
echo ""
echo "To load the extension:"
echo "  1. Open about:debugging#/runtime/this-firefox in Firefox"
echo "  2. Click 'Load Temporary Add-on'"
echo "  3. Select: $SCRIPT_DIR/manifest.json"
echo ""
echo "Then: curl -s http://localhost:8765/tabs | jq"
