// Local backend for Warp-on-web built with the `remote_tty` feature.
//
// PTY protocol (see warp app/src/terminal/remote_tty/event_loop.rs):
//   - client connects to ws://127.0.0.1:<ptyPort>/create?[token=T&]shell=S&num_rows=R&num_cols=C
//     [&shell_path=P][&default_cwd=D][&cwd=C][&pane=U] (`shell` tells Warp which bootstrap to use;
//     the server runs `shell_path`, else its default shell; a restored tab asks for `cwd`; `pane`
//     is Warp's pane uuid, see "Adoption" below)
//   - binary frames carry raw PTY bytes in both directions
//   - text frames from the client are JSON resize events: {width, height, width_px, height_px}
//     where width/height are columns/rows
//   - text frames from the server are JSON control messages: {"session": id}, {"exited": code},
//     "password_prompt" (see watchPasswordPrompts), and {"adopt": ...} / "adopted" (below)
// Adoption: shells outlive the page (daemon.js keeps this server running across VS Code window
// reloads). When a reloaded page asks for a pane whose shell is still running and detached, it
// gets that shell instead of a new one: {"adopt": {"session", "session_ids"}}, the shell's
// recorded output (shellRecorder.js), then "adopted".
// Warp writes its own shell bootstrap over the socket, so we only spawn the shell (see shellLaunch).
//
// Auth: with a token (the VS Code extension always passes one), every PTY connection must carry
// ?token=<token>. Without one (`node server.js <bundle>` for local dev), connections are only
// accepted from the dev page's own origin, since browsers let any website open WebSockets to
// localhost.
//
// The static server serves Warp's web bundle (mirroring warp's crates/serve-wasm routes) plus
// media/host.html as the page. It holds no secrets: the token only ever travels in the page URL's
// fragment, which browsers never send to the server.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { ShellRecorder } = require('./shellRecorder');

const HOST = '127.0.0.1';
const HOST_PAGE = path.join(__dirname, 'media', 'host.html');
// Warp normally loads fallback fonts (e.g. ⌘⇧⌥ from Noto Sans Symbols 2) from app.warp.dev, which
// CORS blocks for us; our Warp build requests them from this server instead.
const FALLBACK_FONTS_PREFIX = '/assets/client/static/fallback-fonts/';
const FALLBACK_FONTS_DIR = path.join(__dirname, 'media', 'fallback-fonts');

// A shell whose page disconnected (sleep, network change) waits this long for it to reattach,
// buffering up to DETACHED_BUFFER_BYTES of output meanwhile.
const DETACHED_TIMEOUT_MS = 10 * 60 * 1000;
const DETACHED_BUFFER_BYTES = 2 * 1024 * 1024;

/** `dir` if it's an absolute path to an existing directory. */
function existingDirectory(dir) {
  if (!dir || !path.isAbsolute(dir)) return null;
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

const isOpen = (ws) => ws?.readyState === 1; // WebSocket.OPEN

/** A full-screen program redraws on a size change; an adopted one is nudged to (see adopt). */
const REDRAW_NUDGE_MS = 500;

const PASSWORD_POLL_MS = 1000;

/**
 * Tells the page when the running command shows a password prompt, for Warp's "needs input"
 * notification. Like desktop Warp's termios poller: echo off with line editing on is a password
 * prompt (full-screen apps turn both off, shells turn line editing off at their prompt). Only
 * checks while a command, not the shell, is in the foreground, and reports each command once.
 */
function watchPasswordPrompts(session, shellName) {
  const sttyFlag = process.platform === 'darwin' ? '-f' : '-F';
  let reported = null;
  let checking = false;
  const timer = setInterval(() => {
    let foreground;
    try {
      foreground = session.term.process;
    } catch {
      return;
    }
    if (!foreground || foreground === shellName) {
      reported = null;
      return;
    }
    if (foreground === reported || checking || !isOpen(session.ws)) return;
    checking = true;
    execFile('stty', ['-a', sttyFlag, session.term.ptsName], { timeout: 1000 }, (error, stdout) => {
      checking = false;
      if (error) return;
      const flags = stdout.split(/\s+/);
      if (flags.includes('-echo') && flags.includes('icanon') && isOpen(session.ws)) {
        reported = foreground;
        session.ws.send(JSON.stringify('password_prompt'));
      }
    });
  }, PASSWORD_POLL_MS);
  timer.unref();
  return timer;
}

/** The static server's ETag for a file: changes whenever the file is rebuilt. */
const etagFor = (stat) => `"${stat.size}-${Math.round(stat.mtimeMs)}"`;

/** The wasm's current ETag, so the page can use its cached copy without asking first. */
function wasmEtag(bundleDir) {
  try {
    return etagFor(fs.statSync(servedFile(path.join(bundleDir, 'wasm', 'warp_bg.wasm')).file));
  } catch {
    return null;
  }
}

// The packaged extension ships large files brotli-compressed as `<file>.br` (scripts/package.sh)
// and lists each one's decoded size here, so the page can still show download progress.
const PRECOMPRESSED_LIST = path.join(__dirname, 'precompressed.json');
let precompressedSizes;
const decodedSize = (brFile) => {
  if (!precompressedSizes) {
    try {
      precompressedSizes = JSON.parse(fs.readFileSync(PRECOMPRESSED_LIST, 'utf8'));
    } catch {
      precompressedSizes = {};
    }
  }
  return precompressedSizes[path.relative(__dirname, brFile.slice(0, -3)).split(path.sep).join('/')];
};

/** The file to serve for `file`: itself, or its precompressed `.br` copy in the packaged extension. */
function servedFile(file) {
  if (fs.existsSync(file)) return { file, brotli: false };
  const br = `${file}.br`;
  return fs.existsSync(br) ? { file: br, brotli: true } : { file, brotli: false };
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

// node-pty's prebuilt spawn-helper ships without the executable bit on some installs.
function ensureSpawnHelperExecutable() {
  const helper = path.join(
    path.dirname(require.resolve('node-pty/package.json')),
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // Not present for this platform; node-pty will report a real error if it's needed.
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server.address().port));
  });
}

// Bash keeps the user's history at full length until Warp's bootstrap has sourced their rc files,
// which then may set their own sizes (desktop Warp's sentinel, see `local_tty/unix.rs`).
const BASH_HISTORY_SIZE_SENTINEL = '57265949261';

/**
 * How to start `shell` for Warp, like desktop Warp does (`local_tty/shell.rs`): Warp's bootstrap
 * sources the zsh and bash startup files itself, so those start without them (otherwise they'd
 * run twice); fish reads its config itself. Warp types its init line prefixed with a space; the
 * flags keep such lines out of the history file. Unsupported shells fall back to zsh or bash.
 * @param {string} shell
 * @returns {{kind: 'zsh' | 'bash' | 'fish', file: string, args: string[], env: object}}
 */
function shellLaunch(shell) {
  const name = path.basename(shell).replace(/^-/, '');
  if (name === 'zsh') return { kind: 'zsh', file: shell, args: ['-l', '-g', '--no-rcs'], env: {} };
  if (name === 'bash') {
    return {
      kind: 'bash',
      file: shell,
      args: ['--noprofile', '--norc'],
      env: {
        HISTFILESIZE: BASH_HISTORY_SIZE_SENTINEL,
        HISTSIZE: BASH_HISTORY_SIZE_SENTINEL,
        WARP_INITIAL_HISTFILESIZE: BASH_HISTORY_SIZE_SENTINEL,
        WARP_INITIAL_HISTSIZE: BASH_HISTORY_SIZE_SENTINEL,
      },
    };
  }
  // no-mark-prompt: fish's OSC 133 marks confuse Warp (desktop passes it too).
  if (name === 'fish') return { kind: 'fish', file: shell, args: ['--login', '-f', 'no-mark-prompt'], env: {} };
  return fs.existsSync('/bin/zsh') ? shellLaunch('/bin/zsh') : shellLaunch('/bin/bash');
}

/**
 * Starts the PTY WebSocket server and the static bundle server.
 * @param {{bundleDir: string, token?: string, ptyPort?: number, staticPort?: number,
 *          cwd?: string, shell?: string, log?: (msg: string) => void}} options
 */
async function startServer({
  bundleDir,
  token,
  ptyPort = 0,
  staticPort = 0,
  cwd = process.env.HOME,
  shell = process.env.SHELL || '/bin/zsh',
  log = console.log,
}) {
  ensureSpawnHelperExecutable();
  const defaultLaunch = shellLaunch(shell);
  if (defaultLaunch.file !== shell) log(`${shell} isn't supported (zsh, bash or fish); using ${defaultLaunch.file}`);
  /** @type {Map<string, any>} id -> {id, pane, term, ws, recorder, pending, pendingBytes, expiry, debug} */
  const sessions = new Map();
  let devOrigins = new Set();
  /** When a page last asked for something (for the daemon's idle exit). */
  let lastActivity = Date.now();

  const isAuthorized = (req) => {
    if (!token) return devOrigins.has(req.headers.origin);
    const given = Buffer.from(new URL(req.url, 'http://localhost').searchParams.get('token') || '');
    const expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const ptyHttp = http.createServer();
  const wss = new WebSocketServer({
    server: ptyHttp,
    path: '/create',
    verifyClient: ({ req }, done) => {
      if (isAuthorized(req)) return done(true);
      log(`rejected PTY connection (origin: ${req.headers.origin || 'none'})`);
      done(false, 401, 'Unauthorized');
    },
  });

  wss.on('connection', (ws, req) => {
    lastActivity = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const resumeId = url.searchParams.get('session');
    if (resumeId) {
      const session = sessions.get(resumeId);
      if (!session) {
        log(`no session ${resumeId} to reattach to`);
        ws.close(4404, 'unknown session');
        return;
      }
      attach(session, ws);
      log(`session ${session.term.pid} reattached`);
      return;
    }

    const pane = /^[0-9a-f]{1,64}$/.test(url.searchParams.get('pane') || '') ? url.searchParams.get('pane') : null;
    if (pane) {
      // Another page (window) may show the same restored pane; only a detached shell is taken.
      const previous = [...sessions.values()].find((s) => s.pane === pane && !s.ws);
      if (previous && adopt(previous, ws)) return;
      if (previous) {
        log(`session ${previous.term.pid} can't be taken over; ending it`);
        previous.term.kill();
      }
    }

    const launch = url.searchParams.get('shell_path') ? shellLaunch(url.searchParams.get('shell_path')) : defaultLaunch;
    const rows = Number(url.searchParams.get('num_rows')) || 24;
    // A restored tab asks for the directory it was in; the page's default if that's gone.
    const sessionCwd =
      existingDirectory(url.searchParams.get('cwd')) || existingDirectory(url.searchParams.get('default_cwd')) || cwd;
    const cols = Number(url.searchParams.get('num_cols')) || 80;

    const term = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: sessionCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        HISTCONTROL: 'ignorespace',
        ...launch.env,
      },
      encoding: null,
    });
    const session = {
      id: crypto.randomBytes(16).toString('hex'),
      pane,
      term,
      ws: null,
      recorder: new ShellRecorder(),
      pending: [],
      pendingBytes: 0,
      expiry: null,
    };
    sessions.set(session.id, session);
    log(`session ${term.pid}: ${launch.file} ${cols}x${rows} in ${sessionCwd}`);

    const debug = process.env.WARP_PANEL_DEBUG
      ? (dir, buf) => log(`${dir} ${buf.length}B ${JSON.stringify(buf.toString('utf8').slice(0, 160))}`)
      : () => {};

    term.onData((data) => {
      debug('pty->warp', data);
      session.recorder.record(data, isOpen(session.ws));
      if (isOpen(session.ws)) {
        session.ws.send(data, { binary: true });
        return;
      }
      // Detached: keep the output for when the page reattaches, dropping the oldest past the cap.
      session.pending.push(data);
      session.pendingBytes += data.length;
      while (session.pendingBytes > DETACHED_BUFFER_BYTES && session.pending.length > 1) {
        session.pendingBytes -= session.pending.shift().length;
      }
    });
    const passwordWatch = watchPasswordPrompts(session, path.basename(launch.file));
    term.onExit(({ exitCode }) => {
      sessions.delete(session.id);
      clearTimeout(session.expiry);
      clearInterval(passwordWatch);
      log(`session ${term.pid} exited (${exitCode})`);
      if (isOpen(session.ws)) {
        session.ws.send(JSON.stringify({ exited: exitCode }));
        session.ws.close(1000, 'shell exited');
      }
    });

    session.debug = debug;
    attach(session, ws);
    ws.send(JSON.stringify({ session: session.id }));
  });

  // Hands a reloaded page its pane's running shell (see "Adoption" at the top). Returns false if
  // the shell can't be taken over (it hadn't finished bootstrapping, or printed too much then).
  function adopt(session, ws) {
    const replay = session.recorder.replay();
    if (!replay) return false;
    ws.send(
      JSON.stringify({
        adopt: { session: session.id, session_ids: session.recorder.sessionIds, running: session.recorder.running },
      }),
    );
    for (const chunk of replay) ws.send(chunk, { binary: true });
    ws.send(JSON.stringify('adopted'));
    // The replay already has what was buffered while detached.
    session.pending = [];
    session.pendingBytes = 0;
    attach(session, ws);
    log(`session ${session.term.pid} taken over by a new page (${replay.reduce((n, c) => n + c.length, 0)} B replayed)`);
    if (session.recorder.running) {
      // The replay ends with a full-screen program's screen half drawn; a size change makes it
      // redraw (the page's own resize may not change the size).
      setTimeout(() => {
        try {
          const { cols, rows } = session.term;
          session.term.resize(cols + 1, rows);
          setTimeout(() => session.term.resize(cols, rows), 50);
        } catch {
          // The shell exited meanwhile.
        }
      }, REDRAW_NUDGE_MS);
    }
    return true;
  }

  // Connects a page to a shell. When the connection drops without the shell exiting (the
  // browser closes sockets on sleep or network changes), the shell keeps running so the page
  // can reattach; it's ended if nobody does within DETACHED_TIMEOUT_MS.
  function attach(session, ws) {
    if (session.ws && session.ws !== ws) session.ws.close(4000, 'replaced');
    session.ws = ws;
    clearTimeout(session.expiry);
    for (const chunk of session.pending) ws.send(chunk, { binary: true });
    session.pending = [];
    session.pendingBytes = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        session.debug('warp->pty', Buffer.from(data));
        session.term.write(Buffer.from(data));
        return;
      }
      try {
        const { width, height } = JSON.parse(data.toString());
        if (width > 0 && height > 0) session.term.resize(width, height);
      } catch (e) {
        log(`bad control message: ${e.message}`);
      }
    });
    ws.on('close', (code) => {
      if (session.ws !== ws || !sessions.has(session.id)) return;
      session.ws = null;
      log(`session ${session.term.pid} disconnected (${code}); waiting for the page to reattach`);
      session.expiry = setTimeout(() => {
        log(`session ${session.term.pid} not reattached; closing it`);
        session.term.kill();
      }, DETACHED_TIMEOUT_MS);
    });
  }

  const staticHttp = http.createServer((req, res) => {
    lastActivity = Date.now();
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file;
    if (pathname === '/') {
      file = HOST_PAGE;
    } else if (pathname.startsWith(FALLBACK_FONTS_PREFIX)) {
      file = path.join(FALLBACK_FONTS_DIR, pathname.slice(FALLBACK_FONTS_PREFIX.length));
      if (!file.startsWith(FALLBACK_FONTS_DIR + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      // Most fallback families ship only a regular weight; Warp's bold requests get it too
      // (the same file, without a duplicate in the package).
      if (file.endsWith('-Bold.ttf') && !fs.existsSync(servedFile(file).file)) {
        file = file.replace(/-Bold\.ttf$/, '-Regular.ttf');
      }
    } else {
      const rel = pathname
        .replace(/^\/assets\/client\/wasm\//, '/wasm/')
        .replace(/^\/assets\/client\/static\//, '/assets/');
      file = path.join(bundleDir, rel);
      if (!file.startsWith(bundleDir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
    }
    const served = servedFile(file);
    fs.stat(served.file, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        res.writeHead(404).end();
        return;
      }
      // Revalidate every load, but let the browser reuse its cached copy (304) while the file is
      // unchanged, so the ~100 MB wasm isn't downloaded again on every panel start.
      const etag = etagFor(stat);
      const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      const stream = fs.createReadStream(served.file);
      if (!served.brotli) {
        res.writeHead(200, { ...headers, 'Content-Length': stat.size });
        stream.pipe(res);
        return;
      }
      const size = decodedSize(served.file);
      if (size) headers['X-Decoded-Length'] = size;
      if (/\bbr\b/.test(req.headers['accept-encoding'] || '')) {
        res.writeHead(200, { ...headers, 'Content-Encoding': 'br', 'Content-Length': stat.size });
        stream.pipe(res);
      } else {
        res.writeHead(200, size ? { ...headers, 'Content-Length': size } : headers);
        stream.pipe(zlib.createBrotliDecompress()).pipe(res);
      }
    });
  });

  const actualPtyPort = await listen(ptyHttp, ptyPort);
  // A preferred port that's taken falls back to a random one.
  const actualStaticPort = await listen(staticHttp, staticPort).catch(() => listen(staticHttp, 0));
  devOrigins = new Set([`http://${HOST}:${actualStaticPort}`, `http://localhost:${actualStaticPort}`]);

  // Warp reads `shell` to pick its bootstrap (see shellLaunch for the server's side).
  const ptyBaseUrl = `ws://${HOST}:${actualPtyPort}/create${token ? `?token=${token}` : ''}`;
  const ptyUrl = `${ptyBaseUrl}${token ? '&' : '?'}shell=${defaultLaunch.kind}`;
  return {
    pageUrl: `http://${HOST}:${actualStaticPort}/`,
    staticOrigin: `http://${HOST}:${actualStaticPort}`,
    ptyUrl,
    /** Without `shell`, for a page that picks its own shell (`shell`, `shell_path`). */
    ptyBaseUrl,
    wasmEtag: () => wasmEtag(bundleDir),
    /** Running shells, how many pages show one, and when a page last made a request. */
    stats() {
      const all = [...sessions.values()];
      return { sessions: all.length, attached: all.filter((s) => isOpen(s.ws)).length, lastActivity };
    },
    /** Drops every page connection without ending the shells, like a network change does (tests). */
    dropConnections() {
      for (const { ws } of sessions.values()) ws?.terminate();
    },
    close() {
      for (const { term, expiry } of sessions.values()) {
        clearTimeout(expiry);
        term.kill();
      }
      wss.close();
      ptyHttp.close();
      staticHttp.close();
    },
  };
}

module.exports = { shellLaunch, startServer, wasmEtag };

if (require.main === module) {
  const bundleDir = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !fs.existsSync(path.join(bundleDir, 'wasm', 'warp.js'))) {
    console.error('usage: node server.js <path to warp wasm bundle dir>');
    process.exit(1);
  }
  startServer({
    bundleDir,
    token: process.env.WARP_PANEL_TOKEN,
    ptyPort: Number(process.env.PTY_PORT || 3030),
    staticPort: Number(process.env.STATIC_PORT || 8080),
  }).then(({ pageUrl, ptyUrl }) => {
    console.log(`PTY backend: ${ptyUrl}`);
    console.log(`open ${pageUrl}#pty_url=${ptyUrl}`);
  });
}
