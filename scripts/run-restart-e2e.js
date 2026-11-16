#!/usr/bin/env node
'use strict';
/**
 * Runs the app twice on one data folder: part A sets up a busy board and
 * quits, part B starts again and checks what came back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-restart-ud-'));
const run = (file) => spawnSync(process.execPath, [path.join(__dirname, 'run-board-e2e.js'), path.join(__dirname, '..', 'test', 'campaign', file)],
  { stdio: 'inherit', env: { ...process.env, SEAMUX_KEEP_UD: ud } }).status;
const a = run('restart-a.e2e.js');
const b = a === 0 ? run('restart-b.e2e.js') : 1;
fs.rmSync(ud, { recursive: true, force: true });
process.exit(a || b ? 1 : 0);
