#!/usr/bin/env node
'use strict';
/**
 * The end-to-end campaign: every scenario and edge case suite, the
 * independent ones in parallel (each its own app and data folder), then the
 * restart pair. Prints one summary line per suite.
 */
const path = require('path');
const { spawn } = require('child_process');

const runOne = (label, args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ label, code, out }));
});

(async () => {
  const board = path.join(__dirname, 'run-board-e2e.js');
  const suite = (f) => path.join(__dirname, '..', 'test', 'campaign', f);
  const parallel = await Promise.all([
    runOne('lifecycle', [board, suite('lifecycle.e2e.js')]),
    runOne('rules and knowledge', [board, suite('rules-knowledge.e2e.js')]),
    runOne('worktrees, planner, hooks', [board, suite('worktree-planner-hooks.e2e.js')]),
    runOne('time and focus', [board, suite('time-focus.e2e.js')], { SEAMUX_TIME_TICK_MS: '300', SEAMUX_AWAY_SECONDS: '100000' }),
  ]);
  const restart = await runOne('restart', [path.join(__dirname, 'run-restart-e2e.js')]);
  let failed = 0;
  for (const r of [...parallel, restart]) {
    const lines = r.out.split('\n');
    const summary = lines.filter((l) => /PASSED|FAILED/.test(l)).join(' | ');
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.label}: ${summary}`);
    if (r.code !== 0) { failed++; console.log(lines.filter((l) => /^FAIL/.test(l)).join('\n')); }
  }
  process.exit(failed ? 1 : 0);
})();
