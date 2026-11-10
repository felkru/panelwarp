const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ShellRecorder } = require('../shellRecorder');

// A Warp hook as the bootstrap prints it (DCS with hex JSON, spaced over lines)
function hook(name, value = {}) {
  const json = JSON.stringify({ hook: name, value: { session_id: 42, ...value } }, null, 1);
  return `\x1bP$d${Buffer.from(json).toString('hex')}\x1b\\`;
}

// A hook as Warp's SSH wrapper prints it (OSC)
function wrapperHook(name, value) {
  return `\x1b]9278;d;${Buffer.from(JSON.stringify({ hook: name, value })).toString('hex')}\x07`;
}

const BOOTSTRAP = `bootstrap script\r\n${hook('InitShell')}${hook('Bootstrapped')}`;
const TITLE = '\x1b]0;~\x07';
const PROMPT_HOOK = hook('Precmd', { pwd: '/Users/me' });
const PROMPT = '\r\x1b[J\x1b]133;A\x07me@mac:~ % \x1b]133;B\x07\x1b[K\x1b[?2004h';
const INPUT_BUFFER = hook('InputBuffer', { buffer: '' });

// Warp asks for the input buffer once its input is up, then runs a completion in the shell
function inBandCommand(command = "warp_run_generator_command 1 'ls'", session = {}) {
  return [
    hook('InputBuffer', { ...session, buffer: '' }),
    `\x1b[7m${command}\x1b[27m`,
    hook('Preexec', { ...session, command }),
    TITLE,
    hook('CommandFinished', { ...session, exit_code: 0 }),
    hook('Precmd', { ...session, pwd: '', is_after_in_band_command: true }),
    PROMPT,
    '\x1b]9277;A\x07' + Buffer.from('1;Desktop\nDocuments;0').toString('hex') + '\x1b]9277;B\x07',
  ];
}

function shellOutput(...chunks) {
  const recorder = new ShellRecorder();
  for (const chunk of chunks) recorder.record(Buffer.from(chunk, 'latin1'), true);
  return recorder;
}

function replayed(recorder) {
  return Buffer.concat(recorder.replay()).toString('latin1');
}

test("a reloaded page gets the prompt and title without the old page's completions", () => {
  const recorder = shellOutput(
    BOOTSTRAP,
    `%\r \r${TITLE}`,
    hook('CommandFinished', { exit_code: 0 }),
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    ...inBandCommand(),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test("fish's completions, typed with a leading space, are left out too", () => {
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(" warp_run_generator_command 1 'ls'"),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test('native shell completions are left out too', () => {
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand('warp_run_generator_command_native_completions 67697420636865636b6f7574'),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test('output while no page shows the shell is kept for the next page', () => {
  const recorder = shellOutput(BOOTSTRAP, PROMPT_HOOK, PROMPT, ...inBandCommand(), INPUT_BUFFER);
  recorder.record(Buffer.from('server listening on :3000\r\n', 'latin1'), false);

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT + 'server listening on :3000\r\n');
});

test('a completion still ending when the page went away is left out', () => {
  const [inputBuffer, echo, preexec, ...ending] = inBandCommand();
  const recorder = shellOutput(BOOTSTRAP, PROMPT_HOOK, PROMPT, inputBuffer, echo, preexec);
  for (const chunk of ending) recorder.record(Buffer.from(chunk, 'latin1'), false);

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
});

test("a reloaded page gets the user's running command with its echo", () => {
  const preexec = hook('Preexec', { command: 'sleep 60' });
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    INPUT_BUFFER,
    '\x1b[?2004l\r\r\n',
    preexec,
    '\x1b]0;sleep\x07',
    'still sleeping',
  );

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + '\x1b]0;sleep\x07' + PROMPT_HOOK + PROMPT + '\x1b[?2004l\r\r\n' + preexec + '\x1b]0;sleep\x07still sleeping',
  );
  assert.equal(recorder.running, true);
});

test('a reloaded page gets the latest prompt after Enter on an empty line', () => {
  const nextPromptHook = hook('Precmd', { pwd: '/Users/me', exit_code: 0 });
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    INPUT_BUFFER,
    '\x1b[?2004l\r\r\n',
    hook('CommandFinished', { exit_code: 0 }),
    nextPromptHook,
    PROMPT,
    ...inBandCommand(),
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + nextPromptHook + PROMPT);
});

const REMOTE = { session_id: 77 };
// `ssh server` from the prompt, through the remote shell's bootstrap
const SSH_START = [
  'ssh server',
  hook('Preexec', { command: 'ssh server' }),
  wrapperHook('SSH', { session_id: 42, remote_session_id: 77 }),
  wrapperHook('InitShell', { ...REMOTE, shell: 'bash' }),
  'Welcome to Ubuntu\r\n',
  hook('Bootstrapped', REMOTE),
];
const REMOTE_PROMPT_HOOK = hook('Precmd', { ...REMOTE, pwd: '/home/ubuntu' });
const REMOTE_PROMPT = 'ubuntu@server:~$ ';
const REMOTE_INPUT_BUFFER = hook('InputBuffer', { ...REMOTE, buffer: '' });

function sshSession(...remoteOutput) {
  return shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    INPUT_BUFFER,
    ...SSH_START,
    hook('CommandFinished', { ...REMOTE, exit_code: 0 }),
    REMOTE_PROMPT_HOOK,
    REMOTE_PROMPT,
    ...remoteOutput,
  );
}

test("a reloaded page gets the SSH session's prompt, ready for Warp's commands there", () => {
  const recorder = sshSession(
    REMOTE_INPUT_BUFFER,
    'whoami\r\n',
    hook('Preexec', { ...REMOTE, command: 'whoami' }),
    'ubuntu\r\n',
    hook('CommandFinished', { ...REMOTE, exit_code: 0 }),
    REMOTE_PROMPT_HOOK,
    REMOTE_PROMPT,
    ...inBandCommand("warp_run_generator_command 2 'git branch'", REMOTE),
    REMOTE_INPUT_BUFFER,
  );

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + PROMPT_HOOK + PROMPT + SSH_START.join('') + TITLE + REMOTE_PROMPT_HOOK + REMOTE_PROMPT,
  );
  assert.equal(recorder.running, false);
});

test('a reloaded page gets the command running over SSH', () => {
  const preexec = hook('Preexec', { ...REMOTE, command: 'sleep 60' });
  const recorder = sshSession(REMOTE_INPUT_BUFFER, 'sleep 60\r\n', preexec, 'still sleeping');

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + PROMPT_HOOK + PROMPT + SSH_START.join('') + REMOTE_PROMPT_HOOK + REMOTE_PROMPT + 'sleep 60\r\n' + preexec + 'still sleeping',
  );
  assert.equal(recorder.running, true);
});

test('a reloaded page gets the local prompt after the user leaves SSH', () => {
  const recorder = sshSession(
    REMOTE_INPUT_BUFFER,
    'exit\r\n',
    hook('Preexec', { ...REMOTE, command: 'exit' }),
    'Connection to server closed.\r\n',
    hook('CommandFinished', { exit_code: 0 }),
    PROMPT_HOOK,
    PROMPT,
    ...inBandCommand(),
    INPUT_BUFFER,
  );

  assert.equal(replayed(recorder), BOOTSTRAP + TITLE + PROMPT_HOOK + PROMPT);
  assert.equal(recorder.running, false);
});

test('a reloaded page gets the subshell without its request to be bootstrapped', () => {
  const SUBSHELL = { session_id: 88 };
  const request = '\x1bP$f{"hook": "SourcedRcFileForWarp", "value": { "shell": "zsh", "uname": "Darwin" }}\x1b\\';
  const start = [
    'zsh',
    hook('Preexec', { command: 'zsh' }),
    request.slice(0, 20),
    request.slice(20),
    hook('InitShell', SUBSHELL),
    hook('Bootstrapped', SUBSHELL),
  ];
  const subshellPromptHook = hook('Precmd', { ...SUBSHELL, pwd: '/Users/me' });
  const recorder = shellOutput(
    BOOTSTRAP,
    PROMPT_HOOK,
    PROMPT,
    INPUT_BUFFER,
    ...start,
    subshellPromptHook,
    PROMPT,
    hook('InputBuffer', { ...SUBSHELL, buffer: '' }),
  );

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + PROMPT_HOOK + PROMPT + start.join('').replace(request, '') + subshellPromptHook + PROMPT,
  );
  assert.equal(recorder.running, false);
});

test('an SSH session that ended while no page showed it is kept for the next page', () => {
  const recorder = sshSession(REMOTE_INPUT_BUFFER);
  const ending = ['Connection to server closed.\r\n', hook('CommandFinished', { exit_code: 255 }), PROMPT_HOOK, PROMPT];
  for (const chunk of ending) recorder.record(Buffer.from(chunk, 'latin1'), false);

  assert.equal(
    replayed(recorder),
    BOOTSTRAP + PROMPT_HOOK + PROMPT + SSH_START.join('') + REMOTE_PROMPT_HOOK + REMOTE_PROMPT + ending.join(''),
  );
  assert.equal(recorder.running, false);
});
