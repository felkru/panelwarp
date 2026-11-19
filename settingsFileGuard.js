'use strict';

// Keeps Warp's settings closed while settings.toml or keybindings.yaml is open in an editor, so
// settings always open showing what the files say. Opening a file closes the settings tab; opening
// settings while a file is open asks to close the file first, then opens them.
//
// The windows of one machine share the files, so each window records whether it has one open in a
// marker next to them: {"boot": <boot time>, "windows": {"<window session id>": <extension host
// pid>}}. Entries of windows that quit without removing theirs are dropped when their process is
// gone, or with the whole marker once the machine restarts, since a new process can get their pid.
// A container keeps the host's boot time, but its pids start low again when it restarts, so an
// entry with this window's pid and another id is dropped too.

const fs = require('fs');
const os = require('os');
const path = require('path');

// 0.1.19 kept entries in another format in .settings-file-open.json. A new name keeps its windows
// and newer ones from dropping each other's entries until they reload
const MARKER = '.settings-file-windows.json';
const OPEN_ELSEWHERE =
  "Warp's settings file is open in another VS Code window. Close it there to open Warp settings.";
// Boot times computed from the clock drift a little, and a restart moves them by far more
const BOOT_SLACK_SECONDS = 60;

/** When this machine started, in seconds. */
function bootTime() {
  return Math.round(Date.now() / 1000 - os.uptime());
}

const sameBoot = (a, b) => Math.abs(a - b) < BOOT_SLACK_SECONDS;

// EPERM means another user's process has the pid, which can't be a window of ours
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : {};
  } catch {
    return {};
  }
}

/** The marker's entries of live windows. */
function readMarker(file, isAlive = alive, boot = bootTime()) {
  const marker = readJson(file);
  const live = {};
  if (!sameBoot(marker.boot, boot)) return live;
  for (const [id, pid] of Object.entries(marker.windows ?? {})) {
    if (Number.isInteger(pid) && isAlive(pid)) live[id] = pid;
  }
  return live;
}

/** Adds or removes this window's entry and drops dead windows' ones. Returns the live entries. */
function writeMarker(file, id, pid, open, isAlive = alive, boot = bootTime()) {
  const before = readJson(file);
  const entries = readMarker(file, isAlive, boot);
  for (const [other, otherPid] of Object.entries(entries)) {
    if (otherPid === pid && other !== id) delete entries[other];
  }
  if (open) entries[id] = pid;
  else delete entries[id];
  const marker = { boot: sameBoot(before.boot, boot) ? before.boot : boot, windows: entries };
  if (JSON.stringify(marker) !== JSON.stringify(before)) {
    if (Object.keys(entries).length) fs.writeFileSync(file, JSON.stringify(marker));
    else fs.rmSync(file, { force: true });
  }
  return entries;
}

class SettingsFileGuard {
  /**
   * @param {{dir: string, files: string[], onState: (open: boolean) => void,
   *   log: {appendLine: (line: string) => void}}} options `onState` gets whether a file is open in
   *   any window of this machine, whenever that changes
   */
  constructor(vscode, context, { dir, files, onState, log }) {
    this.vscode = vscode;
    this.files = files;
    this.onState = onState;
    this.log = log;
    this.marker = path.join(dir, MARKER);
    this.id = vscode.env.sessionId;
    this.openHere = false;
    this.open = false;
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      { dispose: () => this.record(false) },
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, (_event, name) => {
        if (!name || name === MARKER) this.refresh();
      });
      watcher.on('error', (error) => log.appendLine(`settings file guard: ${error.message}`));
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (error) {
      log.appendLine(`settings file guard can't watch: ${error.message}`);
    }
    this.refresh();
  }

  /** This window's editor tabs showing one of the files. */
  tabs() {
    const { TabInputText, TabInputTextDiff } = this.vscode;
    const shows = (uri) => uri?.scheme === 'file' && this.files.includes(uri.fsPath);
    return this.vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          (tab.input instanceof TabInputText && shows(tab.input.uri)) ||
          (tab.input instanceof TabInputTextDiff && (shows(tab.input.original) || shows(tab.input.modified))),
      );
  }

  record(open) {
    try {
      return writeMarker(this.marker, this.id, process.pid, open);
    } catch (error) {
      this.log.appendLine(`settings file guard: ${error.message}`);
      return open ? { [this.id]: process.pid } : {};
    }
  }

  refresh() {
    this.openHere = this.tabs().length > 0;
    const open = Object.keys(this.record(this.openHere)).length > 0;
    if (open === this.open) return;
    this.open = open;
    this.onState(open);
  }

  /**
   * Warp asked for settings while a file is open: asks to close it. Returns true if no file is
   * open any more.
   */
  async requestClose() {
    this.refresh();
    if (!this.open) return true;
    const tabs = this.tabs();
    if (!tabs.length) {
      this.vscode.window.showInformationMessage(OPEN_ELSEWHERE);
      return false;
    }
    const docs = this.vscode.workspace.textDocuments.filter(
      (doc) => doc.uri.scheme === 'file' && this.files.includes(doc.uri.fsPath),
    );
    const dirty = docs.filter((doc) => doc.isDirty);
    const names = [...new Set(docs.map((doc) => path.basename(doc.uri.fsPath)))].join(' and ') || 'the settings file';
    const action = dirty.length ? 'Save and Close' : 'Close';
    const choice = await this.vscode.window.showWarningMessage(
      `Close ${names} to open Warp settings?`,
      {
        modal: true,
        detail: 'Warp settings open from the file, so they show what it says.',
      },
      action,
    );
    if (choice !== action) return false;
    for (const doc of dirty) {
      if (!(await doc.save())) return false;
    }
    await this.vscode.window.tabGroups.close(this.tabs());
    this.refresh();
    // Only another window's tab needs saying: a tab here that didn't close is in view
    if (!this.openHere && this.open) this.vscode.window.showInformationMessage(OPEN_ELSEWHERE);
    return !this.open;
  }
}

module.exports = { SettingsFileGuard, OPEN_ELSEWHERE, readMarker, writeMarker };
