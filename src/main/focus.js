'use strict';

const { EventEmitter } = require('events');

// Focus mode: one task, one terminal, a set length. While it runs, other
// tasks that need you are held back (counted, not announced) and the app
// keeps you on this task. Plain Node; main.js wires it to the window.

const MIN_MINUTES = 1;
const MAX_MINUTES = 240;

function checkMinutes(n) {
  const s = String(n ?? '').trim();
  const v = Number(s);
  if (!s || !Number.isInteger(v) || v < MIN_MINUTES || v > MAX_MINUTES) {
    throw new Error(`focus length must be a whole number of minutes between ${MIN_MINUTES} and ${MAX_MINUTES}`);
  }
  return v;
}

class Focus extends EventEmitter {
  constructor({ board, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    Object.assign(this, { board, now, setTimer, clearTimer });
    this.session = null;
    this.timer = null;
  }

  /** The running session, or null. */
  get current() {
    if (!this.session) return null;
    const s = this.session;
    return { taskId: s.taskId, paneId: s.paneId, title: s.title, minutes: s.minutes, startedAt: s.startedAt, endsAt: s.endsAt, held: [...s.held] };
  }

  start({ taskId, paneId, minutes }) {
    const m = checkMinutes(minutes);
    const t = this.board.get(taskId);
    if (!t) throw new Error(`no such task: ${taskId}`);
    if (!paneId) throw new Error('start the task’s terminal first');
    if (this.session) this.stop('switched');
    const start = this.now();
    this.session = { taskId, paneId, title: t.title, minutes: m, startedAt: start, endsAt: start + m * 60000, held: new Set() };
    this._arm();
    this.emit('changed', { focus: this.current });
    return this.current;
  }

  /** More time on the running session. */
  extend(minutes) {
    if (!this.session) throw new Error('no focus session is running');
    const m = checkMinutes(minutes);
    const s = this.session;
    const total = s.minutes + m;
    if (total > MAX_MINUTES) throw new Error(`a focus session runs at most ${MAX_MINUTES} minutes`);
    s.minutes = total;
    s.endsAt += m * 60000;
    this._arm();
    this.emit('changed', { focus: this.current });
    return this.current;
  }

  /**
   * End the session and record it on the task.
   * @param {'done'|'ended'|'switched'|'terminal'|'removed'} why
   */
  stop(why = 'ended') {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    this.clearTimer(this.timer);
    this.timer = null;
    const end = Math.min(this.now(), s.endsAt);
    const completed = why === 'done';
    if (why !== 'removed' && this.board.get(s.taskId)) {
      this.board.addFocusSession(s.taskId, { startedAt: new Date(s.startedAt).toISOString(), endedAt: new Date(end).toISOString(), completed });
    }
    const summary = { taskId: s.taskId, title: s.title, why, completed, spentMs: end - s.startedAt, held: [...s.held] };
    this.emit('changed', { focus: null, summary });
    return summary;
  }

  /**
   * A terminal wants your attention. During focus, anything but the focused
   * terminal is held: returns true when the caller should stay quiet.
   */
  hold(paneId) {
    if (!this.session || paneId === this.session.paneId) return false;
    if (!this.session.held.has(paneId)) {
      this.session.held.add(paneId);
      this.emit('changed', { focus: this.current });
    }
    return true;
  }

  /** A held terminal no longer needs you. */
  release(paneId) {
    if (this.session && this.session.held.delete(paneId)) this.emit('changed', { focus: this.current });
  }

  paneEnded(paneId) {
    if (this.session && this.session.paneId === paneId) this.stop('terminal');
    else this.release(paneId);
  }

  taskRemoved(taskId) {
    if (this.session && this.session.taskId === taskId) this.stop('removed');
  }

  _arm() {
    this.clearTimer(this.timer);
    const ms = Math.max(0, this.session.endsAt - this.now());
    this.timer = this.setTimer(() => this.stop('done'), ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }
}

module.exports = { Focus, checkMinutes, MIN_MINUTES, MAX_MINUTES };
