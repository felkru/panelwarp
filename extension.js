// Hosts Warp-on-web in a VS Code panel tab. server.js runs in the PTY host, a background process
// shared by all windows that keeps the shells running across window reloads (ptyHost.js,
// daemon.js; random localhost ports, a random token), and the webview embeds the served page in
// an iframe. Keys in Warp's `host.keys_to_host` setting (plus defaults) are routed back to VS
// Code by media/host.html.

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellLaunch, wasmEtag } = require('./server');
const { ensurePtyHost } = require('./ptyHost');
const { SettingsFile } = require('./settingsFile');
const { WarpAi } = require('./ai');
const { PanelSettings, confirm } = require('./panelSettings');
const { CommandHistory } = require('./history');
const { SessionStore } = require('./sessionStore');
const filePaths = require('./filePaths');
const { readWorkflowFiles } = require('./workflows');
const { AgentConversations, openPendingClaudeConversation } = require('./agents');
const { MemoryMonitor } = require('./memoryMonitor');

// Warp's default macOS shortcuts, sent as synthetic keystrokes by the "Warp: ..." commands.
const WARP_KEYS = {
  'warp.commandPalette': { key: 'p', code: 'KeyP', cmd: true },
  'warp.newTab': { key: 't', code: 'KeyT', cmd: true },
  'warp.closeTab': { key: 'w', code: 'KeyW', cmd: true },
  'warp.reopenClosedTab': { key: 'T', code: 'KeyT', cmd: true, shift: true },
  'warp.nextTab': { key: '}', code: 'BracketRight', cmd: true, shift: true },
  'warp.previousTab': { key: '{', code: 'BracketLeft', cmd: true, shift: true },
  'warp.splitRight': { key: 'd', code: 'KeyD', cmd: true },
  'warp.splitDown': { key: 'D', code: 'KeyD', cmd: true, shift: true },
  'warp.clearBlocks': { key: 'k', code: 'KeyK', cmd: true },
};

function resolveBundleDir() {
  // Development override; release builds ship the bundle with the extension.
  const configured = process.env.WARP_PANEL_BUNDLE;
  if (configured) {
    const dir = configured.replace(/^~(?=$|\/)/, os.homedir());
    return fs.existsSync(path.join(dir, 'wasm', 'warp.js')) ? dir : undefined;
  }
  // A packaged extension (scripts/package.sh) ships the bundle next to this file.
  const packaged = path.join(__dirname, 'bundle');
  if (fs.existsSync(path.join(packaged, 'wasm', 'warp.js'))) return packaged;
  // scripts/build-warp.sh builds one of these profiles; load the most recently built bundle.
  let newest;
  for (const profile of ['wasm-fast', 'wasm-thin', 'release-wasm', 'dev-wasm']) {
    const dir = path.join(os.homedir(), 'Library/Caches/warp-target/wasm32-unknown-unknown', profile, 'bundle');
    try {
      if (!fs.existsSync(path.join(dir, 'wasm', 'warp.js'))) continue;
      const mtime = fs.statSync(path.join(dir, 'wasm', 'warp_bg.wasm')).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { dir, mtime };
    } catch {
      // A bundle mid-build may be missing its wasm; skip it.
    }
  }
  return newest?.dir;
}

/**
 * The shell to run: the one VS Code's own terminal starts (`terminal.integrated.defaultProfile.*`),
 * else the login shell. Read when the panel starts.
 */
function startupShell() {
  const platform = { darwin: 'osx', win32: 'windows' }[process.platform] || 'linux';
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  const name = config.get(`defaultProfile.${platform}`);
  const profile = name ? config.get(`profiles.${platform}`)?.[name] : null;
  const candidates = [profile?.path].flat().filter((file) => typeof file === 'string');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const file of candidates) {
    const resolved = path.isAbsolute(file) ? [file] : dirs.map((dir) => path.join(dir, file));
    const found = resolved.find((f) => fs.existsSync(f));
    if (found) return found;
  }
  return process.env.SHELL || '/bin/zsh';
}

const STORAGE_KEY = 'warp.localStorage';
// Opt-in (`host.history_sync`): the newest commands, synced across machines by VS Code Settings
// Sync and merged into each machine's history at startup.
const HISTORY_SYNC_KEY = 'warp.historySync';
const STATIC_PORT_KEY = 'warp.staticPort';

/** `url` as the webview can reach it (see vscode.env.asExternalUri; ws URLs map like http). */
async function externalUrl(url) {
  const ws = /^wss?:/.test(url);
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(ws ? url.replace(/^ws/, 'http') : url));
  const mapped = uri.toString(true);
  return ws ? mapped.replace(/^http/, 'ws') : mapped;
}

const IN_SIDE_BAR_KEY = 'warp.inSideBar';
const TERMINAL_KEY_FREED_KEY = 'warp.terminalShortcutFreed';

/**
 * Ctrl+` is Warp's shortcut (package.json). Once per install this takes it away from VS Code's own
 * terminal toggle in the user's keybindings.json (so the two never compete) and lets it through
 * VS Code's integrated terminal (which would otherwise send it to its shell). Done once, so a
 * user who adds the terminal binding back keeps it.
 */
async function freeTerminalShortcut(context, log) {
  if (context.globalState.get(TERMINAL_KEY_FREED_KEY)) return;
  try {
    // globalStorage is <user data>/User/globalStorage/<extension>.
    const file = path.join(context.globalStorageUri.fsPath, '..', '..', 'keybindings.json');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!text.includes('-workbench.action.terminal.toggleTerminal')) {
      const entry = '{ "key": "ctrl+`", "command": "-workbench.action.terminal.toggleTerminal" }';
      fs.writeFileSync(file, addJsoncArrayEntry(text, entry));
      log.appendLine(`removed VS Code's Ctrl+\` terminal toggle in ${file} (Warp uses it)`);
    }
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const skip = terminal.inspect('commandsToSkipShell')?.globalValue || [];
    if (!skip.includes('warp.show')) {
      await terminal.update('commandsToSkipShell', [...skip, 'warp.show'], vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(TERMINAL_KEY_FREED_KEY, true);
  } catch (error) {
    log.appendLine(`could not free Ctrl+\` from VS Code's terminal: ${error.message}`);
  }
}

/** `text` (a JSONC array, possibly empty or missing) with `entry` added as its last element. */
function addJsoncArrayEntry(text, entry) {
  // The top-level array's brackets and its last element's last character (-1: empty), skipping
  // strings and comments.
  let open = -1;
  let close = -1;
  let last = -1;
  let comma = -1;
  let depth = 0;
  for (let i = 0; i < text.length && close === -1; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    if (c === '[' || c === '{') {
      depth++;
      if (open === -1) {
        open = i;
        continue;
      }
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        continue;
      }
    }
    if (c === ',') comma = i;
    else if (open !== -1 && !/\s/.test(c)) last = i;
  }
  if (open === -1 || close === -1) return `[\n  ${entry}\n]\n`;
  const separator = comma > last ? '' : ',';
  const head = last === -1 ? text.slice(0, open + 1) : `${text.slice(0, last + 1)}${separator}${text.slice(last + 1, close).replace(/\s*$/, '')}`;
  return `${head}\n  ${entry}\n${text.slice(close)}`;
}

/** Moves the Warp view between the bottom panel and the activity bar's side bar container. */
async function moveWarpView(context, toSideBar) {
  lastMove = Date.now();
  await context.globalState.update(IN_SIDE_BAR_KEY, toSideBar);
  await vscode.commands.executeCommand('setContext', IN_SIDE_BAR_KEY, toSideBar);
  await vscode.commands.executeCommand('vscode.moveViews', {
    viewIds: ['warp.view'],
    destinationId: `workbench.view.extension.${toSideBar ? 'warp-launcher' : 'warp'}`,
  });
  await vscode.commands.executeCommand('warp.view.focus');
}
let lastMove = 0;

/**
 * A placeholder that keeps a Warp button where Warp currently isn't (activity bar or bottom
 * panel); showing it moves Warp there. Right after a move the other place's placeholder can show
 * up on its own (its container was open), which closes that side bar or panel instead.
 */
function warpLauncher(context, toSideBar) {
  return {
    resolveWebviewView(view) {
      view.webview.html = '<body></body>';
      const moveHere = () => {
        if (!view.visible) return;
        if (Date.now() - lastMove < 1500) {
          vscode.commands.executeCommand(toSideBar ? 'workbench.action.closeSidebar' : 'workbench.action.closePanel');
        } else {
          moveWarpView(context, toSideBar);
        }
      };
      view.onDidChangeVisibility(moveHere);
      moveHere();
    },
  };
}

class WarpViewProvider {
  constructor(globalState, storageDir, log) {
    this.globalState = globalState;
    this.storageDir = storageDir;
    this.settingsFile = null;
    this.ready = Promise.resolve();
    this.panelSettings = new PanelSettings(globalState, STORAGE_KEY, () => this.settingsFile.state);
    this.history = null;
    this.ai = null;
    this.log = log;
    this.server = null;
    this.view = null;
  }

  async ensureServer() {
    if (this.server) return this.server;
    const bundleDir = resolveBundleDir();
    if (!bundleDir) throw new Error('No Warp web bundle found (set WARP_PANEL_BUNDLE for a custom path).');
    // Reusing the page's port keeps its origin stable, so the browser cache (the ~100 MB wasm)
    // survives VS Code restarts.
    const host = await ensurePtyHost({
      storageDir: this.storageDir,
      bundleDir,
      staticPort: this.globalState.get(STATIC_PORT_KEY, 0),
      log: (msg) => this.log.appendLine(`${new Date().toLocaleTimeString()} ${msg}`),
    });
    // The PTY host serves every window; this window's shell and folder go in its PTY URL.
    const launch = shellLaunch(startupShell());
    const params = new URLSearchParams({
      shell: launch.kind,
      shell_path: launch.file,
      default_cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
    });
    // In a remote window (SSH, WSL, containers) the PTY host runs on the remote machine and VS
    // Code forwards its ports to the webview; locally the URLs stay as they are.
    const pageUrl = await externalUrl(host.pageUrl);
    this.server = {
      pageUrl,
      staticOrigin: new URL(pageUrl).origin,
      ptyUrl: `${await externalUrl(host.ptyBaseUrl)}&${params}`,
      wasmEtag: () => wasmEtag(bundleDir),
    };
    this.log.appendLine(`PTY host ${host.pid} serves ${bundleDir} at ${host.pageUrl}`);
    await this.globalState.update(STATIC_PORT_KEY, Number(new URL(host.pageUrl).port));
    return this.server;
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post({ type: 'warp-focus' });
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    });
    await this.render();
  }

  async render() {
    if (!this.view) return;
    this.warpLoaded = false;
    try {
      // The page reads the settings at startup, so they must be ready first; the server starts
      // meanwhile.
      const [server] = await Promise.all([this.ensureServer(), this.ready]);
      const keys = Object.keys(this.panelSettings.keysToVSCode());
      this.view.webview.html = webviewHtml(server, keys);
    } catch (e) {
      this.log.appendLine(`failed to start: ${e.message}`);
      this.view.webview.html = `<body style="font-family:sans-serif;padding:1em">Warp Terminal for VS Code: ${escapeHtml(e.message)}</body>`;
    }
  }

  async onMessage(msg) {
    switch (msg?.type) {
      case 'warp-loaded':
        this.warpLoaded = true;
        this.liveSettings = msg.liveSettings === true;
        this.settingsFile.confirmRouting();
        if (msg.timing) this.log.appendLine(`page loaded (ms since page start): ${JSON.stringify(msg.timing)}`);
        if (this.pendingUrl) {
          this.post({ type: 'warp-navigate', url: this.pendingUrl });
          this.pendingUrl = null;
        }
        break;
      // Warp's settings live in the page's localStorage; the durable copy is kept here
      // (settings.toml and the globalState mirror) so it survives the page's origin (random port)
      // changing between sessions.
      case 'warp-storage-request':
        this.post({
          type: 'warp-storage-snapshot',
          entries: await this.settingsFile.load(),
          history: this.history ? JSON.stringify(this.history.load()) : null,
          session: this.loadSession(),
          workflows: JSON.stringify(
            readWorkflowFiles((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)),
          ),
        });
        break;
      case 'warp-storage-changes':
        await this.settingsFile.save(msg.changes || {});
        this.onSettingsChanged(msg.changes || {});
        break;
      case 'warp-ai-generate-commands':
        try {
          const json = await this.ai.generateCommands(
            String(msg.prompt),
            msg.context ?? null,
            msg.stage === 'expanded' ? 'expanded' : 'fast',
          );
          this.post({ type: 'warp-ai-result', id: msg.id, json });
        } catch (error) {
          this.post({ type: 'warp-ai-result', id: msg.id, error: error.code || 'other' });
        }
        break;
      case 'warp-ai-next-command':
        try {
          const command = await this.ai.nextCommand(String(msg.request));
          this.post({ type: 'warp-ai-result', id: msg.id, json: command });
        } catch (error) {
          this.post({ type: 'warp-ai-result', id: msg.id, error: error.code || 'other' });
        }
        break;
      case 'warp-ai-prompt-suggestion':
        try {
          const prompt = await this.ai.promptSuggestion(String(msg.request));
          this.post({ type: 'warp-ai-result', id: msg.id, json: prompt });
        } catch (error) {
          this.post({ type: 'warp-ai-result', id: msg.id, error: error.code || 'other' });
        }
        break;
      case 'warp-agents-seen':
        this.agents.markSeen(String(msg.agent), String(msg.sessionId));
        break;
      case 'warp-agents-list':
      case 'warp-agents-summary':
      case 'warp-agents-trash':
      case 'warp-agents-open': {
        const reply = (fields) => this.post({ type: 'warp-agents-result', id: msg.id, ...fields });
        try {
          const agent = String(msg.agent);
          const sessionId = String(msg.sessionId);
          if (msg.type === 'warp-agents-list') {
            reply({ value: this.agents.list() });
          } else if (msg.type === 'warp-agents-summary') {
            await this.agents.summarize(agent, sessionId, (text) =>
              this.post({ type: 'warp-agents-text', id: msg.id, text }),
            );
            reply({});
          } else if (msg.type === 'warp-agents-trash') {
            await this.agents.trash(agent, sessionId);
            reply({});
          } else {
            reply({ value: await this.agents.open(agent, sessionId, String(msg.mode || 'default')) });
          }
        } catch (error) {
          if (error.message !== 'cancelled') this.log.appendLine(`agents: ${msg.type}: ${error.message}`);
          reply({ error: error.message || 'failed' });
        }
        break;
      }
      case 'warp-confirm': {
        const confirmed = await confirm(String(msg.message), String(msg.detail), String(msg.confirmLabel));
        this.post({ type: 'warp-confirm-result', id: msg.id, confirmed });
        break;
      }
      case 'warp-store-api-key':
        await this.ai.storeApiKey(String(msg.provider), String(msg.key));
        break;
      case 'warp-open-settings':
        await this.settingsFile.open();
        break;
      case 'warp-resolve-paths': {
        let value = [];
        try {
          value = await filePaths.resolvePaths(String(msg.cwd), JSON.parse(String(msg.candidates)));
        } catch (error) {
          this.log.appendLine(`resolve paths: ${error.message}`);
        }
        this.post({ type: 'warp-resolve-paths-result', id: msg.id, json: JSON.stringify(value) });
        break;
      }
      case 'warp-open-file':
        await filePaths.openFile(vscode, msg.path, msg.line, msg.column);
        break;
      case 'warp-reveal-file':
        await filePaths.revealFile(vscode, msg.path);
        break;
      case 'warp-save-session':
        try {
          this.sessions?.saveSession(msg.json);
        } catch (error) {
          this.log.appendLine(`save tabs: ${error.message}`);
        }
        break;
      case 'warp-save-block':
        try {
          this.sessions?.saveBlock(msg.paneUuid, msg.json);
        } catch (error) {
          this.log.appendLine(`save block: ${error.message}`);
        }
        break;
      case 'warp-notify':
        this.agents.noteWarpNotice();
        this.notify(String(msg.title).slice(0, 200), String(msg.body).slice(0, 500));
        break;
      case 'warp-request-focus':
        await vscode.commands.executeCommand('warp.view.focus');
        this.post({ type: 'warp-focus' });
        break;
      case 'warp-record-command':
        try {
          this.history?.record(msg.kind, JSON.parse(msg.json));
          if (msg.kind === 'finished') this.scheduleHistorySync();
        } catch (error) {
          this.log.appendLine(`failed to record command: ${error.message}`);
        }
        break;
      case 'warp-clipboard-read':
        this.post({ type: 'warp-paste', text: await vscode.env.clipboard.readText() });
        break;
      case 'warp-routed-key': {
        const command = this.panelSettings.keysToVSCode()[msg.spec];
        if (command) vscode.commands.executeCommand(command);
        break;
      }
      case 'warp-open-url': {
        const uri = vscode.Uri.parse(String(msg.url));
        // Only web links: the page must not be able to launch arbitrary URL-scheme handlers.
        if (uri.scheme !== 'https' && uri.scheme !== 'http') {
          this.log.appendLine(`blocked opening non-web URL: ${uri.scheme}:`);
          break;
        }
        vscode.env.openExternal(uri);
        break;
      }
      case 'warp-clipboard-write':
        vscode.env.clipboard.writeText(String(msg.text));
        break;
    }
  }

  post(msg) {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Hands the running Warp entries changed in the settings files. Returns false if this Warp build
   * can't apply them without a reload.
   */
  applyStorageChanges(changes) {
    this.onSettingsChanged(changes);
    if (!this.view || !this.warpLoaded || !this.liveSettings) return false;
    if (Object.keys(changes).length) this.post({ type: 'warp-storage-update', changes });
    return true;
  }

  /** Acts on the panel's own settings that changed, in Warp or in the files. */
  onSettingsChanged(changes) {
    if ('HostHistorySync' in changes) this.syncHistory();
    // The page only reads ?keys= when it loads
    if ('HostKeysToHost' in changes) {
      this.post({ type: 'warp-routed-keys', keys: Object.keys(this.panelSettings.keysToVSCode()) });
    }
  }

  /** The tabs to restore (sessionStore.js), as JSON; null if none or unreadable. */
  loadSession() {
    try {
      return this.sessions?.load() ?? null;
    } catch (error) {
      this.log.appendLine(`load tabs: ${error.message}`);
      return null;
    }
  }

  /** A Warp notification (a long-running command finished, a command waits for a password). */
  async notify(title, body) {
    // Warp labels the output it includes ("Latest output: …"); a label with nothing after it adds nothing.
    const text = body && !/^[^:]*:\s*$/.test(body) ? `${title}: ${body}` : title;
    const choice = await vscode.window.showInformationMessage(text, 'Show Warp');
    if (choice === 'Show Warp') await vscode.commands.executeCommand('warp.view.focus');
  }

  /** Opens a warp:// URL inside the panel's Warp (e.g. a settings page). */
  async openWarpUrl(url) {
    if (!this.view?.visible) await vscode.commands.executeCommand('warp.view.focus');
    // Warp may still be loading (panel just opened); navigate once it reports it's running.
    if (this.warpLoaded) this.post({ type: 'warp-navigate', url });
    else this.pendingUrl = url;
  }

  async sendWarpKey(keystroke) {
    // Focus the view even when it's visible: otherwise VS Code keeps keyboard focus where it was
    // and the first key typed after the command (e.g. into Warp's palette) goes there.
    await vscode.commands.executeCommand('warp.view.focus');
    this.post({ type: 'warp-send-key', ...keystroke });
  }

  /**
   * With history sync on, merges the synced commands from other machines into the local table and
   * publishes the newest local ones (which then include theirs). Off, it removes this machine's
   * synced copy, so turning it off stops sharing commands.
   */
  async syncHistory() {
    if (!this.history) return;
    try {
      if (this.panelSettings.get('HostHistorySync') !== true) {
        if (this.globalState.get(HISTORY_SYNC_KEY) !== undefined) {
          await this.globalState.update(HISTORY_SYNC_KEY, undefined);
        }
        return;
      }
      const merged = this.history.mergeSynced(this.globalState.get(HISTORY_SYNC_KEY, {}).commands);
      if (merged) this.log.appendLine(`merged ${merged} commands from history sync`);
      await this.globalState.update(HISTORY_SYNC_KEY, { version: 1, commands: this.history.exportForSync() });
    } catch (error) {
      this.log.appendLine(`history sync failed: ${error.message}`);
    }
  }

  /** Publishes new commands for history sync at most every 30 s. */
  scheduleHistorySync() {
    if (this.historySyncTimer || this.panelSettings.get('HostHistorySync') !== true) return;
    this.historySyncTimer = setTimeout(() => {
      this.historySyncTimer = null;
      this.syncHistory();
    }, 30_000);
  }

  async restart() {
    // Finds the PTY host again (or starts it); the page takes its shells back over.
    this.server = null;
    await this.render();
  }

  dispose() {
    // Commands not yet published are published at the next startup.
    clearTimeout(this.historySyncTimer);
    this.history?.close();
    this.sessions?.close();
    // The PTY host and its shells stay for the reloaded window (or exit on their own when idle).
  }
}

function webviewHtml(server, keys) {
  const nonce = crypto.randomBytes(16).toString('base64');
  // The token rides in the fragment, which is never sent to the static server.
  const query = new URLSearchParams({ keys: JSON.stringify(keys), wasm: server.wasmEtag() ?? '' });
  const src = `${server.pageUrl}?${query}#pty_url=${server.ptyUrl}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${server.staticOrigin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #000; }
    iframe { border: 0; width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <iframe id="warp" src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('warp');
    const warpOrigin = ${JSON.stringify(server.staticOrigin)};
    const FROM_WARP = new Set([
      'warp-storage-request',
      'warp-storage-changes',
      'warp-request-focus',
      'warp-loaded',
      'warp-record-command',
      'warp-open-settings',
      'warp-resolve-paths',
      'warp-open-file',
      'warp-reveal-file',
      'warp-notify',
      'warp-save-session',
      'warp-save-block',
      'warp-store-api-key',
      'warp-confirm',
      'warp-ai-generate-commands',
      'warp-ai-next-command',
      'warp-ai-prompt-suggestion',
      'warp-agents-list',
      'warp-agents-seen',
      'warp-agents-summary',
      'warp-agents-open',
      'warp-agents-trash',
      'warp-routed-key',
      'warp-open-url',
      'warp-clipboard-write',
      'warp-clipboard-read',
    ]);
    window.addEventListener('message', (e) => {
      if (e.source === frame.contentWindow) {
        if (e.origin === warpOrigin && FROM_WARP.has(e.data?.type)) vscode.postMessage(e.data);
        return;
      }
      // Anything else comes from the extension.
      if (e.data?.type === 'warp-focus') frame.focus();
      frame.contentWindow.postMessage(e.data, warpOrigin);
    });
    window.addEventListener('focus', () => {
      frame.focus();
      frame.contentWindow.postMessage({ type: 'warp-focus' }, warpOrigin);
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function activate(context) {
  const log = vscode.window.createOutputChannel('Warp Terminal for VS Code');
  // Only opt-in history sync goes through VS Code Settings Sync. Settings stay per machine in
  // settings.toml like desktop Warp's, so the mirror isn't synced either.
  context.globalState.setKeysForSync([HISTORY_SYNC_KEY]);
  const provider = new WarpViewProvider(context.globalState, context.globalStorageUri.fsPath, log);
  provider.ai = new WarpAi(
    context.secrets,
    log,
    () => provider.panelSettings.ai(),
    (limit) => provider.history?.recent(limit) ?? [],
    (command, pwd, exitCode) => provider.history?.nextCommandContext(command, pwd, exitCode) ?? null,
  );
  provider.agents = new AgentConversations(context.globalState, log, provider.ai, () =>
    provider.panelSettings.ai(),
  );
  freeTerminalShortcut(context, log);
  context.subscriptions.push(provider.agents.watchFinished());
  openPendingClaudeConversation(context.globalState, log);
  context.subscriptions.push(
    // A click on a finished-agent notification: vscode://felixkrueckel.panelwarp/open?agent=claude&id=…
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const params = new URLSearchParams(uri.query);
        if (uri.path !== '/open' || params.get('agent') !== 'claude' || !params.get('id')) return;
        provider.agents.open('claude', params.get('id'), 'editor').catch((error) => {
          log.appendLine(`agents: could not open ${params.get('id')}: ${error.message}`);
          vscode.window.showErrorMessage(`Could not open the conversation: ${error.message}`);
        });
      },
    }),
    // The conversation's folder may already be open in this window when another one hands it over.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) openPendingClaudeConversation(context.globalState, log);
    }),
  );
  provider.settingsFile = new SettingsFile(context, {
    storageKey: STORAGE_KEY,
    onChanged: (changes) => provider.applyStorageChanges(changes),
    onApplied: () => provider.restart(),
    log,
  });
  // Warp reads its settings once at startup, so the panel waits for this.
  provider.ready = provider.panelSettings
    .migrateFromVSCodeSettings()
    .catch((error) => log.appendLine(`settings migration failed: ${error.message}`))
    .then(() => provider.settingsFile.migrate())
    .catch((error) => log.appendLine(`moving settings into settings.toml failed: ${error.message}`))
    // Before history sync below reads host.history_sync
    .then(() => provider.settingsFile.load());
  try {
    provider.history = new CommandHistory(context.globalStorageUri.fsPath);
    provider.history.shell = startupShell();
    const imported = provider.history.importShellHistory();
    if (imported) log.appendLine(`imported ${imported} commands from shell history`);
    // Before the panel loads the history, so synced commands show up in it.
    provider.ready = provider.ready.then(() => provider.syncHistory());
  } catch (error) {
    log.appendLine(`command history unavailable: ${error.message}`);
  }
  try {
    provider.sessions = new SessionStore(context.globalStorageUri.fsPath);
  } catch (error) {
    log.appendLine(`tab restoration unavailable: ${error.message}`);
  }
  // VS Code remembers where views were moved (per profile); the context key hides the
  // placeholder while Warp is in the side bar.
  vscode.commands.executeCommand('setContext', IN_SIDE_BAR_KEY, context.globalState.get(IN_SIDE_BAR_KEY, false));
  // `ps` isn't on Windows.
  if (process.platform !== 'win32') {
    context.subscriptions.push(new MemoryMonitor(() => provider.panelSettings.memoryWarningGb(), log));
  }
  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider('warp.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // The activity bar's and the bottom panel's Warp buttons both stay; each moves the Warp view
    // itself (same tabs and shells, like Claude Code's side bar) to its place.
    vscode.window.registerWebviewViewProvider('warp.launcher', warpLauncher(context, true)),
    vscode.window.registerWebviewViewProvider('warp.panelLauncher', warpLauncher(context, false)),
    vscode.commands.registerCommand('warp.moveToSideBar', () => moveWarpView(context, true)),
    vscode.commands.registerCommand('warp.moveToPanel', () => moveWarpView(context, false)),
    vscode.commands.registerCommand('warp.splitClaudeTabs', async () => {
      try {
        const { moved, total } = await provider.agents.splitClaudeTabs(context.globalStorageUri.fsPath);
        log.appendLine(`moved ${moved} of ${total} Claude Code tabs to a new window`);
      } catch (error) {
        vscode.window.showWarningMessage(error.message);
      }
    }),
    vscode.commands.registerCommand('warp.saveClaudeWindow', async () => {
      try {
        await provider.agents.saveWindow(context.globalStorageUri.fsPath);
      } catch (error) {
        vscode.window.showWarningMessage(error.message);
      }
    }),
    vscode.commands.registerCommand('warp.reopenClaudeWindow', () => pickSavedWindow(provider.agents, log)),
    ...savedWindowButtons(context, provider.agents),
    vscode.commands.registerCommand('warp.show', () => vscode.commands.executeCommand('warp.view.focus')),
    // Ctrl+` inside Warp (routed by host.html): closes the panel or side bar Warp is in.
    vscode.commands.registerCommand('warp.hide', async () => {
      const inSideBar = context.globalState.get(IN_SIDE_BAR_KEY, false);
      await vscode.commands.executeCommand(inSideBar ? 'workbench.action.closeSidebar' : 'workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }),
    vscode.commands.registerCommand('warp.restart', () => provider.restart()),
    vscode.commands.registerCommand('warp.openSettingsFile', () => provider.settingsFile.open()),
    vscode.commands.registerCommand('warp.openKeybindingsFile', () => provider.settingsFile.openKeybindings()),
    vscode.commands.registerCommand('warp.benchmarkCommandSearch', () => provider.ai.benchmark()),
    vscode.commands.registerCommand('warp.setOpenRouterApiKey', () =>
      provider.openWarpUrl('warposs://settings?widget=host_api_key'),
    ),
    ...Object.entries(WARP_KEYS).map(([command, keystroke]) =>
      vscode.commands.registerCommand(command, () => provider.sendWarpKey(keystroke)),
    ),
  );
}

/**
 * Two status bar buttons for saved windows of Claude Code tabs: "Save window" while this window
 * has Claude Code tabs, and "N saved windows" while the list has entries (it is shared by all
 * windows through globalState, so each window re-reads it when it gets focus). The same two
 * buttons sit in the Warp panel's title bar and in the tab row of an active Claude Code tab.
 */
function savedWindowButtons(context, agents) {
  const save = vscode.window.createStatusBarItem('warp.saveClaudeWindow', vscode.StatusBarAlignment.Right, 90);
  save.name = 'Warp: Save Window';
  save.text = '$(archive) Save window';
  save.tooltip = "Save this window's Claude Code conversations to the saved windows and close it";
  save.command = 'warp.saveClaudeWindow';
  const reopen = vscode.window.createStatusBarItem('warp.reopenClaudeWindow', vscode.StatusBarAlignment.Right, 89);
  reopen.name = 'Warp: Saved Windows';
  reopen.tooltip = 'Reopen a saved window of Claude Code conversations';
  reopen.command = 'warp.reopenClaudeWindow';
  const refresh = () => {
    const claudeTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType));
    const canSave = Boolean(claudeTabs.length && vscode.workspace.workspaceFolders?.length);
    if (canSave) save.show();
    else save.hide();
    const saved = agents.savedWindows();
    // Context keys for the same two buttons in the Warp panel's title bar (package.json view/title).
    vscode.commands.executeCommand('setContext', 'warp.hasClaudeTabs', canSave);
    vscode.commands.executeCommand('setContext', 'warp.hasSavedWindows', saved.length > 0);
    if (saved.length) {
      reopen.text = `$(window) ${saved.length} saved`;
      reopen.show();
    } else {
      reopen.hide();
    }
  };
  refresh();
  agents.onDidChangeSavedWindows = refresh;
  return [
    save,
    reopen,
    vscode.window.tabGroups.onDidChangeTabs(refresh),
    vscode.window.tabGroups.onDidChangeTabGroups(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.window.onDidChangeWindowState((state) => state.focused && refresh()),
  ];
}

/** Quick pick of the saved windows: pick one to reopen it, or its trash button to forget it. */
async function pickSavedWindow(agents, log) {
  const saved = agents.savedWindows();
  if (!saved.length) {
    vscode.window.showInformationMessage('No saved windows. "Warp: Save Window" saves the Claude Code tabs of a window.');
    return;
  }
  const trash = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Forget this saved window' };
  const items = saved.map((w) => ({
    label: `$(window) ${w.folders.map((f) => path.basename(f)).join(', ')}`,
    description: `${w.tabs.length} conversation${w.tabs.length === 1 ? '' : 's'} · saved ${timeAgo(w.savedAt)}`,
    detail: w.tabs.map((t) => t.title).filter(Boolean).join(' · '),
    buttons: [trash],
    saved: w,
  }));
  const pick = vscode.window.createQuickPick();
  pick.title = 'Saved windows';
  pick.placeholder = 'Reopen a window with its Claude Code conversations';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.items = items;
  const chosen = await new Promise((resolve) => {
    pick.onDidTriggerItemButton(async (event) => {
      await agents.forgetWindow(event.item.saved.id);
      pick.items = pick.items.filter((item) => item !== event.item);
      if (!pick.items.length) pick.hide();
    });
    pick.onDidAccept(() => resolve(pick.selectedItems[0]));
    pick.onDidHide(() => resolve(undefined));
    pick.show();
  });
  pick.dispose();
  if (!chosen) return;
  try {
    await agents.reopenWindow(chosen.saved.id);
  } catch (error) {
    log.appendLine(`agents: could not reopen saved window: ${error.message}`);
    vscode.window.showWarningMessage(`Could not reopen the saved window: ${error.message}`);
  }
}

function timeAgo(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function deactivate() {}

module.exports = { activate, deactivate };
