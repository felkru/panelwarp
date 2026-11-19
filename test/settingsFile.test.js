const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');
const TOML = require('smol-toml');

const root = path.resolve(__dirname, '..');
const oldBindings = '"editor_view:insert_autosuggestion": tab\n';
const newBindings = '"editor_view:insert_autosuggestion": ctrl-space\n';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Only the VS Code API is replaced. Both project modules and the filesystem are real.
function loadSettings(vscode) {
  const modules = new Map();
  const load = (file) => {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const actualRequire = createRequire(file);
    const requireModule = (id) => {
      if (id === 'vscode') return vscode;
      if (id === './panelSettings') return load(path.join(root, 'panelSettings.js'));
      return actualRequire(id);
    };
    compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports'], { filename: file })(
      requireModule, module, module.exports,
    );
    return module.exports;
  };
  return load(path.join(root, 'settingsFile.js'));
}

async function fixture(t, { mirror = {}, dir, live = true, watch = false, reload = false } = {}) {
  const storageDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-settings-'));
  const subscriptions = [];
  const errors = [];
  const confirmations = [];
  const reloadPrompts = [];
  const waiting = [];
  const page = { ...mirror };
  let entries = { ...mirror };
  let pausedUpdate;
  let allowRouting = false;
  let reloads = 0;
  const globalState = {
    get: (_key, fallback) => entries ?? fallback,
    async update(_key, value) {
      entries = value;
      const paused = pausedUpdate;
      pausedUpdate = null;
      if (paused) {
        paused.started.resolve();
        await paused.released.promise;
      }
    },
  };
  const vscode = {
    workspace: { onDidSaveTextDocument: () => ({ dispose() {} }) },
    window: {
      showErrorMessage: (message) => { errors.push(message); },
      showInformationMessage: async (message, ...choices) => {
        if (!choices.includes('Reload now')) return undefined;
        reloadPrompts.push(message);
        return reload ? 'Reload now' : undefined;
      },
      showWarningMessage: async (...args) => {
        confirmations.push(args);
        return allowRouting ? 'Allow' : undefined;
      },
    },
  };
  const { SettingsFile } = loadSettings(vscode);
  const settings = new SettingsFile({
    globalState, globalStorageUri: { fsPath: storageDir }, subscriptions,
  }, {
    storageKey: 'warp.localStorage',
    onChanged(changes) {
      if (!live) return false;
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete page[key];
        else page[key] = value;
      }
      waiting.shift()?.(changes);
      return true;
    },
    onApplied: async () => {
      reloads += 1;
      const snapshot = await settings.load();
      for (const key of Object.keys(page)) delete page[key];
      Object.assign(page, snapshot);
    },
    log: { appendLine() {} },
  });
  if (!watch) subscriptions.at(-1).dispose();
  t.after(() => {
    for (const subscription of subscriptions) subscription.dispose();
    if (!dir) fs.rmSync(storageDir, { recursive: true, force: true });
  });
  await settings.migrate();
  await settings.load();
  return {
    settings, page, errors, confirmations, reloadPrompts,
    get reloads() { return reloads; },
    get mirror() { return entries; },
    // VS Code Settings Sync replaces the whole mirror with another machine's
    receiveSync: (mirror) => { entries = mirror; },
    allowRouting: () => { allowRouting = true; },
    chooseReload: () => { reload = true; },
    nextChange: () => new Promise((resolve) => waiting.push(resolve)),
    pauseNextUpdate() {
      const started = deferred();
      const released = deferred();
      pausedUpdate = { started, released };
      return { started: started.promise, release: released.resolve };
    },
  };
}

test('a delayed file update cannot overwrite a newer Warp setting', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 14\n');
  const update = f.pauseNextUpdate();
  const applying = f.settings.apply(false);
  await update.started;
  f.page.FontSize = '"16"';
  await f.settings.save({ FontSize: '"16"' });
  update.release();
  await applying;
  await f.settings.apply(false);
  assert.equal(f.page.FontSize, '"16"');
  assert.equal(f.settings.state.FontSize, '"16"');
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).appearance.text.font_size, 16);
});

test('a delayed editor save cannot restore a setting removed in Warp', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 14\n');
  const update = f.pauseNextUpdate();
  const applying = f.settings.applySaved();
  await update.started;
  delete f.page.FontSize;
  await f.settings.save({ FontSize: null });
  update.release();
  await applying;
  assert.equal(f.page.FontSize, undefined);
  assert.equal(f.settings.state.FontSize, undefined);
});

test('keybindings apply despite invalid TOML and settings recover after correction', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"', CustomKeybindings: JSON.stringify(oldBindings) } });
  fs.writeFileSync(f.settings.file, '[broken');
  fs.writeFileSync(f.settings.keybindingsFile, newBindings);
  await f.settings.applySaved();
  assert.equal(f.page.CustomKeybindings, JSON.stringify(newBindings));
  assert.equal(f.settings.state.FontSize, '"13"');
  assert.match(f.errors.join('\n'), /settings\.toml/);
  assert.equal(f.reloads, 0);
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 15\n');
  await f.settings.applySaved();
  assert.equal(f.page.FontSize, '"15"');
  assert.equal(f.page.CustomKeybindings, JSON.stringify(newBindings));
});

test('startup loads keybindings even when settings.toml is invalid', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  fs.writeFileSync(f.settings.file, '[broken');
  fs.writeFileSync(f.settings.keybindingsFile, newBindings);
  const entries = await f.settings.load();
  assert.equal(entries.CustomKeybindings, JSON.stringify(newBindings));
  assert.equal(entries.FontSize, '"13"');
  assert.match(f.errors.join('\n'), /settings\.toml/);
});

test('older Warp builds can reload valid keybindings despite invalid TOML', async (t) => {
  const f = await fixture(t, { live: false, reload: true });
  fs.writeFileSync(f.settings.file, '[broken');
  fs.writeFileSync(f.settings.keybindingsFile, newBindings);
  await f.settings.applySaved();
  assert.equal(f.reloads, 1);
  assert.equal(f.settings.state.CustomKeybindings, JSON.stringify(newBindings));
  assert.match(f.errors.join('\n'), /settings\.toml/);
});

test('a watcher-first update still offers reload to an older Warp build', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' }, live: false, reload: true });
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 14\n');
  fs.writeFileSync(f.settings.keybindingsFile, newBindings);
  await f.settings.apply(false);
  assert.equal(f.page.FontSize, '"13"');
  assert.equal(f.page.CustomKeybindings, undefined);
  await f.settings.applySaved();
  assert.equal(f.reloads, 1);
  assert.equal(f.page.FontSize, '"14"');
  assert.equal(f.page.CustomKeybindings, JSON.stringify(newBindings));
  await f.settings.applySaved();
  assert.equal(f.reloadPrompts.length, 1);
});

test('unapplied changes survive declining the reload prompt', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' }, live: false });
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 14\n');
  await f.settings.apply(false);
  await f.settings.applySaved();
  assert.equal(f.page.FontSize, '"13"');
  assert.equal(f.reloadPrompts.length, 1);
  f.chooseReload();
  await f.settings.applySaved();
  assert.equal(f.reloads, 1);
  assert.equal(f.page.FontSize, '"14"');
});

test('an editor save offers reload while a watcher is waiting for storage', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' }, live: false, reload: true });
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 14\n');
  const update = f.pauseNextUpdate();
  const applying = f.settings.apply(false);
  await update.started;
  try {
    await f.settings.applySaved();
    assert.equal(f.reloads, 1);
    assert.equal(f.page.FontSize, '"14"');
  } finally {
    update.release();
    await applying;
  }
});

test('an unchanged save does not offer reload to an older Warp build', async (t) => {
  const f = await fixture(t, { live: false, reload: true });
  await f.settings.applySaved();
  assert.equal(f.reloadPrompts.length, 0);
});

test('removing keybindings in Warp stays removed after startup', async (t) => {
  const f = await fixture(t, { mirror: { CustomKeybindings: JSON.stringify(oldBindings) } });
  await f.settings.save({ CustomKeybindings: null });
  assert.equal((await f.settings.load()).CustomKeybindings, undefined);
  assert.equal(fs.readFileSync(f.settings.keybindingsFile, 'utf8').trim(), '');
});

test('Warp saves keybindings despite invalid TOML', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.settings.file, '[broken');
  await f.settings.save({ CustomKeybindings: JSON.stringify(newBindings), FontSize: '"16"' });
  assert.equal(fs.readFileSync(f.settings.keybindingsFile, 'utf8'), newBindings);
  assert.equal((await f.settings.load()).CustomKeybindings, JSON.stringify(newBindings));
});

test('unreadable keybindings do not block a valid settings edit', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  fs.mkdirSync(f.settings.keybindingsFile);
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 17\n');
  await f.settings.applySaved();
  assert.equal(f.page.FontSize, '"17"');
  assert.match(f.errors.join('\n'), /keybindings\.yaml/);
});

test('private routing stays on until file edits are confirmed', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.settings.file, '[host.ai]\nprivate_routing = false\n');
  await f.settings.apply(false);
  assert.equal(f.settings.state.HostAiPrivateRouting, '"true"');
  assert.equal(fs.existsSync(f.settings.routingAllowedFile), false);
  assert.equal(f.confirmations.length, 0);
  f.allowRouting();
  await f.settings.apply(true);
  assert.equal(f.page.HostAiPrivateRouting, '"false"');
  assert.equal(fs.existsSync(f.settings.routingAllowedFile), true);
  assert.equal(f.confirmations.length, 1);
});

test('refusing public routing restores the file and still applies keybindings', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.settings.file, '[host.ai]\nprivate_routing = false\n');
  fs.writeFileSync(f.settings.keybindingsFile, newBindings);
  await f.settings.applySaved();
  assert.equal(f.page.HostAiPrivateRouting, '"true"');
  assert.equal(f.page.CustomKeybindings, JSON.stringify(newBindings));
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host.ai.private_routing, true);
  assert.equal(fs.existsSync(f.settings.routingAllowedFile), false);
});

test('migration backs up an old settings view and preserves file-only keys on UI saves', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'settings.toml'), '[appearance.text]\nfont_size = 10\n');
  const f = await fixture(t, { dir, mirror: { FontSize: '"13"' } });
  assert.equal(TOML.parse(fs.readFileSync(`${f.settings.file}.bak`, 'utf8')).appearance.text.font_size, 10);
  fs.appendFileSync(f.settings.file, '\n[custom]\nkeep_me = "yes"\n');
  await f.settings.save({ FontSize: '"18"' });
  const doc = TOML.parse(fs.readFileSync(f.settings.file, 'utf8'));
  assert.equal(doc.appearance.text.font_size, 18);
  assert.equal(doc.custom.keep_me, 'yes');
});

test('the filesystem watcher applies edits from another editor', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' }, watch: true });
  const changed = f.nextChange();
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 19\n');
  await changed;
  assert.equal(f.page.FontSize, '"19"');
});

test('a second window sees settings and keybindings saved by the first', async (t) => {
  const first = await fixture(t, { mirror: { FontSize: '"13"' } });
  const second = await fixture(t, {
    dir: path.dirname(first.settings.file), mirror: { FontSize: '"13"' },
  });
  await first.settings.save({ FontSize: '"20"', CustomKeybindings: JSON.stringify(newBindings) });
  await second.settings.apply(false);
  assert.equal(second.page.FontSize, '"20"');
  assert.equal(second.page.CustomKeybindings, JSON.stringify(newBindings));
});

test('a delayed file update cannot undo turning private routing back on', async (t) => {
  const f = await fixture(t, { mirror: { HostAiPrivateRouting: '"true"' } });
  f.allowRouting();
  fs.writeFileSync(f.settings.file, '[host.ai]\nprivate_routing = false\n');
  const update = f.pauseNextUpdate();
  const applying = f.settings.applySaved();
  await update.started;
  f.page.HostAiPrivateRouting = '"true"';
  await f.settings.save({ HostAiPrivateRouting: '"true"' });
  update.release();
  await applying;
  assert.equal(f.page.HostAiPrivateRouting, '"true"');
  assert.equal(fs.existsSync(f.settings.routingAllowedFile), false);
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host.ai.private_routing, true);
});

// The mirror as another machine leaves it after changing its settings
function otherMachine(entries, id = 'change-1') {
  return { ...entries, __panelwarpSync: { from: 'other-machine', id } };
}

const fontSize = (f) => TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).appearance?.text?.font_size;

test("another machine's synced settings and keybindings reach the files and the page", async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"', TabTitle: '"x"' } });
  f.receiveSync(otherMachine({ FontSize: '"15"', CustomKeybindings: JSON.stringify(newBindings), TabTitle: '"x"' }));
  await f.settings.apply(false);
  assert.equal(fontSize(f), 15);
  assert.equal(fs.readFileSync(f.settings.keybindingsFile, 'utf8'), newBindings);
  assert.equal(f.page.FontSize, '"15"');
  assert.equal(f.page.CustomKeybindings, JSON.stringify(newBindings));
  assert.equal('__panelwarpSync' in f.page, false);
  assert.equal('__panelwarpSync' in (await f.settings.load()), false);
});

test('a synced change applies once, so a late window or a later local edit keeps the newer value', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  const synced = otherMachine({ FontSize: '"15"' });
  f.receiveSync(synced);
  await f.settings.apply(false);
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 17\n');
  await f.settings.apply(false);
  // A window that sees the mirror late still has the other machine's change
  f.receiveSync(synced);
  await f.settings.apply(false);
  assert.equal(fontSize(f), 17);
  assert.equal(f.page.FontSize, '"17"');
});

test("this machine's changes are stamped as its own and aren't pulled back", async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  await f.settings.save({ FontSize: '"16"' });
  const stamp = f.mirror.__panelwarpSync;
  assert.equal(stamp.from, fs.readFileSync(f.settings.syncIdFile, 'utf8'));
  fs.writeFileSync(f.settings.file, '[appearance.text]\nfont_size = 18\n');
  await f.settings.apply(false);
  assert.equal(fontSize(f), 18);
  assert.notEqual(f.mirror.__panelwarpSync.id, stamp.id);
  assert.equal(f.mirror.FontSize, encodeNumber(18));
});

test('a Warp change made before a pending sync is applied lands on top of it', async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  f.receiveSync(otherMachine({ FontSize: '"15"', CustomKeybindings: JSON.stringify(newBindings) }));
  await f.settings.save({ FontSize: '"16"' });
  assert.equal(fontSize(f), 16);
  assert.equal(fs.readFileSync(f.settings.keybindingsFile, 'utf8'), newBindings);
  assert.equal(f.mirror.FontSize, '"16"');
  assert.equal(f.mirror.CustomKeybindings, JSON.stringify(newBindings));
});

test("with settings sync off, another machine's settings are left out", async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  fs.writeFileSync(f.settings.file, '[host]\nsettings_sync = false\n\n[appearance.text]\nfont_size = 14\n');
  await f.settings.apply(false);
  f.receiveSync(otherMachine({ FontSize: '"15"' }));
  await f.settings.apply(false);
  assert.equal(fontSize(f), 14);
  assert.equal(f.page.FontSize, '"14"');
});

test("another machine's choice of syncing doesn't change this one's", async (t) => {
  const f = await fixture(t, { mirror: { FontSize: '"13"' } });
  f.receiveSync(otherMachine({ FontSize: '"15"', HostSettingsSync: '"false"' }));
  await f.settings.apply(false);
  assert.equal(fontSize(f), 15);
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host?.settings_sync, undefined);
  assert.equal(f.page.HostSettingsSync, undefined);
});

test('private routing turned off on another machine still asks on this one', async (t) => {
  const f = await fixture(t);
  f.receiveSync(otherMachine({ HostAiPrivateRouting: '"false"' }));
  await f.settings.apply(false);
  assert.equal(f.page.HostAiPrivateRouting, '"true"');
  assert.equal(f.confirmations.length, 0);
  f.settings.confirmRouting();
  await f.settings.apply(true);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.page.HostAiPrivateRouting, '"true"');
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host.ai.private_routing, true);
});

// Machine A turns private routing off and confirms it, and machine B gets that through settings sync
async function routingOffOnA(t) {
  const a = await fixture(t);
  a.allowRouting();
  fs.writeFileSync(a.settings.file, '[host.ai]\nprivate_routing = false\n');
  await a.settings.apply(true);
  const b = await fixture(t);
  b.receiveSync(a.mirror);
  return { a, b, stamp: a.mirror.__panelwarpSync };
}

// A pulls what B left in the mirror and keeps routing off
async function assertOffOnA(a, b) {
  a.receiveSync(b.mirror);
  await a.settings.apply(false);
  assert.equal(a.page.HostAiPrivateRouting, '"false"');
  assert.equal(TOML.parse(fs.readFileSync(a.settings.file, 'utf8')).host.ai.private_routing, false);
}

test('private routing kept on by a machine that has not been asked stays off where it was turned off', async (t) => {
  const { a, b } = await routingOffOnA(t);
  await a.settings.save({ FontSize: '"15"' });
  b.receiveSync(a.mirror);
  await b.settings.apply(false);
  assert.equal(b.page.HostAiPrivateRouting, '"true"');
  // B passes on A's font as its own change, without routing
  assert.equal(b.mirror.FontSize, '"15"');
  assert.equal(b.mirror.__panelwarpSync.from, fs.readFileSync(b.settings.syncIdFile, 'utf8'));
  assert.equal(b.mirror.HostAiPrivateRouting, '"false"');
  await assertOffOnA(a, b);
});

test('declining private routing off from another machine keeps it off there', async (t) => {
  const { a, b, stamp } = await routingOffOnA(t);
  await b.settings.apply(true);
  assert.equal(b.confirmations.length, 1);
  assert.equal(b.page.HostAiPrivateRouting, '"true"');
  assert.equal(TOML.parse(fs.readFileSync(b.settings.file, 'utf8')).host.ai.private_routing, true);
  assert.equal(b.mirror.HostAiPrivateRouting, '"false"');
  assert.deepEqual(b.mirror.__panelwarpSync, stamp);
  await assertOffOnA(a, b);
});

test("a new window on a machine that declined private routing off doesn't turn it back on", async (t) => {
  const { a, b, stamp } = await routingOffOnA(t);
  await b.settings.apply(true);
  // B's next window starts from the mirror, which has A's "off", and reads routing on from the file
  const window = await fixture(t, { dir: path.dirname(b.settings.file), mirror: b.mirror });
  assert.equal(window.settings.state.HostAiPrivateRouting, '"true"');
  assert.equal(window.mirror.HostAiPrivateRouting, '"false"');
  assert.deepEqual(window.mirror.__panelwarpSync, stamp);
  await assertOffOnA(a, window);
});

test('a new window keeps private routing on while settings.toml is broken', async (t) => {
  const { a, b, stamp } = await routingOffOnA(t);
  await b.settings.apply(true);
  fs.appendFileSync(b.settings.file, '\n[broken\n');
  const window = await fixture(t, { dir: path.dirname(b.settings.file), mirror: b.mirror });
  assert.equal(window.errors.length, 1);
  assert.equal(window.settings.state.HostAiPrivateRouting, '"true"');
  assert.equal(window.mirror.HostAiPrivateRouting, '"false"');
  assert.deepEqual(window.mirror.__panelwarpSync, stamp);
  await assertOffOnA(a, window);
});

test('a new remote host whose mirror has private routing off from another machine asks once', async (t) => {
  const { a, b, stamp } = await routingOffOnA(t);
  await b.settings.apply(true);
  // A remote window of B's on a new host shares B's mirror and has its own files
  const host = await fixture(t, { mirror: b.mirror });
  assert.equal(fs.existsSync(host.settings.routingAllowedFile), false);
  assert.equal(host.settings.state.HostAiPrivateRouting, '"true"');
  assert.equal(host.settings.routingPending, true);
  await host.settings.apply(true);
  assert.equal(host.confirmations.length, 1);
  assert.equal(TOML.parse(fs.readFileSync(host.settings.file, 'utf8')).host.ai.private_routing, true);
  assert.equal(host.mirror.HostAiPrivateRouting, '"false"');
  assert.deepEqual(host.mirror.__panelwarpSync, stamp);
  await assertOffOnA(a, host);
});

test('a mirror from before settings sync with private routing off keeps it off without asking', async (t) => {
  const f = await fixture(t, { mirror: { HostAiPrivateRouting: '"false"' } });
  assert.equal(fs.existsSync(f.settings.routingAllowedFile), true);
  assert.equal(f.settings.state.HostAiPrivateRouting, '"false"');
  await f.settings.apply(true);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.page.HostAiPrivateRouting, '"false"');
});

test('a machine that turned private routing off can turn it back on everywhere', async (t) => {
  const { a, b } = await routingOffOnA(t);
  b.allowRouting();
  await b.settings.apply(true);
  assert.equal(b.page.HostAiPrivateRouting, '"false"');
  fs.writeFileSync(a.settings.file, '[host.ai]\nprivate_routing = true\n');
  await a.settings.apply(false);
  assert.equal(a.mirror.HostAiPrivateRouting, '"true"');
  b.receiveSync(a.mirror);
  await b.settings.apply(false);
  assert.equal(b.page.HostAiPrivateRouting, '"true"');
});

test("turning private routing back on in one window isn't undone by another window's late mirror", async (t) => {
  const w1 = await fixture(t);
  w1.allowRouting();
  fs.writeFileSync(w1.settings.file, '[host.ai]\nprivate_routing = false\n');
  await w1.settings.apply(true);
  const w2 = await fixture(t, { dir: path.dirname(w1.settings.file), mirror: w1.mirror });
  await w1.settings.save({ HostAiPrivateRouting: '"true"', FontSize: '"16"' });
  // Window 2's watcher runs before window 1's mirror write reaches it
  await w2.settings.apply(false);
  assert.equal(w2.page.HostAiPrivateRouting, '"true"');
  assert.equal(w2.mirror.HostAiPrivateRouting, '"true"');
  assert.equal(w2.mirror.FontSize, '"16"');
});

test("a new machine's files start from the synced mirror without its sync choice", async (t) => {
  const f = await fixture(t, { mirror: otherMachine({ FontSize: '"15"', HostSettingsSync: '"false"' }) });
  assert.equal(fontSize(f), 15);
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host?.settings_sync, undefined);
  assert.equal('__panelwarpSync' in f.settings.state, false);
  // Migrating counts as applying the mirror's change
  await f.settings.apply(false);
  assert.equal(fontSize(f), 15);
});

function encodeNumber(n) {
  return JSON.stringify(JSON.stringify(n));
}

test('a panel default edited inside the header comment applies and moves out of it', async (t) => {
  const f = await fixture(t);
  const text = fs.readFileSync(f.settings.file, 'utf8');
  assert.match(text, /^# history_sync = false$/m);
  fs.writeFileSync(f.settings.file, text.replace(/^# history_sync = false$/m, '# history_sync = true'));
  await f.settings.apply(false);
  assert.equal(f.page.HostHistorySync, '"true"');
  const after = fs.readFileSync(f.settings.file, 'utf8');
  assert.equal(TOML.parse(after).host.history_sync, true);
  // The comment shows the default again
  assert.match(after, /^# history_sync = false$/m);
});

test('a header edit saved with an error elsewhere in the file applies once that is fixed', async (t) => {
  const f = await fixture(t);
  const edited = fs.readFileSync(f.settings.file, 'utf8').replace(/^# history_sync = false$/m, '# history_sync = true');
  fs.writeFileSync(f.settings.file, `${edited}\n[broken`);
  await f.settings.apply(false);
  fs.writeFileSync(f.settings.file, edited);
  await f.settings.apply(false);
  assert.equal(f.page.HostHistorySync, '"true"');
  assert.equal(TOML.parse(fs.readFileSync(f.settings.file, 'utf8')).host.history_sync, true);
});

test('the header comment does not override a setting the file sets', () => {
  const { promoteEditedDefaults, renderToml } = loadSettings({});
  const header = renderToml({});
  assert.equal(promoteEditedDefaults(header, header), null);
  // An unedited header, or an edit to a setting set below it, changes nothing
  const set = header.replace(/^# history_sync = false$/m, '# history_sync = true') + '\n[host]\nhistory_sync = false\n';
  assert.equal(promoteEditedDefaults(set, header), null);
  // A broken comment block is left alone
  assert.equal(promoteEditedDefaults(header.replace('# [host]', '# [host'), header), null);
});

// The header as a version with an older fast model default wrote it
const staleHeader = (text) => text.replace(/^# fast_model = .*$/m, '# fast_model = "old/model"');

test("an older version's defaults in the header are not taken as edits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { renderToml } = loadSettings({});
  fs.writeFileSync(path.join(dir, 'settings.toml'), staleHeader(renderToml({})));
  fs.writeFileSync(path.join(dir, '.settings-migrated'), '');
  const f = await fixture(t, { dir });
  await f.settings.apply(false);
  assert.equal(f.settings.state.HostAiFastModel, undefined);
  assert.match(fs.readFileSync(f.settings.file, 'utf8'), /^# fast_model = "old\/model"$/m);
  // An edit to another line applies alone and the header shows the current defaults again
  const text = fs.readFileSync(f.settings.file, 'utf8');
  fs.writeFileSync(f.settings.file, text.replace(/^# history_sync = false$/m, '# history_sync = true'));
  await f.settings.apply(false);
  assert.equal(f.page.HostHistorySync, '"true"');
  assert.equal(f.settings.state.HostAiFastModel, undefined);
  const after = fs.readFileSync(f.settings.file, 'utf8');
  assert.equal(TOML.parse(after).host.history_sync, true);
  assert.equal(TOML.parse(after).host.ai, undefined);
  assert.match(after, /^# fast_model = "deepseek\/deepseek-v4.1-flash"$/m);
});

test('only header lines changed since the last read count as edits', () => {
  const { promoteEditedDefaults, renderToml } = loadSettings({});
  const stale = staleHeader(renderToml({}));
  assert.equal(promoteEditedDefaults(stale, stale), null);
  const edited = stale.replace(/^# fast_model = .*$/m, '# fast_model = "my/model"');
  const result = promoteEditedDefaults(edited, stale);
  assert.deepEqual(result.promoted, ['host.ai.fast_model']);
  assert.equal(TOML.parse(result.text).host.ai.fast_model, 'my/model');
});
