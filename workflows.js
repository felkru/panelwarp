// Local workflow files for Warp's Ctrl+R and workflows menu, like desktop Warp's: YAML files in
// ~/.warp/workflows and in the workspace's .warp/workflows. The web build has no file system, so
// the extension reads them and Warp parses them (app/src/platform/wasm.rs, host_workflows).

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 4;

/** `{name, text}` for every .yaml / .yml file under `dir` (recursively), sorted by path. */
function readWorkflowDir(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < MAX_DEPTH) {
      files.push(...readWorkflowDir(file, depth + 1));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        files.push({ name: file, text: fs.readFileSync(file, 'utf8') });
      } catch {
        // Unreadable file: skip it.
      }
    }
  }
  return files;
}

/** @param {string[]} workspaceFolders paths whose .warp/workflows are read too */
function readWorkflowFiles(workspaceFolders = []) {
  const dirs = [path.join(os.homedir(), '.warp', 'workflows')];
  for (const folder of workspaceFolders) dirs.push(path.join(folder, '.warp', 'workflows'));
  return [...new Set(dirs)].flatMap((dir) => readWorkflowDir(dir));
}

module.exports = { readWorkflowFiles };
