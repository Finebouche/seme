#!/bin/bash
# Build the local setup window. No Stremio writes, publishing, or notarization.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo "Build this app on macOS." >&2; exit 1; }
for tool in xcrun sips iconutil codesign ditto python3; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in arm64|x86_64) ;; *) echo "ARCH must be arm64 or x86_64." >&2; exit 1 ;; esac
APP="$ROOT/dist/Sème Setup.app"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/seme-integration-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/Seme.iconset" "$ROOT/dist"
xcrun swiftc -module-cache-path "$WORK/swift-cache" -swift-version 5 -O -whole-module-optimization -target "$ARCH-apple-macosx13.0" \
  -framework AppKit stremio-integration/macos/main.swift -o "$WORK/SemeSetup"
# Build into a fresh temporary app before replacing the previous build.
STAGE="$WORK/Sème Setup.app"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/stremio-integration"
cp "$WORK/SemeSetup" "$STAGE/Contents/MacOS/SemeSetup"
cp stremio-integration/macos/Info.plist "$STAGE/Contents/Info.plist"
cp LICENSE "$STAGE/Contents/Resources/LICENSE"
cp stremio-integration/*.cjs "$STAGE/Contents/Resources/stremio-integration/"
ditto stremio-integration/lib "$STAGE/Contents/Resources/stremio-integration/lib"
cp stremio-integration/package.json "$STAGE/Contents/Resources/stremio-integration/"
cp docs/stremio-integration.md "$STAGE/Contents/Resources/Integration Guide.md"
cat > "$STAGE/Contents/Resources/ORIGIN.txt" <<'EOF'
Sème — https://github.com/Finebouche/seme
Fork of Seedstrem — https://github.com/kipsilabs/seedstrem
Original copyright and MIT license: see LICENSE.
Direct cache integration inspired by stremio-seed; independently implemented.
Version 0.4.1. Stremio and the torrent clients are separate software.
EOF
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/icon-512.png --out "$WORK/Seme.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" assets/icon-512.png --out "$WORK/Seme.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
if ! iconutil -c icns "$WORK/Seme.iconset" -o "$STAGE/Contents/Resources/Seme.icns" 2>/dev/null; then
  # Some restricted sessions cannot use iconutil's image service. ICNS supports
  # these PNG representations directly; package the already resized seed icon.
  python3 - "$WORK/Seme.iconset" "$STAGE/Contents/Resources/Seme.icns" <<'PYICON'
import pathlib, struct, sys
folder = pathlib.Path(sys.argv[1])
entries = [(b'icp4', 'icon_16x16.png'), (b'icp5', 'icon_32x32.png'),
           (b'ic07', 'icon_128x128.png'), (b'ic08', 'icon_256x256.png'),
           (b'ic09', 'icon_512x512.png'), (b'ic10', 'icon_512x512@2x.png')]
chunks = []
for kind, name in entries:
    png = (folder / name).read_bytes()
    chunks.append(kind + struct.pack('>I', len(png) + 8) + png)
payload = b''.join(chunks)
pathlib.Path(sys.argv[2]).write_bytes(b'icns' + struct.pack('>I', len(payload) + 8) + payload)
PYICON
fi
plutil -lint "$STAGE/Contents/Info.plist"
codesign --force --sign - "$STAGE"
codesign --verify --deep --strict --verbose=2 "$STAGE"
rm -rf "$APP"
ditto "$STAGE" "$APP"
ARCHIVE="$ROOT/dist/Seme-Stremio-Integration-macos.zip"
rm -f "$ARCHIVE"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
printf 'Built local ad hoc setup: %s\nUses /Applications/Stremio.app/Contents/MacOS/node at runtime. No permanent Sème process.\n' "$APP"
