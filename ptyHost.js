// Finds the PTY host (daemon.js) for this build of the extension, or starts it. It runs detached
// from the extension host, so shells survive window reloads; every VS Code window uses the same
// one. Its state file (in the extension's global storage, only readable by this user) says where it
// listens and holds the PTY token.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const STATE_FILE = 'pty-host.json';
const LOG_FILE = 'pty-host.log';
const LOG_MAX_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 15 * 1000;

/**
 * Identifies the PTY host's code and bundle: after an update (or a rebuild in development) a new
 * one starts, and the old one exits once its shells have ended.
 */
function buildKey(bundleDir) {
  const hash = crypto.createHash('sha256').update(`${__dirname}\n${bundleDir}`);
  // The packaged extension bundles server.js and shellRecorder.js into daemon.js.
  for (const file of ['daemon.js', 'server.js', 'shellRecorder.js']) {
    try {
      const stat = fs.statSync(path.join(__dirname, file));
      hash.update(`\n${file}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      // Not shipped separately.
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether the PTY host from `state` is running and accepting connections. */
function isRunning(state) {
  try {
    process.kill(state.pid, 0);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const { hostname, port } = new URL(state.pageUrl);
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Opens the log for appending, starting over once it's grown past LOG_MAX_BYTES. */
function openLog(file) {
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  return fs.openSync(file, 'a', 0o600);
}

/**
 * @param {{storageDir: string, bundleDir: string, staticPort?: number, log: (msg: string) => void}} options
 * @returns {Promise<{pid: number, pageUrl: string, staticOrigin: string, ptyBaseUrl: string}>}
 */
async function ensurePtyHost({ storageDir, bundleDir, staticPort = 0, log }) {
  fs.mkdirSync(storageDir, { recursive: true });
  const stateFile = path.join(storageDir, STATE_FILE);
  const key = buildKey(bundleDir);
  const existing = readState(stateFile);
  if (existing?.key === key && (await isRunning(existing))) return existing;

  const logFile = path.join(storageDir, LOG_FILE);
  const nonce = crypto.randomBytes(16).toString('hex');
  const out = openLog(logFile);
  // VS Code's own runtime as plain Node, as VS Code starts its helper processes.
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: os.homedir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WARP_PANEL_STATE: stateFile,
      WARP_PANEL_BUNDLE_DIR: bundleDir,
      WARP_PANEL_KEY: key,
      WARP_PANEL_NONCE: nonce,
      WARP_PANEL_STATIC_PORT: String(staticPort || 0),
    },
  });
  child.unref();
  fs.closeSync(out);
  let exited = null;
  child.once('exit', (code) => (exited = code));
  child.once('error', (error) => (exited = error.message));

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(stateFile);
    if (state?.nonce === nonce) {
      log(`started PTY host ${state.pid} (log: ${logFile})`);
      return state;
    }
    if (exited !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-6).join('\n');
  throw new Error(`The PTY host didn't start (${exited ?? 'timed out'}):\n${tail}`);
}

module.exports = { ensurePtyHost };
