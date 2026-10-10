#!/bin/bash
# Builds the Warp web bundle the panel loads (remote_tty) and plays a sound + notification when a
# new version is ready to test (or a different one on failure).
#   (default)  wasm-fast profile: no LTO, incremental, no wasm-opt. ~20-30 s per edit.
#   --thin     wasm-thin profile: thin LTO + wasm-opt. ~1.5 min per edit, close to release.
#   --release  release-wasm profile: fat LTO + wasm-opt, the build to ship. ~9 min.
#   --note "Shells other than zsh"  what the build adds, shown in the notification (default: the
#              newest Warp commit's subject, marked "+ uncommitted" when the tree has changes)
# The panel loads whichever bundle was built most recently (see resolveBundleDir in extension.js).
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WARP_SRC="${WARP_SRC:-$HOME/src/warp}"
LOG="${LOG:-/tmp/warp-panel-build.log}"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
PROFILE=wasm-fast
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --thin) PROFILE=wasm-thin ;;
    --release) PROFILE=release-wasm ;;
    --note) NOTE="$2"; shift ;;
    *) echo "usage: $0 [--thin|--release] [--note TEXT]"; exit 2 ;;
  esac
  shift
done
cd "$WARP_SRC" || exit 1
if [ -z "$NOTE" ]; then
  NOTE="$(git log -1 --format=%s)"
  [ -n "$(git status --porcelain --untracked-files=no)" ] && NOTE="$NOTE + uncommitted"
fi
# Keep the patch backup in the extension folder current with every build.
"$SCRIPT_DIR/export-warp-patches.sh" >/dev/null || echo "warning: patch export failed"
B=target/wasm32-unknown-unknown/$PROFILE/bundle
# Arguments go through argv, so quotes in the note can't break the AppleScript.
notify() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Warp panel build" subtitle (item 2 of argv)' -e 'end run' "$1" "$NOTE" >/dev/null 2>&1
}
optimize() {
  # The fast loop skips wasm-opt: a ~200 MB unoptimized wasm loads just as quickly locally.
  [ "$PROFILE" = wasm-fast ] && return 0
  wasm-opt --strip-debug --strip-producers -O2 --enable-bulk-memory \
    --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    --enable-reference-types --enable-multivalue "$B/wasm/warp_bg.wasm" -o "$B/wasm/warp_bg.opt.wasm" >>"$LOG" 2>&1 \
    && mv "$B/wasm/warp_bg.opt.wasm" "$B/wasm/warp_bg.wasm"
}
start=$(date +%s)
if ./script/wasm/bundle --no-split --channel oss --profile "$PROFILE" --features remote_tty >"$LOG" 2>&1 \
  && optimize; then
  secs=$(( $(date +%s) - start ))
  echo "build ok ($PROFILE) in ${secs}s: $NOTE"
  notify "New version ready ($PROFILE, ${secs}s). Reload the VS Code window to test."
  afplay /System/Library/Sounds/Glass.aiff
else
  echo "build FAILED, see $LOG"; grep -E '^error' -A8 "$LOG" | head -40
  notify "Build failed. See $LOG"
  afplay /System/Library/Sounds/Basso.aiff
  exit 1
fi
