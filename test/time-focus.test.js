'use strict';

// Time per task and focus mode, without Electron: the board's time buckets,
// the tracker's arithmetic (gaps, sleep, flushing) and focus sessions
// (length checks, holding, extending, ending every way it can end).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Board } = require('../src/main/board');
const { TimeTracker, bucketsFor } = require('../src/main/time-tracker');
const { Focus, checkMinutes } = require('../src/main/focus');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smx-time-'));
let n = 0;
const fresh = () => new Board(path.join(dir, `b${n++}.json`));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;

test('buckets: running is agent time, a question is blocked on you, looking is yours, Waiting counts apart', () => {
  assert.deepStrictEqual(bucketsFor({ status: 'active', paneState: 'running' }), ['agent']);
  assert.deepStrictEqual(bucketsFor({ status: 'active', paneState: 'needs_input', looking: true }), ['needsYou', 'you']);
  assert.deepStrictEqual(bucketsFor({ status: 'active', paneState: 'idle', looking: true }), ['you']);
  assert.deepStrictEqual(bucketsFor({ status: 'waiting', paneState: null }), ['waiting']);
  assert.deepStrictEqual(bucketsFor({ status: 'ready', paneState: null }), []);
  assert.deepStrictEqual(bucketsFor({ status: 'active', paneState: 'starting' }), [], 'launching is nobody’s time');
});

test('addTime adds up in memory, rejects unknown buckets, ignores junk and gone tasks', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  b.addTime(t.id, 'agent', 1000);
  b.addTime(t.id, 'agent', 2500.4);
  b.addTime(t.id, 'agent', -5);
  b.addTime(t.id, 'agent', NaN);
  b.addTime('t_gone', 'agent', 1000);
  assert.strictEqual(b.get(t.id).time.agent, 3500);
  assert.throws(() => b.addTime(t.id, 'coffee', 1), /unknown time bucket/);
  assert.ok(b.dirty);
  // Not on disk until a flush.
  assert.strictEqual(new Board(b.file).get(t.id).time, undefined);
  b.flush();
  assert.strictEqual(new Board(b.file).get(t.id).time.agent, 3500);
  assert.ok(!b.dirty);
});

test('any other save also writes the held time', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  b.addTime(t.id, 'you', 4000);
  b.setNextStep(t.id, 'next');
  assert.strictEqual(new Board(b.file).get(t.id).time.you, 4000);
});

test('tracker credits each gap to what was seen at its start', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  let clock = 0;
  let seen = { taskId: t.id, status: 'active', paneState: 'running' };
  const tr = new TimeTracker({ board: b, observe: () => [{ ...seen }], now: () => clock, flushEvery: 1000 });
  tr.tick();                     // first look: nothing to credit
  clock = 5000; seen = { ...seen, paneState: 'needs_input', looking: true };
  tr.tick();                     // 5 s of running
  clock = 8000;
  tr.tick();                     // 3 s blocked on you, and yours
  assert.deepStrictEqual(b.get(t.id).time, { agent: 5000, needsYou: 3000, you: 3000 });
});

test('a long gap (the machine slept) counts as at most maxGap; a clock going back counts nothing', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  let clock = 0;
  const tr = new TimeTracker({ board: b, observe: () => [{ taskId: t.id, status: 'active', paneState: 'running' }], now: () => clock, maxGapMs: 30000 });
  tr.tick();
  clock = 8 * 3600 * 1000;
  tr.tick();
  assert.strictEqual(b.get(t.id).time.agent, 30000);
  clock -= 60000;
  tr.tick();
  assert.strictEqual(b.get(t.id).time.agent, 30000);
});

test('tracker flushes every N looks, and stop counts up to now and flushes', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  let clock = 0;
  const tr = new TimeTracker({ board: b, observe: () => [{ taskId: t.id, status: 'waiting' }], now: () => clock, flushEvery: 3 });
  tr.tick(); clock += 1000; tr.tick();
  assert.strictEqual((new Board(b.file).get(t.id).time || {}).waiting, undefined);
  clock += 1000; tr.tick();      // third look: flushed
  assert.strictEqual(new Board(b.file).get(t.id).time.waiting, 2000);
  clock += 500;
  tr.stop();
  assert.strictEqual(new Board(b.file).get(t.id).time.waiting, 2500);
});

test('a task deleted between looks loses no sleep', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  let clock = 0;
  const tr = new TimeTracker({ board: b, observe: () => b.list().map((x) => ({ taskId: x.id, status: 'waiting' })), now: () => clock });
  tr.tick();
  b.remove(t.id);
  clock = 1000;
  assert.doesNotThrow(() => tr.tick());
});

function fakeTimers() {
  const timers = [];
  let clock = 1_000_000;
  return {
    now: () => clock,
    setTimer: (fn, ms) => { const x = { fn, at: clock + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      clock += ms;
      for (const x of [...timers]) if (x.at <= clock) { timers.splice(timers.indexOf(x), 1); x.fn(); }
    },
    get pending() { return timers.length; },
  };
}

test('focus length: whole minutes from 1 to 240', () => {
  assert.strictEqual(checkMinutes(25), 25);
  assert.strictEqual(checkMinutes(' 90 '), 90);
  for (const bad of [0, 241, 2.5, '', null, 'abc', -1, '1e1x']) assert.throws(() => checkMinutes(bad), /between 1 and 240/, String(bad));
});

test('focus needs a task and a live terminal', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  const f = new Focus({ board: b, ...fakeTimers() });
  assert.throws(() => f.start({ taskId: 't_nope', paneId: 's1', minutes: 25 }), /no such task/);
  assert.throws(() => f.start({ taskId: t.id, paneId: null, minutes: 25 }), /start the task’s terminal first/);
  assert.strictEqual(f.current, null);
});

test('a focus session runs out, is recorded as completed, and reports what was held', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'Deep work' });
  const ft = fakeTimers();
  const f = new Focus({ board: b, ...ft });
  const events = [];
  f.on('changed', (e) => events.push(e));
  const cur = f.start({ taskId: t.id, paneId: 's1', minutes: 25 });
  assert.strictEqual(cur.endsAt - cur.startedAt, 25 * MIN);
  assert.strictEqual(f.hold('s1'), false, 'the focused terminal is never held');
  assert.strictEqual(f.hold('s2'), true);
  assert.strictEqual(f.hold('s2'), true);
  assert.strictEqual(f.hold('s3'), true);
  assert.deepStrictEqual(f.current.held, ['s2', 's3']);
  f.release('s3');
  assert.deepStrictEqual(f.current.held, ['s2']);
  ft.advance(25 * MIN);
  assert.strictEqual(f.current, null);
  const last = events.at(-1);
  assert.deepStrictEqual({ ...last.summary, spentMs: last.summary.spentMs }, { taskId: t.id, title: 'Deep work', why: 'done', completed: true, spentMs: 25 * MIN, held: ['s2'] });
  assert.deepStrictEqual({ ...new Board(b.file).get(t.id).focus, lastAt: null }, { sessions: 1, completed: 1, ms: 25 * MIN, lastAt: null });
});

test('extending moves the end; past 240 minutes is refused; with nothing running it is refused', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  const ft = fakeTimers();
  const f = new Focus({ board: b, ...ft });
  assert.throws(() => f.extend(5), /no focus session/);
  f.start({ taskId: t.id, paneId: 's1', minutes: 25 });
  f.extend(5);
  assert.strictEqual(f.current.minutes, 30);
  ft.advance(25 * MIN);
  assert.ok(f.current, 'still running after the old end');
  assert.throws(() => f.extend(240), /at most 240/);
  ft.advance(5 * MIN);
  assert.strictEqual(f.current, null);
  assert.strictEqual(ft.pending, 0);
});

test('ended early: counted as not completed, with the time actually spent', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  const ft = fakeTimers();
  const f = new Focus({ board: b, ...ft });
  f.start({ taskId: t.id, paneId: 's1', minutes: 50 });
  ft.advance(12 * MIN);
  const s = f.stop('ended');
  assert.deepStrictEqual([s.completed, s.spentMs], [false, 12 * MIN]);
  assert.strictEqual(ft.pending, 0, 'no timer left behind');
  assert.deepStrictEqual([b.get(t.id).focus.sessions, b.get(t.id).focus.completed], [1, 0]);
  assert.strictEqual(f.stop(), null, 'stopping twice is harmless');
});

test('the focused terminal closing ends focus; another closing only drops it from held', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  const f = new Focus({ board: b, ...fakeTimers() });
  f.start({ taskId: t.id, paneId: 's1', minutes: 25 });
  f.hold('s2');
  f.paneEnded('s2');
  assert.deepStrictEqual(f.current.held, []);
  const events = [];
  f.on('changed', (e) => events.push(e));
  f.paneEnded('s1');
  assert.strictEqual(f.current, null);
  assert.strictEqual(events.at(-1).summary.why, 'terminal');
});

test('deleting the focused task ends focus without writing to a task that is gone', () => {
  const b = fresh();
  const t = b.create({ cwd: '/p', title: 'T' });
  const f = new Focus({ board: b, ...fakeTimers() });
  f.start({ taskId: t.id, paneId: 's1', minutes: 25 });
  f.taskRemoved('t_other');
  assert.ok(f.current);
  f.taskRemoved(t.id);
  b.remove(t.id);
  assert.strictEqual(f.current, null);
});

test('focusing on another task ends the first as switched', () => {
  const b = fresh();
  const a = b.create({ cwd: '/p', title: 'A' });
  const c = b.create({ cwd: '/p', title: 'C' });
  const ft = fakeTimers();
  const f = new Focus({ board: b, ...ft });
  f.start({ taskId: a.id, paneId: 's1', minutes: 25 });
  ft.advance(MIN);
  f.start({ taskId: c.id, paneId: 's2', minutes: 25 });
  assert.strictEqual(f.current.taskId, c.id);
  assert.strictEqual(b.get(a.id).focus.sessions, 1);
  assert.strictEqual(ft.pending, 1, 'only the new session’s timer');
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log(`PASS  ${name}`); }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`TIME AND FOCUS: ALL ${tests.length} PASSED`);
})().catch((e) => { console.error(e); process.exit(1); });
