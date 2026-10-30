#!/bin/zsh
# Builds a self-contained interpretability.app (with its own Python) and a DMG to share.
#
#   ./macos/package.sh          -> dist/release/interpretability.app and dist/interpretability-<ver>-arm64.dmg
#
# Unlike build.sh (which uses this machine's Python), the result runs on any Apple Silicon Mac
# with macOS 13+. It is ad-hoc signed, not notarized: the first open needs "Open Anyway"
# in System Settings > Privacy & Security (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="0.2.1"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-aarch64-apple-darwin-install_only.tar.gz"
PY_SHA="83dcb04777c798bd95f3687acf9ae84b09860272ee6bdfb05be8bcf9447f75b8"
OUT="dist/release"
APP="$OUT/interpretability.app"
RES="$APP/Contents/Resources"
DMG="dist/interpretability-$VERSION-arm64.dmg"
HOST_PY="$(command -v python3)"   # only used to draw the icon

[[ "$(uname -m)" == "arm64" ]] || { echo "Build on an Apple Silicon Mac."; exit 1; }

# ---- a relocatable Python (cached, checksum-verified)
mkdir -p build/cache
TARBALL="build/cache/python-3.12.15-aarch64-apple-darwin.tar.gz"
if [[ ! -f "$TARBALL" ]] || [[ "$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)" != "$PY_SHA" ]]; then
  echo "Downloading Python…"
  curl -fsSL "$PY_URL" -o "$TARBALL"
fi
[[ "$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)" == "$PY_SHA" ]] || { echo "Python checksum mismatch"; exit 1; }

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$RES"
tar -xzf "$TARBALL" -C "$RES"          # -> $RES/python
PY="$RES/python/bin/python3"

echo "Installing dependencies…"
"$PY" -m pip install --quiet --disable-pip-version-check --no-cache-dir --no-compile -r macos/requirements-app.txt

# ---- trim what the app never uses
SITE="$RES/python/lib/python3.12"
rm -rf "$SITE/test" "$SITE/idlelib" "$SITE/tkinter" "$SITE/turtledemo" "$SITE/ensurepip" "$SITE/lib2to3" \
       "$RES/python/lib/tcl"* "$RES/python/lib/tk"* "$RES/python/lib/itcl"* "$RES/python/lib/thread"* \
       "$RES/python/share" "$RES/python/include"
find "$RES/python" -name "__pycache__" -type d -prune -exec rm -rf {} +
find "$RES/python" -path "*/site-packages/*/tests" -type d -prune -exec rm -rf {} +
"$PY" -m compileall -q -j 0 "$SITE" >/dev/null 2>&1 || true

# ---- the app code
mkdir -p "$RES/app"
cp ./*.py "$RES/app/"
cp -R static "$RES/app/static"

# ---- the native shell and icon
swiftc -O -target arm64-apple-macos13.0 -o "$APP/Contents/MacOS/interpretability" macos/main.swift \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers
rm -rf build/AppIcon.iconset
"$HOST_PY" macos/make_icon.py build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$RES/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>interpretability</string>
  <key>CFBundleDisplayName</key><string>interpretability</string>
  <key>CFBundleIdentifier</key><string>local.interpretability.app</string>
  <key>CFBundleExecutable</key><string>interpretability</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>AGPL-3.0 · github.com/xinhaoc/interpretability</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>PDF Document</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
  </dict></array>
</dict></plist>
PLIST

# Sign every Mach-O file inside, then the bundle (ad-hoc; no Apple developer ID).
find "$RES/python" -type f \( -name "*.so" -o -name "*.dylib" -o -perm -111 \) -exec codesign --force --sign - {} \; 2>/dev/null || true
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP ($(du -sh "$APP" | cut -f1))"

# ---- DMG: the app plus a link to /Applications
STAGE="build/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "interpretability" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "Built $DMG ($(du -h "$DMG" | cut -f1))"
