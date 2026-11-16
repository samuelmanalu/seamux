'use strict';

// The board model on its own: tasks, statuses, limits, queue order, and what
// happens to a task's state across an app restart.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Board, openingPrompt, rulesText, DEFAULT_PROJECT_LIMIT, DEFAULT_GLOBAL_LIMIT } = require('../src/main/board');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-board-'));
const file = path.join(dir, 'board.json');
let results = 0;
const ok = (name, fn) => { fn(); results++; console.log(`PASS  ${name}`); };

ok('starts empty with default limits', () => {
  const b = new Board(file);
  assert.deepStrictEqual(b.list(), []);
  assert.strictEqual(b.limitFor('/p'), DEFAULT_PROJECT_LIMIT);
  assert.strictEqual(b.globalLimit(), DEFAULT_GLOBAL_LIMIT);
});

ok('creates a task in Ready by default, trimmed, with an id', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: '  Fix rounding  ', brief: ' cart total ' });
  assert.match(t.id, /^t_[0-9a-f]{10}$/);
  assert.strictEqual(t.title, 'Fix rounding');
  assert.strictEqual(t.brief, 'cart total');
  assert.strictEqual(t.status, 'ready');
  assert.strictEqual(t.agent, null);
  assert.strictEqual(t.sessionId, null);
});

ok('rejects a task without a title or project', () => {
  const b = new Board(file);
  assert.throws(() => b.create({ cwd: '/p', title: '  ' }), /title/);
  assert.throws(() => b.create({ title: 'x' }), /project/);
});

ok('only backlog or ready are allowed at creation', () => {
  const b = new Board(file);
  assert.strictEqual(b.create({ cwd: '/p', title: 'x', status: 'backlog' }).status, 'backlog');
  assert.strictEqual(b.create({ cwd: '/p', title: 'y', status: 'active' }).status, 'ready');
});

ok('persists across instances', () => {
  const a = new Board(file);
  const n = a.list().length;
  const b = new Board(file);
  assert.strictEqual(b.list().length, n);
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp file left behind');
});

ok('update edits only title, brief and agent', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'Old' });
  const u = b.update(t.id, { title: 'New', brief: 'b', agent: 'gemini', status: 'done', cwd: '/x' });
  assert.deepStrictEqual([u.title, u.brief, u.agent, u.status, u.cwd], ['New', 'b', 'gemini', 'ready', '/p']);
  assert.throws(() => b.update(t.id, { title: '' }), /title/);
  assert.throws(() => b.update('t_nope', { title: 'x' }), /no such task/);
});

ok('setStatus validates and stamps queue time', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'Q' });
  assert.throws(() => b.setStatus(t.id, 'running'), /unknown status/);
  const q = b.setStatus(t.id, 'queued');
  assert.strictEqual(q.status, 'queued');
  assert.ok(q.queuedAt);
});

ok('limits clamp to 1..50 and fall back on nonsense', () => {
  const b = new Board(file);
  assert.strictEqual(b.setLimit('/p', 2), 2);
  assert.strictEqual(b.limitFor('/p'), 2);
  assert.strictEqual(b.setLimit('/p', 0), DEFAULT_PROJECT_LIMIT);
  assert.strictEqual(b.setLimit('/p', 'abc'), DEFAULT_PROJECT_LIMIT);
  assert.strictEqual(b.setLimit('/p', 99), DEFAULT_PROJECT_LIMIT);
  assert.strictEqual(b.setGlobalLimit(4), 4);
  b.setLimit('/p', 2);
});

ok('canStart checks the project limit and the overall limit', () => {
  const b = new Board(file);
  assert.strictEqual(b.canStart('/p', { project: 1, total: 1 }).ok, true);
  assert.match(b.canStart('/p', { project: 2, total: 2 }).reason, /project/);
  assert.match(b.canStart('/q', { project: 0, total: 4 }).reason, /overall/);
});

ok('queued lists oldest request first, per project', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-board-'));
  const b = new Board(path.join(dir2, 'b.json'));
  const a = b.create({ cwd: '/p', title: 'a' });
  const c = b.create({ cwd: '/q', title: 'c' });
  const d = b.create({ cwd: '/p', title: 'd' });
  b.setStatus(d.id, 'queued');
  // Make the later request look later even within the same millisecond.
  b.data.tasks.find((t) => t.id === d.id).queuedAt = '2026-01-01T00:00:00.000Z';
  b.setStatus(a.id, 'queued');
  b.data.tasks.find((t) => t.id === a.id).queuedAt = '2026-01-01T00:00:01.000Z';
  b.setStatus(c.id, 'queued');
  assert.deepStrictEqual(b.queued('/p').map((t) => t.title), ['d', 'a']);
  assert.deepStrictEqual(b.queued().length, 3);
  fs.rmSync(dir2, { recursive: true, force: true });
});

ok('after a restart, active and queued go back to Ready and keep their session id', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'R' });
  b.setStatus(t.id, 'active');
  b.setSessionId(t.id, '11111111-2222-3333-4444-555555555555');
  const reloaded = new Board(file);
  assert.strictEqual(reloaded.recoverAfterRestart(), true);
  const r = reloaded.get(t.id);
  assert.strictEqual(r.status, 'ready');
  assert.strictEqual(r.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(reloaded.recoverAfterRestart(), false, 'nothing left to recover');
});

ok('removeProject drops its tasks and limit', () => {
  const b = new Board(file);
  b.create({ cwd: '/gone', title: 'x' });
  b.setLimit('/gone', 5);
  b.removeProject('/gone');
  assert.ok(!b.list().some((t) => t.cwd === '/gone'));
  assert.strictEqual(b.limitFor('/gone'), DEFAULT_PROJECT_LIMIT);
});

ok('opening prompt carries the title and the brief', () => {
  assert.strictEqual(openingPrompt({ title: 'T', brief: '' }), 'Task: T');
  assert.strictEqual(openingPrompt({ title: 'T', brief: 'do it' }), 'Task: T\n\ndo it');
});

ok('project rules: add, refuse duplicates and empties, edit, remove', () => {
  const b = new Board(file);
  const v0 = b.rulesVersion('/p');
  const r1 = b.addRule('/p', '  Never push to main  ');
  assert.strictEqual(r1.text, 'Never push to main');
  assert.throws(() => b.addRule('/p', 'Never push to main'), /already/);
  assert.throws(() => b.addRule('/p', ' '), /empty/);
  const v1 = b.rulesVersion('/p');
  assert.notStrictEqual(v0, v1, 'version changes when rules change');
  b.addRule('/p', 'Run the tests before committing');
  b.updateRule('/p', r1.id, 'Never push to main directly');
  assert.deepStrictEqual(b.rulesFor('/p').map((r) => r.text), ['Never push to main directly', 'Run the tests before committing']);
  assert.deepStrictEqual(new Board(file).rulesFor('/p').length, 2, 'rules persist');
  b.removeRule('/p', r1.id);
  assert.strictEqual(b.rulesFor('/p').length, 1);
  assert.throws(() => b.removeRule('/p', 'r_nope'), /no such rule/);
  assert.deepStrictEqual(b.rulesFor('/other'), []);
});

ok('rules become numbered standing instructions', () => {
  assert.strictEqual(rulesText([], 'x'), '');
  assert.strictEqual(rulesText([{ text: 'A' }, { text: 'B' }], 'shop'),
    'Project rules for shop. Follow every one of them for the whole session:\n1. A\n2. B');
});

ok('waiting records what the task waits for', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'W' });
  const w = b.setWaiting(t.id, ' code review on 2 MRs ');
  assert.deepStrictEqual([w.status, w.waitingFor], ['waiting', 'code review on 2 MRs']);
});

ok('next step is stored and stamped only when it changes', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'N' });
  const a = b.setNextStep(t.id, 'Which keys should I drop?');
  assert.strictEqual(a.nextStep, 'Which keys should I drop?');
  const again = b.setNextStep(t.id, 'Which keys should I drop?');
  assert.strictEqual(again.nextStepAt, a.nextStepAt);
  assert.strictEqual(b.setNextStep(t.id, '').nextStep, null);
});

ok('isolation, links and worktree fields', () => {
  const b = new Board(file);
  const t = b.create({ cwd: '/p', title: 'I', links: ' https://x/1 \nhttps://x/1\n\n https://x/2' });
  assert.strictEqual(t.isolation, 'auto');
  assert.deepStrictEqual(t.links, ['https://x/1', 'https://x/2']);
  assert.strictEqual(b.update(t.id, { isolation: 'main' }).isolation, 'main');
  assert.throws(() => b.update(t.id, { isolation: 'cloud' }), /unknown isolation/);
  b.setWorktree(t.id, { path: '/w', branch: 'seamux/i', base: 'abc', runCwd: '/w', root: '/p' });
  assert.throws(() => b.update(t.id, { isolation: 'worktree' }), /keeps where it runs/);
  assert.deepStrictEqual(b.setDiffStat(t.id, { files: 1, added: 2, removed: 0 }).diffStat, { files: 1, added: 2, removed: 0 });
  assert.deepStrictEqual(b.update(t.id, { links: ['https://y'] }).links, ['https://y']);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`BOARD: ALL ${results} PASSED`);
