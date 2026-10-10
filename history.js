// Command history for the Warp panel, persisted like desktop Warp: a SQLite `commands` table with
// desktop's columns (crates/persistence/src/schema.rs), here in the extension's global storage via
// Node's built-in node:sqlite. Warp reports started/finished commands
// (app/src/platform/wasm.rs, host_history) and loads all rows, newest first, at startup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class CommandHistory {
  /** @param {string} storageDir the extension's globalStorageUri.fsPath */
  constructor(storageDir) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(path.join(storageDir, 'warp.sqlite'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER,
        start_ts TEXT,
        completed_ts TEXT,
        pwd TEXT,
        shell TEXT,
        username TEXT,
        hostname TEXT,
        session_id INTEGER,
        git_branch TEXT,
        cloud_workflow_id TEXT,
        workflow_command TEXT,
        is_agent_executed BOOLEAN
      );
      CREATE INDEX IF NOT EXISTS commands_session_start ON commands (session_id, start_ts);
      CREATE INDEX IF NOT EXISTS commands_command ON commands (command);
      CREATE TABLE IF NOT EXISTS shell_history_imports (
        file TEXT PRIMARY KEY NOT NULL,
        last_ts INTEGER,
        entries INTEGER
      );
    `);
    this.lastImportCheck = 0;
    this.insert = this.db.prepare(`
      INSERT INTO commands (command, start_ts, pwd, shell, username, hostname, session_id,
                            git_branch, workflow_command, is_agent_executed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.finish = this.db.prepare(`
      UPDATE commands SET exit_code = ?, completed_ts = ?
      WHERE session_id = ? AND start_ts = ?`);
    this.all = this.db.prepare('SELECT * FROM commands ORDER BY id DESC');
    this.latest = this.db.prepare(
      'SELECT command, exit_code, pwd FROM commands ORDER BY id DESC LIMIT ?',
    );
    this.all.setReadBigInts(true);
  }

  /** Rows for Warp, newest first; session ids as decimal strings (u64 doesn't fit a JS number). */
  load() {
    return this.all.all().map((row) => ({
      id: Number(row.id),
      command: row.command,
      exit_code: row.exit_code == null ? null : Number(row.exit_code),
      start_ts: row.start_ts,
      completed_ts: row.completed_ts,
      pwd: row.pwd,
      shell: row.shell,
      username: row.username,
      hostname: row.hostname,
      session_id: row.session_id == null ? null : BigInt.asUintN(64, row.session_id).toString(),
      git_branch: row.git_branch,
      workflow_command: row.workflow_command,
      is_agent_executed: Boolean(row.is_agent_executed),
    }));
  }

  /** The last `limit` commands, oldest first: `{command, exit_code, pwd}`. */
  recent(limit) {
    // Pick up commands run in other terminals since the last import (at most every 10 s).
    if (Date.now() - this.lastImportCheck > 10_000) this.importShellHistory();
    return this.latest.all(limit).reverse();
  }

  /**
   * History for Next Command, like desktop Warp's "similar history contexts": what the user ran
   * right after earlier runs of `command` (preferring the same directory and the same success or
   * failure), and earlier commands that mention the same file or path names. The newest row is
   * skipped when it's the run that just finished.
   * @returns {{followups: {command: string, count: number}[], total: number, related: string[]}}
   */
  nextCommandContext(command, pwd, exitCode, { maxRuns = 25, maxRelated = 8 } = {}) {
    if (Date.now() - this.lastImportCheck > 10_000) this.importShellHistory();
    const failed = exitCode != null && Number(exitCode) !== 0;
    const runs = this.db
      .prepare(
        `SELECT id, session_id, pwd, exit_code FROM commands WHERE command = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(command, maxRuns + 1);
    // The run that just finished is the newest row; it has no follow-up yet.
    const newest = this.db.prepare('SELECT max(id) AS id FROM commands').get().id;
    if (runs.length && runs[0].id === newest) runs.shift();
    const next = this.db.prepare(
      `SELECT command FROM commands WHERE id > ? AND session_id IS ? ORDER BY id LIMIT 1`,
    );
    const counts = new Map();
    let total = 0;
    for (const run of runs) {
      const sameOutcome = run.exit_code == null || (Number(run.exit_code) !== 0) === failed;
      if (!sameOutcome) continue;
      const following = next.get(run.id, run.session_id)?.command;
      if (!following || following === command || isWarpBootstrap(following)) continue;
      // Runs in the same directory count double.
      const weight = pwd && run.pwd === pwd ? 2 : 1;
      counts.set(following, (counts.get(following) ?? 0) + weight);
      total += weight;
    }
    const followups = [...counts]
      .map(([cmd, count]) => ({ command: cmd, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Path-like words (a slash, a dot or a tilde) name files the user may have used before.
    const words = [...new Set(command.split(/\s+/).slice(1))]
      .filter((w) => !w.startsWith('-') && /[./~]/.test(w) && w.length >= 3 && w.length <= 200)
      .map((w) => w.replace(/^['"]|['"]$/g, '').split('/').filter(Boolean).pop())
      .filter((w) => w && w.length >= 3 && w !== '..');
    const related = [];
    const mentions = this.db.prepare(
      `SELECT DISTINCT command FROM commands WHERE instr(command, ?) > 0 AND command != ?
       ORDER BY id DESC LIMIT ?`,
    );
    for (const word of words.slice(0, 4)) {
      for (const row of mentions.all(word, command, maxRelated)) {
        if (related.length < maxRelated && !related.includes(row.command) && !isWarpBootstrap(row.command)) {
          related.push(row.command);
        }
      }
    }
    return { followups, total, related };
  }

  /**
   * Imports the user's shell history file (zsh, bash or fish) into the table, so it has history from
   * before the panel existed and from other terminals. Incremental: only entries newer than the
   * last import. Entries the panel itself recorded (same command within a few seconds) and Warp's
   * own bootstrap lines are skipped. Returns the number of imported commands.
   */
  importShellHistory(shell = this.shell || process.env.SHELL || '/bin/zsh') {
    this.lastImportCheck = Date.now();
    const name = path.basename(shell);
    const shellName = name.includes('bash') ? 'bash' : name.includes('fish') ? 'fish' : 'zsh';
    const file = {
      bash: () => path.join(os.homedir(), '.bash_history'),
      fish: () =>
        path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'fish', 'fish_history'),
      zsh: () => path.join(process.env.ZDOTDIR || os.homedir(), '.zsh_history'),
    }[shellName]();
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return 0;
    }
    const state = this.db
      .prepare('SELECT last_ts, entries FROM shell_history_imports WHERE file = ?')
      .get(file);
    if (state && this.lastImportedSize === `${file}:${stat.size}:${stat.mtimeMs}`) return 0;
    this.lastImportedSize = `${file}:${stat.size}:${stat.mtimeMs}`;

    const entries = parseShellHistory(fs.readFileSync(file), shellName);
    const lastTs = state?.last_ts ?? -1;
    const fresh = entries.filter((entry, index) =>
      entry.ts != null ? entry.ts > lastTs : !state || index >= (state.entries ?? 0),
    );
    const sameCommand = this.db.prepare('SELECT start_ts FROM commands WHERE command = ?');
    const user = os.userInfo().username;
    const hostname = os.hostname();
    let imported = 0;
    this.db.exec('BEGIN');
    try {
      for (const { ts, command } of fresh) {
        if (!command.trim() || isWarpBootstrap(command)) continue;
        if (ts != null) {
          // The panel's own commands land in the history file too; they're already recorded.
          const recorded = sameCommand
            .all(command)
            .some((row) => Math.abs(Date.parse(row.start_ts) / 1000 - ts) < 10);
          if (recorded) continue;
        }
        this.insert.run(
          command,
          ts != null ? new Date(ts * 1000).toISOString() : null,
          null,
          shellName,
          user,
          hostname,
          null,
          null,
          null,
          0,
        );
        imported++;
      }
      const newestTs = entries.reduce((max, entry) => Math.max(max, entry.ts ?? -1), lastTs);
      this.db
        .prepare(
          `INSERT INTO shell_history_imports (file, last_ts, entries) VALUES (?, ?, ?)
           ON CONFLICT(file) DO UPDATE SET last_ts = excluded.last_ts, entries = excluded.entries`,
        )
        .run(file, newestTs, entries.length);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return imported;
  }

  /**
   * The newest commands for history sync, oldest first, as compact rows. Only commands with a
   * start time (needed to merge without duplicates), and not ones starting with a space (the
   * shells' "keep out of history" convention) or longer than 2000 characters (likely pasted
   * data or secrets). Trimmed further to stay under `maxBytes` of JSON.
   */
  exportForSync(limit = 500, maxBytes = 100_000) {
    const rows = this.db
      .prepare(
        `SELECT command, exit_code, start_ts, completed_ts, pwd, shell, hostname, git_branch
         FROM commands WHERE start_ts IS NOT NULL AND command NOT LIKE ' %'
           AND length(command) <= 2000
         ORDER BY start_ts DESC LIMIT ?`,
      )
      .all(limit)
      .reverse()
      .map((row) => ({
        c: row.command,
        x: row.exit_code == null ? null : Number(row.exit_code),
        s: row.start_ts,
        e: row.completed_ts,
        p: row.pwd,
        sh: row.shell,
        h: row.hostname,
        b: row.git_branch,
      }));
    while (rows.length && JSON.stringify(rows).length > maxBytes) rows.splice(0, Math.ceil(rows.length / 10));
    return rows;
  }

  /** Adds synced rows (from `exportForSync` on any machine) that aren't in the table yet. */
  mergeSynced(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    const exists = this.db.prepare(
      'SELECT 1 FROM commands WHERE command = ? AND start_ts = ? AND hostname IS ? LIMIT 1',
    );
    const insert = this.db.prepare(`
      INSERT INTO commands (command, exit_code, start_ts, completed_ts, pwd, shell, hostname,
                            git_branch, is_agent_executed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    const text = (value) => (typeof value === 'string' ? value : null);
    let merged = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (typeof row?.c !== 'string' || typeof row.s !== 'string') continue;
        if (exists.get(row.c, row.s, text(row.h))) continue;
        insert.run(
          row.c,
          Number.isInteger(row.x) ? row.x : null,
          row.s,
          text(row.e),
          text(row.p),
          text(row.sh),
          text(row.h),
          text(row.b),
        );
        merged++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return merged;
  }

  /** @param {'started' | 'finished'} kind @param {object} data JSON from Warp's host_history */
  record(kind, data) {
    // Warp session ids are u64; SQLite integers are i64, so store the same 64 bits signed.
    const sessionId = data.session_id == null ? null : BigInt.asIntN(64, BigInt(data.session_id));
    if (kind === 'started') {
      this.insert.run(
        String(data.command),
        data.start_ts ?? null,
        data.pwd ?? null,
        data.shell ?? null,
        data.username ?? null,
        data.hostname ?? null,
        sessionId,
        data.git_branch ?? null,
        data.workflow_command ?? null,
        data.is_agent_executed ? 1 : 0,
      );
    } else if (kind === 'finished') {
      this.finish.run(Number(data.exit_code), data.completed_ts, sessionId, data.start_ts);
    }
  }

  close() {
    this.db.close();
  }
}

/** Warp's shell bootstrap / init lines, which older panel builds leaked into history files. */
const isWarpBootstrap = (command) =>
  /^\s*WARP_HONOR_PS1=|WARP_SESSION_ID=|WARP_BOOTSTRAP_VAR|WARP_USING_WINDOWS_CON_PTY/.test(command);

/** zsh stores some bytes "metafied": 0x83 followed by the byte XOR 0x20. */
function unmetafy(buffer) {
  const out = Buffer.alloc(buffer.length);
  let n = 0;
  for (let i = 0; i < buffer.length; i++) {
    out[n++] = buffer[i] === 0x83 && i + 1 < buffer.length ? buffer[++i] ^ 0x20 : buffer[i];
  }
  return out.subarray(0, n);
}

/**
 * Parses a history file into `{ts, command}` entries, oldest first (`ts`: Unix seconds or null).
 * zsh: extended lines are ": <start>:<elapsed>;<command>", and a line ending in a backslash
 * continues on the next line. bash: optional "#<epoch>" lines before each command.
 */
function parseShellHistory(buffer, shellName) {
  const lines = (shellName === 'zsh' ? unmetafy(buffer) : buffer).toString('utf8').split('\n');
  const entries = [];
  if (shellName === 'fish') {
    // YAML-like: "- cmd: <command>" then "  when: <unix time>"; the command escapes \\ and \n.
    for (const line of lines) {
      const cmd = line.match(/^- cmd: (.*)$/);
      if (cmd) entries.push({ ts: null, command: cmd[1].replace(/\\(\\|n)/g, (_, c) => (c === 'n' ? '\n' : '\\')) });
      const when = line.match(/^ {2}when: (\d+)$/);
      if (when && entries.length) entries[entries.length - 1].ts = Number(when[1]);
    }
    return entries;
  }
  if (shellName === 'bash') {
    let ts = null;
    for (const line of lines) {
      const stamp = line.match(/^#(\d{9,})$/);
      if (stamp) ts = Number(stamp[1]);
      else if (line) {
        entries.push({ ts, command: line });
        ts = null;
      }
    }
    return entries;
  }
  let current = null;
  for (const line of lines) {
    if (current?.command.endsWith('\\')) {
      current.command = current.command.slice(0, -1) + '\n' + line;
      continue;
    }
    if (!line) continue;
    const extended = line.match(/^: (\d+):\d+;([\s\S]*)$/);
    current = extended ? { ts: Number(extended[1]), command: extended[2] } : { ts: null, command: line };
    entries.push(current);
  }
  return entries;
}

module.exports = { CommandHistory, parseShellHistory };
