// The PTY host: runs server.js outside VS Code's extension host, so the panel's shells keep
// running when a VS Code window reloads (like VS Code's own terminal, whose pty host is a separate
// process too). Started detached by ptyHost.js with VS Code's own runtime (ELECTRON_RUN_AS_NODE);
// one serves every window. It writes how to reach it to WARP_PANEL_STATE and exits once it has had
// no shell and no page request for IDLE_EXIT_MS.

const crypto = require('crypto');
const fs = require('fs');
const { startServer } = require('./server');

const IDLE_EXIT_MS = 5 * 60 * 1000;
const IDLE_CHECK_MS = 10 * 1000;

const stateFile = process.env.WARP_PANEL_STATE;
const bundleDir = process.env.WARP_PANEL_BUNDLE_DIR;
const key = process.env.WARP_PANEL_KEY;
const nonce = process.env.WARP_PANEL_NONCE;
// The shells get the environment VS Code gave the extension, without the variable that made this
// process plain Node (Electron apps started from a shell would otherwise do the same).
delete process.env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(process.env)) if (name.startsWith('WARP_PANEL_')) delete process.env[name];

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes the state file only readable by this user: it holds the PTY token. */
function writeState(state) {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

async function main() {
  if (!stateFile || !bundleDir) throw new Error('WARP_PANEL_STATE and WARP_PANEL_BUNDLE_DIR are required');
  const server = await startServer({
    bundleDir,
    token: crypto.randomBytes(32).toString('hex'),
    staticPort: Number(process.env.WARP_PANEL_STATIC_PORT) || 0,
    log,
  });
  writeState({
    pid: process.pid,
    key,
    nonce,
    pageUrl: server.pageUrl,
    staticOrigin: server.staticOrigin,
    ptyBaseUrl: server.ptyBaseUrl,
  });
  log(`PTY host ${process.pid} serving ${bundleDir} at ${server.pageUrl}`);

  let idleSince = Date.now();
  setInterval(() => {
    const { sessions, lastActivity } = server.stats();
    if (sessions) idleSince = Date.now();
    if (Date.now() - Math.max(idleSince, lastActivity) < IDLE_EXIT_MS) return;
    log('idle; exiting');
    shutdown(server);
  }, IDLE_CHECK_MS);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(server));
}

function shutdown(server) {
  server.close();
  // A newer PTY host may have taken over the state file meanwhile.
  if (readState()?.pid === process.pid) fs.rmSync(stateFile, { force: true });
  process.exit(0);
}

main().catch((error) => {
  log(`PTY host failed: ${error.stack || error}`);
  process.exit(1);
});
