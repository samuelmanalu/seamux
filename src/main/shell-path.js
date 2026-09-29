'use strict';

const { execFileSync } = require('child_process');

// An app opened from the Dock, Finder or Spotlight inherits launchd's PATH,
// /usr/bin:/bin:/usr/sbin:/sbin, not your shell's. `claude` usually lives in
// ~/.local/bin or /opt/homebrew/bin, so every session failed with ENOENT.
// Ask the user's shell for its PATH instead. Interactive (-i) as well as login
// (-l), because installers commonly put their PATH line in ~/.zshrc, which a
// non-interactive zsh never reads.

const MARK = '__SEAMUX_PATH__';

/** The login shell's PATH, or null if it cannot be read in time. */
function loginShellPath(shell = process.env.SHELL || '/bin/zsh', timeout = 5000) {
  try {
    const out = execFileSync(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
      encoding: 'utf8',
      timeout,
      // Rc files may print banners or read stdin; markers find the value
      // among any noise, and a closed stdin keeps a prompt from hanging us.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePath(out);
  } catch {
    return null;
  }
}

function parsePath(out) {
  const m = String(out).match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Join PATH strings in priority order, keeping each directory's first place. */
function mergePath(...paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    for (const dir of String(p || '').split(':')) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out.join(':');
}

module.exports = { loginShellPath, parsePath, mergePath };
