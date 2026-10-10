#!/bin/bash
# Packages the extension as a platform-specific VSIX (local only; publishing is a separate step).
#   scripts/package.sh [target] [profile]
#   target:  darwin-arm64 (default), darwin-x64, win32-arm64, win32-x64
#   profile: Warp build profile whose bundle to ship (default release-wasm; build it with
#            scripts/build-warp.sh --release)
# Builds in a staging copy, so the working tree stays as it is:
#   - the extension's JS and its pure-JS dependencies become bundled extension.js and daemon.js
#     (the PTY host) (esbuild);
#     node-pty stays a module (native code), with only the target platform's prebuild
#   - the Warp bundle goes into bundle/ (loaded by resolveBundleDir in extension.js), without the
#     onboarding and sign-in slide images, which embedded builds never show
#   - the wasm and the fallback fonts ship brotli-compressed as <file>.br; server.js
#     serves them with Content-Encoding: br, and precompressed.json lists their decoded sizes
# Linux targets need node-pty built on Linux (prebuilds/linux-<arch>/pty.node; built on Rocky
# Linux 8, glibc 2.28, as VS Code requires).
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-darwin-arm64}"
PROFILE="${2:-release-wasm}"
WARP_SRC="${WARP_SRC:-$HOME/src/warp}"
SRC="$WARP_SRC/target/wasm32-unknown-unknown/$PROFILE/bundle"
PREBUILDS=node_modules/node-pty/prebuilds
[ -d "$PREBUILDS/$TARGET" ] || { echo "no node-pty prebuild for $TARGET"; exit 2; }
[ -f "$SRC/wasm/warp.js" ] || { echo "no Warp bundle at $SRC"; exit 2; }

"$PWD/scripts/export-warp-patches.sh" >/dev/null
OUT="$PWD/panelwarp-$TARGET.vsix"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$STAGE.extension.js" "$STAGE.daemon.js"' EXIT

# Extension files and node-pty (with only this platform's prebuild).
rsync -a --exclude .git --exclude bundle --exclude node_modules --exclude '*.vsix' ./ "$STAGE/"
mkdir -p "$STAGE/node_modules"
rsync -a --exclude prebuilds node_modules/node-pty node_modules/node-addon-api "$STAGE/node_modules/"
mkdir -p "$STAGE/node_modules/node-pty/prebuilds"
cp -R "$PREBUILDS/$TARGET" "$STAGE/node_modules/node-pty/prebuilds/"
case "$TARGET" in win32-*) ;; *) rm -rf "$STAGE/node_modules/node-pty/third_party" ;; esac # ConPTY

# One bundled extension.js and daemon.js (the PTY host) in place of the sources (same directory,
# so __dirname is unchanged).
for entry in extension daemon; do
  npx --yes esbuild@0.25 "$entry.js" --bundle --platform=node --format=cjs --target=node20 \
    --external:vscode --external:node-pty --external:'node:*' --log-level=warning \
    --outfile="$STAGE.$entry.js"
done
rm "$STAGE"/*.js
mv "$STAGE.extension.js" "$STAGE/extension.js" && mv "$STAGE.daemon.js" "$STAGE/daemon.js"
node -e '
  const fs = require("fs"), file = process.argv[1], pkg = JSON.parse(fs.readFileSync(file));
  pkg.dependencies = { "node-pty": pkg.dependencies["node-pty"] };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE/package.json"
rm -f "$STAGE/package-lock.json"

# The Warp bundle, minus the slide images (keeping the in-app feature banners).
cp -R "$SRC" "$STAGE/bundle"
find "$STAGE/bundle/assets/png/onboarding" -type f ! -name '*_banner-*' -delete

# Brotli-compress the large text-like files.
(
  cd "$STAGE"
  echo '{' >precompressed.json
  first=1
  for file in bundle/wasm/warp_bg.wasm media/fallback-fonts/*/*.ttf; do
    size=$(stat -f %z "$file" 2>/dev/null || stat -c %s "$file")
    brotli -q "${BROTLI_QUALITY:-11}" -w 24 -o "$file.br" "$file" && rm "$file"
    [ $first = 1 ] || echo ',' >>precompressed.json
    printf '  "%s": %s' "$file" "$size" >>precompressed.json
    first=0
  done
  printf '\n}\n' >>precompressed.json
)

(cd "$STAGE" && npx --yes @vscode/vsce package --target "$TARGET" \
  --allow-missing-repository -o "$OUT")
ls -lh "$OUT"
