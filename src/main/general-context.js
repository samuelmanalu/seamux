'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * General context: the rules every Claude session gets, i.e. the global
 * CLAUDE.md that Claude Code reads at startup.
 *
 * This edits a file the user already owns and relies on -- 85 lines of real
 * working rules in this case. So: never write without an explicit confirmation
 * showing a diff, always take a timestamped backup first, and never silently
 * create the file if the path looks wrong.
 */
const DEFAULT_PATH = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const MAX_BACKUPS = 20;

class GeneralContext {
  constructor(file) {
    this.file = file || DEFAULT_PATH;
    this.backupDir = path.join(path.dirname(this.file), 'seamux-backups');
  }

  read() {
    // Some agents (a plain shell) have no global-rules file at all.
    if (!this.file) {
      return { file: null, exists: false, content: '', bytes: 0, lines: 0, mtime: null, supported: false };
    }
    let content = '';
    let exists = true;
    try {
      content = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') exists = false;
      else throw err;
    }
    return {
      file: this.file,
      exists,
      content,
      bytes: Buffer.byteLength(content),
      lines: content ? content.split('\n').length : 0,
      mtime: exists ? fs.statSync(this.file).mtimeMs : null,
    };
  }

  /** What would change, for the confirmation box. Nothing is written. */
  preview(next) {
    const current = this.read();
    const diff = diffLines(current.content, String(next == null ? '' : next));
    return {
      file: this.file,
      exists: current.exists,
      unchanged: diff.added === 0 && diff.removed === 0,
      ...diff,
      currentBytes: current.bytes,
      nextBytes: Buffer.byteLength(String(next == null ? '' : next)),
    };
  }

  /**
   * @param {string} next
   * @param {number|null} expectedMtime  guards against overwriting an edit made
   *        outside Seamux since the editor was opened
   */
  write(next, expectedMtime) {
    const current = this.read();
    if (current.exists && expectedMtime != null && current.mtime !== expectedMtime) {
      const err = new Error('This file changed outside Seamux since you opened it. Reopen it to see the current version.');
      err.code = 'STALE';
      throw err;
    }

    let backup = null;
    if (current.exists) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(this.backupDir, `CLAUDE.md.${stamp}`);
      fs.writeFileSync(backup, current.content);
      this._pruneBackups();
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, String(next == null ? '' : next));
    return { ...this.read(), backup };
  }

  backups() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter((f) => f.startsWith('CLAUDE.md.'))
        .sort().reverse()
        .map((f) => ({ name: f, path: path.join(this.backupDir, f) }));
    } catch { return []; }
  }

  restore(name) {
    const b = this.backups().find((x) => x.name === name);
    if (!b) throw new Error('backup not found');
    return this.write(fs.readFileSync(b.path, 'utf8'), null);
  }

  _pruneBackups() {
    const all = this.backups();
    for (const b of all.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(b.path); } catch { /* best effort */ }
    }
  }
}

/**
 * Line diff via longest common subsequence. Small inputs (a CLAUDE.md), so the
 * O(n*m) table is fine and the result is exact rather than heuristic.
 */
function diffLines(a, b) {
  const A = String(a == null ? '' : a).split('\n');
  const B = String(b == null ? '' : b).split('\n');

  const n = A.length, m = B.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const hunks = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { hunks.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { hunks.push({ type: 'removed', text: A[i] }); removed++; i++; }
    else { hunks.push({ type: 'added', text: B[j] }); added++; j++; }
  }
  while (i < n) { hunks.push({ type: 'removed', text: A[i++] }); removed++; }
  while (j < m) { hunks.push({ type: 'added', text: B[j++] }); added++; }

  return { hunks, added, removed };
}

module.exports = { GeneralContext, diffLines, DEFAULT_PATH };
