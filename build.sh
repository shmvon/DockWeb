#!/bin/bash
# Build DockWeb.app: a menu-bar app that runs the bundled Node server.
#
#   ./build.sh              build and install to /Applications/DockWeb.app
#   ./build.sh --no-install build to ./dist/DockWeb.app only
#
# Signing: uses $DOCKWEB_SIGN_ID, else the first valid code-signing identity in your keychain,
# else ad-hoc. A real (even self-signed) identity keeps the Accessibility permission across rebuilds;
# with ad-hoc signing macOS sees every rebuild as a new app and asks again.
set -euo pipefail

APP_NAME="DockWeb"
SRC="$(cd "$(dirname "$0")" && pwd)"
DIST="$SRC/dist"
INSTALL=true
[ "${1:-}" = "--no-install" ] && INSTALL=false

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$NODE_BIN" ] || { echo "Node.js 18+ is required (brew install node)."; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc not found: install Xcode Command Line Tools (xcode-select --install)."; exit 1; }

STAGING="$(mktemp -d /private/tmp/${APP_NAME}_build.XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT
APP="$STAGING/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server/scripts"

echo "==> Compiling launcher"
swiftc -O -target "$(uname -m)-apple-macos13.0" -o "$APP/Contents/MacOS/$APP_NAME" "$SRC/macos/DockWeb.swift"

echo "==> Copying server"
cp "$SRC/server.js" "$SRC/icon-png.js" "$SRC/index.html" "$SRC/manifest.webmanifest" "$SRC/package.json" "$APP/Contents/Resources/server/"
cp "$SRC"/scripts/*.js "$APP/Contents/Resources/server/scripts/"

echo "==> Info.plist (node: $NODE_BIN)"
cp "$SRC/macos/Info.plist" "$APP/Contents/Info.plist"
plutil -replace DockWebNodePath -string "$NODE_BIN" "$APP/Contents/Info.plist"

echo "==> App icon"
ICONSET="$STAGING/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  "$NODE_BIN" "$SRC/icon-png.js" "$s" "$ICONSET/icon_${s}x${s}.png"
  "$NODE_BIN" "$SRC/icon-png.js" "$((s * 2))" "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "==> Signing"
xattr -cr "$APP" 2>/dev/null || true
SIGN_ID="${DOCKWEB_SIGN_ID:-$(security find-identity -p codesigning -v 2>/dev/null | awk -F'"' '/^ *[0-9]+\)/ {print $2; exit}')}"
if [ -n "$SIGN_ID" ] && codesign --force --deep --sign "$SIGN_ID" "$APP" 2>/dev/null; then
  echo "    signed with \"$SIGN_ID\""
else
  codesign --force --deep --sign - "$APP"
  echo "    ad-hoc signed (re-allow Accessibility after each rebuild)"
fi
codesign --verify "$APP"

if $INSTALL; then DEST="/Applications/$APP_NAME.app"; else DEST="$DIST/$APP_NAME.app"; mkdir -p "$DIST"; fi

# Quit a running copy so the new one can take the port.
osascript -e "tell application id \"io.github.shmvon.dockweb\" to quit" >/dev/null 2>&1 || true
pkill -x "$APP_NAME" 2>/dev/null || true

echo "==> Installing to $DEST"
rm -rf "$DEST"
mv "$APP" "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true

# Carry over the PIN and logged-in devices from running server.js from this folder.
DATA="$HOME/Library/Application Support/DockWeb"
if [ -f "$SRC/config.json" ] && [ ! -f "$DATA/config.json" ]; then
  mkdir -p "$DATA"
  cp "$SRC/config.json" "$DATA/config.json" && chmod 600 "$DATA/config.json"
  echo "==> Copied existing PIN/sessions to $DATA"
fi

echo
echo "Built $DEST"
echo "Start it with: open \"$DEST\"   (it lives in the menu bar)"
