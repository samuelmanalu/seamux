'use strict';

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { parseEnv, maskValue } = require('./dotenv');

const COMMAND_TIMEOUT_MS = 20000;
const MAX_COMMAND_OUTPUT = 1_000_000;

let seq = 0;

/**
 * Named environment sets, each a list of ordered sources, bound to projects.
 *
 * Source kinds:
 *   instructions { text }             standing rules, passed as
 *                                     --append-system-prompt at spawn
 *   preprompt    { text }             an opening message, passed as claude's
 *                                     positional [prompt] -- Claude answers it
 *                                     immediately and the session stays live
 *   inline  { vars }                  pasted blob or the key-by-key table
 *   file    { path, mode }            'live' re-reads on every launch (default),
 *                                     'snapshot' froze the values when added
 *   command { command, cwd }          stdout parsed as KEY=value on every launch
 *
 * Within a set, later sources win. Across sets bound to a project, later sets
 * win. The result is layered over process.env, so a set can deliberately
 * override something inherited from the shell.
 */
class EnvManager {
  constructor(secretStore) {
    this.secrets = secretStore;
    if (!Array.isArray(this.secrets.data.envSets)) this.secrets.data.envSets = [];
    for (const s of this.secrets.data.envSets) {
      const n = Number(String(s.id).replace(/^e/, ''));
      if (Number.isFinite(n) && n > seq) seq = n;
    }
  }

  sets() { return this.secrets.data.envSets; }

  get(id) { return this.sets().find((s) => s.id === id) || null; }

  create(name) {
    const set = { id: `e${++seq}`, name: name || 'new environment', sources: [] };
    this.sets().push(set);
    this.secrets.save();
    return set;
  }

  rename(id, name) {
    const s = this.get(id);
    if (s) { s.name = name; this.secrets.save(); }
    return s;
  }

  remove(id) {
    this.secrets.data.envSets = this.sets().filter((s) => s.id !== id);
    this.secrets.save();
  }

  addSource(id, source) {
    const s = this.get(id);
    if (!s) return null;
    s.sources.push({ ...source, id: `src${Date.now()}${Math.random().toString(36).slice(2, 6)}` });
    this.secrets.save();
    return s;
  }

  updateSource(setId, sourceId, patch) {
    const s = this.get(setId);
    if (!s) return null;
    const src = s.sources.find((x) => x.id === sourceId);
    if (src) { Object.assign(src, patch); this.secrets.save(); }
    return s;
  }

  removeSource(setId, sourceId) {
    const s = this.get(setId);
    if (!s) return null;
    s.sources = s.sources.filter((x) => x.id !== sourceId);
    this.secrets.save();
    return s;
  }

  /** Set a single variable in the set's first inline source, creating it if needed. */
  setVar(setId, key, value) {
    const s = this.get(setId);
    if (!s) return null;
    let inline = s.sources.find((x) => x.type === 'inline');
    if (!inline) {
      inline = { id: `src${Date.now()}`, type: 'inline', vars: {} };
      s.sources.push(inline);
    }
    inline.vars[key] = value;
    this.secrets.save();
    return s;
  }

  removeVar(setId, key) {
    const s = this.get(setId);
    if (!s) return null;
    for (const src of s.sources) if (src.type === 'inline' && src.vars) delete src.vars[key];
    this.secrets.save();
    return s;
  }

  /**
   * Resolve one set to plain vars.
   * @returns {Promise<{vars:object, warnings:string[]}>}
   */
  async resolveSet(id) {
    const set = this.get(id);
    if (!set) return { vars: {}, origins: {}, instructions: [], prePrompts: [], warnings: [`context ${id} no longer exists`] };

    const vars = {};
    const origins = {};   // key -> label of the source that last set it
    const instructions = [];
    const prePrompts = [];
    const warnings = [];

    const take = (src, produced) => {
      for (const [k, v] of Object.entries(produced || {})) {
        vars[k] = v;
        origins[k] = describeSource(src);
      }
    };

    for (const src of set.sources) {
      try {
        if (src.type === 'instructions') {
          if (src.text && src.text.trim()) instructions.push(src.text.trim());
        } else if (src.type === 'preprompt') {
          if (src.text && src.text.trim()) prePrompts.push(src.text.trim());
        } else if (src.type === 'inline') {
          take(src, src.vars);
        } else if (src.type === 'file') {
          if (src.mode === 'snapshot') {
            take(src, src.vars);
          } else {
            take(src, parseEnv(fs.readFileSync(expandHome(src.path), 'utf8')));
          }
        } else if (src.type === 'command') {
          take(src, parseEnv(await runCommand(src.command, expandHome(src.cwd || os.homedir()))));
        }
      } catch (err) {
        warnings.push(`${set.name}: ${describeSource(src)} failed — ${err && err.message || err}`);
      }
    }

    return { vars, origins, instructions, prePrompts, warnings };
  }

  /** Resolve several sets in order; later sets override earlier ones. */
  async resolveMany(ids) {
    const vars = {};
    const warnings = [];
    const names = [];
    const instructions = [];
    const prePrompts = [];
    for (const id of ids || []) {
      const set = this.get(id);
      if (set) names.push(set.name);
      const r = await this.resolveSet(id);
      Object.assign(vars, r.vars);
      instructions.push(...r.instructions);
      prePrompts.push(...r.prePrompts);
      warnings.push(...r.warnings);
    }
    return { vars, warnings, names, instructions, prePrompts };
  }

  /** Masked view for the UI -- raw values never cross to the renderer. */
  async describe(id) {
    const set = this.get(id);
    if (!set) return null;
    const { vars, origins, instructions, prePrompts, warnings } = await this.resolveSet(id);
    return {
      id: set.id,
      name: set.name,
      sources: set.sources.map((s) => ({
        id: s.id, type: s.type, path: s.path, mode: s.mode,
        command: s.command, cwd: s.cwd,
        count: s.type === 'inline' || s.mode === 'snapshot' ? Object.keys(s.vars || {}).length : undefined,
        text: (s.type === 'instructions' || s.type === 'preprompt') ? s.text : undefined,
        label: describeSource(s),
      })),
      keys: Object.keys(vars).sort(),
      masked: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, maskValue(v)])),
      lengths: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v == null ? '' : v).length])),
      origins,
      count: Object.keys(vars).length,
      instructions,
      instructionCount: instructions.length,
      prePrompts,
      prePromptCount: prePrompts.length,
      warnings,
    };
  }

  async describeAll() {
    return Promise.all(this.sets().map((s) => this.describe(s.id)));
  }

  /** Raw value for one key, for an explicit reveal action in the UI. */
  async reveal(setId, key) {
    const { vars } = await this.resolveSet(setId);
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : null;
  }
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

function describeSource(s) {
  if (s.type === 'instructions' || s.type === 'preprompt') {
    const t = String(s.text || '').trim();
    const label = s.type === 'preprompt' ? 'opening prompt' : 'instructions';
    return `${label} — ${t.split(/\s+/).length} words`;
  }
  if (s.type === 'inline') return `${Object.keys(s.vars || {}).length} pasted variables`;
  if (s.type === 'file') return `file ${s.path}${s.mode === 'snapshot' ? ' (snapshot)' : ''}`;
  if (s.type === 'command') return `command ${String(s.command).slice(0, 60)}`;
  return s.type;
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-lc', command], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT,
      env: process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split('\n')[0] || err.message;
        return reject(new Error(detail));
      }
      resolve(stdout);
    });
  });
}

module.exports = { EnvManager };
