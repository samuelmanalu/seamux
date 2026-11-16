'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The board's model: tasks, their status, and the rules for how many task
// terminals may run at once. Plain Node, no Electron, so it can be tested on
// its own and carried over if the app shell ever changes.
//
// A task owns at most one terminal. Which terminal is live is runtime state
// held by main.js; this file only stores what must survive a restart.

const STATUSES = ['backlog', 'ready', 'queued', 'active', 'review', 'done'];
const DEFAULT_PROJECT_LIMIT = 3;
const DEFAULT_GLOBAL_LIMIT = 8;
const EDITABLE = ['title', 'brief', 'agent'];

function now() { return new Date().toISOString(); }

function clampLimit(n, fallback) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 50 ? v : fallback;
}

class Board {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, tasks: [], limits: {}, globalLimit: DEFAULT_GLOBAL_LIMIT };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw };
    } catch { /* first run */ }
    if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);   // never leave a half-written board behind
  }

  /* ------------------------------------------------------------- tasks */

  list() { return this.data.tasks.map((t) => ({ ...t })); }

  get(id) {
    const t = this.data.tasks.find((x) => x.id === id);
    return t ? { ...t } : null;
  }

  create({ cwd, title, brief = '', agent = null, status = 'ready' }) {
    if (!cwd) throw new Error('a task needs a project');
    const clean = String(title || '').trim();
    if (!clean) throw new Error('a task needs a title');
    if (!['backlog', 'ready'].includes(status)) status = 'ready';
    const t = {
      id: `t_${crypto.randomBytes(5).toString('hex')}`,
      cwd,
      title: clean,
      brief: String(brief || '').trim(),
      agent: agent || null,          // null: the project's default agent
      status,
      sessionId: null,               // the agent's own session id, for resume
      createdAt: now(),
      updatedAt: now(),
      statusAt: now(),
      order: this._nextOrder(),
    };
    this.data.tasks.push(t);
    this.save();
    return { ...t };
  }

  update(id, patch = {}) {
    const t = this._find(id);
    for (const k of EDITABLE) {
      if (!(k in patch)) continue;
      if (k === 'title') {
        const v = String(patch.title || '').trim();
        if (!v) throw new Error('a task needs a title');
        t.title = v;
      } else if (k === 'brief') {
        t.brief = String(patch.brief || '').trim();
      } else {
        t.agent = patch.agent || null;
      }
    }
    t.updatedAt = now();
    this.save();
    return { ...t };
  }

  /** Change status. Seamux itself owns 'queued' and 'active'. */
  setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
    const t = this._find(id);
    if (t.status !== status) {
      t.status = status;
      t.statusAt = now();
      t.updatedAt = t.statusAt;
      // Queue order is the order tasks were asked to start.
      if (status === 'queued') t.queuedAt = t.statusAt;
      this.save();
    }
    return { ...t };
  }

  setSessionId(id, sessionId) {
    const t = this._find(id);
    t.sessionId = sessionId || null;
    t.updatedAt = now();
    this.save();
    return { ...t };
  }

  remove(id) {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    this.save();
  }

  /** Forget every task of a project that is no longer on the board. */
  removeProject(cwd) {
    this.data.tasks = this.data.tasks.filter((t) => t.cwd !== cwd);
    delete this.data.limits[cwd];
    this.save();
  }

  /* ------------------------------------------------------------ limits */

  limitFor(cwd) { return clampLimit(this.data.limits[cwd], DEFAULT_PROJECT_LIMIT); }

  setLimit(cwd, n) {
    this.data.limits[cwd] = clampLimit(n, DEFAULT_PROJECT_LIMIT);
    this.save();
    return this.data.limits[cwd];
  }

  globalLimit() { return clampLimit(this.data.globalLimit, DEFAULT_GLOBAL_LIMIT); }

  setGlobalLimit(n) {
    this.data.globalLimit = clampLimit(n, DEFAULT_GLOBAL_LIMIT);
    this.save();
    return this.data.globalLimit;
  }

  /**
   * Can one more task terminal start in this project?
   * @param {string} cwd
   * @param {{project:number, total:number}} live  terminals running now
   */
  canStart(cwd, live) {
    if (live.total >= this.globalLimit()) return { ok: false, reason: 'all projects are at the overall limit' };
    if (live.project >= this.limitFor(cwd)) return { ok: false, reason: 'this project is at its limit' };
    return { ok: true };
  }

  /** Queued tasks, oldest request first, optionally for one project. */
  queued(cwd) {
    return this.data.tasks
      .filter((t) => t.status === 'queued' && (!cwd || t.cwd === cwd))
      .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)))
      .map((t) => ({ ...t }));
  }

  /**
   * After a restart no terminal is live, so a task left 'active' or 'queued'
   * goes back to Ready. Its session id stays, so starting it again resumes
   * the conversation instead of beginning a new one.
   */
  recoverAfterRestart() {
    let changed = false;
    for (const t of this.data.tasks) {
      if (t.status === 'active' || t.status === 'queued') {
        t.status = 'ready';
        t.statusAt = now();
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /* ----------------------------------------------------------- private */

  _find(id) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no such task: ${id}`);
    return t;
  }

  _nextOrder() {
    return this.data.tasks.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1;
  }
}

/** The opening message a task's agent receives on its first start. */
function openingPrompt(task) {
  const parts = [`Task: ${task.title}`];
  if (task.brief) parts.push(task.brief);
  return parts.join('\n\n');
}

module.exports = {
  Board, STATUSES, openingPrompt, DEFAULT_PROJECT_LIMIT, DEFAULT_GLOBAL_LIMIT,
};
