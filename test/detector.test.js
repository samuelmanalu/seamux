'use strict';

/**
 * Rules run against REAL Claude Code screens captured from a live session
 * (test/fixtures/*.txt). Synthetic strings hid two false negatives here:
 * "esc to interrupt" never appears in real output, and the trust dialog uses a
 * bare "❯ " cursor with no numbering. Fixtures are the guard against that.
 *
 * Run: node test/detector.test.js
 */

const fs = require('fs');
const path = require('path');
const { classify: rawClassify } = require('../src/main/status-detector');
const { PROFILES } = require('../src/main/profiles');

// Claude-specific rules now live in its profile; the detector itself is generic.
const classify = (screen, ctx) => rawClassify(screen, ctx, PROFILES.claude.rules);

const FIX = path.join(__dirname, 'fixtures');
const read = (n) => fs.readFileSync(path.join(FIX, n + '.txt'), 'utf8');

let fails = 0;
function check(name, got, want, extra) {
  const ok = got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${got} want=${want}`) + (extra || ''));
  if (!ok) fails++;
}

// --- real screens, quiet (so nothing is rescued by the streaming fallback) ---
const QUIET = { msSinceOutput: 9999 };

const fixtures = [
  ['trust-prompt',      'needs_input'],
  ['permission-prompt', 'needs_input'],
  ['working-spinner',   'running'],
  ['idle-prompt-box',   'idle'],
  ['turn-complete',     'idle'],
];

console.log('--- real captured screens ---');
for (const [name, want] of fixtures) {
  const v = classify(read(name), QUIET);
  check(name, v.state, want, `  [rule=${v.rule || '-'}]`);
}

// The two states that must never be confused: both carry the same glyph and
// differ only by the ellipsis.
console.log('\n--- working vs complete must not collapse ---');
check('working !== complete',
  classify(read('working-spinner'), QUIET).state === classify(read('turn-complete'), QUIET).state
    ? 'same' : 'different', 'different');

// --- synthetic edge cases ---
console.log('\n--- edge cases ---');
const pad = (s, n) => s + '\n'.repeat(n);
const cases = [
  ['y/n below cursor padding', pad('Overwrite? (y/n) ', 30), QUIET, 'needs_input'],
  ['spinner below cursor padding', pad('✽ Calculating… (6s)', 30), QUIET, 'running'],
  ['streaming output', 'chunk', { msSinceOutput: 100 }, 'running'],
  ['bell at quiet prompt', '> ', { msSinceOutput: 9999, bellPending: true }, 'needs_input'],
  ['exited wins over everything', '✽ Calculating… (6s)', { exited: true }, 'exited'],
  ['completion line alone is not running', '✻ Churned for 20s · done 11:11 AM', QUIET, 'idle'],
  ['tool progress line is running', '⎿  Running…', QUIET, 'running'],
  ['stale content above the window is ignored', 'Do you want to?' + '\nx'.repeat(40), QUIET, 'idle'],
];
for (const [name, screen, ctx, want] of cases) {
  check(name, classify(screen, ctx).state, want);
}

console.log(fails === 0 ? '\nDETECTOR: ALL PASSED' : `\nDETECTOR: ${fails} FAILED`);
process.exit(fails ? 1 : 0);
