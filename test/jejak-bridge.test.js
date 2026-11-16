'use strict';

// jejak-bridge against a fake `jejak` (SEAMUX_JEJAK_BIN): filtering, the
// arguments it passes, and every failure degrading to { ok: false } instead
// of rejecting.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { artifactsForSession } = require('../src/main/jejak-bridge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-jejak-'));

function fake(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const records = JSON.stringify([
  { id: 'a', type: 'artifact', content: 'Artifact: Plan (https://claude.ai/artifact/x)' },
  { id: 'b', type: 'decision', content: 'not an artifact' },
  { id: 'c', type: 'artifact', content: 'Document: Notes (~/notes.md)' },
]);

(async () => {
  let r = await artifactsForSession(null);
  assert.deepStrictEqual(r, { ok: true, artifacts: [] }, 'no session id -> empty, no call');

  process.env.SEAMUX_JEJAK_BIN = fake('ok', `[ "$1 $3" = "session --json" ] || exit 9\nprintf '%s' '${records}'`);
  r = await artifactsForSession('11111111-2222-3333-4444-555555555555');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.artifacts.map((a) => a.id), ['a', 'c'], 'only artifact-type records');

  process.env.SEAMUX_JEJAK_BIN = fake('down', "echo 'Error: Cannot reach the Jejak server' >&2; exit 1");
  r = await artifactsForSession('s');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Cannot reach the Jejak server/);

  process.env.SEAMUX_JEJAK_BIN = fake('garbage', "echo 'not json'");
  r = await artifactsForSession('s');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bad JSON/);

  process.env.SEAMUX_JEJAK_BIN = path.join(dir, 'missing');
  r = await artifactsForSession('s');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found on PATH/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('jejak-bridge: ok');
})().catch((e) => { console.error(e); process.exit(1); });
