'use strict';

// TaskRunner with a fake pane manager and spawn: limits, the queue, closing
// and ending terminals, and failures.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Board } = require('../src/main/board');
const { TaskRunner } = require('../src/main/task-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamux-runner-'));
let n = 0;

function setup({ failFor = null, delay = 0 } = {}) {
  const board = new Board(path.join(dir, `b${++n}.json`));
  const panes = [];
  let seq = 0;
  const ptys = { list: () => panes.map((p) => ({ ...p })) };
  const spawned = [];
  const spawn = async (task) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (failFor === task.title) throw new Error('spawn failed');
    const p = { id: `s${++seq}`, taskId: task.id, cwd: task.cwd, exited: false };
    panes.push(p);
    spawned.push(task.title);
    return p;
  };
  const runner = new TaskRunner({ board, ptys, spawn });
  const end = (taskId) => { panes.find((p) => p.taskId === taskId).exited = true; return runner.terminalEnded(); };
  const close = (taskId) => {
    const i = panes.findIndex((p) => p.taskId === taskId);
    panes.splice(i, 1);
    return runner.paneClosed(taskId);
  };
  return { board, runner, spawned, end, close, panes };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('starts a task and marks it In progress', async () => {
  const { board, runner, spawned } = setup();
  const t = board.create({ cwd: '/p', title: 'A' });
  const r = await runner.start(t.id);
  assert.strictEqual(r.status, 'started');
  assert.strictEqual(board.get(t.id).status, 'active');
  assert.deepStrictEqual(spawned, ['A']);
});

test('a task never gets a second terminal', async () => {
  const { board, runner, spawned } = setup();
  const t = board.create({ cwd: '/p', title: 'A' });
  await runner.start(t.id);
  assert.strictEqual((await runner.start(t.id)).status, 'already');
  assert.deepStrictEqual(spawned, ['A']);
});

test('beyond the project limit a task is queued, and starts when a terminal ends', async () => {
  const { board, runner, spawned, end } = setup();
  board.setLimit('/p', 1);
  const a = board.create({ cwd: '/p', title: 'A' });
  const b = board.create({ cwd: '/p', title: 'B' });
  await runner.start(a.id);
  const r = await runner.start(b.id);
  assert.strictEqual(r.status, 'queued');
  assert.match(r.reason, /project/);
  assert.strictEqual(board.get(b.id).status, 'queued');
  await end(a.id);
  assert.deepStrictEqual(spawned, ['A', 'B']);
  assert.strictEqual(board.get(b.id).status, 'active');
});

test('closing a pane sends its task back to Ready and frees the slot', async () => {
  const { board, runner, spawned, close } = setup();
  board.setLimit('/p', 1);
  const a = board.create({ cwd: '/p', title: 'A' });
  const b = board.create({ cwd: '/p', title: 'B' });
  await runner.start(a.id);
  await runner.start(b.id);
  await close(a.id);
  assert.strictEqual(board.get(a.id).status, 'ready');
  assert.deepStrictEqual(spawned, ['A', 'B']);
});

test('the overall limit applies across projects', async () => {
  const { board, runner } = setup();
  board.setGlobalLimit(2);
  const a = board.create({ cwd: '/p', title: 'A' });
  const b = board.create({ cwd: '/q', title: 'B' });
  const c = board.create({ cwd: '/r', title: 'C' });
  await runner.start(a.id);
  await runner.start(b.id);
  const r = await runner.start(c.id);
  assert.strictEqual(r.status, 'queued');
  assert.match(r.reason, /overall/);
});

test('the queue is served oldest request first', async () => {
  const { board, runner, spawned, end } = setup();
  board.setLimit('/p', 1);
  const a = board.create({ cwd: '/p', title: 'A' });
  const late = board.create({ cwd: '/p', title: 'Late' });
  const early = board.create({ cwd: '/p', title: 'Early' });
  await runner.start(a.id);
  await runner.start(early.id);
  await new Promise((r) => setTimeout(r, 5));
  await runner.start(late.id);
  await end(a.id);
  assert.deepStrictEqual(spawned, ['A', 'Early']);
});

test('two quick starts cannot both take the last slot', async () => {
  const { board, runner, spawned } = setup({ delay: 20 });
  board.setLimit('/p', 1);
  const a = board.create({ cwd: '/p', title: 'A' });
  const b = board.create({ cwd: '/p', title: 'B' });
  const [ra, rb] = await Promise.all([runner.start(a.id), runner.start(b.id)]);
  assert.deepStrictEqual([ra.status, rb.status], ['started', 'queued']);
  assert.deepStrictEqual(spawned, ['A']);
});

test('moving to In progress means start; moving a queued task away drops it from the queue', async () => {
  const { board, runner, spawned, end } = setup();
  board.setLimit('/p', 1);
  const a = board.create({ cwd: '/p', title: 'A' });
  const b = board.create({ cwd: '/p', title: 'B' });
  assert.strictEqual((await runner.move(a.id, 'active')).status, 'started');
  await runner.move(b.id, 'queued');
  await runner.move(b.id, 'backlog');
  await end(a.id);
  assert.deepStrictEqual(spawned, ['A'], 'B left the queue, so it did not start');
  assert.strictEqual(board.get(b.id).status, 'backlog');
});

test('a live terminal keeps running when its card moves to Review', async () => {
  const { board, runner, panes } = setup();
  const a = board.create({ cwd: '/p', title: 'A' });
  await runner.start(a.id);
  await runner.move(a.id, 'review');
  assert.strictEqual(board.get(a.id).status, 'review');
  assert.strictEqual(panes[0].exited, false);
});

test('deleting a task with a live terminal is refused', async () => {
  const { board, runner, end } = setup();
  const a = board.create({ cwd: '/p', title: 'A' });
  await runner.start(a.id);
  assert.throws(() => runner.remove(a.id), /close the task/);
  await end(a.id);
  runner.remove(a.id);
  assert.strictEqual(board.get(a.id), null);
});

test('a failed spawn puts the task back in Ready', async () => {
  const { board, runner } = setup({ failFor: 'Bad' });
  const t = board.create({ cwd: '/p', title: 'Bad' });
  await assert.rejects(runner.start(t.id), /spawn failed/);
  assert.strictEqual(board.get(t.id).status, 'ready');
});

test('emits changed and started events', async () => {
  const { board, runner } = setup();
  const seen = [];
  runner.on('changed', () => seen.push('changed'));
  runner.on('started', ({ task }) => seen.push(`started:${task.title}`));
  const t = board.create({ cwd: '/p', title: 'E' });
  await runner.start(t.id);
  assert.deepStrictEqual(seen, ['changed', 'started:E']);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS  ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`TASK RUNNER: ALL ${tests.length} PASSED`);
})().catch((e) => { console.error(e); process.exit(1); });
