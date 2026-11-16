'use strict';

// Worktrees on a real throwaway git repository: creation (also for a project
// below the repo root), stats and diffs across committed, uncommitted and new
// files, refusal to remove a dirty worktree, and branches always kept.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('../src/main/worktree');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-wt-')));
const repo = path.join(tmp, 'repo');
const base = path.join(tmp, 'worktrees');
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
g(tmp, 'init', '-q', '-b', 'main', repo);
g(repo, 'config', 'user.email', 'test@example.com');
g(repo, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(repo, 'README.md'), 'one\ntwo\n');
fs.writeFileSync(path.join(repo, 'app', 'main.js'), 'a\n');
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'init');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('slugs are short and safe', () => {
  assert.strictEqual(wt.slugify('Fix cart total — rounding (€)!'), 'fix-cart-total-rounding');
  assert.strictEqual(wt.slugify(''), 'task');
});

test('not a repository: no root, and create refuses', async () => {
  assert.strictEqual(await wt.repoRoot(tmp), null);
  await assert.rejects(wt.create({ projectCwd: tmp, task: { id: 't_aaaaaa1111', title: 'x' }, baseDir: base }), /not a git repository/);
});

let w1;
test('creates a worktree on a new branch from HEAD, outside the repo', async () => {
  w1 = await wt.create({ projectCwd: repo, task: { id: 't_abc123def0', title: 'Fix rounding' }, baseDir: base });
  assert.strictEqual(w1.branch, 'seamux/fix-rounding-abc123');
  assert.ok(w1.path.startsWith(base), w1.path);
  assert.strictEqual(w1.runCwd, w1.path);
  assert.strictEqual(w1.base, g(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(g(w1.path, 'branch', '--show-current'), 'seamux/fix-rounding-abc123');
  assert.strictEqual(g(repo, 'branch', '--show-current'), 'main', 'the main checkout is untouched');
});

test('a project below the repo root runs in the same subfolder of the worktree', async () => {
  const w = await wt.create({ projectCwd: path.join(repo, 'app'), task: { id: 't_sub0000000', title: 'Sub' }, baseDir: base });
  assert.strictEqual(w.runCwd, path.join(w.path, 'app'));
  assert.ok(fs.existsSync(path.join(w.runCwd, 'main.js')));
});

test('stats and diff cover committed, uncommitted and new files; ignored files stay out', async () => {
  fs.writeFileSync(path.join(w1.path, 'README.md'), 'one\nTWO\nthree\n');
  g(w1.path, 'commit', '-q', '-am', 'edit readme');
  fs.writeFileSync(path.join(w1.path, 'app', 'main.js'), 'a\nb\n');           // uncommitted
  fs.writeFileSync(path.join(w1.path, 'new.txt'), 'x\ny\n');                  // untracked
  fs.mkdirSync(path.join(w1.path, 'node_modules'));
  fs.writeFileSync(path.join(w1.path, 'node_modules', 'dep.js'), 'ignored\n'); // ignored
  const s = await wt.stat(w1.path, w1.base);
  assert.deepStrictEqual(s, { files: 3, added: 5, removed: 1 });
  const d = await wt.diff(w1.path, w1.base);
  assert.ok(/\+TWO/.test(d.text) && /\+three/.test(d.text), 'committed change');
  assert.ok(/\+b/.test(d.text), 'uncommitted change');
  assert.ok(/\+\+\+ b\/new\.txt[\s\S]*\+x\n\+y/.test(d.text), 'new file');
  assert.ok(!/node_modules/.test(d.text), 'ignored file left out');
  assert.strictEqual(d.truncated, false);
});

test('a dirty worktree is not removed', async () => {
  assert.strictEqual(await wt.dirty(w1.path), true);
  await assert.rejects(wt.remove(w1), /not committed/);
  assert.ok(fs.existsSync(w1.path));
});

test('a clean worktree is removed and its branch kept', async () => {
  g(w1.path, 'add', '-A');
  g(w1.path, 'commit', '-q', '-m', 'rest');
  const r = await wt.remove(w1);
  assert.strictEqual(r.branchKept, 'seamux/fix-rounding-abc123');
  assert.ok(!fs.existsSync(w1.path));
  assert.ok(g(repo, 'branch', '--list', 'seamux/fix-rounding-abc123').includes('seamux/fix-rounding-abc123'));
});

test('recreating a removed task worktree checks out its kept branch with its commits', async () => {
  const again = await wt.create({ projectCwd: repo, task: { id: 't_abc123def0', title: 'Fix rounding' }, baseDir: base });
  assert.strictEqual(again.branch, 'seamux/fix-rounding-abc123');
  assert.ok(/rest/.test(g(again.path, 'log', '--oneline', '-1')), 'earlier commits are there');
});

test('a given name is reused even if the title changed', async () => {
  const w = await wt.create({ projectCwd: repo, task: { id: 't_ren0000000', title: 'Old title' }, baseDir: base });
  g(repo, 'worktree', 'remove', w.path);
  const again = await wt.create({ projectCwd: repo, task: { id: 't_ren0000000', title: 'New title' }, baseDir: base, name: path.basename(w.path) });
  assert.strictEqual(again.path, w.path);
  assert.strictEqual(again.branch, w.branch);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS  ${name}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`WORKTREE: ALL ${tests.length} PASSED`);
})().catch((e) => { console.error(e); process.exit(1); });
