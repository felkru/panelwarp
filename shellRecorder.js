// What a reloaded page needs to take over a running shell (see `adopt` in server.js). Warp builds
// its blocks from hooks its bootstrap makes the shell print, so a new page can't start from the
// shell's current screen: it gets the shell's output from the start up to the end of its
// bootstrap (the session's identity: shell, aliases, functions), then the tab title and everything
// since the latest prompt (the running command, or the idle prompt). Earlier blocks come back from
// the tab store. Warp's own commands at the prompt (completions, history) are left out: only the
// page that ran them can follow them, and a new page that got them showed no prompt until the
// user's next command. An SSH session or subshell Warp bootstrapped is followed the same way,
// after the output that started it (from the outer prompt through its bootstrap).
//
// Hooks are `ESC P $ d <hex JSON> ESC \` (DCS) or `ESC ] 9278 ; d ; <hex JSON> BEL` (OSC, used by
// the SSH wrapper), with JSON like {"hook": "Precmd", "value": {"session_id": 123, ...}}.

const DCS_START = Buffer.from('\x1bP$d', 'latin1');
const DCS_END = Buffer.from('\x1b\\', 'latin1');
const OSC_START = Buffer.from('\x1b]9278;d;', 'latin1');
const OSC_END = Buffer.from('\x07', 'latin1');
const MARKERS = [
  { start: DCS_START, end: DCS_END },
  { start: OSC_START, end: OSC_END },
];

/** A hook longer than this isn't one (Bootstrapped, the largest, is tens of KB). */
const MAX_HOOK_BYTES = 4 * 1024 * 1024;
/** Output up to the end of the bootstrap kept; a shell that prints more can't be taken over. */
const MAX_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
/** Output since the latest prompt kept: its start (the prompt, the command, a full-screen app's
 * mode switches) and the newest output, dropping the middle past this. */
const TAIL_HEAD_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/** `ESC ] 0 ;` or `ESC ] 2 ;` <title> BEL or ST */
const TITLE = /\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** `ESC P $ f` <JSON> `ESC \`: a subshell asking Warp to bootstrap it (InitSubshell, or
 * SourcedRcFileForWarp from Warp's rc file snippet) */
const SUBSHELL_REQUEST = /\x1bP\$f[^\x1b]*\x1b\\/g;

class ShellRecorder {
  constructor() {
    /** Bytes of a hook (or what may start one) split across chunks. */
    this.carry = null;
    this.bootstrap = [];
    this.bootstrapBytes = 0;
    this.bootstrapped = false;
    this.adoptable = true;
    /** Warp session ids the shell's hooks use: its own (first), then subshells and SSH. */
    this.sessionIds = [];
    this.tailHead = [];
    this.tailHeadBytes = 0;
    this.tailRest = [];
    this.tailRestBytes = 0;
    /** SSH sessions and subshells the shell runs, innermost last, each with the output from the
     * outer session's prompt through its bootstrap. */
    this.nested = [];
    /** Whether the innermost session is running the user's command, rather than waiting at its
     * prompt. A new page drops its own writes while it is, so they don't reach the command. */
    this.running = false;
    /** The latest tab title the shell set, which comes before the prompt's hooks. */
    this.title = null;
    /** Output at the prompt since Warp last asked for the input buffer, kept only in case the
     * user's command follows (its echo); null until the prompt is up. */
    this.idleOutput = null;
    this.idleOutputBytes = 0;
    /** Whether Warp's own commands printed hooks since it last asked for the input buffer. */
    this.idleHooks = false;
  }

  /**
   * @param {Buffer} data the shell's output
   * @param {boolean} attached whether a page shows it; the kept output starts at the latest
   *   prompt a page has seen, so blocks that finished while none did are handed over too
   */
  record(data, attached) {
    let buf = this.carry ? Buffer.concat([this.carry, data]) : data;
    this.carry = null;
    let pos = 0;
    while (pos < buf.length) {
      const next = nextHookStart(buf, pos);
      if (!next) {
        const partial = partialMarkerStart(buf, pos);
        this.onOutput(buf.subarray(pos, partial), null, attached);
        if (partial < buf.length) this.carry = Buffer.from(buf.subarray(partial));
        return;
      }
      if (next.index > pos) this.onOutput(buf.subarray(pos, next.index), null, attached);
      const payloadStart = next.index + next.marker.start.length;
      const end = buf.indexOf(next.marker.end, payloadStart);
      if (end < 0) {
        if (buf.length - next.index > MAX_HOOK_BYTES) {
          // Not a hook after all; pass it on as output.
          this.onOutput(buf.subarray(next.index), null, attached);
        } else {
          this.carry = Buffer.from(buf.subarray(next.index));
        }
        return;
      }
      const hookEnd = end + next.marker.end.length;
      this.onOutput(buf.subarray(next.index, hookEnd), parseHook(buf.subarray(payloadStart, end)), attached);
      pos = hookEnd;
    }
  }

  onOutput(bytes, hook, attached) {
    if (!bytes.length) return;
    if (hook?.name === 'InitShell' && hook.sessionId && !this.sessionIds.includes(hook.sessionId)) {
      this.sessionIds.push(hook.sessionId);
    }
    const ownHook = hook && hook.sessionId && hook.sessionId === this.sessionIds[0];
    if (!this.bootstrapped) {
      if (!this.adoptable) return;
      this.bootstrap.push(Buffer.from(bytes));
      this.bootstrapBytes += bytes.length;
      if (this.bootstrapBytes > MAX_BOOTSTRAP_BYTES) {
        this.adoptable = false;
        this.bootstrap = [];
      }
      if (ownHook && hook.name === 'Bootstrapped') this.bootstrapped = true;
      return;
    }
    if (!hook && bytes.includes('\x1b]')) {
      const titles = bytes.toString('latin1').match(TITLE);
      if (titles) this.title = Buffer.from(titles[titles.length - 1], 'latin1');
    }
    // Prompts and commands of the innermost session count. Over SSH, the user's shell only runs ssh.
    const level = hook?.sessionId
      ? [this.sessionIds[0], ...this.nested.map((n) => n.sessionId)].indexOf(hook.sessionId)
      : -1;
    if (level >= 0 && level < this.nested.length) {
      // An outer session is back (the user left SSH), so the nested ones' output belongs to its
      // command
      const chunks = [...this.nested.splice(level).map((n) => n.start), ...this.tailHead, ...this.tailRest];
      this.resetTail();
      for (const chunk of chunks) this.pushTail(chunk);
      this.running = true;
      this.idleOutput = null;
    }
    if (hook?.name === 'Bootstrapped' && level < 0 && this.sessionIds.includes(hook.sessionId)) {
      this.pushTail(Buffer.from(bytes));
      // A new page would act on a subshell's request again and type Warp's init into its prompt
      const start = Buffer.concat([...this.tailHead, ...this.tailRest])
        .toString('latin1')
        .replace(SUBSHELL_REQUEST, '');
      this.nested.push({ sessionId: hook.sessionId, start: Buffer.from(start, 'latin1') });
      this.resetTail();
      return;
    }
    const currentHook = level >= 0;
    // Warp's own (in-band) commands end with a Precmd too, without the prompt's details.
    const userPrecmd = currentHook && hook.name === 'Precmd' && !hook.afterInBand;
    const userPreexec = currentHook && hook.name === 'Preexec' && !hook.inBand;
    // Warp asks for the input buffer whenever its input is up again, so what follows at the
    // prompt is Warp's own commands, or the echo of the user's
    if (currentHook && hook.name === 'InputBuffer' && !this.running) {
      this.idleOutput = [];
      this.idleOutputBytes = 0;
      this.idleHooks = false;
      return;
    }
    if (this.idleOutput) {
      if (!userPrecmd && !userPreexec) {
        if (currentHook) this.idleHooks = true;
        // Warp only runs its commands while a page shows the shell, so output without one (a
        // background job's) is kept for the next page, unless a command Warp started is ending
        if (!attached && !hook && !this.idleHooks) {
          this.pushTail(Buffer.from(bytes));
          return;
        }
        this.idleOutput.push(Buffer.from(bytes));
        this.idleOutputBytes += bytes.length;
        while (this.idleOutputBytes > MAX_TAIL_BYTES && this.idleOutput.length > 1) {
          this.idleOutputBytes -= this.idleOutput.shift().length;
        }
        return;
      }
      // The user's command, or Enter on an empty line
      for (const chunk of this.idleOutput) this.pushTail(chunk);
      this.idleOutput = null;
    }
    if (userPrecmd && attached) this.resetTail();
    if (userPreexec) this.running = true;
    if (currentHook && (hook.name === 'CommandFinished' || hook.name === 'Precmd')) this.running = false;
    this.pushTail(Buffer.from(bytes));
  }

  resetTail() {
    this.tailHead = [];
    this.tailHeadBytes = 0;
    this.tailRest = [];
    this.tailRestBytes = 0;
  }

  pushTail(bytes) {
    if (this.tailHeadBytes < TAIL_HEAD_BYTES) {
      this.tailHead.push(bytes);
      this.tailHeadBytes += bytes.length;
      return;
    }
    this.tailRest.push(bytes);
    this.tailRestBytes += bytes.length;
    while (this.tailRestBytes > MAX_TAIL_BYTES - this.tailHeadBytes && this.tailRest.length > 1) {
      this.tailRestBytes -= this.tailRest.shift().length;
    }
  }

  /** The output to hand a new page, or null if this shell can't be taken over. */
  replay() {
    if (!this.adoptable || !this.bootstrapped) return null;
    return [
      ...this.bootstrap,
      ...this.nested.map((n) => n.start),
      ...(this.title ? [this.title] : []),
      ...this.tailHead,
      ...this.tailRest,
    ];
  }
}

function nextHookStart(buf, from) {
  let best = null;
  for (const marker of MARKERS) {
    const index = buf.indexOf(marker.start, from);
    if (index >= 0 && (!best || index < best.index)) best = { index, marker };
  }
  return best;
}

/** Where a hook marker cut off by the end of `buf` starts (`buf.length` if none). */
function partialMarkerStart(buf, from) {
  const longest = Math.max(...MARKERS.map((m) => m.start.length));
  for (let i = Math.max(from, buf.length - longest + 1); i < buf.length; i++) {
    if (buf[i] !== 0x1b) continue;
    const rest = buf.subarray(i);
    if (MARKERS.some((m) => m.start.subarray(0, rest.length).equals(rest))) return i;
  }
  return buf.length;
}

/** The hook's name, session id (kept as a string: it's a u64) and whether it starts or ends an
 * in-band command (like Warp's `is_in_band_command`, which covers native completions too). */
function parseHook(hex) {
  const json = Buffer.from(hex.toString('latin1'), 'hex').toString('utf8');
  const name = /"hook"\s*:\s*"(\w+)"/.exec(json)?.[1];
  if (!name) return null;
  return {
    name,
    sessionId: /"session_id"\s*:\s*(\d+)/.exec(json)?.[1] ?? null,
    afterInBand: /"is_after_in_band_command"\s*:\s*true/.test(json),
    inBand: /"command"\s*:\s*"\s*warp_run_generator_command/.test(json),
  };
}

module.exports = { ShellRecorder };
