'use strict';

const { EventEmitter } = require('events');

// Starts and stops task terminals and enforces the limits. One task owns at
// most one terminal; a project runs at most N live task terminals, and all
// projects together at most the overall limit. A task asked to start beyond
// either limit waits in Queued and starts by itself when a slot frees up.
//
// "Live" means the terminal's process is still running, idle or not. A
// terminal whose process ended no longer holds a slot, even while its pane is
// still open for reading.
//
// No Electron here: the runner is handed the board, the pane manager and a
// spawn function, so tests can drive it with fakes.

class TaskRunner extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./board').Board} deps.board
   * @param {{list: () => object[]}} deps.ptys        pane manager (needs taskId on each pane)
   * @param {(task: object) => Promise<object>} deps.spawn  starts a terminal, returns pane info
   */
  constructor({ board, ptys, spawn }) {
    super();
    this.board = board;
    this.ptys = ptys;
    this.spawn = spawn;
    this.starting = new Set();   // task ids being spawned right now
    this.pumping = false;
  }

  /** The task's live pane, if any (exited panes included, so the UI can show them). */
  paneOf(taskId) {
    const mine = this.ptys.list().filter((s) => s.taskId === taskId);
    return mine.find((s) => !s.exited) || mine[mine.length - 1] || null;
  }

  liveCounts(cwd) {
    const live = this.ptys.list().filter((s) => s.taskId && !s.exited);
    // A spawn in flight already holds its slot, so two quick starts cannot
    // both squeeze into the last one.
    const startingTasks = [...this.starting].map((id) => this.board.get(id)).filter(Boolean);
    return {
      project: live.filter((s) => (s.projectCwd || s.cwd) === cwd).length + startingTasks.filter((t) => t.cwd === cwd).length,
      total: live.length + startingTasks.length,
    };
  }

  /**
   * Start a task's terminal, or queue it if a limit is reached.
   * @returns {Promise<{status: 'started'|'already'|'queued', pane?: object, reason?: string}>}
   */
  async start(taskId) {
    const task = this.board.get(taskId);
    if (!task) throw new Error(`no such task: ${taskId}`);

    const pane = this.paneOf(taskId);
    if (pane && !pane.exited) return { status: 'already', pane };
    if (this.starting.has(taskId)) return { status: 'already' };

    const blocked = this.board.blockedBy(taskId);
    if (blocked.length) throw new Error(`it waits for ${blocked.map((b) => `“${b.title}”`).join(', ')} to be done`);

    const check = this.board.canStart(task.cwd, this.liveCounts(task.cwd));
    if (!check.ok) {
      this.board.setStatus(taskId, 'queued');
      this._changed();
      return { status: 'queued', reason: check.reason };
    }
    return this._spawn(task);
  }

  /** Called when a task's pane is closed: the task leaves In progress. */
  paneClosed(taskId) {
    const t = this.board.get(taskId);
    if (t && t.status === 'active') this.board.setStatus(taskId, 'ready');
    this._changed();
    return this.pump();
  }

  /** Called when any terminal's process ends: its slot is free again. */
  terminalEnded() {
    this._changed();
    return this.pump();
  }

  /**
   * Move a task by hand. Seamux owns Queued and In progress: asking for
   * either means "start it". Moving a task out of the queue drops it from
   * the queue; a live terminal keeps running wherever the card goes.
   */
  async move(taskId, status) {
    if (status === 'active' || status === 'queued') return this.start(taskId);
    const t = this.board.setStatus(taskId, status);
    this._changed();
    await this.pump();
    return { status: 'moved', task: t };
  }

  /** Delete a task. Refused while its terminal is live, so work is never cut off by surprise. */
  remove(taskId) {
    const pane = this.paneOf(taskId);
    if (pane && !pane.exited) throw new Error('close the task’s terminal first');
    this.board.remove(taskId);
    this._changed();
  }

  /** Start queued tasks, oldest request first, while there is room. */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const t of this.board.queued()) {
        if (this.starting.has(t.id)) continue;
        if (!this.board.canStart(t.cwd, this.liveCounts(t.cwd)).ok) continue;
        await this._spawn(t);
      }
    } finally {
      this.pumping = false;
    }
  }

  async _spawn(task) {
    this.starting.add(task.id);
    try {
      const pane = await this.spawn(task);
      this.board.setStatus(task.id, 'active');
      this._changed();
      this.emit('started', { task: this.board.get(task.id), pane });
      return { status: 'started', pane };
    } catch (err) {
      // A failed spawn must not leave the task stuck in the queue forever.
      this.board.setStatus(task.id, 'ready');
      this._changed();
      throw err;
    } finally {
      this.starting.delete(task.id);
    }
  }

  _changed() { this.emit('changed'); }
}

module.exports = { TaskRunner };
