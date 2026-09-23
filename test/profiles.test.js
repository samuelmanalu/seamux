'use strict';
/**
 * The profile system is what makes Seamux agent-agnostic, so the differences
 * between agents are the thing worth pinning down — especially Gemini, whose
 * positional argument runs ONE-SHOT and would silently end the session if it
 * were treated like Claude's.
 */
const fs = require('fs');
const path = require('path');
const profiles = require('../src/main/profiles');
const { classify } = require('../src/main/status-detector');

let fails = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  if (!ok) fails++;
};
const ok = (n, c, d) => { console.log((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };

const I = ['always use stage'];
const P = ['summarise the open MRs'];

/* ---- Claude: instruction flag, positional prompt LAST ---- */
const claude = profiles.get('claude');
eq('claude passes instructions via --append-system-prompt',
  profiles.buildArgs(claude, { instructions: I }), ['--append-system-prompt', 'always use stage']);
eq('claude passes the opening prompt positionally',
  profiles.buildArgs(claude, { prePrompts: P }), ['summarise the open MRs']);
const both = profiles.buildArgs(claude, { instructions: I, prePrompts: P });
eq('claude puts options before the positional prompt',
  both, ['--append-system-prompt', 'always use stage', 'summarise the open MRs']);
ok('the positional prompt is last', both[both.length - 1] === P[0]);
eq('claude supports everything', profiles.unsupported(claude), []);

/* ---- Gemini: no instruction flag, prompt via -i ---- */
const gemini = profiles.get('gemini');
eq('gemini uses -i so the session stays interactive',
  profiles.buildArgs(gemini, { prePrompts: P }), ['-i', 'summarise the open MRs']);
ok('gemini never emits a bare positional prompt (that would run one-shot)',
  !profiles.buildArgs(gemini, { prePrompts: P }).some((a, i, arr) => a === P[0] && arr[i - 1] !== '-i'));
eq('gemini drops standing instructions', profiles.buildArgs(gemini, { instructions: I }), []);
eq('gemini reports what it cannot carry', profiles.unsupported(gemini), ['standing instructions']);
eq('gemini reads GEMINI.md', gemini.globalRules, '~/.gemini/GEMINI.md');

/* ---- Shell: carries neither ---- */
const shell = profiles.get('shell');
eq('shell takes no context flags', profiles.buildArgs(shell, { instructions: I, prePrompts: P }), []);
eq('shell reports both as unsupported',
  profiles.unsupported(shell), ['standing instructions', 'opening prompt']);
eq('shell has no global rules file', shell.globalRules, null);

/* ---- Codex is present but honestly marked ---- */
const codex = profiles.get('codex');
ok('codex is flagged unverified', codex.verified === false);
ok('codex says why', /not installed/i.test(codex.unverifiedNote || ''));
eq('codex ships no invented detection rules', codex.rules, []);

/* ---- Custom ---- */
const custom = profiles.customProfile({
  id: 'aider', label: 'Aider', command: 'aider',
  instructionFlag: '--message', promptPositional: true,
});
eq('custom honours its instruction flag',
  profiles.buildArgs(custom, { instructions: I }), ['--message', 'always use stage']);
eq('custom honours a positional prompt',
  profiles.buildArgs(custom, { prePrompts: P }), ['summarise the open MRs']);

/* ---- binary override ---- */
const saved = process.env.SEAMUX_CLAUDE_BIN;
process.env.SEAMUX_CLAUDE_BIN = '/tmp/fake-claude';
eq('binEnv overrides the command', profiles.commandFor(claude), '/tmp/fake-claude');
if (saved === undefined) delete process.env.SEAMUX_CLAUDE_BIN; else process.env.SEAMUX_CLAUDE_BIN = saved;

/* ---- extra args come first, before any positional ---- */
const withExtra = profiles.buildArgs(claude, { prePrompts: P, extra: ['--continue'] });
eq('extra flags precede the positional prompt', withExtra, ['--continue', 'summarise the open MRs']);

/* ---- detection: generic rules must handle a real non-Claude screen ---- */
const gem = fs.readFileSync(path.join(__dirname, 'fixtures', 'gemini-auth-menu.txt'), 'utf8');
eq('gemini auth menu is detected as needing input (generic rules, no profile rules)',
  classify(gem, { msSinceOutput: 9999 }, gemini.rules).state, 'needs_input');
eq('a braille spinner reads as running anywhere',
  classify('⠹ Working on it', { msSinceOutput: 9999 }).state, 'running');
eq('claude rules do not leak into other profiles',
  classify('✽ Calculating… (6s)', { msSinceOutput: 9999 }, shell.rules).state, 'idle');
eq('claude rules apply under the claude profile',
  classify('✽ Calculating… (6s)', { msSinceOutput: 9999 }, claude.rules).state, 'running');

/* ---- listing ---- */
const all = profiles.list([{ id: 'x', label: 'X', command: 'x' }]);
ok('built-ins and customs are listed together', all.length === 5, String(all.length));

console.log(fails === 0 ? '\nPROFILES: ALL PASSED' : `\nPROFILES: ${fails} FAILED`);
process.exit(fails ? 1 : 0);
