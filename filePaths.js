// File paths in terminal output, for Warp's clickable file links: Warp sends the possible paths
// under the mouse, this resolves which exist (stat only), and opens or reveals the one clicked.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CANDIDATES = 512;
const MAX_PATH_LENGTH = 4096;

/** `~` and `~/x` to the home directory; relative paths against `cwd`. */
function absolutePath(candidate, cwd, home = os.homedir()) {
  const expanded = candidate.replace(/^~(?=$|\/)/, home);
  return path.resolve(cwd, expanded);
}

/**
 * @param {string} cwd the directory relative paths are relative to
 * @param {string[]} candidates paths in the order Warp prefers them
 * @returns {Promise<({absolutePath: string, isDir: boolean} | null)[]>} one entry per candidate
 */
async function resolvePaths(cwd, candidates, home = os.homedir()) {
  if (!Array.isArray(candidates)) return [];
  const usable = typeof cwd === 'string' && path.isAbsolute(cwd);
  return Promise.all(
    candidates.map(async (candidate, index) => {
      if (!usable || index >= MAX_CANDIDATES) return null;
      if (typeof candidate !== 'string' || !candidate || candidate.length > MAX_PATH_LENGTH) return null;
      const file = absolutePath(candidate, cwd, home);
      try {
        const stat = await fs.promises.stat(file);
        return { absolutePath: file, isDir: stat.isDirectory() };
      } catch {
        return null;
      }
    }),
  );
}

/** Opens a file in an editor at `line`/`column` (1-based); a directory is revealed instead. */
async function openFile(vscode, file, line, column) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    vscode.window.showWarningMessage(`Warp: ${file} no longer exists.`);
    return;
  }
  if (stat.isDirectory()) return revealFile(vscode, file);
  const uri = vscode.Uri.file(file);
  const options = { preview: false };
  if (Number.isInteger(line) && line > 0) {
    const col = Number.isInteger(column) && column > 0 ? column - 1 : 0;
    const position = new vscode.Position(line - 1, col);
    options.selection = new vscode.Range(position, position);
  }
  // `vscode.open` also handles images, PDFs and other non-text files.
  await vscode.commands.executeCommand('vscode.open', uri, options);
}

/** Shows a file or directory in VS Code's Explorer, or in Finder when it's outside the workspace. */
async function revealFile(vscode, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  const uri = vscode.Uri.file(file);
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  } else {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

module.exports = { resolvePaths, openFile, revealFile, absolutePath };
