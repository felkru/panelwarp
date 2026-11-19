const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { SettingsFileGuard, readMarker, writeMarker } = require('../settingsFileGuard');

test("windows record the open settings file and dead windows' entries are dropped", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, '.settings-file-windows.json');
  const live = new Set([1, 2]);
  const isAlive = (pid) => live.has(pid);

  assert.deepEqual(readMarker(marker, isAlive), {});
  assert.deepEqual(writeMarker(marker, 'a', 1, true, isAlive), { a: 1 });
  assert.deepEqual(writeMarker(marker, 'b', 2, true, isAlive), { a: 1, b: 2 });
  assert.deepEqual(writeMarker(marker, 'a', 1, false, isAlive), { b: 2 });
  // Window b quit without removing its entry
  live.delete(2);
  assert.deepEqual(readMarker(marker, isAlive), {});
  assert.deepEqual(writeMarker(marker, 'a', 1, false, isAlive), {});
  assert.equal(fs.existsSync(marker), false);
  // A broken marker counts as no window
  fs.writeFileSync(marker, '[1, 2');
  assert.deepEqual(readMarker(marker, isAlive), {});
  // The real liveness check knows this process
  assert.deepEqual(writeMarker(marker, 'me', process.pid, true), { me: process.pid });
});

test('entries from before a restart are dropped, since pids get reused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, '.settings-file-windows.json');
  const isAlive = () => true;

  assert.deepEqual(writeMarker(marker, 'a', 1, true, isAlive, 1000), { a: 1 });
  // The same boot, its time computed a second later
  assert.deepEqual(readMarker(marker, isAlive, 1001), { a: 1 });
  // Window a crashed with the file open, and the machine restarted
  assert.deepEqual(readMarker(marker, isAlive, 90000), {});
  assert.deepEqual(writeMarker(marker, 'b', 2, true, isAlive, 90000), { b: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { boot: 90000, windows: { b: 2 } });
  // A window that crashed before this machine last started, whose pid a live process has now
  const lastBoot = Math.round(Date.now() / 1000 - os.uptime());
  fs.writeFileSync(marker, JSON.stringify({ boot: lastBoot - 86400, windows: { a: process.ppid } }));
  assert.deepEqual(readMarker(marker), {});
});

test("an entry with this window's pid and another id is a window from before a container restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, '.settings-file-windows.json');
  writeMarker(marker, 'old-window', process.pid, true);
  assert.deepEqual(writeMarker(marker, 'this-window', process.pid, false), {});
  assert.equal(fs.existsSync(marker), false);
});

// Whether pid 1 belongs to another user, so checking it fails with EPERM. Not in a container whose
// pid 1 is ours, as root, or on Windows
const pidOneIsOthers = (() => {
  try {
    process.kill(1, 0);
    return false;
  } catch (error) {
    return error.code === 'EPERM';
  }
})();

test("another user's process isn't a window", { skip: !pidOneIsOthers }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, '.settings-file-windows.json');
  writeMarker(marker, 'a', 1, true);
  assert.deepEqual(readMarker(marker), {});
});

/** A guard for this window with settings.toml open in a tab, and the info messages it shows. */
function guardFixture(t, { closesTabs = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  const file = path.join(dir, 'settings.toml');
  class TabInputText {
    constructor(uri) { this.uri = uri; }
  }
  let tabs = [{ input: new TabInputText({ scheme: 'file', fsPath: file }) }];
  const messages = [];
  const vscode = {
    env: { sessionId: 'this-window' },
    TabInputText,
    TabInputTextDiff: class {},
    window: {
      tabGroups: {
        get all() { return [{ tabs }]; },
        onDidChangeTabs: () => ({ dispose() {} }),
        close: async (closing) => {
          if (closesTabs) tabs = tabs.filter((tab) => !closing.includes(tab));
        },
      },
      showWarningMessage: async (_message, _options, action) => action,
      showInformationMessage: (message) => { messages.push(message); },
    },
    workspace: { textDocuments: [] },
  };
  const subscriptions = [];
  t.after(() => {
    for (const subscription of subscriptions) subscription.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    messages,
    get tabs() { return tabs; },
    guard: () => new SettingsFileGuard(vscode, { subscriptions }, {
      dir, files: [file], onState() {}, log: { appendLine() {} },
    }),
  };
}

test('closing the file here says why settings stay closed when another window has it open', async (t) => {
  const f = guardFixture(t);
  // The test runner, a live process of this user
  writeMarker(path.join(f.dir, '.settings-file-windows.json'), 'other-window', process.ppid, true);
  assert.equal(await f.guard().requestClose(), false);
  assert.equal(f.tabs.length, 0);
  assert.deepEqual(f.messages, [
    "Warp's settings file is open in another VS Code window. Close it there to open Warp settings.",
  ]);
});

test("a tab here that doesn't close isn't blamed on another window", async (t) => {
  const f = guardFixture(t, { closesTabs: false });
  assert.equal(await f.guard().requestClose(), false);
  assert.equal(f.tabs.length, 1);
  assert.deepEqual(f.messages, []);
});
