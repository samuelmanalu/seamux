'use strict';

// extractNextStep on real captured Claude Code screens and on edge cases.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extractNextStep } = require('../src/main/next-step');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

ok('takes the last assistant message, not the tool call', () => {
  assert.strictEqual(extractNextStep(fx('turn-complete.txt'), 'claude'), 'Ran it — output was OK.');
});

ok('joins continuation lines and strips markdown', () => {
  const screen = [
    '⏺ Read(src/a.js)',
    '  ⎿  Read 40 lines',
    '',
    '⏺ Removed **ReportScheduler**. Three config keys are still read',
    '  elsewhere: `report.export.cron` and two more.',
    '  Which of these should I drop?',
    '',
    '❯ ',
  ].join('\n');
  assert.strictEqual(extractNextStep(screen, 'claude'),
    'Removed ReportScheduler. Three config keys are still read elsewhere: report.export.cron and two more. Which of these should I drop?');
});

ok('skips namespaced tool calls', () => {
  const screen = '⏺ Done with the first part.\n\n⏺ mcp__jejak__jejak_save(type: "x")\n  ⎿  Saved';
  assert.strictEqual(extractNextStep(screen, 'claude'), 'Done with the first part.');
});

ok('caps very long messages', () => {
  const out = extractNextStep(`⏺ ${'word '.repeat(200)}`, 'claude');
  assert.ok(out.length <= 240 && out.endsWith('…'));
});

ok('returns null when there is no assistant message', () => {
  assert.strictEqual(extractNextStep(fx('idle-prompt-box.txt'), 'claude'), null);
  assert.strictEqual(extractNextStep('', 'claude'), null);
});

ok('does not guess for other agents', () => {
  assert.strictEqual(extractNextStep(fx('turn-complete.txt'), 'gemini'), null);
});

console.log(`NEXT STEP: ALL ${n} PASSED`);
