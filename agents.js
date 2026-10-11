// Coding-agent conversations for Warp's Agents panel: recent Claude Code, Codex and Gemini CLI
// sessions from anywhere on this Mac, an AI summary of each (fast model, streamed) and opening
// one (Claude Code in its VS Code editor tab, the others resumed in a new Warp tab).
//
// Everything is read from the agents' own session files; nothing is written to them.

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { providerPreferences } = require('./ai');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const GEMINI_TMP = path.join(HOME, '.gemini', 'tmp');

const MAX_CONVERSATIONS = 100;
// How much of a conversation's end the summary is based on (~4k tokens).
const SUMMARY_CHARS = 16000;
// Session files can be tens of MB; only their ends are read.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
// A Claude conversation opened in another folder's new window is handed off through globalState.
const PENDING_OPEN_KEY = 'warp.pendingClaudeOpen';
const PENDING_OPEN_MAX_AGE = 2 * 60 * 1000;
// When each conversation was last seen (agent:id -> ms), shared by all windows, and when this
// tracking started: turns that finished earlier count as seen.
const SEEN_KEY = 'warp.agentsSeen';
const SEEN_SINCE_KEY = 'warp.agentsSeenSince';

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed JSON lines from the start (`head`) or end of a file; partial lines are dropped. */
function jsonLines(file, size, which) {
  const length = which === 'head' ? HEAD_BYTES : TAIL_BYTES;
  const start = which === 'head' ? 0 : Math.max(0, size - length);
  let lines = readRange(file, start, Math.min(length, size)).split('\n');
  if (which === 'head' && size > length) lines.pop();
  if (which === 'tail' && start > 0) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Visible text of a message's content (a string or content blocks), without tool traffic. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => ['text', 'input_text', 'output_text'].includes(block?.type))
    .map((block) => block.text)
    .join('\n');
}

// Harness-injected messages (command output, environment context, ...) start with a tag.
const isInjected = (text) => /^\s*</.test(text);

const oneLine = (text, max = 120) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Newest files under `dir` matching `test`, as {file, mtimeMs, size}. */
function recentFiles(dir, test, depth) {
  const out = [];
  const walk = (current, level) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) walk(full, level + 1);
      } else if (test(entry.name, full)) {
        try {
          const stat = fs.statSync(full);
          out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CONVERSATIONS);
}

// --- Claude Code: ~/.claude/projects/<cwd slug>/<session id>.jsonl ---------------------------

const claude = {
  files: () => recentFiles(CLAUDE_PROJECTS, (name) => name.endsWith('.jsonl'), 1),

  parse({ file, size }) {
    let cwd = '';
    let firstPrompt = '';
    for (const entry of jsonLines(file, size, 'head')) {
      cwd ||= entry.cwd || '';
      if (!firstPrompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
        const text = contentText(entry.message?.content);
        if (text && !isInjected(text)) firstPrompt = text;
      }
      if (cwd && firstPrompt) break;
    }
    if (!firstPrompt) return null;
    let title = '';
    // When the latest turn ended (Claude writes `turn_duration` then), or 0 while one runs.
    let doneAt = 0;
    for (const entry of jsonLines(file, size, 'tail')) {
      if (entry.type === 'ai-title' && entry.aiTitle) title = entry.aiTitle;
      else if (entry.type === 'summary' && entry.summary && !title) title = entry.summary;
      if (entry.isSidechain) continue;
      if (entry.type === 'system' && entry.subtype === 'turn_duration') {
        doneAt = Date.parse(entry.timestamp) || 0;
      } else if ((entry.type === 'user' && !entry.isMeta) || entry.type === 'assistant') {
        doneAt = 0;
      }
    }
    return { id: path.basename(file, '.jsonl'), title: oneLine(title || firstPrompt), cwd, doneAt };
  },

  /** [{role, text}] of the conversation's end. */
  transcript({ file, size }) {
    const turns = [];
    for (const entry of jsonLines(file, size, 'tail')) {
      if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || entry.isSidechain) continue;
      const text = contentText(entry.message?.content);
      if (text && !isInjected(text)) turns.push({ role: entry.type, text });
    }
    return turns;
  },
};

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl ----------------------------

/** A Codex rollout line's message, for both the `response_item` wrapper and the older bare form. */
function codexMessage(entry) {
  const item = entry.type === 'response_item' ? entry.payload : entry;
  if (item?.type !== 'message') return null;
  const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
  const text = role && contentText(item.content);
  return text && !isInjected(text) ? { role, text } : null;
}

const codex = {
  files: () => recentFiles(CODEX_SESSIONS, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), 3),

  parse({ file, size }) {
    let id = '';
    let cwd = '';
    let firstPrompt = '';
    for (const entry of jsonLines(file, size, 'head')) {
      const meta = entry.type === 'session_meta' ? entry.payload : entry;
      id ||= (entry.type === 'session_meta' || !entry.type ? meta?.id : '') || '';
      cwd ||= meta?.cwd || '';
      const message = codexMessage(entry);
      if (!firstPrompt && message?.role === 'user') firstPrompt = message.text;
      if (id && cwd && firstPrompt) break;
    }
    id ||= path.basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1] || '';
    if (!id || !firstPrompt) return null;
    let doneAt = 0;
    for (const entry of jsonLines(file, size, 'tail')) {
      const event = entry.type === 'event_msg' ? entry.payload?.type : null;
      if (event === 'task_complete') doneAt = Date.parse(entry.timestamp) || 0;
      else if (event === 'task_started' || event === 'user_message') doneAt = 0;
    }
    return { id, title: oneLine(firstPrompt), cwd, doneAt };
  },

  transcript: ({ file, size }) => jsonLines(file, size, 'tail').map(codexMessage).filter(Boolean),
};

// --- Gemini CLI: ~/.gemini/tmp/<sha256 of project root>/chats/session-*.json -----------------

const gemini = {
  files: () =>
    recentFiles(GEMINI_TMP, (name, full) => name.endsWith('.json') && path.basename(path.dirname(full)) === 'chats', 2),

  read({ file }) {
    const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
    const turns = (chat.messages || [])
      .map((m) => ({
        role: m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : null,
        text: contentText(m.content) || (Array.isArray(m.content) ? '' : String(m.content ?? '')),
      }))
      .filter((m) => m.role && m.text && !isInjected(m.text));
    return { chat, turns };
  },

  parse(entry, projectRoots) {
    const { chat, turns } = gemini.read(entry);
    const firstPrompt = turns.find((t) => t.role === 'user')?.text;
    if (!chat.sessionId || !firstPrompt) return null;
    // Gemini only stores a hash of the project root; match it against folders we know.
    const hash = chat.projectHash || path.basename(path.dirname(path.dirname(entry.file)));
    // Gemini writes the file once a reply is complete, so an answered last prompt is a done turn.
    const last = (chat.messages || []).filter((m) => m.type === 'user' || m.type === 'gemini').at(-1);
    const doneAt = last?.type === 'gemini' ? Date.parse(last.timestamp || chat.lastUpdated) || entry.mtimeMs : 0;
    return { id: chat.sessionId, title: oneLine(firstPrompt), cwd: projectRoots.get(hash) || '', doneAt };
  },

  transcript: (entry) => gemini.read(entry).turns,
};

const AGENTS = { claude, codex, gemini };

class AgentConversations {
  /**
   * @param {import('./ai').WarpAi} ai for the OpenRouter key
   * @param {() => object} settings panelSettings.ai()
   */
  constructor(globalState, log, ai, settings) {
    this.globalState = globalState;
    this.log = log;
    this.ai = ai;
    this.settings = settings;
    // Parsed conversations by file + mtime, and summaries by agent:id:mtime.
    this.parsed = new Map();
    this.summaries = new Map();
    // Where each listed conversation's file is, so later requests can't name arbitrary files.
    this.known = new Map();
    this.summaryInFlight = null;
  }

  /** JSON array of {agent, id, title, cwd, updatedAt}, newest first. */
  list() {
    const projectRoots = new Map();
    const addRoot = (dir) => dir && projectRoots.set(crypto.createHash('sha256').update(dir).digest('hex'), dir);
    for (const folder of vscode.workspace.workspaceFolders || []) addRoot(folder.uri.fsPath);

    const conversations = [];
    // Gemini last, so the Claude and Codex folders can resolve its project hashes.
    for (const agent of ['claude', 'codex', 'gemini']) {
      for (const entry of AGENTS[agent].files()) {
        const cacheKey = `${entry.file}\0${entry.mtimeMs}`;
        let parsed = this.parsed.get(cacheKey);
        if (parsed === undefined || (agent === 'gemini' && parsed && !parsed.cwd)) {
          try {
            parsed = AGENTS[agent].parse(entry, projectRoots);
          } catch (error) {
            this.log.appendLine(`agents: skipped ${entry.file}: ${error.message}`);
            parsed = null;
          }
          this.parsed.set(cacheKey, parsed);
        }
        if (!parsed) continue;
        addRoot(parsed.cwd);
        this.known.set(`${agent}:${parsed.id}`, entry);
        conversations.push({ agent, ...parsed, updatedAt: Math.round(entry.mtimeMs) });
      }
    }
    if (this.parsed.size > 2000) this.parsed.clear();
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    const listed = conversations.slice(0, MAX_CONVERSATIONS);
    this.markVisibleClaudeTabsSeen(listed);
    const seen = this.globalState.get(SEEN_KEY) || {};
    const since = this.seenSince();
    return JSON.stringify(
      listed.map(({ doneAt, ...conversation }) => ({
        ...conversation,
        // Its latest turn finished after you last looked at it (here or in its Claude tab).
        unread: doneAt > Math.max(since, seen[`${conversation.agent}:${conversation.id}`] || 0),
      })),
    );
  }

  seenSince() {
    let since = this.globalState.get(SEEN_SINCE_KEY);
    if (!since) {
      since = Date.now();
      this.globalState.update(SEEN_SINCE_KEY, since);
    }
    return since;
  }

  /** Records that a conversation was seen now (clicked in the Agents panel, its tab in front). */
  markSeen(agent, id) {
    const seen = { ...(this.globalState.get(SEEN_KEY) || {}) };
    seen[`${agent}:${id}`] = Date.now();
    // Only conversations that can still be listed.
    const keys = Object.keys(seen);
    if (keys.length > MAX_CONVERSATIONS * 3) {
      for (const key of keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - MAX_CONVERSATIONS * 2)) {
        delete seen[key];
      }
    }
    this.globalState.update(SEEN_KEY, seen);
  }

  /**
   * A Claude Code conversation shown in front in a Claude editor tab of this focused window is
   * seen. The tab is matched by its title, the only thing VS Code tells us about another
   * extension's webview.
   */
  markVisibleClaudeTabsSeen(conversations) {
    if (!vscode.window.state.focused) return;
    const labels = vscode.window.tabGroups.all
      .map((group) => group.activeTab)
      .filter((tab) => tab?.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType))
      .map((tab) => normalizeTitle(tab.label))
      .filter(Boolean);
    if (!labels.length) return;
    for (const conversation of conversations) {
      if (conversation.agent !== 'claude' || !conversation.doneAt) continue;
      const title = normalizeTitle(conversation.title);
      if (labels.some((label) => title.startsWith(label) || label.startsWith(title))) {
        const seen = this.globalState.get(SEEN_KEY) || {};
        if ((seen[`claude:${conversation.id}`] || 0) < conversation.doneAt) this.markSeen('claude', conversation.id);
      }
    }
  }

  entry(agent, id) {
    if (!this.known.has(`${agent}:${id}`)) this.list();
    const entry = this.known.get(`${agent}:${id}`);
    if (!entry) throw new Error('unknown conversation');
    try {
      const stat = fs.statSync(entry.file);
      return { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      throw new Error('conversation no longer exists');
    }
  }

  /**
   * Streams a summary of the conversation's last ~4k tokens from the fast model, calling
   * `onText` with the summary so far. Only one runs at a time: a new one cancels the last.
   */
  async summarize(agent, id, onText) {
    const entry = this.entry(agent, id);
    const cacheKey = `${agent}:${id}:${entry.mtimeMs}`;
    const cached = this.summaries.get(cacheKey);
    if (cached) return onText(cached);

    const config = this.settings();
    // Transcripts can contain secrets, like recent commands: never sent to hosts that keep them.
    if (!config.privateRouting) throw new Error('Summaries need private routing (Settings › AI provider)');
    let transcript = '';
    for (const turn of AGENTS[agent].transcript(entry).reverse()) {
      const line = `${turn.role === 'user' ? 'User' : 'Agent'}: ${turn.text.trim()}\n\n`;
      if (transcript.length + line.length > SUMMARY_CHARS) {
        if (!transcript) transcript = `…${line.slice(-SUMMARY_CHARS)}`;
        break;
      }
      transcript = line + transcript;
    }
    if (!transcript) throw new Error('No messages to summarize');

    const apiKey = await this.ai.apiKey().catch(() => {
      throw new Error('Needs an OpenRouter API key');
    });
    this.summaryInFlight?.abort();
    const controller = new AbortController();
    this.summaryInFlight = controller;
    const started = Date.now();
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.fastModel,
          max_tokens: 300,
          stream: true,
          reasoning: { enabled: false },
          provider: providerPreferences(config.privateRouting, config.fastPriority),
          messages: [
            {
              role: 'system',
              content:
                'You summarize the end of a conversation between a developer and a coding agent ' +
                '(the transcript may start mid-conversation). Write at most 2 short sentences on ' +
                'what they are working on, then 2-4 bullet points, each on its own line starting ' +
                'with "- ", on where it stands and what is left or blocked. Keep each bullet under ' +
                '12 words. No preamble, no headings, no other markdown.',
            },
            { role: 'user', content: transcript },
          ],
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${response.status}`);
      }
      let text = '';
      let buffered = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.error) throw new Error(event.error.message || 'provider error');
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) onText((text += delta));
        }
      }
      text = text.trim();
      if (!text) throw new Error('Empty summary');
      this.summaries.set(cacheKey, text);
      if (this.summaries.size > 200) this.summaries.delete(this.summaries.keys().next().value);
      this.log.appendLine(`agents: summary via ${config.fastModel} in ${Date.now() - started} ms`);
      onText(text);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('cancelled');
      throw error;
    } finally {
      if (this.summaryInFlight === controller) this.summaryInFlight = null;
    }
  }

  /**
   * Opens a conversation. Claude Code ones open in its VS Code editor tab (in a new window for
   * another folder) and this returns undefined; Codex and Gemini ones return the shell command
   * that resumes them, for Warp to run in a new tab.
   */
  async open(agent, id) {
    const entry = this.entry(agent, id);
    this.markSeen(agent, id);
    const parsed = this.parsed.get(`${entry.file}\0${entry.mtimeMs}`) || AGENTS[agent].parse(entry, new Map());
    const cwd = parsed?.cwd || '';
    const cd = cwd && fs.existsSync(cwd) ? `cd ${shellQuote(cwd)} && ` : '';
    if (agent === 'codex') return `${cd}codex resume ${shellQuote(id)}`;
    if (agent === 'gemini') return `${cd}gemini --resume ${shellQuote(id)}`;

    if (!vscode.extensions.getExtension('anthropic.claude-code')) {
      return `${cd}claude --resume ${shellQuote(id)}`;
    }
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!cwd || folders.includes(cwd)) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', id);
      return undefined;
    }
    if (!fs.existsSync(cwd)) throw new Error(`folder no longer exists: ${cwd}`);
    // Claude Code resumes conversations of the window's folder, so open that folder; the new
    // window's instance of this extension finishes the job (openPendingClaudeConversation).
    await this.globalState.update(PENDING_OPEN_KEY, { folder: cwd, id, at: Date.now() });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), {
      forceNewWindow: folders.length > 0,
    });
    return undefined;
  }
}

/** On activation: opens a Claude conversation another window handed to this window's folder. */
async function openPendingClaudeConversation(globalState, log) {
  const pending = globalState.get(PENDING_OPEN_KEY);
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_OPEN_MAX_AGE) {
    await globalState.update(PENDING_OPEN_KEY, undefined);
    return;
  }
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  if (!folders.includes(pending.folder)) return;
  await globalState.update(PENDING_OPEN_KEY, undefined);
  try {
    await vscode.extensions.getExtension('anthropic.claude-code')?.activate();
    await vscode.commands.executeCommand('claude-vscode.editor.open', pending.id);
  } catch (error) {
    log.appendLine(`agents: could not open Claude conversation: ${error.message}`);
  }
}

/** A title for matching tab labels: one line, no ellipsis, at least a few characters. */
function normalizeTitle(text) {
  const title = String(text || '').replace(/\s+/g, ' ').replace(/(…|\.\.\.)$/, '').trim().toLowerCase();
  return title.length >= 4 ? title : '';
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

module.exports = { AgentConversations, openPendingClaudeConversation };
