# node-pty for Linux

node-pty has no Linux prebuilds, so this builds `pty.node` for linux-x64 and linux-arm64 (QEMU) on
Rocky Linux 8 (glibc 2.28, VS Code's minimum) in Google Cloud Build, and smoke-tests server.js
with bash on each:

    cp ../../server.js ../../shellRecorder.js . && mkdir -p bundle && echo '<html></html>' >bundle/index.html
    gcloud builds submit --config cloudbuild.yaml --substitutions _BUCKET=<bucket> .

Then copy `gs://<bucket>/out/linux-<arch>/pty.node` to `node_modules/node-pty/prebuilds/linux-<arch>/`
before `scripts/package.sh linux-<arch>`.
