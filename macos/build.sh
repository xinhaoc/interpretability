#!/bin/zsh
# Builds interpretability.app (a native window around the local server) and installs it.
#
#   ./macos/build.sh            build into dist/ and copy to /Applications
#   ./macos/build.sh --no-install
#
# The app carries a copy of the code (so it never needs access to the Desktop folder)
# and runs it with the Python found here at build time. Re-run this script after
# changing the code; data stays in ~/Interpretability.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="dist/interpretability.app"
PY="$(command -v python3)"

"$PY" -c "import fitz, fastapi, uvicorn, httpx, anthropic, multipart, mcp, PIL" 2>/dev/null || {
  echo "Installing Python dependencies for $PY"; "$PY" -m pip install -r requirements.txt; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build

swiftc -O -target "$(uname -m)-apple-macos13.0" -o "$APP/Contents/MacOS/interpretability" macos/main.swift \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers
test -x "$APP/Contents/MacOS/interpretability"

# The server code, copied into the bundle
mkdir -p "$APP/Contents/Resources/app"
cp ./*.py requirements.txt "$APP/Contents/Resources/app/"
cp -R static "$APP/Contents/Resources/app/static"

rm -rf build/AppIcon.iconset
"$PY" macos/make_icon.py build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

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
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>读懂每一篇论文</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>PDF Document</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
  </dict></array>
</dict></plist>
PLIST
# Paths go in with plutil so characters like & or < cannot break the XML.
NODE_DIR="$(dirname "$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)")"
plutil -insert InterpretabilityPython -string "$PY" "$APP/Contents/Info.plist"
plutil -insert InterpretabilityPATH -string "$HOME/.local/bin:$(dirname "$PY"):$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$APP/Contents/Info.plist"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $ROOT/$APP"

if [[ "${1:-}" != "--no-install" ]]; then
  rm -rf "/Applications/interpretability.app"
  cp -R "$APP" /Applications/
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/interpretability.app >/dev/null 2>&1 || true
  echo "Installed /Applications/interpretability.app"
fi
