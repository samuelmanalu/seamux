'use strict';

const { execFile } = require('child_process');

// Jejak's one sanctioned interface is its `jejak` command (a client of the
// Jejak server); never reach into its storage directly. Found on PATH, which
// main.js widens to the login shell's PATH so a Dock launch finds
// ~/.local/bin too. SEAMUX_JEJAK_BIN swaps in a fake for tests.
function jejakBin() {
  return process.env.SEAMUX_JEJAK_BIN || 'jejak';
}

/**
 * Artifacts (published Artifacts + written documents) that Jejak indexed for
 * a given Claude Code session id: `artifact`-type memories in that session.
 * Needs the full session id; Jejak does not match on a prefix.
 *
 * Returns { ok, artifacts, error }. Never rejects: Jejak being unavailable
 * (not installed, server down, not signed in) should degrade the panel,
 * not the app.
 */
function artifactsForSession(sessionId) {
  return new Promise((resolve) => {
    if (!sessionId) { resolve({ ok: true, artifacts: [] }); return; }
    execFile(
      jejakBin(),
      ['session', sessionId, '--json'],
      { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const error = err.code === 'ENOENT'
            ? 'the `jejak` command was not found on PATH'
            : (stderr || err.message || 'jejak failed').trim().slice(0, 500);
          resolve({ ok: false, artifacts: [], error });
          return;
        }
        try {
          const all = JSON.parse(stdout);
          if (!Array.isArray(all)) throw new Error('expected a list');
          resolve({ ok: true, artifacts: all.filter((m) => m && m.type === 'artifact') });
        } catch (e) {
          resolve({ ok: false, artifacts: [], error: 'bad JSON from jejak: ' + e.message });
        }
      },
    );
  });
}

module.exports = { artifactsForSession };
