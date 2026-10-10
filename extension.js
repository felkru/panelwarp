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

// Warp's default macOS shortcuts, sent as synthetic keystrokes by the "Warp: ..." commands.
const WARP_KEYS = {
  'warp.commandPalette': { key: 'p', code: 'KeyP', cmd: true },
  'warp.newTab': { key: 't', code: 'KeyT', cmd: true },
  'warp.closeTab': { key: 'w', code: 'KeyW', cmd: true },
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
    const dir = path.join(os.homedir(), 'src/warp/target/wasm32-unknown-unknown', profile, 'bundle');
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

class WarpViewProvider {
  constructor(globalState, storageDir, log) {
    this.globalState = globalState;
    this.storageDir = storageDir;
    this.settingsFile = null;
    this.ready = Promise.resolve();
    this.panelSettings = new PanelSettings(globalState, STORAGE_KEY);
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
      this.view.webview.html = `<body style="font-family:sans-serif;padding:1em">Panelwarp: ${escapeHtml(e.message)}</body>`;
    }
  }

  async onMessage(msg) {
    switch (msg?.type) {
      case 'warp-loaded':
        this.warpLoaded = true;
        if (msg.timing) this.log.appendLine(`page loaded (ms since page start): ${JSON.stringify(msg.timing)}`);
        if (this.pendingUrl) {
          this.post({ type: 'warp-navigate', url: this.pendingUrl });
          this.pendingUrl = null;
        }
        break;
      // Warp's settings live in the page's localStorage; the durable copy is kept here so it
      // survives the page's origin (random port) changing between sessions.
      case 'warp-storage-request':
        this.post({
          type: 'warp-storage-snapshot',
          entries: this.globalState.get(STORAGE_KEY, {}),
          history: this.history ? JSON.stringify(this.history.load()) : null,
          session: this.loadSession(),
          workflows: JSON.stringify(
            readWorkflowFiles((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)),
          ),
        });
        break;
      case 'warp-storage-changes': {
        const entries = { ...this.globalState.get(STORAGE_KEY, {}) };
        for (const [key, value] of Object.entries(msg.changes || {})) {
          if (value === null) delete entries[key];
          else entries[key] = String(value);
        }
        await this.globalState.update(STORAGE_KEY, entries);
        if ('HostHistorySync' in (msg.changes || {})) await this.syncHistory();
        break;
      }
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
      case 'warp-agents-list':
      case 'warp-agents-summary':
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
          } else {
            reply({ value: await this.agents.open(agent, sessionId) });
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
        await this.settingsFile?.open();
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
      'warp-agents-summary',
      'warp-agents-open',
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
  const log = vscode.window.createOutputChannel('Panelwarp');
  // Warp's settings mirror follows the user across machines via VS Code Settings Sync (the API
  // key stays per machine: SecretStorage doesn't sync).
  context.globalState.setKeysForSync([STORAGE_KEY, HISTORY_SYNC_KEY]);
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
  openPendingClaudeConversation(context.globalState, log);
  // Warp reads its settings once at startup, so the panel waits for this.
  provider.ready = provider.panelSettings
    .migrateFromVSCodeSettings()
    .catch((error) => log.appendLine(`settings migration failed: ${error.message}`));
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
  provider.settingsFile = new SettingsFile(context, {
    storageKey: STORAGE_KEY,
    onApplied: () => provider.restart(),
    log,
  });
  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider('warp.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('warp.restart', () => provider.restart()),
    vscode.commands.registerCommand('warp.benchmarkCommandSearch', () => provider.ai.benchmark()),
    vscode.commands.registerCommand('warp.setOpenRouterApiKey', () =>
      provider.openWarpUrl('warposs://settings?widget=host_api_key'),
    ),
    ...Object.entries(WARP_KEYS).map(([command, keystroke]) =>
      vscode.commands.registerCommand(command, () => provider.sendWarpKey(keystroke)),
    ),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
