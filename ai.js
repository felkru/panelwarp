// Bring-your-own-key AI for the Warp panel, via OpenRouter, or a local OpenAI-compatible server
// such as LM Studio (`host.ai.local_model`), which keeps terminal context on this machine.
// Requests come from Warp via the host page; the API key lives only in VS Code's SecretStorage
// and is used only here in the extension host.
//
// AI Command Search (`#`) runs in two stages (Warp registers one result source per stage):
//   - fast: a low-latency model (default DeepSeek v4.1 Flash) returns 1-2 commands right away.
//   - expanded: once typing pauses longer, a stronger model (default Sonnet 5.5) is shown the fast
//     stage's commands and adds different alternatives, so nothing is listed twice.

const vscode = require('vscode');
const { pathHints } = require('./pathHints');

const API_KEY_SECRET = 'warp.openRouterApiKey';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Built on first use: loading zod takes ~40 ms, which would otherwise delay activation.
let commandsSchema;
const CommandsSchema = () => (commandsSchema ??= buildCommandsSchema());
const buildCommandsSchema = () => {
  const { z } = require('zod');
  return z.object({
    commands: z.array(
      z.object({
        command: z.string(),
        description: z.string(),
        parameters: z.array(z.object({ id: z.string(), description: z.string() })),
      }),
    ),
  });
};

// The same shape as JSON Schema, for OpenRouter's strict structured outputs.
const COMMANDS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commands'],
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'description', 'parameters'],
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          parameters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'description'],
              properties: { id: { type: 'string' }, description: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const commandSearchSystem = (maxCommands) => `You turn a natural-language request into shell commands for the user's terminal.

Return up to ${maxCommands} alternative commands, most likely first. Prefer the simplest command that fully does what was asked, written for the user's OS and shell. Each "description" is shown as the result's title: a short phrase (at most 8 words, sentence case, no trailing period), e.g. "Set your global git username and email".

When the request asks for several things that can be done together, make the first command do all of them at once (e.g. chained with &&), with a placeholder for each value; single-step alternatives may follow.

When the command needs a value only the user knows (a name, email, path, branch, host, ...), write it as a {{snake_case_id}} placeholder in the command and list it in "parameters" with the same id and a short description. Don't invent such values.

If the request can't be done with a shell command, return an empty "commands" list.`;

const NEXT_COMMAND_SYSTEM = `You predict the next shell command the user will run in their terminal, shown as an inline suggestion they accept with Tab. You see the session's recent commands with their output, the command that just finished, and related commands from the user's history.

- If the last command failed, suggest the command that fixes the problem or gets done what the user was trying to do: e.g. create the missing directory (mkdir -p), use the right path, install the missing package, set the upstream branch, add the missing permission, correct the typo. Prefer a fix over a command that only looks around (ls, cat, status). For a missing file or directory: when the user's history shows it under another path, use that path; when it's something the user would write themselves (a config file, notes, a new directory), create it, with mkdir -p for a missing directory; only for a file that must already exist with content (a key, a download, a data file or a build output) and isn't in the history, look for it (list the likely directory).
- If it succeeded, suggest the natural next step in what the user is doing: e.g. create the file in a directory just made, look at what was just created or changed, commit what was just staged, run what was just built.
- Prefer commands and paths from the user's history when they fit: if the user ran the same command before, what they ran right after it is a strong hint; a file the user referred to before by its full path is probably still there.
- Use only file names, hosts and values that appear in the context or follow directly from it; never make up new ones.
- Keep it to one short command on a single line (no heredocs or multi-line scripts; to create an empty file use touch), written for the user's OS and shell. If the user has started typing, the command must start with exactly what they typed.
- Don't repeat a suggestion the user rejected. Return an empty string only when there's no sensible next command.

Return the command in "command".`;

const NEXT_COMMAND_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: { command: { type: 'string' } },
};

/** Characters of the last command's output sent along (its end, where results usually are). */
const NEXT_COMMAND_OUTPUT_CHARS = 4000;

/** Output kept per earlier command in the next-command prompt. */
const NEXT_COMMAND_EARLIER_OUTPUT_CHARS = 600;

/** Warp's own shell bootstrap and init lines, which show up as blocks in its context. */
const isWarpInternal = (command) =>
  /WARP_HONOR_PS1=|WARP_SESSION_ID=|WARP_BOOTSTRAP_VAR|WARP_USING_WINDOWS_CON_PTY/.test(command);

const truncateEnd = (text, max) => (text.length > max ? '...' + text.slice(-max) : text);

/**
 * Warp's next-command request (GenerateAIInputSuggestionsRequest) as a prompt, plus the host's
 * command history (`history`: from CommandHistory.nextCommandContext).
 */
function nextCommandMessage(request, history) {
  const parts = [];
  if (request.system_context) parts.push(`System: ${request.system_context}`);
  const block = request.block_context;
  // context_messages are JSON blocks ({input, output, context}); the last one is block_context.
  const earlier = [];
  for (const raw of request.context_messages || []) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    const input = String(entry.input || '').trim();
    if (!input || isWarpInternal(input)) continue;
    earlier.push(entry);
  }
  const last = earlier.at(-1);
  if (block && last && String(last.input).trim() === String(block.command).trim()) earlier.pop();
  if (earlier.length) {
    parts.push(
      'Earlier commands in this session, oldest first:\n' +
        earlier
          .slice(-8)
          .map((entry) => {
            const ctx = entry.context || {};
            const output = truncateEnd(String(entry.output || '').trim(), NEXT_COMMAND_EARLIER_OUTPUT_CHARS);
            return (
              `$ ${String(entry.input).trim()}  (exit ${ctx.exit_code ?? '?'}${ctx.pwd ? `, in ${ctx.pwd}` : ''})` +
              (output ? `\n${output}` : '')
            );
          })
          .join('\n'),
    );
  }
  if (history?.followups?.length) {
    parts.push(
      'What the user ran right after this same command before (most frequent first):\n' +
        history.followups.map((f) => `- ${f.command}  (${f.count}x)`).join('\n'),
    );
  }
  if (history?.related?.length) {
    parts.push(
      'Earlier commands from the user\'s history that mention the same files, newest first:\n' +
        history.related.map((c) => `- ${c}`).join('\n'),
    );
  }
  if (history?.paths?.length) {
    parts.push('Paths in the command that just finished (checked on disk):\n' + history.paths.map((p) => `- ${p}`).join('\n'));
  }
  if (request.history_context) parts.push(`Related command history:\n${request.history_context}`);
  if (block) {
    const output = truncateEnd(String(block.output || ''), NEXT_COMMAND_OUTPUT_CHARS);
    const where = [block.pwd && `in ${block.pwd}`, block.git_branch && `on git branch ${block.git_branch}`]
      .filter(Boolean)
      .join(' ');
    const status = Number(block.exit_code) === 0 ? 'succeeded' : `FAILED with exit code ${block.exit_code}`;
    parts.push(`The command that just finished${where ? ` (${where})` : ''} ${status}:\n$ ${block.command}\nOutput:\n${output}`);
  }
  const rejected = request.rejected_suggestions || [];
  if (rejected.length) parts.push('Suggestions the user didn\'t take:\n' + rejected.map((c) => `- ${c}`).join('\n'));
  parts.push(request.prefix ? `The user has typed: ${request.prefix}` : 'The input is empty.');
  return parts.join('\n\n');
}

const PROMPT_SUGGESTION_SYSTEM = `You watch a developer's terminal. After a command finishes, decide whether a CLI coding agent (like Claude Code), started in the same directory, could clearly help with a concrete next task: usually fixing a failed build, test, compile, install or config step, or an obvious next step in a code project.

If so, return in "prompt" what the user would ask the agent: imperative, one or two sentences, under 200 characters, self-contained (name the command and the key error, since the agent can't see the terminal). Otherwise return an empty string.

Return an empty string for routine successful commands (ls, cd, git status, ...), typos and "command not found" (the terminal suggests corrections), commands the user interrupted (exit 130), errors that only need a retry, and anything unrelated to code or system setup. When unsure, return an empty string.`;

const PROMPT_SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: { prompt: { type: 'string' } },
};

/** Longest prompt passed on to the CLI agent. */
const PROMPT_SUGGESTION_MAX_CHARS = 300;

/** Warp's prompt suggestion request (GenerateAMQuerySuggestionsRequest) as a prompt. */
function promptSuggestionMessage(request) {
  const parts = [];
  if (request.system_context) parts.push(`System: ${request.system_context}`);
  for (const raw of request.context_messages || []) {
    let block;
    try {
      block = JSON.parse(raw);
    } catch {
      parts.push(String(raw));
      continue;
    }
    let output = String(block.output || '');
    if (output.length > NEXT_COMMAND_OUTPUT_CHARS) output = '...' + output.slice(-NEXT_COMMAND_OUTPUT_CHARS);
    const exitCode = request.exit_code ?? block.exit_code;
    parts.push(
      `Command${block.pwd ? ` (in ${block.pwd})` : ''}: ${block.command}\nExit code: ${exitCode}\nOutput:\n${output}`,
    );
  }
  return parts.join('\n\n');
}

const FAST_MAX_COMMANDS = 2;
const EXPANDED_MAX_COMMANDS = 3;

/** Error codes understood by Warp's host bridge (app/src/platform/wasm.rs). */
class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Commands compare equal regardless of spacing and placeholder names. */
const commandKey = (command) =>
  command.replace(/\{\{[^}]*\}\}/g, '{{}}').replace(/\s+/g, ' ').trim();

function userMessage(prompt, contextJson, recent, alreadyShown) {
  let message = contextJson ? `Terminal context: ${contextJson}\n\n` : '';
  if (recent?.length) {
    message +=
      'Recently run commands, oldest first (for context only; the request may be unrelated):\n' +
      recent
        .map((c) => `- ${c.command}` + (c.exit_code == null ? '' : ` (exit ${c.exit_code})`) + (c.pwd ? ` in ${c.pwd}` : ''))
        .join('\n') +
      '\n\n';
  }
  message += `Request: ${prompt}`;
  if (alreadyShown?.length) {
    message +=
      '\n\nThese commands are already shown to the user. Suggest different alternatives only ' +
      '(return an empty list if there are no good ones):\n' +
      alreadyShown.map((c) => `- ${c.command}`).join('\n');
  }
  return message;
}

const PRIORITIES = ['latency', 'price', 'throughput'];

/**
 * OpenRouter's `provider` preferences: which hosts are tried first (`priority` is the
 * `host.ai.*_priority` setting; "balanced" leaves OpenRouter's default load balancing), and with
 * private routing only hosts that neither train on nor retain requests.
 */
function providerPreferences(privateRouting, priority) {
  return {
    ...(PRIORITIES.includes(priority) ? { sort: priority } : {}),
    ...(privateRouting ? { data_collection: 'deny', zdr: true } : {}),
  };
}

/**
 * One chat completion with structured output, from OpenRouter or the local server
 * (`localServer` set: no key, and no OpenRouter-only `reasoning` / `provider` fields).
 * Resolves to the parsed JSON object and the host that served it.
 */
async function chatJson({ apiKey, localServer, model, maxTokens, temperature, reasoning, privateRouting, priority, schemaName, schema, system, user, signal }) {
  const url = localServer ? `${localServer.replace(/\/+$/, '')}/chat/completions` : OPENROUTER_URL;
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      ...(localServer ? {} : { Authorization: `Bearer ${apiKey}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(temperature == null ? {} : { temperature }),
      ...(localServer ? {} : { reasoning, provider: providerPreferences(privateRouting, priority) }),
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.local = Boolean(localServer);
    throw error;
  }
  const message = body.choices?.[0]?.message || {};
  // LM Studio's reasoning parser can put a reasoning model's structured answer (e.g. Qwen's) in
  // `reasoning_content`, leaving `content` empty.
  const content = message.content || (localServer ? message.reasoning_content || message.reasoning : '');
  let json;
  try {
    json = JSON.parse(content || '{}');
  } catch {
    throw new HostError('provider_error', 'malformed response');
  }
  return { json, host: localServer ? 'local server' : body.provider };
}

/**
 * One AI Command Search request. Resolves to the parsed commands array.
 * @param {{apiKey: string, localServer?: string, model: string, maxCommands: number,
 *          reasoning: object, privateRouting: boolean, priority: string, prompt: string,
 *          contextJson: string | null, recent?: object[], alreadyShown?: object[],
 *          signal?: AbortSignal}} request
 */
async function requestCommands({ maxCommands, prompt, contextJson, recent, alreadyShown, ...request }) {
  const { json, host } = await chatJson({
    ...request,
    maxTokens: 4096,
    schemaName: 'commands',
    schema: COMMANDS_JSON_SCHEMA,
    system: commandSearchSystem(maxCommands),
    user: userMessage(prompt, contextJson, recent, alreadyShown),
  });
  const parsed = CommandsSchema().safeParse(json);
  if (!parsed.success) throw new HostError('provider_error', 'malformed response');
  return { commands: parsed.data.commands.slice(0, maxCommands), host };
}

const BENCHMARK_PROMPTS = [
  'set git name and email',
  'find files larger than 100MB in this directory',
  'kill the process listening on port 3000',
  'show disk usage of each folder here sorted by size',
  'undo the last git commit but keep the changes',
];

class WarpAi {
  /**
   * @param {() => {fastModel: string, expandedModel: string, expandedEffort: string,
   *                 fastPriority: string, expandedPriority: string,
   *                 privateRouting: boolean, recentCommands: number}} settings from Warp's
   *   settings (panelSettings.js); recentCommands is already 0 unless private routing is on
   * @param {(limit: number) => object[]} recentCommands the user's last commands, oldest first
   * @param {(command: string, pwd: string, exitCode: number) => object} nextCommandHistory
   *   history for Next Command (CommandHistory.nextCommandContext)
   */
  constructor(secrets, log, settings, recentCommands = () => [], nextCommandHistory = () => null) {
    this.secrets = secrets;
    this.log = log;
    this.settings = settings;
    this.recentCommands = recentCommands;
    this.nextCommandHistory = nextCommandHistory;
    // Fast-stage results by query, so the expanded stage for the same query can reuse them.
    this.fastResults = new Map();
    this.expandedInFlight = null;
    this.lastKeyWarning = 0;
    this.lastLocalWarning = 0;
  }

  /** Stores a key entered in Warp's "AI provider" settings row. */
  async storeApiKey(provider, key) {
    if (provider !== 'openrouter' || !key.trim()) return;
    await this.secrets.store(API_KEY_SECRET, key.trim());
    vscode.window.showInformationMessage('Warp: OpenRouter API key saved in VS Code secret storage.');
  }

  /** The OpenRouter key; none is needed (null) with a local model. */
  async apiKey(config = this.settings()) {
    if (config.localModel) return null;
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (apiKey) return apiKey;
    // Warp queries on nearly every keystroke; don't stack up warnings.
    if (Date.now() - this.lastKeyWarning > 30_000) {
      this.lastKeyWarning = Date.now();
      vscode.window
        .showWarningMessage('Warp AI needs an OpenRouter API key.', 'Set API Key')
        .then((choice) => choice && vscode.commands.executeCommand('warp.setOpenRouterApiKey'));
    }
    throw new HostError('provider_error', 'no API key');
  }

  /** Starts (or reuses) the fast stage for a query. */
  fastStage(apiKey, config, prompt, contextJson, recent) {
    const cacheKey = `${prompt}\0${contextJson}\0${JSON.stringify(recent)}`;
    let result = this.fastResults.get(cacheKey);
    if (!result) {
      const started = Date.now();
      // A local model is the only stage, so it returns the expanded stage's number of commands.
      result = requestCommands({
        apiKey,
        localServer: config.localModel ? config.localServer : undefined,
        model: config.localModel || config.fastModel,
        maxCommands: config.localModel ? EXPANDED_MAX_COMMANDS : FAST_MAX_COMMANDS,
        reasoning: { enabled: false },
        privateRouting: config.privateRouting,
        priority: config.fastPriority,
        prompt,
        contextJson,
        recent,
      }).then(({ commands, host }) => {
        this.log.appendLine(`# fast: ${config.localModel || config.fastModel} via ${host} in ${Date.now() - started} ms`);
        return commands;
      });
      this.fastResults.set(cacheKey, result);
      if (this.fastResults.size > 20) this.fastResults.delete(this.fastResults.keys().next().value);
      result.catch(() => this.fastResults.delete(cacheKey));
    }
    return result;
  }

  /**
   * AI Command Search (`#`): natural language to commands. Returns a JSON array of
   * `{command, description, parameters: [{id, description}]}` for Warp.
   * @param {string} prompt
   * @param {string | null} contextJson Warp's WarpAiExecutionContext (os, shell_name, shell_version)
   * @param {'fast' | 'expanded'} stage
   */
  async generateCommands(prompt, contextJson, stage = 'fast') {
    const config = this.settings();
    const apiKey = await this.apiKey(config);
    const recent = config.recentCommands ? this.recent(config.recentCommands) : [];
    try {
      if (stage !== 'expanded') {
        const commands = await this.fastStage(apiKey, config, prompt, contextJson, recent);
        // With an expanded stage still to come, an empty fast answer isn't final.
        if (commands.length === 0 && (!config.expandedModel || config.localModel)) {
          throw new HostError('bad_prompt', 'no command');
        }
        return JSON.stringify(commands);
      }

      if (!config.expandedModel || config.localModel) return '[]';
      // Warp sends a new query as the user keeps typing; drop the one it superseded.
      this.expandedInFlight?.abort();
      const abort = new AbortController();
      this.expandedInFlight = abort;
      const alreadyShown = await this.fastStage(apiKey, config, prompt, contextJson, recent).catch(() => []);
      if (abort.signal.aborted) throw new HostError('other', 'superseded');
      const started = Date.now();
      try {
        const { commands, host } = await requestCommands({
          apiKey,
          model: config.expandedModel,
          maxCommands: EXPANDED_MAX_COMMANDS,
          reasoning: { effort: config.expandedEffort },
          privateRouting: config.privateRouting,
          priority: config.expandedPriority,
          prompt,
          contextJson,
          recent,
          alreadyShown,
          signal: abort.signal,
        });
        this.log.appendLine(`# expanded: ${config.expandedModel} via ${host} in ${Date.now() - started} ms`);
        const shown = new Set(alreadyShown.map((c) => commandKey(c.command)));
        return JSON.stringify(commands.filter((c) => !shown.has(commandKey(c.command))));
      } finally {
        if (this.expandedInFlight === abort) this.expandedInFlight = null;
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new HostError('other', 'superseded');
      throw this.toHostError(error);
    }
  }

  /**
   * Next Command: predicts the command to run next from Warp's request JSON (a fix after a failed
   * command). Resolves to the command, or null when there's none (or no key is set, or the last
   * command succeeded and the feature is off).
   */
  async nextCommand(requestJson) {
    const config = this.settings();
    if (!config.privateRouting) return null;
    const request = JSON.parse(requestJson);
    const block = request.block_context;
    // After a failed command there's always a suggested fix; after other commands only with
    // `host.ai.next_command` on.
    const failed = block != null && Number(block.exit_code) !== 0;
    if (!config.nextCommand && !(failed && !request.prefix)) return null;
    const apiKey = config.localModel ? null : await this.secrets.get(API_KEY_SECRET);
    if (!apiKey && !config.localModel) return null;
    const started = Date.now();
    let history = null;
    try {
      if (block?.command) history = this.nextCommandHistory(block.command, block.pwd, block.exit_code);
    } catch (error) {
      this.log.appendLine(`next command history unavailable: ${error.message}`);
    }
    if (failed && block.command) {
      try {
        history = { ...history, paths: pathHints(block.command, block.pwd) };
      } catch (error) {
        this.log.appendLine(`next command path check failed: ${error.message}`);
      }
    }
    // Like desktop Warp: when history clearly says what comes next, skip the model.
    const top = history?.followups?.[0];
    if (
      top &&
      history.total >= 3 &&
      top.count / history.total >= 0.5 &&
      (!request.prefix || top.command.startsWith(request.prefix))
    ) {
      this.log.appendLine(`next command: from history (${top.count}/${history.total}): ${JSON.stringify(top.command)}`);
      return top.command;
    }
    try {
      const { json, host } = await chatJson({
        ...this.fastRequest(config, apiKey),
        maxTokens: 512,
        temperature: 0,
        schemaName: 'next_command',
        schema: NEXT_COMMAND_JSON_SCHEMA,
        system: NEXT_COMMAND_SYSTEM,
        user: nextCommandMessage(request, history),
      });
      let command = String(json.command || '').trim();
      // A single line only, and it has to continue what the user typed.
      if (command.includes('\n') || (request.prefix && !command.startsWith(request.prefix))) command = '';
      this.log.appendLine(
        `next command: ${config.localModel || config.fastModel} via ${host} in ${Date.now() - started} ms: ` +
          (command ? JSON.stringify(command) : 'no suggestion'),
      );
      return command || null;
    } catch (error) {
      throw this.toHostError(error);
    }
  }

  /**
   * Prompt Suggestions: after a command, a prompt for a CLI coding agent, from Warp's request
   * JSON. Resolves to the prompt, or null when there's none (or the feature is off or no key is set).
   */
  async promptSuggestion(requestJson) {
    const config = this.settings();
    if (!config.promptSuggestions || !config.privateRouting) return null;
    const apiKey = config.localModel ? null : await this.secrets.get(API_KEY_SECRET);
    if (!apiKey && !config.localModel) return null;
    const request = JSON.parse(requestJson);
    const started = Date.now();
    try {
      const { json, host } = await chatJson({
        ...this.fastRequest(config, apiKey),
        maxTokens: 512,
        schemaName: 'prompt_suggestion',
        schema: PROMPT_SUGGESTION_JSON_SCHEMA,
        system: PROMPT_SUGGESTION_SYSTEM,
        user: promptSuggestionMessage(request),
      });
      const prompt = String(json.prompt || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PROMPT_SUGGESTION_MAX_CHARS);
      this.log.appendLine(
        `prompt suggestion: ${config.localModel || config.fastModel} via ${host} in ${Date.now() - started} ms: ` +
          (prompt ? JSON.stringify(prompt) : 'none'),
      );
      return prompt || null;
    } catch (error) {
      throw this.toHostError(error);
    }
  }

  /** The fast model's request fields (or the local model's). */
  fastRequest(config, apiKey) {
    return {
      apiKey,
      localServer: config.localModel ? config.localServer : undefined,
      model: config.localModel || config.fastModel,
      reasoning: { enabled: false },
      privateRouting: config.privateRouting,
      priority: config.fastPriority,
    };
  }

  recent(limit) {
    try {
      return this.recentCommands(limit);
    } catch (error) {
      this.log.appendLine(`recent commands unavailable: ${error.message}`);
      return [];
    }
  }

  /** Times both stages of AI Command Search and logs a summary to the Warp output channel. */
  async benchmark() {
    const config = this.settings();
    const apiKey = await this.apiKey(config);
    const contextJson = JSON.stringify({ os: { category: 'macOS' }, shell_name: 'zsh' });
    const base = { apiKey, privateRouting: config.privateRouting, contextJson };
    if (config.localModel) {
      // One stage: the local model.
      Object.assign(config, { fastModel: config.localModel, expandedModel: '' });
      base.localServer = config.localServer;
    }
    this.log.show(true);
    this.log.appendLine(
      `# search benchmark: ${config.fastModel} (${config.fastPriority}) then ${config.expandedModel} ` +
        `(${config.expandedPriority}, effort ${config.expandedEffort}), ` +
        `private routing ${config.privateRouting ? 'on' : 'off'}`,
    );
    const fastTimes = [];
    const totalTimes = [];
    for (const prompt of BENCHMARK_PROMPTS) {
      try {
        const started = Date.now();
        const fast = await requestCommands({ ...base, prompt, model: config.fastModel, priority: config.fastPriority, maxCommands: config.localModel ? EXPANDED_MAX_COMMANDS : FAST_MAX_COMMANDS, reasoning: { enabled: false } });
        const fastMs = Date.now() - started;
        const expanded = config.expandedModel
          ? await requestCommands({ ...base, prompt, model: config.expandedModel, priority: config.expandedPriority, maxCommands: EXPANDED_MAX_COMMANDS, reasoning: { effort: config.expandedEffort }, alreadyShown: fast.commands })
          : { commands: [], host: '-' };
        const totalMs = Date.now() - started;
        fastTimes.push(fastMs);
        totalTimes.push(totalMs);
        this.log.appendLine(
          `  fast ${String(fastMs).padStart(5)} ms (${fast.host}, ${fast.commands.length})  ` +
            `all ${String(totalMs).padStart(5)} ms (${expanded.host}, +${expanded.commands.length})  "${prompt}"`,
        );
      } catch (error) {
        this.log.appendLine(`  error: ${error.message}`);
      }
    }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const summary = `fast median ${median(fastTimes)} ms, with expanded ${median(totalTimes)} ms`;
    this.log.appendLine('summary: ' + summary);
    vscode.window.showInformationMessage(`Warp # benchmark: ${summary}`);
  }

  toHostError(error) {
    if (error instanceof HostError) return error;
    if (error.local || error?.cause?.code === 'ECONNREFUSED') {
      this.log.appendLine(`local model error: ${error.status ?? ''} ${error.message}`);
      if (Date.now() - this.lastLocalWarning > 30_000) {
        this.lastLocalWarning = Date.now();
        vscode.window.showWarningMessage(
          `Warp AI: the local model server didn't answer (${error.message}). Is LM Studio's server running with the model loaded?`,
        );
      }
      return new HostError('provider_error', error.message);
    }
    if (error.status === 401) {
      vscode.window
        .showErrorMessage('Warp AI: the OpenRouter API key was rejected.', 'Set API Key')
        .then((choice) => choice && vscode.commands.executeCommand('warp.setOpenRouterApiKey'));
      return new HostError('provider_error', 'authentication failed');
    }
    if (error.status === 429) return new HostError('rate_limited', error.message);
    if (error.status) {
      this.log.appendLine(`OpenRouter error ${error.status}: ${error.message}`);
      return new HostError('provider_error', error.message);
    }
    this.log.appendLine(`AI request failed: ${error?.message || error}`);
    return new HostError('other', String(error?.message || error));
  }
}

module.exports = { WarpAi, HostError, requestCommands, chatJson, providerPreferences, nextCommandMessage, promptSuggestionMessage, BENCHMARK_PROMPTS, NEXT_COMMAND_SYSTEM };
