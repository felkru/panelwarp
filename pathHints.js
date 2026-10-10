// Facts about the paths in a failed command, for Next Command: which ones exist, which part of a
// missing path is missing, and where a missing file with the same name is, from a few likely
// directories. Lets the model tell "create the directory" from "use the right path" without
// guessing. Only reads directory listings and stats; bounded to a handful of directories.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_PATHS = 3;
const MAX_FOUND = 3;

/** Directories searched (non-recursively) for a missing file's name, besides the working one. */
const searchDirs = (home) =>
  ['.ssh', '', 'Downloads', 'Desktop', 'Documents', '.config'].map((dir) => path.join(home, dir));

const kind = (file) => {
  try {
    return fs.statSync(file).isDirectory() ? 'directory' : 'file';
  } catch {
    return null;
  }
};

/** `~` for the home directory, so paths read like the user's own commands. */
const tilde = (file, home) => (file === home || file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file);

/** Path-like arguments: contain a slash or a dot, or start with ~; not flags or URLs. */
function pathArgs(command) {
  return [...new Set(command.split(/\s+/).slice(1))]
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter((word) => word && !word.startsWith('-') && !/^[a-z]+:\/\//i.test(word) && !/[*?$`|;&<>(){}=]/.test(word))
    .filter((word) => /[/.]/.test(word) || word.startsWith('~'))
    .slice(0, MAX_PATHS);
}

/**
 * @param {string} command the failed command
 * @param {string | undefined} pwd its working directory
 * @returns {string[]} one line per path argument
 */
function pathHints(command, pwd, home = os.homedir()) {
  if (!pwd || !path.isAbsolute(pwd)) return [];
  const lines = [];
  for (const arg of pathArgs(command)) {
    const file = path.resolve(pwd, arg.replace(/^~(?=$|\/)/, home));
    const found = kind(file);
    if (found) {
      lines.push(`${arg}: exists (${found})`);
      continue;
    }
    // The deepest existing ancestor tells which part is missing.
    let ancestor = path.dirname(file);
    while (!kind(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
    const missingDir = ancestor !== path.dirname(file);
    let line = missingDir
      ? `${arg}: doesn't exist; ${tilde(path.dirname(file), home)} doesn't exist either (the deepest existing directory is ${tilde(ancestor, home)})`
      : `${arg}: doesn't exist; its directory ${tilde(path.dirname(file), home)} exists`;
    const name = path.basename(file);
    // A missing directory is the problem itself; a same-named file elsewhere is only a hint for a
    // file in the wrong place.
    if (!missingDir && name.length >= 3) {
      const elsewhere = [];
      for (const dir of [pwd, ...searchDirs(home)]) {
        const candidate = path.join(dir, name);
        if (candidate !== file && kind(candidate) && !elsewhere.includes(candidate)) elsewhere.push(candidate);
        if (elsewhere.length >= MAX_FOUND) break;
      }
      if (elsewhere.length) line += `; a ${name} exists at ${elsewhere.map((f) => tilde(f, home)).join(', ')}`;
      else line += `; no ${name} in the working directory, ~, ~/.ssh, ~/Downloads, ~/Desktop, ~/Documents or ~/.config`;
    }
    lines.push(line);
  }
  return lines;
}

module.exports = { pathHints };
