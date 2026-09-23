'use strict';

/**
 * Infers what a Claude Code session is doing by reading its RENDERED SCREEN.
 *
 * We do not regex the raw PTY byte stream. That stream is append-only history,
 * so a spinner line from 40 seconds ago keeps matching forever. Instead each
 * session owns a headless xterm emulator (see pty-manager.js) and we read the
 * viewport it renders -- the exact text a human would see in that pane.
 *
 * TUNING LIVES HERE. If a state is misdetected, adjust RULES below; nothing
 * else in the app needs to change. Cmd+D in the UI opens a debug pane showing
 * the screen text and which rule fired, which is the fastest way to tune.
 */

const State = {
  RUNNING: 'running',       // Claude is working: thinking, calling tools
  NEEDS_INPUT: 'needs_input', // Blocked on you: permission prompt or a question
  IDLE: 'idle',             // Prompt is up, nothing happening, your move
  STARTING: 'starting',
  EXITED: 'exited',
};

// How many lines up from the bottom of the screen to consider. Claude Code
// keeps its spinner / prompt box / permission dialog pinned near the bottom.
const TAIL_LINES = 24;

// Quiet period before a session with no matching rule is called idle.
const QUIET_MS = 1200;

/**
 * Rules that hold for any interactive CLI. Agent-specific rules are supplied by
 * the profile (see profiles.js) and layered on top of these.
 */
const COMMON_RULES = [
  {
    id: 'question',
    state: State.NEEDS_INPUT,
    reason: 'permission / approval prompt',
    test: (s) =>
      /\bdo you want to\b/i.test(s) ||
      /\bwould you like\b/i.test(s) ||
      /\bproceed\?/i.test(s) ||
      /\ballow\b.*\?/i.test(s),
  },
  {
    id: 'yes-no',
    state: State.NEEDS_INPUT,
    reason: 'y/n confirmation',
    test: (s) => /\(y\/n\)/i.test(s) || /\[Y\/n\]/.test(s) || /\(yes\/no\)/i.test(s),
  },
  {
    id: 'menu',
    state: State.NEEDS_INPUT,
    reason: 'waiting on a choice',
    // A numbered menu with a selection cursor is a near-universal TUI shape.
    test: (s) => /[❯>»]\s*\d+[.)]\s/.test(s) || /Select an option|Choose an option|Press Enter to continue/i.test(s),
  },
  {
    id: 'select-menu',
    state: State.NEEDS_INPUT,
    reason: 'waiting on a selection',
    // Captured from Gemini CLI's auth screen: a bulleted numbered list with no
    // cursor character, plus an explicit "(Use Enter to select)". The ❯-style
    // rule above misses this shape entirely.
    test: (s) => /\(Use (Enter|arrow keys?) to select\)/i.test(s) ||
      // allow a box-drawing border before the bullet: many TUIs frame their menus
      (/^[\s│|┃]*[●○•]\s*\d+[.)]\s/m.test(s) && /^[\s│|┃]*\d+[.)]\s/m.test(s)),
  },
  {
    id: 'password',
    state: State.NEEDS_INPUT,
    reason: 'credential prompt',
    test: (s) => /\b(password|passphrase|OTP|one-time code)\s*:\s*$/im.test(s),
  },
];

// Braille spinners (ora and most Node CLIs) are a near-universal "busy" tell.
const BRAILLE_SPINNER = /[\u2807\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u280F\u2818\u2810]/;

const COMMON_RUNNING_RULES = [
  {
    id: 'braille-spinner',
    state: State.RUNNING,
    reason: 'working',
    test: (s) => BRAILLE_SPINNER.test(s),
  },
];

/** needs_input before running: a missed block is worse than a missed spinner. */
const STATE_ORDER = { [State.NEEDS_INPUT]: 0, [State.RUNNING]: 1 };

function rulesFor(profileRules = []) {
  return [...COMMON_RULES, ...COMMON_RUNNING_RULES, ...profileRules]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (STATE_ORDER[a.r.state] - STATE_ORDER[b.r.state]) || (a.i - b.i))
    .map((x) => x.r);
}

/**
 * @param {string} screen  rendered viewport text, newline separated
 * @param {object} ctx     { msSinceOutput, exited, bellPending }
 * @returns {{state:string, reason:string, rule:string|null}}
 */
function classify(screen, ctx = {}, profileRules = []) {
  if (ctx.exited) {
    return { state: State.EXITED, reason: 'process exited', rule: null };
  }

  const tail = lastLines(screen, TAIL_LINES);

  for (const rule of rulesFor(profileRules)) {
    if (rule.test(tail)) {
      return { state: rule.state, reason: rule.reason, rule: rule.id };
    }
  }

  // A terminal bell with no rule match almost always means Claude finished a
  // turn or wants attention. Claude Code rings it on completion.
  if (ctx.bellPending) {
    return { state: State.NEEDS_INPUT, reason: 'terminal bell', rule: 'bell' };
  }

  // Output still streaming with no spinner match: treat as working, otherwise
  // a long tool output would flicker to idle between chunks.
  if ((ctx.msSinceOutput ?? Infinity) < QUIET_MS) {
    return { state: State.RUNNING, reason: 'output streaming', rule: null };
  }

  return { state: State.IDLE, reason: 'quiet at prompt', rule: null };
}

/**
 * The last n meaningful lines, ignoring the blank padding below the cursor.
 *
 * A terminal viewport is a fixed grid, so a session whose cursor sits near the
 * top is followed by rows of empty cells. Slicing the raw tail would return
 * that padding and miss the prompt entirely -- which is exactly how a live
 * y/n prompt went undetected until an unrelated resize shrank the padding.
 */
function lastLines(text, n) {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(Math.max(0, end - n), end).join('\n');
}

module.exports = { classify, State, COMMON_RULES, COMMON_RUNNING_RULES, rulesFor, TAIL_LINES, QUIET_MS };
