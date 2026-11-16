'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// One git worktree per task, so tasks running at the same time in the same
// project never edit the same files. Seamux creates the folder itself, under
// its own data directory, so two tasks can never share a path.
//
// Safety rules:
// - A branch is never deleted. Removing a worktree keeps its branch, and
//   with it every commit the agent made.
// - A worktree with uncommitted or untracked changes is never removed.
// - Nothing here touches the main checkout's files, index or branch.

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_NEW_FILE_BYTES = 200 * 1024;

function git(cwd, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message || '').trim() || `git ${args[0]} failed`);
        e.code = err.code;
        reject(e);
      } else resolve(stdout);
    });
  });
}

/** Does the repository have a first commit to branch from? */
async function hasCommits(cwd) {
  try { await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']); return true; } catch { return false; }
}

/** The repository's top folder, or null when the folder is not in a git repository. */
async function repoRoot(cwd) {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

function slugify(title) {
  return String(title || 'task')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

/**
 * Create the worktree for a task.
 * @param {object} o
 * @param {string} o.projectCwd  the project's folder (may be below the repo root)
 * @param {object} o.task        { id, title }
 * @param {string} o.baseDir     where Seamux keeps worktrees
 * @param {string} [o.name]      reuse an earlier folder and branch name
 * @returns {Promise<{path, branch, base, runCwd, root}>}
 */
async function create({ projectCwd, task, baseDir, name: given }) {
  const root = await repoRoot(projectCwd);
  if (!root) throw new Error('this project is not a git repository');
  // Folders resolve through symlinks (e.g. /tmp -> /private/tmp), so compare real paths.
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(projectCwd));
  if (!(await hasCommits(root))) throw new Error('the repository has no commits yet; make a first commit, or run the task in the project folder');
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  // A worktree folder deleted by hand is still registered with git until
  // pruned, and would block adding it again. Prune only forgets worktrees
  // whose folders are gone.
  await git(root, ['worktree', 'prune']);
  const short = task.id.replace(/^t_/, '').slice(0, 6);
  const name = given || `${slugify(task.title)}-${short}`;
  const projectKey = `${path.basename(root)}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 6)}`;
  const wtPath = path.join(baseDir, projectKey, name);
  const branch = `seamux/${name}`;
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  if (fs.existsSync(wtPath)) throw new Error(`a folder is already in the way: ${wtPath}`);

  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  // An existing branch (an earlier worktree for this task was removed) is
  // checked out again rather than recreated, so its commits are kept.
  if (exists) await git(root, ['worktree', 'add', wtPath, branch]);
  else await git(root, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { path: wtPath, branch, base, runCwd: rel ? path.join(wtPath, rel) : wtPath, root };
}

/** Untracked files, honouring .gitignore. */
async function untracked(wt) {
  const out = await git(wt, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/** Files and lines changed since the task started, committed or not. */
async function stat(wt, base) {
  const numstat = await git(wt, ['diff', '--numstat', base]);
  let added = 0; let removed = 0; let files = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    files++;
    if (a !== '-') added += Number(a) || 0;
    if (d !== '-') removed += Number(d) || 0;
  }
  for (const f of await untracked(wt)) {
    files++;
    try {
      const buf = fs.readFileSync(path.join(wt, f));
      if (!buf.includes(0)) added += buf.toString('utf8').split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1).length;
    } catch { /* gone */ }
  }
  return { files, added, removed };
}

/**
 * The change since the task started as unified diff text: tracked changes
 * (committed and uncommitted) against the base, then each untracked file as
 * a new file.
 */
async function diff(wt, base) {
  let text = await git(wt, ['diff', '--no-color', base], { maxBuffer: MAX_DIFF_BYTES * 4 });
  for (const f of await untracked(wt)) {
    let body = '';
    try {
      const buf = fs.readFileSync(path.join(wt, f));
      if (buf.includes(0)) body = 'Binary file\n';
      else if (buf.length > MAX_NEW_FILE_BYTES) body = `New file of ${buf.length} bytes, too large to show\n`;
      else {
        const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
        body = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
      }
    } catch { body = 'Could not read the file\n'; }
    text += `diff --git a/${f} b/${f}\nnew file (not yet added)\n--- /dev/null\n+++ b/${f}\n${body}`;
  }
  const truncated = text.length > MAX_DIFF_BYTES;
  return { text: truncated ? text.slice(0, MAX_DIFF_BYTES) : text, truncated };
}

/** Uncommitted or untracked changes in the worktree? */
async function dirty(wt) {
  return (await git(wt, ['status', '--porcelain'])).trim().length > 0;
}

/**
 * Remove a task's worktree folder. Refused while it has uncommitted or
 * untracked changes. The branch is always kept.
 */
async function remove({ root, path: wtPath, branch }) {
  if (fs.existsSync(wtPath) && await dirty(wtPath)) {
    throw new Error('the worktree has changes that are not committed; commit or discard them first');
  }
  await git(root, ['worktree', 'remove', wtPath]);
  return { removed: wtPath, branchKept: branch };
}

module.exports = { repoRoot, hasCommits, create, stat, diff, dirty, remove, slugify };
