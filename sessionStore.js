// Tabs for the Warp panel, restored like desktop Warp restores its windows: each workspace's latest
// tab layout (tabs, splits, titles, each pane's directory) and recent command blocks per pane, in
// the same warp.sqlite as the command history (extension global storage, shared by all VS Code
// windows). Warp sends the layout whenever it changes and each block when it finishes
// (`host_session` in app/src/platform/wasm.rs), and gets the latest of both at startup.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** Blocks kept per pane, newest first, like desktop Warp's per-pane limit. */
const MAX_BLOCKS_PER_PANE = 100;
/** Layouts and pane blocks that haven't been saved in this long are dropped. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A layout or block bigger than this isn't stored (a block's output is already truncated). */
const MAX_JSON_LENGTH = 4 * 1024 * 1024;
const EMPTY_WINDOW_KEY = 'warp.emptyWindowId';

class SessionStore {
  /** @param {string} storageDir the extension's globalStorageUri.fsPath */
  constructor(storageDir) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(path.join(storageDir, 'warp.sqlite'));
    // Every VS Code window has its own connection to this file.
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      -- The single layout every window shared made a new window open another folder's tabs
      DROP TABLE IF EXISTS panel_session;
      CREATE TABLE IF NOT EXISTS panel_workspace_session (
        workspace TEXT PRIMARY KEY NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panel_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        pane_uuid TEXT NOT NULL,
        json TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS panel_blocks_pane ON panel_blocks (pane_uuid, id);
    `);
    this.upsertSession = this.db.prepare(`
      INSERT INTO panel_workspace_session (workspace, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (workspace) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`);
    this.selectSession = this.db.prepare('SELECT json FROM panel_workspace_session WHERE workspace = ?');
    this.dropOldSessions = this.db.prepare('DELETE FROM panel_workspace_session WHERE updated_at < ?');
    this.insertBlock = this.db.prepare(
      'INSERT INTO panel_blocks (pane_uuid, json, saved_at) VALUES (?, ?, ?)',
    );
    this.trimPane = this.db.prepare(`
      DELETE FROM panel_blocks WHERE pane_uuid = ? AND id NOT IN (
        SELECT id FROM panel_blocks WHERE pane_uuid = ? ORDER BY id DESC LIMIT ?)`);
    this.selectBlocks = this.db.prepare(
      'SELECT json FROM panel_blocks WHERE pane_uuid = ? ORDER BY id DESC LIMIT ?',
    );
    this.dropOldPanes = this.db.prepare(`
      DELETE FROM panel_blocks WHERE pane_uuid IN (
        SELECT pane_uuid FROM panel_blocks GROUP BY pane_uuid HAVING MAX(saved_at) < ?)`);
  }

  /**
   * The workspace's latest layout and its panes' blocks (oldest first), as JSON for Warp; null if none.
   * @param {string} workspace see workspaceKey
   */
  load(workspace) {
    // A busy database can skip cleanup but must not stop the restore, or Warp's next save
    // replaces the layout with a fresh tab
    try {
      const cutoff = Date.now() - MAX_AGE_MS;
      this.dropOldSessions.run(cutoff);
      this.dropOldPanes.run(cutoff);
    } catch {}
    const row = this.selectSession.get(workspace);
    if (!row) return null;
    let session;
    try {
      session = JSON.parse(row.json);
    } catch {
      return null;
    }
    const blocks = {};
    for (const uuid of paneUuids(session)) {
      const rows = this.selectBlocks.all(uuid, MAX_BLOCKS_PER_PANE);
      if (rows.length) blocks[uuid] = rows.reverse().map((r) => JSON.parse(r.json));
    }
    return JSON.stringify({ session, blocks });
  }

  /**
   * @param {string} workspace see workspaceKey
   * @param {string} json the layout, replacing the workspace's previous one (the latest window wins)
   */
  saveSession(workspace, json) {
    if (typeof json !== 'string' || json.length > MAX_JSON_LENGTH) return;
    JSON.parse(json); // only store what Warp can read back
    this.upsertSession.run(workspace, json, Date.now());
  }

  /** @param {string} paneUuid @param {string} json a finished block */
  saveBlock(paneUuid, json) {
    if (typeof paneUuid !== 'string' || !/^[0-9a-f]{1,64}$/.test(paneUuid)) return;
    if (typeof json !== 'string' || json.length > MAX_JSON_LENGTH) return;
    JSON.parse(json);
    this.insertBlock.run(paneUuid, json, Date.now());
    this.trimPane.run(paneUuid, paneUuid, MAX_BLOCKS_PER_PANE);
  }

  close() {
    this.db.close();
  }
}

/** Terminal pane uuids in a layout (see `host_session` in app/src/platform/wasm.rs for its shape). */
function paneUuids(session) {
  const uuids = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.terminal?.uuid === 'string') uuids.push(node.terminal.uuid);
    for (const child of node.branch?.children || []) visit(child.node);
  };
  for (const window of session?.windows || []) for (const tab of window.tabs || []) visit(tab.root);
  return uuids;
}

/**
 * The key a window's tabs are saved under, so each window only restores its own: the
 * .code-workspace file, else the first folder, else an id kept in an empty window's workspace
 * state, which survives its reloads (a new empty window starts fresh in the home folder).
 * @param {typeof import('vscode').workspace} workspace
 * @param {import('vscode').Memento} workspaceState
 */
function workspaceKey(workspace, workspaceState) {
  const uri = workspace.workspaceFile ?? workspace.workspaceFolders?.[0]?.uri;
  if (uri) return uri.toString();
  const savedId = workspaceState.get(EMPTY_WINDOW_KEY);
  if (savedId) return `empty-window:${savedId}`;
  const id = crypto.randomUUID();
  workspaceState.update(EMPTY_WINDOW_KEY, id);
  return `empty-window:${id}`;
}

module.exports = { SessionStore, paneUuids, workspaceKey };
