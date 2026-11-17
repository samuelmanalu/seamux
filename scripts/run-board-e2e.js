#!/usr/bin/env node
'use strict';
/**
 * The board e2e needs a stub literally named `claude` on PATH, not passed
 * through SEAMUX_CLAUDE_BIN: only a binary called `claude` gets --session-id
 * and --resume, and those are what this suite checks. The stub prints its
 * arguments and then stays alive like an interactive agent would.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-stub-'));
for (const name of ['claude', 'gemini']) {
  fs.writeFileSync(path.join(stubDir, name),
    '#!/bin/bash\nprintf "STUB_ARGS:[%s]\\n" "$*"\nexec /bin/bash --norc -i\n', { mode: 0o755 });
}

const env = { ...process.env };
delete env.SEAMUX_CLAUDE_BIN;
const r = spawnSync(require('electron'), ['.'], {
  stdio: 'inherit',
  env: {
    ...env,
    PATH: `${stubDir}:${process.env.PATH}`,
    SHELL: '/bin/bash',
    SEAMUX_GEMINI_BIN: path.join(stubDir, 'gemini'),
    // SEAMUX_KEEP_UD reuses one data folder across runs (the restart suite).
    SEAMUX_USER_DATA: process.env.SEAMUX_KEEP_UD || fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-ud-')),
    // Another suite can reuse these stubs: node scripts/run-board-e2e.js test/x.e2e.js
    SEAMUX_E2E: path.resolve(process.argv[2] || path.join(__dirname, '..', 'test', 'board.e2e.js')),
  },
});
fs.rmSync(stubDir, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
