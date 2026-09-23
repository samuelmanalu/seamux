#!/usr/bin/env node
'use strict';
/**
 * The general-context e2e needs two things a plain npm script cannot express:
 * a stub binary literally named `claude` (so --append-system-prompt is added
 * and its arguments are observable) and a seeded, isolated CLAUDE.md.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-stub-'));
const stub = path.join(stubDir, 'claude');
fs.writeFileSync(stub, '#!/bin/bash\necho "STUB_ARGS:[$@]"\nexec /bin/bash --norc -i\n', { mode: 0o755 });

const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-gc-e2e-'));
const gc = path.join(gcDir, 'CLAUDE.md');
fs.writeFileSync(gc, '# Rules\n\nORIGINAL RULE: always be careful.\n');

const r = spawnSync(require('electron'), ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SEAMUX_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-ud-')),
    SEAMUX_GENERAL_CONTEXT: gc,
    SEAMUX_CLAUDE_BIN: stub,
    SEAMUX_E2E: path.resolve(__dirname, '..', 'test', 'general.e2e.js'),
  },
});
fs.rmSync(stubDir, { recursive: true, force: true });
fs.rmSync(gcDir, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
