const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { SessionStore, workspaceKey } = require('../sessionStore');

const DAY_MS = 24 * 60 * 60 * 1000;

// Stores close before their folder is removed, which Windows needs for an open warp.sqlite
function storageDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-sessions-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const store = new SessionStore(dir);
    stores.push(store);
    return store;
  };
  return { dir, open };
}

// A window's workspace state, which VS Code keeps across that window's reloads
function windowState() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    update: async (key, value) => {
      values.set(key, value);
    },
  };
}

function uri(value) {
  return { toString: () => value };
}

function layout(uuid, cwd) {
  return JSON.stringify({ windows: [{ tabs: [{ root: { terminal: { uuid, cwd } } }] }] });
}

test('a workspace restores only its own tabs and blocks', (t) => {
  const store = storageDir(t).open();
  store.saveSession('file:///a', layout('aa', '/a'));
  store.saveBlock('aa', '{"command":"ls"}');
  store.saveSession('file:///b', layout('bb', '/b'));
  store.saveBlock('bb', '{"command":"pwd"}');

  assert.deepEqual(JSON.parse(store.load('file:///a')), {
    session: { windows: [{ tabs: [{ root: { terminal: { uuid: 'aa', cwd: '/a' } } }] }] },
    blocks: { aa: [{ command: 'ls' }] },
  });
  assert.deepEqual(JSON.parse(store.load('file:///b')), {
    session: { windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/b' } } }] }] },
    blocks: { bb: [{ command: 'pwd' }] },
  });
  assert.equal(store.load('file:///c'), null);
});

test("saving a workspace's tabs leaves other workspaces alone", (t) => {
  const storage = storageDir(t);
  const windowA = storage.open();
  const windowB = storage.open();
  windowA.saveSession('file:///a', layout('aa', '/a'));
  windowB.saveSession('file:///b', layout('bb', '/b'));
  windowB.saveSession('file:///a', layout('a2', '/a/src'));

  assert.deepEqual(JSON.parse(windowA.load('file:///a')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'a2', cwd: '/a/src' } } }] }],
  });
  assert.deepEqual(JSON.parse(windowA.load('file:///b')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/b' } } }] }],
  });
});

test('the old layout shared by every window is dropped', (t) => {
  const storage = storageDir(t);
  const old = new DatabaseSync(path.join(storage.dir, 'warp.sqlite'));
  old.exec(`
    CREATE TABLE panel_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  old.prepare('INSERT INTO panel_session (id, json, updated_at) VALUES (1, ?, ?)').run(layout('aa', '/a'), Date.now());
  old.close();

  const store = storage.open();

  assert.equal(store.load('file:///a'), null);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'panel_session'").get(), undefined);
});

test("a workspace's tabs are dropped after 30 days without a save", (t) => {
  const store = storageDir(t).open();
  store.saveSession('file:///old', layout('aa', '/old'));
  store.saveBlock('aa', '{"command":"ls"}');
  store.saveSession('file:///recent', layout('bb', '/recent'));
  const monthAgo = Date.now() - 31 * DAY_MS;
  store.db.prepare("UPDATE panel_workspace_session SET updated_at = ? WHERE workspace = 'file:///old'").run(monthAgo);
  store.db.prepare("UPDATE panel_blocks SET saved_at = ? WHERE pane_uuid = 'aa'").run(monthAgo);

  assert.equal(store.load('file:///old'), null);
  assert.deepEqual(JSON.parse(store.load('file:///recent')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/recent' } } }] }],
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM panel_blocks WHERE pane_uuid = 'aa'").get().count, 0);
});

test('a window is keyed by its workspace file, else its first folder', () => {
  const folders = [{ uri: uri('file:///a') }, { uri: uri('file:///b') }];

  assert.equal(workspaceKey({ workspaceFolders: folders }, windowState()), 'file:///a');
  assert.equal(
    workspaceKey({ workspaceFile: uri('file:///a/split.code-workspace'), workspaceFolders: folders }, windowState()),
    'file:///a/split.code-workspace',
  );
});

test('an empty window keeps its tabs across reloads and a new empty window starts fresh', (t) => {
  const store = storageDir(t).open();
  const emptyWindow = windowState();
  store.saveSession(workspaceKey({}, emptyWindow), layout('aa', '/Users/me'));

  const reloaded = workspaceKey({ workspaceFolders: [] }, emptyWindow);
  const newWindow = workspaceKey({}, windowState());

  assert.deepEqual(JSON.parse(store.load(reloaded)).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'aa', cwd: '/Users/me' } } }] }],
  });
  assert.notEqual(newWindow, reloaded);
  assert.equal(store.load(newWindow), null);
});
