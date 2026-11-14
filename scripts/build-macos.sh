#!/bin/bash
# Build a self-contained macOS app. See docs/macos.md for release signing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo "Build this app on macOS." >&2; exit 1; }

ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64) GOARCH=arm64 ;;
  x86_64) GOARCH=amd64 ;;
  *) echo "ARCH must be arm64 or x86_64 (separate builds, not universal)." >&2; exit 1 ;;
esac
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
MACOS_VERSION="${MACOS_VERSION:-0.1.0}"
MACOS_BUILD_NUMBER="${MACOS_BUILD_NUMBER:-1}"
CREATE_DMG="${CREATE_DMG:-0}"
NOTARIZE="${NOTARIZE:-0}"
for tool in go npm xcrun sips iconutil codesign ditto; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
if [[ "$NOTARIZE" == 1 ]]; then
  [[ -n "${DEVELOPER_ID:-}" && -n "${NOTARY_PROFILE:-}" ]] || {
    echo "NOTARIZE=1 requires DEVELOPER_ID and NOTARY_PROFILE (notarytool Keychain profile)." >&2
    exit 1
  }
fi
[[ -f macos/Info.plist ]] || { echo "Missing macos/Info.plist." >&2; exit 1; }
sources=(macos/*.swift)
[[ -f "${sources[0]}" ]] || { echo "No Swift app sources in macos/." >&2; exit 1; }

APP="$ROOT/dist/Sème.app"
RESOURCES="$APP/Contents/Resources"
ARCHIVE="$ROOT/dist/Seme-macos-$ARCH.zip"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/seme-macos.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p dist
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RESOURCES"

# The lockfile pins frontend dependencies; Go embeds the resulting web/dist.
(cd web && npm ci --no-audit --no-fund && npm run build)
CGO_ENABLED=0 GOOS=darwin GOARCH="$GOARCH" go build -trimpath \
  -ldflags "-s -w -X main.version=$VERSION" -o "$RESOURCES/seme-server" ./cmd/seme
xcrun swiftc -O -whole-module-optimization -target "$ARCH-apple-macosx13.0" \
  -framework AppKit -framework WebKit -framework ServiceManagement \
  "${sources[@]}" -o "$APP/Contents/MacOS/Seme"
cp macos/Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MACOS_VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $MACOS_BUILD_NUMBER" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
cp LICENSE "$RESOURCES/LICENSE"
cat > "$RESOURCES/ORIGIN.txt" <<EOF
Sème — https://github.com/Finebouche/seme
Version: $VERSION
Architecture: $ARCH
Fork of Seedstrem — https://github.com/kipsilabs/seedstrem
Copyright and license: see LICENSE (MIT).
The bundled server embeds the Sème web interface. Transmission is separate software.
EOF

# Create all standard ICNS representations using only macOS tools. The committed
# 512px web icon comes from web/public/seed.svg; 1024px is an upscaled rendition.
ICONSET="$WORK/Seme.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" web/public/icon-512.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" web/public/icon-512.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/Seme.icns"

# Sign contained code first, then seal the bundle. Ad hoc builds are local only.
SIGN_ARGS=(--force --sign "${DEVELOPER_ID:--}")
if [[ -n "${DEVELOPER_ID:-}" ]]; then
  SIGN_ARGS+=(--options runtime --timestamp)
fi
codesign "${SIGN_ARGS[@]}" "$RESOURCES/seme-server"
codesign "${SIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

make_zip() {
  rm -f "$ARCHIVE"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
}
make_zip
if [[ "$NOTARIZE" == 1 ]]; then
  # Opt-in submission to Apple; never enabled by the default/local build.
  xcrun notarytool submit "$ARCHIVE" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  make_zip
fi
if [[ "$CREATE_DMG" == 1 ]]; then
  mkdir -p "$WORK/dmg"
  ditto "$APP" "$WORK/dmg/Sème.app"
  ln -s /Applications "$WORK/dmg/Applications"
  DMG="$ROOT/dist/Seme-macos-$ARCH.dmg"
  rm -f "$DMG"
  hdiutil create -volname "Sème" -srcfolder "$WORK/dmg" -ov -format UDZO "$DMG"
  if [[ -n "${DEVELOPER_ID:-}" ]]; then
    codesign --force --sign "$DEVELOPER_ID" --timestamp "$DMG"
  fi
  if [[ "$NOTARIZE" == 1 ]]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
  fi
fi
printf 'Built %s\nArchive: %s\n' "$APP" "$ARCHIVE"
