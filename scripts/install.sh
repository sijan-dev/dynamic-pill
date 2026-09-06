#!/usr/bin/env bash
set -euo pipefail

UUID="dynamic-pill@fedora-gnome.io"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "[DynamicPill] Installing to $DEST_DIR"
mkdir -p "$DEST_DIR"

# Compile schemas
if [ -d "$SRC_DIR/schemas" ]; then
    echo "[DynamicPill] Compiling schemas..."
    glib-compile-schemas "$SRC_DIR/schemas" 2>&1 || echo "[DynamicPill] schema compile warning"
fi

# Copy files
cp -r "$SRC_DIR/metadata.json" "$DEST_DIR/"
cp -r "$SRC_DIR/extension.js" "$DEST_DIR/"
cp -r "$SRC_DIR/prefs.js" "$DEST_DIR/"
cp -r "$SRC_DIR/stylesheet.css" "$DEST_DIR/"
cp -r "$SRC_DIR/src" "$DEST_DIR/" 2>/dev/null || true
cp -r "$SRC_DIR/schemas" "$DEST_DIR/" 2>/dev/null || true

echo "[DynamicPill] Installed. Now compile schemas in destination..."
if [ -f "$DEST_DIR/schemas/org.gnome.shell.extensions.dynamic-pill.gschema.xml" ]; then
    glib-compile-schemas "$DEST_DIR/schemas" && echo "[DynamicPill] Schemas compiled"
fi

echo "[DynamicPill] Done. Enable with:"
echo "  gnome-extensions enable $UUID"
echo "Or restart GNOME Shell (Wayland: logout/login, X11: Alt+F2 → r)"
