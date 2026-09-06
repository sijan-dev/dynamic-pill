#!/usr/bin/env bash
set -euo pipefail
UUID="dynamic-pill@fedora-gnome.io"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "[DynamicPill] Disabling..."
gnome-extensions disable "$UUID" 2>/dev/null || true

echo "[DynamicPill] Removing $DEST_DIR"
rm -rf "$DEST_DIR"

echo "[DynamicPill] Uninstalled. Logout/login if needed."
