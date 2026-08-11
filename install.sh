#!/usr/bin/env bash
# Tab Share Extension Setup Script
set -e

echo "========================================="
echo "       Tab Share Extension Setup"
echo "========================================="
echo ""

# Helper to read interactive input even if running via pipe (curl | bash)
prompt_read() {
    local prompt="$1"
    if [ -t 0 ]; then
        read -p "$prompt" "$2"
    elif [ -e /dev/tty ]; then
        read -p "$prompt" "$2" < /dev/tty
    else
        read -p "$prompt" "$2"
    fi
}

# Verify required CLI tools
for cmd in python3 jq git; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: Required dependency '$cmd' is not installed."
        exit 1
    fi
done

TARGET="$(echo "$1" | tr '[:upper:]' '[:lower:]')"

case "$TARGET" in
    chrome|chromium) TARGET="chrome" ;;
    firefox|both) ;;
    "")
        echo "Which browser would you like to install Tab Share for?"
        echo "  1) Chrome / Chromium"
        echo "  2) Firefox"
        echo "  3) Both"
        prompt_read "Select an option [1-3]: " OPTION
        
        case "$OPTION" in
            1) TARGET="chrome" ;;
            2) TARGET="firefox" ;;
            3) TARGET="both" ;;
            *) echo "Invalid option."; exit 1 ;;
        esac
        ;;
    *)
        echo "Error: Invalid target '$1'. Options: chrome, firefox, both"
        exit 1
        ;;
esac

# Determine if we need to clone (if running via curl, we aren't in a git repo)
if [ ! -f "chromium/manifest.json" ] && [ ! -f "firefox/manifest.json" ]; then
    DEFAULT_DIR="$HOME/.kiro/tab-share"
    prompt_read "Where would you like to install Tab Share? [$DEFAULT_DIR]: " INSTALL_DIR
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_DIR}
    
    if [ -d "$INSTALL_DIR" ]; then
        echo "Directory $INSTALL_DIR already exists."
    else
        echo "Cloning tab-share repository..."
        git clone https://github.com/yoavdim/tab-share.git "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

export TS_DIR="$(pwd)"

install_chrome() {
    echo ""
    echo "--- Chrome / Chromium Setup ---"
    echo "1. In Chrome, navigate to: chrome://extensions"
    echo "2. Enable 'Developer mode' (top right)"

    if [ -d "$HOME/snap/chromium" ]; then
        echo "   (Snap Chromium detected, copying extension to accessible path...)"
        mkdir -p "$HOME/snap/chromium/common/tab_share_extension"
        cp -r "$TS_DIR/chromium/"* "$HOME/snap/chromium/common/tab_share_extension/"
        echo "3. Click 'Load unpacked' and select this folder: $HOME/snap/chromium/common/tab_share_extension"
    else
        echo "3. Click 'Load unpacked' and select this folder: $TS_DIR/chromium"
    fi

    echo "4. Copy the 32-character Extension ID that appears."
    echo ""

    prompt_read "Paste the Extension ID here: " EXT_ID

    if [ -z "$EXT_ID" ]; then
        echo "Aborting Chrome setup."
    else
        if [ -d "$HOME/snap/chromium" ]; then
            bash "$TS_DIR/chromium/install_snap.sh" "$EXT_ID"
        else
            TMP_MANIFEST="$(mktemp)"
            HOST_PATH="$TS_DIR/chromium/native_host.py"
            chmod +x "$HOST_PATH"
            jq --arg path "$HOST_PATH" --arg origin "chrome-extension://$EXT_ID/" \
              '.path = $path | .allowed_origins = [$origin]' \
              "$TS_DIR/chromium/tab_share.json" > "$TMP_MANIFEST"
            
            for base in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/microsoft-edge" "$HOME/.config/BraveSoftware/Brave-Browser"; do
              if [ -d "$base" ]; then
                mkdir -p "$base/NativeMessagingHosts"
                cp "$TMP_MANIFEST" "$base/NativeMessagingHosts/tab_share.json"
                echo "✓ Registered native host in $base/NativeMessagingHosts"
              fi
            done
            rm -f "$TMP_MANIFEST"
        fi
        echo "Chrome Tab Share installation scripts completed."
        echo "Please RELOAD the extension in chrome://extensions to finish setup."
    fi
}

install_firefox() {
    echo ""
    echo "--- Firefox Setup ---"
    
    if [ -d "$HOME/snap/firefox" ]; then
        echo "   (Snap Firefox detected, staging files for snap access...)"
        
        # Snap setup
        mkdir -p "$HOME/.local/lib/tab_share"
        cp "$TS_DIR/firefox/native_host.py" "$HOME/.local/lib/tab_share/native_host.py"
        chmod +x "$HOME/.local/lib/tab_share/native_host.py"
        
        mkdir -p "$HOME/.mozilla/native-messaging-hosts"
        python3 - <<'PY'
import json, os
ts_dir = os.environ.get('TS_DIR', '.')
src = os.path.join(ts_dir, 'firefox', 'tab_share.json')
dst = os.path.expanduser('~/.mozilla/native-messaging-hosts/tab_share.json')
m = json.load(open(src))
m['path'] = os.path.expanduser('~/.local/lib/tab_share/native_host.py')
json.dump(m, open(dst, 'w'), indent=2)
PY
        
        mkdir -p "$HOME/snap/firefox/common/tab_share_extension"
        cp -r "$TS_DIR/firefox/"* "$HOME/snap/firefox/common/tab_share_extension/"
        
        echo "1. Open about:debugging#/runtime/this-firefox in Firefox"
        echo "2. Click 'Load Temporary Add-on'"
        echo "3. Select: $HOME/snap/firefox/common/tab_share_extension/manifest.json"
    else
        # Standard setup
        MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
        mkdir -p "$MANIFEST_DIR"
        jq --arg path "$TS_DIR/firefox/native_host.py" '.path = $path' \
          "$TS_DIR/firefox/tab_share.json" > "$MANIFEST_DIR/tab_share.json"
        
        echo "1. Open about:debugging#/runtime/this-firefox in Firefox"
        echo "2. Click 'Load Temporary Add-on'"
        echo "3. Select: $TS_DIR/firefox/manifest.json"
    fi
    echo ""
    echo "Verify Firefox connection with: curl -s http://localhost:8765/tabs | jq"
}

if [[ "$TARGET" == "chrome" || "$TARGET" == "both" ]]; then
    install_chrome
fi

if [[ "$TARGET" == "firefox" || "$TARGET" == "both" ]]; then
    install_firefox
fi

echo ""
echo "Setup complete!"
