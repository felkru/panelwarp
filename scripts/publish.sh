#!/bin/bash
# Publishes the extension to the VS Code Marketplace for every supported platform.
#   scripts/publish.sh [--skip-build]
# Bump "version" in package.json first. Runs the release Warp build (unless --skip-build), packages
# one VSIX per platform (scripts/package.sh) and uploads them all with vsce, which reads the token
# saved by `npx @vscode/vsce login felixkrueckel` (or VSCE_PAT).
# Linux needs node-pty built on Linux first: see scripts/linux-node-pty/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)
VERSION=$(node -p 'require("./package.json").version')

for target in "${TARGETS[@]}"; do
  [ -d "node_modules/node-pty/prebuilds/$target" ] || {
    echo "no node-pty prebuild for $target (see scripts/linux-node-pty/README.md)"
    exit 2
  }
done
[ -n "${VSCE_PAT:-}" ] || npx --yes @vscode/vsce ls-publishers 2>/dev/null | grep -qx felixkrueckel || {
  echo 'not logged in: run `npx @vscode/vsce login felixkrueckel` with a Marketplace (Manage) token'
  exit 2
}

[ "${1:-}" = --skip-build ] || scripts/build-warp.sh --release --note "Release build for $VERSION"

# Two at a time: each one brotli-compresses ~200 MB.
rm -f panelwarp-*.vsix
for pair in "darwin-arm64 darwin-x64" "linux-x64 linux-arm64"; do
  for target in $pair; do scripts/package.sh "$target" >"/tmp/panelwarp-package-$target.log" 2>&1 & done
  wait
done
for target in "${TARGETS[@]}"; do
  [ -f "panelwarp-$target.vsix" ] || { tail -20 "/tmp/panelwarp-package-$target.log"; exit 1; }
done

npx --yes @vscode/vsce publish --packagePath panelwarp-*.vsix
echo "published $VERSION: https://marketplace.visualstudio.com/items?itemName=felixkrueckel.panelwarp"
