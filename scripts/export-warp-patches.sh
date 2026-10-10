#!/bin/bash
# Exports our Warp changes into warp-patches/ (backed up with the extension): one patch per commit
# on the vscode-panel branch since UPSTREAM_COMMIT, plus any uncommitted edits as a backup patch.
# Rebuild a Warp checkout from them with:
#   git checkout $(cat warp-patches/UPSTREAM_COMMIT) && git am warp-patches/0*.patch
set -euo pipefail
WARP_SRC="${WARP_SRC:-$HOME/src/warp}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/warp-patches"
base="$(cat "$OUT/UPSTREAM_COMMIT")"
cd "$WARP_SRC"
rm -f "$OUT"/0*.patch "$OUT/uncommitted.patch" "$OUT/backup-uncommitted.patch"
git format-patch -q --no-signature -o "$OUT" "$base..vscode-panel"
if ! git diff --quiet HEAD; then git diff HEAD > "$OUT/uncommitted.patch"; fi
ls "$OUT" | sed 's/^/  /'
