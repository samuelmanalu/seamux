'use strict';

const os = require('os');
const path = require('path');

/**
 * Agent profiles.
 *
 * Seamux is not a Claude tool: it drives any interactive CLI. Everything that
 * differs between agents lives here, so adding one means adding a profile
 * rather than editing the spawn path, the detector and the UI.
 *
 * The shapes were taken from the real CLIs, not assumed -- Gemini is the reason
 * `prompt.mode` exists at all, since its positional argument runs ONE-SHOT and
 * an interactive opening prompt needs -i instead.
 *
 *   instructions.mode  'flag'  pass standing instructions via flag
 *                      'none'  the CLI has no equivalent
 *   prompt.mode        'positional' | 'flag' | 'none'
 *   globalRules        file of rules the agent reads at startup, or null
 *   rules              detection rules layered on the common set
 */

const home = os.homedir();
const expand = (p) => (p && p.startsWith('~') ? path.join(home, p.slice(1)) : p);

/* ---- Claude Code: verified against v2.1.278 ---- */
const CLAUDE_SPINNER = new RegExp('[✻✶✳✢✽·⁂*]\\s+[A-Za-z][A-Za-z\'’]*…');

const CLAUDE_RULES = [
  {
    id: 'claude-permission',
    state: 'needs_input',
    reason: 'permission / approval prompt',
    test: (s) => /\bthis command requires approval\b/i.test(s) || /❯\s*\d+\.\s/.test(s),
  },
  {
    id: 'claude-modal',
    state: 'needs_input',
    reason: 'waiting on a choice',
    // trust dialog ends "Enter to confirm · Esc to cancel"; permission dialog
    // ends "Esc to cancel · Tab to amend". Deliberately not a bare /Esc to
    // cancel/, which is too close to the working affordance.
    test: (s) => /Enter to confirm/i.test(s) || /Esc to cancel\s*·\s*Tab to amend/i.test(s),
  },
  {
    id: 'claude-working',
    state: 'running',
    reason: 'working',
    // "✽ Calculating… (6s · ↓ 92 tokens)" is working; "✻ Churned for 20s · done"
    // is finished and uses the SAME glyph -- the ellipsis is the discriminator.
    test: (s) => CLAUDE_SPINNER.test(s) || /esc to interrupt/i.test(s),
  },
  {
    id: 'claude-tool',
    state: 'running',
    reason: 'tool call in flight',
    test: (s) => /⎿\s+[A-Za-z][A-Za-z'’]*…/.test(s) || /\bcompacting conversation/i.test(s),
  },
];

const PROFILES = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    binEnv: 'SEAMUX_CLAUDE_BIN',
    instructions: { mode: 'flag', flag: '--append-system-prompt' },
    prompt: { mode: 'positional' },
    globalRules: '~/.claude/CLAUDE.md',
    rules: CLAUDE_RULES,
    verified: true,
  },

  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    binEnv: 'SEAMUX_GEMINI_BIN',
    // No --append-system-prompt equivalent; standing rules go in GEMINI.md.
    instructions: { mode: 'none' },
    // The positional argument is ONE-SHOT. -i runs the prompt and stays
    // interactive, which is what a session needs.
    prompt: { mode: 'flag', flag: '-i' },
    globalRules: '~/.gemini/GEMINI.md',
    rules: [],
    verified: false,
  },

  shell: {
    id: 'shell',
    label: 'Shell',
    command: process.env.SHELL || '/bin/zsh',
    instructions: { mode: 'none' },
    prompt: { mode: 'none' },
    globalRules: null,
    rules: [],
    verified: true,
  },

  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    binEnv: 'SEAMUX_CODEX_BIN',
    instructions: { mode: 'none' },
    prompt: { mode: 'positional' },
    globalRules: '~/.codex/AGENTS.md',
    rules: [],
    // Not installed on this machine, so nothing here was observed. Generic
    // detection only, and the UI says so rather than implying it was checked.
    verified: false,
    unverifiedNote: 'Not installed here, so its flags and output were never observed. '
      + 'Detection falls back to the generic rules; check with ⌘D and tell Seamux what you see.',
  },
};

/** A user-defined profile stored in config; same shape, nothing special. */
function customProfile(def) {
  return {
    id: def.id,
    label: def.label || def.command,
    command: def.command,
    args: def.args || [],
    instructions: def.instructionFlag
      ? { mode: 'flag', flag: def.instructionFlag }
      : { mode: 'none' },
    prompt: def.promptFlag
      ? { mode: 'flag', flag: def.promptFlag }
      : (def.promptPositional ? { mode: 'positional' } : { mode: 'none' }),
    globalRules: def.globalRules || null,
    rules: [],
    verified: false,
    custom: true,
  };
}

function get(id, customs = []) {
  if (PROFILES[id]) return PROFILES[id];
  const c = (customs || []).find((x) => x.id === id);
  return c ? customProfile(c) : PROFILES.claude;
}

function list(customs = []) {
  return [...Object.values(PROFILES), ...(customs || []).map(customProfile)];
}

/** Resolve the binary, honouring the profile's env override. */
function commandFor(profile) {
  return (profile.binEnv && process.env[profile.binEnv]) || profile.command;
}

/** Build argv for a spawn: options first, then a positional prompt last. */
function buildArgs(profile, { instructions = [], prePrompts = [], extra = [] } = {}) {
  const args = [...(profile.args || []), ...extra];

  if (instructions.length && profile.instructions.mode === 'flag') {
    args.push(profile.instructions.flag, instructions.join('\n\n'));
  }
  if (prePrompts.length) {
    const text = prePrompts.join('\n\n');
    if (profile.prompt.mode === 'flag') args.push(profile.prompt.flag, text);
    else if (profile.prompt.mode === 'positional') args.push(text);
  }
  return args;
}

/** What a profile cannot carry, so the UI can say so instead of silently dropping it. */
function unsupported(profile) {
  const out = [];
  if (profile.instructions.mode === 'none') out.push('standing instructions');
  if (profile.prompt.mode === 'none') out.push('opening prompt');
  return out;
}

module.exports = { PROFILES, get, list, commandFor, buildArgs, unsupported, customProfile, expand };
