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

const STATUSES = ['backlog', 'ready', 'queued', 'active', 'waiting', 'review', 'done'];
const DEFAULT_PROJECT_LIMIT = 3;
const DEFAULT_GLOBAL_LIMIT = 8;
const EDITABLE = ['title', 'brief', 'agent', 'isolation', 'links', 'dependsOn'];
const ISOLATION = ['auto', 'worktree', 'main'];

function now() { return new Date().toISOString(); }

function cleanLinks(links) {
  const list = Array.isArray(links) ? links : String(links || '').split('\n');
  return [...new Set(list.map((l) => String(l || '').trim()).filter(Boolean))];
}

function clampLimit(n, fallback) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 50 ? v : fallback;
}

/** A limit the user typed: a whole number from 1 to 50, or an error. */
function checkLimit(n) {
  const s = String(n ?? '').trim();
  const v = Number(s);
  if (!s || !Number.isInteger(v) || v < 1 || v > 50) throw new Error('a limit must be a whole number between 1 and 50');
  return v;
}

class Board {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, tasks: [], limits: {}, globalLimit: DEFAULT_GLOBAL_LIMIT, rules: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw };
    } catch { /* first run */ }
    if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
    if (!this.data.rules || typeof this.data.rules !== 'object') this.data.rules = {};
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

  create({ cwd, title, brief = '', agent = null, status = 'ready', isolation = 'auto', links = [], dependsOn = [] }) {
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
      isolation: ISOLATION.includes(isolation) ? isolation : 'auto',
      worktree: null,                // { path, branch, base, runCwd, root } once created
      links: cleanLinks(links),      // MRs, tickets: anything worth a click
      diffStat: null,                // { files, added, removed } since the task started
      dependsOn: [],                 // task ids that must be Done before this one starts
      createdAt: now(),
      updatedAt: now(),
      statusAt: now(),
      order: this._nextOrder(),
    };
    t.dependsOn = this._checkDeps(t, dependsOn);
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
      } else if (k === 'links') {
        t.links = cleanLinks(patch.links);
      } else if (k === 'dependsOn') {
        t.dependsOn = this._checkDeps(t, patch.dependsOn);
      } else if (k === 'isolation') {
        if (!ISOLATION.includes(patch.isolation)) throw new Error(`unknown isolation: ${patch.isolation}`);
        // Where a task runs is fixed once it has run: its conversation and
        // its changes live there.
        if (patch.isolation !== t.isolation && (t.sessionId || t.worktree)) {
          throw new Error('a task that has started keeps where it runs');
        }
        t.isolation = patch.isolation;
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

  /** Waiting on someone else: a review, a deploy watch, another team. */
  setWaiting(id, waitingFor) {
    const t = this._find(id);
    t.waitingFor = String(waitingFor || '').trim() || null;
    this.save();
    return this.setStatus(id, 'waiting');
  }

  /** Where the work stands, taken from the agent's latest message. */
  setNextStep(id, text) {
    const t = this._find(id);
    const v = String(text || '').trim() || null;
    if (t.nextStep === v) return { ...t };
    t.nextStep = v;
    t.nextStepAt = now();
    this.save();
    return { ...t };
  }

  setWorktree(id, worktree) {
    const t = this._find(id);
    t.worktree = worktree || null;
    t.updatedAt = now();
    this.save();
    return { ...t };
  }

  setDiffStat(id, stat) {
    const t = this._find(id);
    t.diffStat = stat || null;
    this.save();
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
    // Nothing may wait on a task that no longer exists.
    for (const t of this.data.tasks) if (t.dependsOn) t.dependsOn = t.dependsOn.filter((d) => d !== id);
    this.save();
  }

  /** The tasks this one still waits for (not Done yet). */
  blockedBy(id) {
    const t = this._find(id);
    return (t.dependsOn || [])
      .map((d) => this.data.tasks.find((x) => x.id === d))
      .filter((d) => d && d.status !== 'done')
      .map((d) => ({ id: d.id, title: d.title, status: d.status }));
  }

  /** Forget every task of a project that is no longer on the board. */
  removeProject(cwd) {
    this.data.tasks = this.data.tasks.filter((t) => t.cwd !== cwd);
    delete this.data.limits[cwd];
    this.save();
  }

  /* ------------------------------------------------------------- rules */

  // Project rules: written once per project, given to every terminal in it.

  rulesFor(cwd) { return (this.data.rules[cwd] || []).map((r) => ({ ...r })); }

  addRule(cwd, text) {
    const clean = String(text || '').trim();
    if (!cwd) throw new Error('a rule needs a project');
    if (!clean) throw new Error('a rule cannot be empty');
    const list = this.data.rules[cwd] || (this.data.rules[cwd] = []);
    if (list.some((r) => r.text === clean)) throw new Error('this project already has that rule');
    const r = { id: `r_${crypto.randomBytes(4).toString('hex')}`, text: clean, createdAt: now(), updatedAt: now() };
    list.push(r);
    this.save();
    return { ...r };
  }

  updateRule(cwd, id, text) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('a rule cannot be empty');
    const r = (this.data.rules[cwd] || []).find((x) => x.id === id);
    if (!r) throw new Error(`no such rule: ${id}`);
    r.text = clean;
    r.updatedAt = now();
    this.save();
    return { ...r };
  }

  removeRule(cwd, id) {
    const before = (this.data.rules[cwd] || []).length;
    this.data.rules[cwd] = (this.data.rules[cwd] || []).filter((x) => x.id !== id);
    if (this.data.rules[cwd].length === before) throw new Error(`no such rule: ${id}`);
    this.save();
  }

  /** Changes whenever a project's rules change, so a terminal can tell it has an old copy. */
  rulesVersion(cwd) {
    const text = this.rulesFor(cwd).map((r) => `${r.id}:${r.text}`).join('\n');
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
  }

  /* ------------------------------------------------------------ limits */

  limitFor(cwd) { return clampLimit(this.data.limits[cwd], DEFAULT_PROJECT_LIMIT); }

  setLimit(cwd, n) {
    this.data.limits[cwd] = checkLimit(n);
    this.save();
    return this.data.limits[cwd];
  }

  globalLimit() { return clampLimit(this.data.globalLimit, DEFAULT_GLOBAL_LIMIT); }

  setGlobalLimit(n) {
    this.data.globalLimit = checkLimit(n);
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

  /** Dependencies must be other tasks of the same project, with no loop. */
  _checkDeps(task, deps) {
    const ids = [...new Set((Array.isArray(deps) ? deps : []).map(String).filter(Boolean))];
    for (const d of ids) {
      if (d === task.id) throw new Error('a task cannot depend on itself');
      const other = this.data.tasks.find((x) => x.id === d);
      if (!other) throw new Error(`no such task: ${d}`);
      if (other.cwd !== task.cwd) throw new Error('a task can only depend on tasks of its own project');
    }
    // Walk the graph from each dependency; reaching this task again is a loop.
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === task.id) throw new Error('that would make tasks wait on each other in a loop');
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = this.data.tasks.find((x) => x.id === cur);
      if (c && c.dependsOn) stack.push(...c.dependsOn);
    }
    return ids;
  }

  _nextOrder() {
    return this.data.tasks.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1;
  }
}

/** Project rules as standing instructions. Empty string when there are none. */
function rulesText(rules, projectName) {
  if (!rules || !rules.length) return '';
  return [
    `Project rules${projectName ? ` for ${projectName}` : ''}. Follow every one of them for the whole session:`,
    ...rules.map((r, i) => `${i + 1}. ${r.text}`),
  ].join('\n');
}

/** The opening message a task's agent receives on its first start. */
function openingPrompt(task) {
  const parts = [`Task: ${task.title}`];
  if (task.brief) parts.push(task.brief);
  return parts.join('\n\n');
}

module.exports = {
  Board, STATUSES, ISOLATION, openingPrompt, rulesText, DEFAULT_PROJECT_LIMIT, DEFAULT_GLOBAL_LIMIT,
};
