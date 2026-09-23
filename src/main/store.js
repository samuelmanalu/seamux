'use strict';

const fs = require('fs');
const path = require('path');

/** Tiny JSON store for the project list and window state. */
class Store {
  constructor(file) {
    this.file = file;
    this.data = { projects: [], lastCwd: null, customProfiles: [] };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { /* first run */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  projects() { return this.data.projects; }

  addProject(cwd) {
    const existing = this.data.projects.find((p) => p.cwd === cwd);
    if (existing) return existing;
    const entry = { cwd, name: path.basename(cwd) || cwd, envSetIds: [] };
    this.data.projects.push(entry);
    this.save();
    return entry;
  }

  /** Which agent a project uses by default. */
  profileFor(cwd) {
    const p = this.data.projects.find((x) => x.cwd === cwd);
    return (p && p.profileId) || null;
  }

  setProfile(cwd, profileId) {
    const p = this.addProject(cwd);
    p.profileId = profileId;
    this.save();
    return p;
  }

  customProfiles() { return this.data.customProfiles || []; }

  saveCustomProfile(def) {
    const list = this.customProfiles();
    const i = list.findIndex((x) => x.id === def.id);
    if (i >= 0) list[i] = def; else list.push(def);
    this.data.customProfiles = list;
    this.save();
    return def;
  }

  removeCustomProfile(id) {
    this.data.customProfiles = this.customProfiles().filter((x) => x.id !== id);
    this.save();
  }

  /** Environment sets bound to a project, in apply order. */
  envSetsFor(cwd) {
    const p = this.data.projects.find((x) => x.cwd === cwd);
    return (p && p.envSetIds) || [];
  }

  bindEnvSets(cwd, ids) {
    const p = this.addProject(cwd);
    p.envSetIds = Array.from(new Set(ids || []));
    this.save();
    return p;
  }

  /** Drop a deleted set from every project that referenced it. */
  forgetEnvSet(id) {
    for (const p of this.data.projects) {
      if (p.envSetIds) p.envSetIds = p.envSetIds.filter((x) => x !== id);
    }
    this.save();
  }

  removeProject(cwd) {
    this.data.projects = this.data.projects.filter((p) => p.cwd !== cwd);
    this.save();
  }
}

module.exports = { Store };
