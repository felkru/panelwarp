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
