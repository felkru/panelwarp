// The panel's own settings live in Warp's settings (Warp's `HostAiSettings` group, shown in its
// settings UI and in settings.toml under `host.*`), so there is one place to configure the panel.
// Warp stores them in localStorage, which extension.js mirrors into globalState; this reads them
// from that mirror.

const vscode = require('vscode');

/** Storage key -> default, matching app/src/settings/host_ai.rs in the Warp fork. */
const DEFAULTS = {
  HostAiFastModel: 'deepseek/deepseek-v4.1-flash',
  HostAiExpandedModel: 'anthropic/claude-sonnet-5.5',
  HostAiExpandedEffort: 'low',
  HostAiFastPriority: 'latency',
  HostAiExpandedPriority: 'latency',
  HostAiPrivateRouting: true,
  HostAiRecentCommandsInContext: 0,
  HostAiNextCommand: false,
  HostAiPromptSuggestions: false,
  HostAiPromptSuggestionsAgent: 'claude',
  HostHistorySync: false,
  HostAiLocalModel: '',
  HostAiLocalServer: 'http://127.0.0.1:1234/v1',
  HostKeysToHost: {},
};

/** Keys that go to VS Code instead of Warp; `host.keys_to_host` adds to or ("") removes these. */
const DEFAULT_KEYS_TO_VSCODE = {
  'cmd+shift+p': 'workbench.action.showCommands',
  'cmd+p': 'workbench.action.quickOpen',
  'cmd+j': 'workbench.action.togglePanel',
  'cmd+b': 'workbench.action.toggleSidebarVisibility',
  'cmd+shift+e': 'workbench.view.explorer',
  'cmd+shift+f': 'workbench.view.search',
  'cmd+shift+g': 'workbench.view.scm',
  'ctrl+`': 'workbench.action.terminal.toggleTerminal',
};

// localStorage holds each setting as a JSON string of its JSON-serialized value.
const decode = (raw) => JSON.parse(JSON.parse(raw));
const encode = (value) => JSON.stringify(JSON.stringify(value));

class PanelSettings {
  /** @param {vscode.Memento} globalState @param {string} storageKey the mirror's globalState key */
  constructor(globalState, storageKey) {
    this.globalState = globalState;
    this.storageKey = storageKey;
  }

  get(key) {
    const raw = this.globalState.get(this.storageKey, {})[key];
    if (raw === undefined) return DEFAULTS[key];
    try {
      return decode(raw) ?? DEFAULTS[key];
    } catch {
      return DEFAULTS[key];
    }
  }

  ai() {
    const privateRouting = this.get('HostAiPrivateRouting') !== false;
    const recent = Math.max(0, Math.min(20, Math.floor(Number(this.get('HostAiRecentCommandsInContext')) || 0)));
    const localServer = String(this.get('HostAiLocalServer') || DEFAULTS.HostAiLocalServer).trim();
    return {
      // A local model (LM Studio etc.) replaces OpenRouter for every AI request when set.
      localModel: String(this.get('HostAiLocalModel') || '').trim(),
      localServer: /^https?:\/\//i.test(localServer) ? localServer : DEFAULTS.HostAiLocalServer,
      fastModel: this.get('HostAiFastModel') || DEFAULTS.HostAiFastModel,
      expandedModel: this.get('HostAiExpandedModel') ?? '',
      expandedEffort: this.get('HostAiExpandedEffort') || DEFAULTS.HostAiExpandedEffort,
      // OpenRouter host order per stage: balanced, latency, price or throughput.
      fastPriority: this.get('HostAiFastPriority') || DEFAULTS.HostAiFastPriority,
      expandedPriority: this.get('HostAiExpandedPriority') || DEFAULTS.HostAiExpandedPriority,
      privateRouting,
      // Recent commands can contain secrets: only ever sent to zero-data-retention hosts.
      recentCommands: privateRouting ? recent : 0,
      // Next Command sends command output: also only with private routing.
      nextCommand: privateRouting && this.get('HostAiNextCommand') === true,
      // Prompt Suggestions send command output too.
      promptSuggestions: privateRouting && this.get('HostAiPromptSuggestions') === true,
    };
  }

  /** Key spec (e.g. "cmd+shift+p") -> VS Code command. */
  keysToVSCode() {
    const keys = { ...DEFAULT_KEYS_TO_VSCODE };
    for (const [spec, command] of Object.entries(this.get('HostKeysToHost') || {})) {
      const normalized = spec.toLowerCase().replace(/\s+/g, '');
      if (command) keys[normalized] = String(command);
      else delete keys[normalized];
    }
    return keys;
  }

  /**
   * One-time move of the settings that used to be VS Code settings (`warp.ai.*`,
   * `warp.keysToVSCode`) into Warp's settings, removing them from VS Code's settings.
   */
  async migrateFromVSCodeSettings() {
    const config = vscode.workspace.getConfiguration('warp');
    const moves = {
      'ai.fastModel': 'HostAiFastModel',
      'ai.expandedModel': 'HostAiExpandedModel',
      'ai.expandedEffort': 'HostAiExpandedEffort',
      'ai.privateRouting': 'HostAiPrivateRouting',
      'ai.recentCommandsInContext': 'HostAiRecentCommandsInContext',
      keysToVSCode: 'HostKeysToHost',
    };
    const entries = { ...this.globalState.get(this.storageKey, {}) };
    let moved = false;
    for (const [setting, key] of Object.entries(moves)) {
      const value = config.inspect(setting)?.globalValue;
      if (value === undefined) continue;
      if (!(key in entries)) entries[key] = encode(value);
      await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
      moved = true;
    }
    for (const setting of ['bundlePath', 'ai.commandSearchModel']) {
      if (config.inspect(setting)?.globalValue !== undefined) {
        await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
      }
    }
    if (moved) await this.globalState.update(this.storageKey, entries);
  }
}

/** Shows a modal confirmation in VS Code; resolves to true if the user confirmed. */
async function confirm(message, detail, confirmLabel) {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
  return choice === confirmLabel;
}

const PUBLIC_ROUTING_MESSAGE = 'Allow hosts that retain your AI requests?';
const PUBLIC_ROUTING_DETAIL =
  'With private routing off, OpenRouter may send your # requests (what you type after #, plus ' +
  'your OS and shell) to hosts such as Azure or Anthropic that keep request data for a while and ' +
  "may log it. Recent commands are no longer sent. Check the host's data-retention and training " +
  "policy on OpenRouter's model page.";
const confirmPublicRouting = () => confirm(PUBLIC_ROUTING_MESSAGE, PUBLIC_ROUTING_DETAIL, 'Allow');

module.exports = {
  PanelSettings,
  DEFAULTS,
  DEFAULT_KEYS_TO_VSCODE,
  decode,
  encode,
  confirm,
  confirmPublicRouting,
};
