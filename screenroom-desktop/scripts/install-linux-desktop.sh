#!/usr/bin/env bash
#
# Install a desktop launcher for MygleTV on Linux.
#
#   ./scripts/install-linux-desktop.sh              install
#   ./scripts/install-linux-desktop.sh --uninstall  remove
#
# The launcher points at *this checkout*, so the menu entry always runs the
# current code -- there is nothing to rebuild after a git pull. The trade-off is
# that moving or deleting the checkout breaks the entry, so run --uninstall
# before relocating it.
#
# The relay is not passed here. main.js already defaults to the deployed one, so
# the only reason to set SCREENROOM_URL is to point at a different relay.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$APP_DIR/node_modules/.bin/electron"
ENTRY="$APP_DIR/main.js"
ICON_SRC="$APP_DIR/packaging/mygletv.svg"

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/scalable/apps"
DESKTOP_FILE="$DESKTOP_DIR/mygletv.desktop"
ICON_FILE="$ICON_DIR/mygletv.svg"

refresh_caches() {
	# Both are optional; a missing one is not a failure.
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
	command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" >/dev/null 2>&1 || true
	return 0
}

if [[ "${1:-}" == "--uninstall" ]]; then
	rm -f "$DESKTOP_FILE" "$ICON_FILE"
	refresh_caches
	echo "Removed the MygleTV launcher."
	echo "  $DESKTOP_FILE"
	echo "  $ICON_FILE"
	exit 0
fi

if [[ ! -f "$ENTRY" ]]; then
	echo "error: cannot find $ENTRY" >&2
	exit 1
fi

if [[ ! -x "$ELECTRON" ]]; then
	echo "error: Electron is not installed in this checkout." >&2
	echo "       Run 'npm install' in $APP_DIR first." >&2
	exit 1
fi

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
cp "$ICON_SRC" "$ICON_FILE"
# cp inherits the source's mode, which is 600 in a fresh checkout.
chmod 644 "$ICON_FILE"

# Exec is written as an absolute pair rather than 'npm start' so the launcher
# does not depend on npm, a login shell or a working directory. Path= covers the
# relative paths main.js and app-server.js resolve at runtime.
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=MygleTV
GenericName=Screen sharing
Comment=Share your screen and one application's audio
Exec=$ELECTRON $ENTRY
Path=$APP_DIR
Icon=mygletv
Terminal=false
Categories=Network;RemoteAccess;
Keywords=screen;share;stream;webrtc;
EOF

chmod +x "$DESKTOP_FILE"
refresh_caches

echo "Installed the MygleTV launcher."
echo "  entry : $DESKTOP_FILE"
echo "  icon  : $ICON_FILE"
echo "  runs  : $ELECTRON $ENTRY"
echo
echo "It should appear in your application menu as MygleTV."
echo "If it does not show up immediately, your launcher's cache may need a moment."
