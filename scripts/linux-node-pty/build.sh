#!/bin/bash
# Builds node-pty for this platform on Rocky Linux 8 (glibc 2.28), then runs the smoke test.
set -euxo pipefail
dnf -y -q module enable nodejs:20 && dnf -y -q install nodejs gcc-c++ make python3 >/dev/null
cp -rL /src/. /work/ && rm -rf /work/out && cd /work
npm init -y >/dev/null && npm install --no-audit --no-fund node-pty@1.1.0 ws@8 >/dev/null
ls node_modules/node-pty/build/Release/
ldd node_modules/node-pty/build/Release/pty.node || true
node smoke.js
mkdir -p /src/out/linux-$1 && cp node_modules/node-pty/build/Release/pty.node /src/out/linux-$1/
