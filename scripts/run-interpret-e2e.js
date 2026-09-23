#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');

// A stub named `claude`: answers `-p` with the model JSON, otherwise behaves
// like a session and echoes the arguments it was launched with.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-istub-'));
const stub = path.join(dir, 'claude');
fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "-p" ]; then
  cat <<'JSON'
{"name":"Stage DB","variables":{"DB_PASSWORD":"«V1»"},"instructions":"Always stage.","preprompt":"Summarise MRs.","notes":""}
JSON
  exit 0
fi
echo "STUB_ARGS:[$@]"
exec /bin/bash --norc -i
`, { mode: 0o755 });

const r = spawnSync(require('electron'), ['.'], {
  stdio: 'inherit',
  env: { ...process.env,
    SEAMUX_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-ud-')),
    SEAMUX_CLAUDE_BIN: stub,
    SEAMUX_E2E: path.resolve(__dirname, '..', 'test', 'interpret.e2e.js') },
});
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
