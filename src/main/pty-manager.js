'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { classify, State } = require('./status-detector');

const POLL_MS = 400;          // how often we re-read the screen and reclassify
const SCROLLBACK = 5000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;

/**
 * Session-scoped markers belonging to a Claude Code process that happens to be
 * this app's PARENT. Inheriting them makes every session Seamux spawns believe
 * it is a child of that session, and Claude Code then DISABLES TRANSCRIPT
 * SAVING -- so `claude --continue` has nothing to resume and the conversation
 * is unrecoverable if the pane dies.
 *
 * This bit real work: sessions launched while Seamux itself was started from
 * inside a Claude Code session saved no transcripts at all.
 */
const PARENT_SESSION_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

/** process.env minus anything that would make a session look like a child. */
function cleanParentEnv() {
  const env = { ...process.env };
  for (const k of PARENT_SESSION_MARKERS) delete env[k];
  return env;
}

let seq = 0;

/**
 * Owns every live session. A session = one node-pty process running `claude`
 * in a project directory, plus a headless xterm that renders its output so we
 * can read the screen for status detection.
 *
 * Emits:
 *   'data'   { id, chunk }        raw PTY output, for the renderer's xterm
 *   'status' { id, state, ... }   only when the state actually changes
 *   'exit'   { id, exitCode }
 */
class PtyManager extends EventEmitter {
  constructor(contextDir) {
    super();
    this.sessions = new Map();
    this.contextDir = contextDir || path.join(os.tmpdir(), 'seamux-context');
    this._sweepOrphans();
    this._timer = setInterval(() => this._pollAll(), POLL_MS);
  }

  /**
   * Context files are removed when their session closes, but a crash or a
   * force-quit leaves them behind, and they hold values in plaintext. No
   * session exists at startup, so anything here now is an orphan.
   */
  _sweepOrphans() {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(this.contextDir)) {
        if (!f.endsWith('.env')) continue;
        try { fs.unlinkSync(path.join(this.contextDir, f)); removed++; } catch { /* best effort */ }
      }
    } catch { /* directory not created yet */ }
    return removed;
  }

  /**
   * Per-session context file.
   *
   * An earlier version of this shipped and was removed, because nothing read
   * it: a process's environment is fixed at exec(), and the Bash tool ignores
   * BASH_ENV. What was missing was not the file but anyone telling Claude it
   * existed. Paired with an injected notice (see queueInjection) it becomes the
   * one way changed context reaches a session that is already running.
   *
   * Values live here in plaintext, 0600 inside a 0700 directory, removed when
   * the session closes. Only variable NAMES are ever injected into the
   * conversation; the values stay in this file.
   */
  _writeContextFile(session, vars) {
    fs.mkdirSync(this.contextDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.contextDir, 0o700); } catch { /* best effort */ }
    const file = path.join(this.contextDir, `${session.id}.env`);
    const body = Object.entries(vars || {}).map(([k, v]) => {
      const val = String(v == null ? '' : v);
      return /[\s"'#\\]/.test(val)
        ? `${k}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
        : `${k}=${val}`;
    }).join('\n');
    fs.writeFileSync(file,
      '# Written by Seamux; rewritten whenever this session\'s context changes.\n'
      + '# Load with:  set -a; . "$SEAMUX_CONTEXT_FILE"; set +a\n' + body + '\n',
      { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return file;
  }

  _removeContextFile(session) {
    try { fs.unlinkSync(path.join(this.contextDir, `${session.id}.env`)); } catch { /* gone */ }
  }

  /**
   * Send a one-line message into a live session, but only once it is actually
   * at its prompt -- typing into a permission dialog or mid-turn would be both
   * useless and rude. The poll loop delivers it when the state says idle.
   */
  queueInjection(id, text) {
    const s = this.sessions.get(id);
    if (!s || s.exited || !text) return false;
    s.pendingInjection = String(text).replace(/\s*\n\s*/g, ' ').trim();
    return true;
  }

  /**
   * @param {{cwd:string, title?:string, command?:string, args?:string[], env?:object}} opts
   */
  create(opts) {
    const id = `s${++seq}`;
    const cwd = opts.cwd || os.homedir();
    const command = opts.command || process.env.SEAMUX_CLAUDE_BIN || 'claude';
    const args = opts.args || [];
    const contextFile = path.join(this.contextDir, `${id}.env`);
    this._writeContextFile({ id }, opts.env || {});

    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: {
        ...cleanParentEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Claude Code (and most TUIs) behave badly if they think they're piped.
        FORCE_COLOR: '1',
        // Resolved context last, so a set can deliberately override something
        // inherited from the shell that launched Seamux.
        ...(opts.env || {}),
        // Path is fixed for the life of the process; the CONTENTS are rewritten
        // whenever this session's context changes.
        SEAMUX_CONTEXT_FILE: contextFile,
        SEAMUX_SESSION_ID: id,
      },
    });

    // Headless mirror: same bytes the visible terminal gets, so the screen we
    // classify is the screen the user would see.
    const mirror = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });

    const session = {
      id,
      proc,
      mirror,
      cwd,
      title: opts.title || path.basename(cwd) || cwd,
      command,
      state: State.STARTING,
      reason: 'starting',
      rule: null,
      lastOutputAt: Date.now(),
      bellPending: false,
      exited: false,
      exitCode: null,
      // Ring buffer of raw output so a pane can be rehydrated when you switch
      // back to it, or when the renderer attaches late.
      replay: [],
      replayBytes: 0,
      unread: false,
      createdAt: Date.now(),
      // Names only -- values are never held here, so they cannot leak into a
      // status payload or the replay buffer.
      envSetIds: opts.envSetIds || [],
      envSetNames: opts.envSetNames || [],
      contextFile,
      pendingInjection: null,
      profileId: opts.profileId || 'claude',
      profileLabel: opts.profileLabel || '',
      rules: opts.rules || [],
      instructionCount: opts.instructionCount || 0,
      prePromptCount: opts.prePromptCount || 0,
      envKeys: Object.keys(opts.env || {}),
      envWarnings: opts.envWarnings || [],
      // What the process was actually launched with, so we can tell whether a
      // later change genuinely needs a restart or is already live in the file.
      spawnEnv: { ...(opts.env || {}) },
      contextPending: false,
      command,
      args,
    };

    mirror.onBell(() => { session.bellPending = true; });

    // A restart replaces session.proc. The OLD process then fires onExit a
    // moment later, which would mark the freshly restarted session as exited
    // and make every write() bail out -- a dead pane with no error anywhere.
    // Every handler therefore checks it still owns the session.
    const mine = () => session.proc === proc;

    proc.onData((chunk) => {
      if (!mine()) return;
      session.lastOutputAt = Date.now();
      mirror.write(chunk);
      this._pushReplay(session, chunk);
      this.emit('data', { id, chunk });
    });

    proc.onExit(({ exitCode }) => {
      if (!mine()) return;
      session.exited = true;
      session.exitCode = exitCode;
      this._setStatus(session, { state: State.EXITED, reason: `exited (${exitCode})`, rule: null });
      this.emit('exit', { id, exitCode });
    });

    this.sessions.set(id, session);
    return this.describe(session);
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    // Typing into a session means you've seen it.
    s.bellPending = false;
    s.unread = false;
    s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || s.exited) return;
    if (cols < 2 || rows < 2) return;
    try {
      s.proc.resize(cols, rows);
      s.mirror.resize(cols, rows);
    } catch { /* pty can race with exit */ }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { if (!s.exited) s.proc.kill(); } catch { /* already gone */ }
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.kill(id);
    this._removeContextFile(s);
    try { s.mirror.dispose(); } catch { /* noop */ }
    this.sessions.delete(id);
  }

  /** Full raw output so far, for rehydrating a pane on switch. */
  replay(id) {
    const s = this.sessions.get(id);
    return s ? s.replay.join('') : '';
  }

  markRead(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.unread = false;
    s.bellPending = false;
  }

  /**
   * Point this session at different context.
   *
   * A process's environment is fixed at exec(), and measurement confirms the
   * only consumers are `claude` itself and the commands it runs through its
   * Bash tool -- which inherit that same spawn-time environment. There is no
   * mechanism that delivers new values to a running session: BASH_ENV is not
   * honoured by the Bash tool, so a live file on disk bought nothing and cost
   * plaintext secrets for the session's lifetime. It was removed.
   *
   * So this records the new choice and flags contextPending. The user restarts
   * when it suits them; we never do it silently, because restarting ends the
   * conversation in that pane.
   */
  setContext(id, { vars, args, envSetIds, envSetNames, envWarnings, instructionCount, prePromptCount }) {
    const s = this.sessions.get(id);
    if (!s) return null;
    this._writeContextFile(s, vars || {});
    s.envSetIds = envSetIds || [];
    s.envSetNames = envSetNames || [];
    s.envWarnings = envWarnings || [];
    s.envKeys = Object.keys(vars || {});
    s.pendingEnv = { ...(vars || {}) };
    s.pendingArgs = args || null;
    const promptsChanged =
      (instructionCount !== undefined && instructionCount !== (s.instructionCount || 0)) ||
      (prePromptCount !== undefined && prePromptCount !== (s.prePromptCount || 0));
    s.contextPending = !sameEnv(s.spawnEnv, vars || {}) || promptsChanged;
    const info = this.describe(s);
    this.emit('status', { ...info, previous: s.state });
    return info;
  }

  /** Relaunch in place so the pane, id and position survive. */
  restart(id, { vars, args, envSetIds, envSetNames, envWarnings, instructionCount, prePromptCount } = {}) {
    const s = this.sessions.get(id);
    if (!s) return null;

    const nextVars = vars || s.pendingEnv || s.spawnEnv || {};
    this._writeContextFile(s, nextVars);
    if (args) s.args = args;
    if (instructionCount !== undefined) s.instructionCount = instructionCount;
    if (prePromptCount !== undefined) s.prePromptCount = prePromptCount;
    try { if (!s.exited) s.proc.kill(); } catch { /* already gone */ }

    const proc = pty.spawn(s.command, s.args, {
      name: 'xterm-256color',
      cols: s.mirror.cols, rows: s.mirror.rows,
      cwd: s.cwd,
      env: {
        ...cleanParentEnv(),
        TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1',
        ...nextVars,
        SEAMUX_CONTEXT_FILE: s.contextFile,
        SEAMUX_SESSION_ID: s.id,
      },
    });

    s.mirror.reset();
    s.replay = []; s.replayBytes = 0;
    s.proc = proc;
    s.exited = false; s.exitCode = null;
    s.spawnEnv = { ...nextVars };
    s.pendingEnv = null;
    s.contextPending = false;
    s.envSetIds = envSetIds || s.envSetIds;
    s.envSetNames = envSetNames || s.envSetNames;
    s.envWarnings = envWarnings || [];
    s.envKeys = Object.keys(nextVars);
    s.lastOutputAt = Date.now();
    s.bellPending = false;

    const mine = () => s.proc === proc;

    proc.onData((chunk) => {
      if (!mine()) return;
      s.lastOutputAt = Date.now();
      s.mirror.write(chunk);
      this._pushReplay(s, chunk);
      this.emit('data', { id: s.id, chunk });
    });
    proc.onExit(({ exitCode }) => {
      if (!mine()) return;
      s.exited = true; s.exitCode = exitCode;
      this._setStatus(s, { state: State.EXITED, reason: `exited (${exitCode})`, rule: null });
      this.emit('exit', { id: s.id, exitCode });
    });

    this._setStatus(s, { state: State.STARTING, reason: 'restarting', rule: null });
    this.emit('restarted', { id: s.id });
    return this.describe(s);
  }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  describe(s) {
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      state: s.state,
      reason: s.reason,
      rule: s.rule,
      unread: s.unread,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      envSetIds: s.envSetIds,
      envSetNames: s.envSetNames,
      instructionCount: s.instructionCount || 0,
      prePromptCount: s.prePromptCount || 0,
      contextFile: s.contextFile,
      envKeys: s.envKeys,
      envWarnings: s.envWarnings,
      contextPending: s.contextPending,
      profileId: s.profileId,
      profileLabel: s.profileLabel,
    };
  }

  /** The rendered viewport -- what the detector reads. Also powers Cmd+D. */
  screenText(id) {
    const s = this.sessions.get(id);
    if (!s) return '';
    const buf = s.mirror.buffer.active;
    const out = [];
    for (let i = 0; i < s.mirror.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  }

  dispose() {
    clearInterval(this._timer);
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }

  _pollAll() {
    for (const s of this.sessions.values()) {
      if (s.exited) continue;
      const verdict = classify(this.screenText(s.id), {
        msSinceOutput: Date.now() - s.lastOutputAt,
        exited: s.exited,
        bellPending: s.bellPending,
      }, s.rules);
      this._setStatus(s, verdict);

      if (s.pendingInjection && verdict.state === State.IDLE) {
        const text = s.pendingInjection;
        s.pendingInjection = null;
        try {
          s.proc.write(text);
          setTimeout(() => { try { s.proc.write('\r'); } catch { /* gone */ } }, 120);
          this.emit('injected', { id: s.id, text });
        } catch { /* session went away mid-write */ }
      }
    }
  }

  _setStatus(s, verdict) {
    if (s.state === verdict.state && s.reason === verdict.reason) return;
    const previous = s.state;
    s.state = verdict.state;
    s.reason = verdict.reason;
    s.rule = verdict.rule;
    this.emit('status', { ...this.describe(s), previous });
  }

  _pushReplay(s, chunk) {
    const MAX = 400_000; // ~400KB of scrollback per session is plenty
    s.replay.push(chunk);
    s.replayBytes += chunk.length;
    while (s.replayBytes > MAX && s.replay.length > 1) {
      s.replayBytes -= s.replay.shift().length;
    }
  }
}

/** Same keys and same values? Used to decide whether a restart is warranted. */
function sameEnv(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && String(a[k]) === String(b[k]));
}

module.exports = { PtyManager, State, sameEnv, cleanParentEnv, PARENT_SESSION_MARKERS };
